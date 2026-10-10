/**
 * Characters: base stats + season modifiers → effective stats.
 *
 * Responsibilities:
 * - Apply a character's modifiers (primitives and registry traits) on top of
 *   its Open5e base to produce `EffectiveStats`.
 * - Validate modifiers against the closed vocabulary and the per-character
 *   season budget.
 * - Know nothing about chrome. `CharacterRef` has no name field.
 *
 * Carryover (which characters a tavern keeps between seasons) is roster and
 * lifecycle business, not this module's. See T3.6 and T10.3.
 */
import type { BaseStats } from '../adapters/open5e';
import { notImplemented } from '../internal/not-implemented';
import { ABILITIES, SENSES, SKILLS, SPEEDS } from '../vocabulary';
import { PRIMITIVE_RULES, type PrimitiveRule } from './registry';
import type {
  CheckTarget,
  EffectiveStats,
  Modifier,
  ModifierEffect,
  PooledCharacter,
  TraitDefinition,
} from './types';

export type * from './types';
export { PRIMITIVE_RULES, REGISTRY_VERSION, TRAITS, type PrimitiveRule } from './registry';
export { ModifierEffectSchema, ModifierSchema, PoolEntrySchema, type PoolEntry } from './schema';

/** Which rule a modifier issue breaks. Stable, so callers and tests can match on it. */
export type ModifierIssueCode =
  | 'unknown_kind'
  | 'unknown_trait'
  | 'invalid_trait'
  | 'invalid_vocabulary'
  | 'out_of_range'
  | 'stacking'
  | 'duplicate_advantage'
  | 'over_budget';

export interface ModifierBudgetIssue {
  readonly characterId: string;
  readonly code: ModifierIssueCode;
  readonly message: string;
}

/** A registry problem with one trait definition. */
export interface TraitRegistryIssue {
  readonly traitId: string;
  readonly message: string;
}

/** Stable string key for a check target, e.g. "skill:stealth", "save:dex" or "ability:str". */
export function checkTargetKey(target: CheckTarget): string {
  return target.type === 'skill' ? `skill:${target.skill}` : `${target.type}:${target.ability}`;
}

/**
 * Total cost of a modifier list under the registry. Per-point kinds cost
 * `cost × value`, flat kinds cost `cost`, traits cost their registry cost.
 * Throws on an unknown kind or trait. It does not check ranges or budget:
 * use `validateModifiers` for that.
 */
export function modifierCost(modifiers: ReadonlyArray<Modifier>, traits: ReadonlyArray<TraitDefinition>): number {
  return modifiers.reduce((total, modifier, i) => {
    const cost = costOf(modifier, traits);
    if (cost === undefined) {
      const what = modifier.kind === 'trait' ? `trait "${modifier.trait}"` : `kind "${String(modifier.kind)}"`;
      throw new Error(`modifiers[${i}]: unknown ${what}`);
    }
    return total + cost;
  }, 0);
}

/**
 * Every vocabulary, range, stacking and budget violation for one pooled
 * character, all reported together. Trait effects count toward stacking and
 * duplicate-advantage checks, since they apply to the same stats.
 */
