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
import type { CheckTarget, EffectiveStats, Modifier, PooledCharacter, TraitDefinition } from './types';

export type * from './types';
export { PRIMITIVE_RULES, REGISTRY_VERSION, TRAITS } from './registry';

export interface ModifierBudgetIssue {
  readonly characterId: string;
  readonly message: string;
}

/** Stable string key for a check target, e.g. "skill:stealth" or "save:dex". */
export function checkTargetKey(_target: CheckTarget): string {
  return notImplemented('checkTargetKey', 'T3.3');
}

/** Total cost of a modifier list under the registry. Unknown traits are an error. */
export function modifierCost(_modifiers: ReadonlyArray<Modifier>, _traits: ReadonlyArray<TraitDefinition>): number {
  return notImplemented('modifierCost', 'T3.2');
}

/** Every vocabulary, range and budget violation for one pooled character. */
export function validateModifiers(
  _character: PooledCharacter,
  _budget: number,
  _traits: ReadonlyArray<TraitDefinition>,
): ReadonlyArray<ModifierBudgetIssue> {
  return notImplemented('validateModifiers', 'T3.2');
}

/** Base + modifiers → the stats the resolver uses. Pure and total for valid input. */
export function effectiveStats(
  _character: PooledCharacter,
  _base: BaseStats,
  _traits: ReadonlyArray<TraitDefinition>,
): EffectiveStats {
  return notImplemented('effectiveStats', 'T3.3');
}