export function validateModifiers(
  character: PooledCharacter,
  budget: number,
  traits: ReadonlyArray<TraitDefinition>,
): ReadonlyArray<ModifierBudgetIssue> {
  const characterId = character.ref.id;
  const issues: ModifierBudgetIssue[] = [];
  const report = (code: ModifierIssueCode, message: string): void => {
    issues.push({ characterId, code, message });
  };
  const registryIssues = validateTraitRegistry(traits);

  /** Every primitive effect that ends up applied, tagged with where it came from. */
  const applied: Array<{ readonly effect: ModifierEffect; readonly from: string }> = [];
  let total = 0;

  character.modifiers.forEach((modifier, i) => {
    const at = `modifiers[${i}]`;
    if (modifier.kind === 'trait') {
      const trait = findTrait(traits, modifier.trait);
      if (trait === undefined) {
        report('unknown_trait', `${at}: unknown trait "${modifier.trait}"`);
        return;
      }
      for (const problem of registryIssues.filter((r) => r.traitId === trait.id)) {
        report('invalid_trait', `${at}: trait "${trait.id}" is invalid in the registry: ${problem.message}`);
      }
      total += trait.cost;
      for (const effect of trait.effects) {
        if (ruleFor(effect.kind) !== undefined) applied.push({ effect, from: `${at} (trait ${trait.id})` });
      }
      return;
    }

    const rule = ruleFor(modifier.kind);
    if (rule === undefined) {
      report('unknown_kind', `${at}: unknown modifier kind "${String(modifier.kind)}"`);
      return;
    }
    const problems = effectProblems(modifier, rule);
    for (const p of problems) report(p.code, `${at} (${modifier.kind}): ${p.message}`);
    const cost = primitiveCost(modifier, rule);
    if (cost !== undefined) total += cost;
    if (problems.every((p) => p.code !== 'invalid_vocabulary')) applied.push({ effect: modifier, from: at });
  });

  // Stacking: the same primitive on the same target is summed and must stay within max.
  const stacks = new Map<string, { sum: number; max: number | undefined; from: string[] }>();
  // Advantage doesn't stack: one per check target.
  const advantages = new Map<string, string[]>();
  for (const { effect, from } of applied) {
    if (effect.kind === 'advantage') {
      const key = checkTargetKey(effect.on);
      advantages.set(key, [...(advantages.get(key) ?? []), from]);
      continue;
    }
    const key = stackKey(effect);
    const points = pointsOf(effect);
    if (key === undefined || points === undefined || !Number.isFinite(points)) continue;
    const entry = stacks.get(key) ?? { sum: 0, max: ruleFor(effect.kind)?.max, from: [] };
    entry.sum += points;
    entry.from.push(from);
    stacks.set(key, entry);
  }
  for (const [key, { sum, max, from }] of stacks) {
    if (from.length > 1 && max !== undefined && sum > max) {
      report('stacking', `${key} stacks to ${sum}, over its max of ${max} (from ${from.join(', ')})`);
    }
  }
  for (const [key, from] of advantages) {
    if (from.length > 1) {
      report('duplicate_advantage', `advantage on ${key} appears ${from.length} times (from ${from.join(', ')}); advantage doesn't stack`);
    }
  }

  if (total > budget) {
    report('over_budget', `modifiers cost ${total}, over the budget of ${budget}`);
  }
  return issues;
}

/**
 * Registry sanity: trait ids are unique kebab-case, costs are non-negative
 * integers, and every effect is a valid primitive. A trait containing a trait
 * is invalid (the type forbids it, but registry data may not be typed).
 */
export function validateTraitRegistry(traits: ReadonlyArray<TraitDefinition>): ReadonlyArray<TraitRegistryIssue> {
  const issues: TraitRegistryIssue[] = [];
  const seen = new Set<string>();
  for (const trait of traits) {
    const report = (message: string): void => {
      issues.push({ traitId: trait.id, message });
    };
    if (seen.has(trait.id)) report('duplicate trait id');
    seen.add(trait.id);
    if (!KEBAB_CASE.test(trait.id)) report('id must be kebab-case');
    if (!Number.isInteger(trait.cost) || trait.cost < 0) report(`cost ${trait.cost} must be a non-negative integer`);
    if (trait.effects.length === 0) report('has no effects');
    trait.effects.forEach((effect, i) => {
      const kind: string = effect.kind;
      if (kind === 'trait') {
        report(`effects[${i}] is a trait; traits may contain only primitives`);
        return;
      }
      const rule = ruleFor(kind);
      if (rule === undefined) {
        report(`effects[${i}] has unknown kind "${kind}"`);
        return;
      }
      for (const p of effectProblems(effect, rule)) report(`effects[${i}] (${kind}): ${p.message}`);
    });
  }
  return issues;
}

/** Base + modifiers → the stats the resolver uses. Pure and total for valid input. */
export function effectiveStats(
  _character: PooledCharacter,
  _base: BaseStats,
  _traits: ReadonlyArray<TraitDefinition>,
): EffectiveStats {
  return notImplemented('effectiveStats', 'T3.3');
}

// ── internals ──────────────────────────────────────────────────────────────

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function ruleFor(kind: string): PrimitiveRule | undefined {
  return PRIMITIVE_RULES.find((r) => r.kind === kind);
}

function findTrait(traits: ReadonlyArray<TraitDefinition>, id: string): TraitDefinition | undefined {
  return traits.find((t) => t.id === id);
}

function isOneOf<T extends string>(values: ReadonlyArray<T>, x: unknown): x is T {
  return typeof x === 'string' && (values as ReadonlyArray<string>).includes(x);
}

/** The `value` a per-point kind scales by, or undefined for kinds without one. */
function pointsOf(effect: ModifierEffect): number | undefined {
  return 'value' in effect ? effect.value : undefined;
}

/** Cost of one modifier, or undefined if its kind or trait is unknown. */
function costOf(modifier: Modifier, traits: ReadonlyArray<TraitDefinition>): number | undefined {
  if (modifier.kind === 'trait') return findTrait(traits, modifier.trait)?.cost;
  const rule = ruleFor(modifier.kind);
  return rule === undefined ? undefined : primitiveCost(modifier, rule);
}

function primitiveCost(effect: ModifierEffect, rule: PrimitiveRule): number | undefined {
  if (!rule.perPoint) return rule.cost;
  const points = pointsOf(effect);
  return points === undefined || !Number.isFinite(points) ? undefined : rule.cost * points;
}

/** Key under which repeated primitives are summed, e.g. "skill_bonus:stealth". */
function stackKey(effect: ModifierEffect): string | undefined {
  switch (effect.kind) {
    case 'skill_bonus':
      return `skill_bonus:${effect.skill}`;
    case 'save_bonus':
      return `save_bonus:${effect.ability}`;
    case 'battle_bonus':
      return 'battle_bonus';
    default:
      return undefined;
  }
}

interface EffectProblem {
  readonly code: 'invalid_vocabulary' | 'out_of_range';
  readonly message: string;
}

/** Vocabulary and range problems in one primitive, checked at runtime since inputs may be untyped. */
function effectProblems(effect: ModifierEffect, rule: PrimitiveRule): EffectProblem[] {
  const problems: EffectProblem[] = [];
  const vocab = (field: string, value: unknown, allowed: ReadonlyArray<string>): void => {
    if (!isOneOf(allowed, value)) {
      problems.push({ code: 'invalid_vocabulary', message: `unknown ${field} "${String(value)}"` });
    }
  };
  const range = (field: string, value: unknown, min: number | undefined, max: number | undefined): void => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      problems.push({ code: 'out_of_range', message: `${field} ${String(value)} must be an integer` });
    } else if ((min !== undefined && value < min) || (max !== undefined && value > max)) {
      problems.push({ code: 'out_of_range', message: `${field} ${value} is outside ${min ?? '-∞'}..${max ?? '∞'}` });
    }
  };

  switch (effect.kind) {
    case 'skill_bonus':
      vocab('skill', effect.skill, SKILLS);
      range('value', effect.value, rule.min, rule.max);
      break;
    case 'save_bonus':
      vocab('ability', effect.ability, ABILITIES);
      range('value', effect.value, rule.min, rule.max);
      break;
    case 'battle_bonus':
      range('value', effect.value, rule.min, rule.max);
      break;
    case 'advantage': {
      const on = effect.on as { readonly type?: unknown; readonly skill?: unknown; readonly ability?: unknown } | undefined;
      if (on?.type === 'skill') vocab('skill', on.skill, SKILLS);
      else if (on?.type === 'save' || on?.type === 'ability') vocab('ability', on.ability, ABILITIES);
      else vocab('check type', on?.type, ['skill', 'save', 'ability']);
      break;
    }
    case 'grant_speed':
      vocab('speed', effect.speed, SPEEDS);
      range('feet', effect.feet, rule.min ?? 1, rule.max);
      break;
    case 'grant_sense':
      vocab('sense', effect.sense, SENSES);
      range('feet', effect.feet, rule.min ?? 1, rule.max);
      break;
  }
  return problems;
}
