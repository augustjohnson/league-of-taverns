import type { BaseStats } from '../adapters/open5e';
import type { Ability, CrEighths, SenseKind, Skill, SpeedKind } from '../vocabulary';

/**
 * The engine's view of a character: a stable id plus a base slug.
 *
 * Deliberately has no name, epithet, backstory or portrait. Chrome lives in
 * characters/<id>/character.yaml and is stripped by the loader before anything
 * reaches the engine. The engine cannot read chrome because the type does not
 * carry it.
 */
export interface CharacterRef {
  /** Stable across seasons, e.g. "bruno-the-bruiser". Career history follows this id. */
  readonly id: string;
  /** Open5e slug in the season's pinned snapshot. Two characters may share a base. */
  readonly base: string;
}

/**
 * A primitive mechanical delta. This union IS the closed vocabulary: anything
 * not expressible here cannot be authored. Adding a kind is a schema change
 * (docs/schema.md § Modifier registry).
 */
export type ModifierEffect =
  | { readonly kind: 'skill_bonus'; readonly skill: Skill; readonly value: number }
  | { readonly kind: 'save_bonus'; readonly ability: Ability; readonly value: number }
  | { readonly kind: 'advantage'; readonly on: CheckTarget }
  | { readonly kind: 'grant_speed'; readonly speed: SpeedKind; readonly feet: number }
  | { readonly kind: 'grant_sense'; readonly sense: SenseKind; readonly feet: number }
  | { readonly kind: 'battle_bonus'; readonly value: number };

/** What a check tests. Shared with mission checks. */
export type CheckTarget =
  | { readonly type: 'skill'; readonly skill: Skill }
  | { readonly type: 'save'; readonly ability: Ability }
  | { readonly type: 'ability'; readonly ability: Ability };

/** A modifier as authored in pool.yaml: a primitive effect or a named trait. */
export type Modifier = ModifierEffect | { readonly kind: 'trait'; readonly trait: string };

/** A named bundle of primitive effects with a fixed cost. Lives in the registry. */
export interface TraitDefinition {
  readonly id: string;
  readonly cost: number;
  readonly effects: ReadonlyArray<ModifierEffect>;
}

/** One character as pooled for a season: who, on what base, with which modifiers. */
export interface PooledCharacter {
  readonly ref: CharacterRef;
  readonly modifiers: ReadonlyArray<Modifier>;
}

/** Base stats with this season's modifiers applied. All the resolver ever sees. */
export interface EffectiveStats {
  readonly characterId: string;
  readonly base: BaseStats;
  readonly cr: CrEighths;
  readonly skills: Readonly<Record<Skill, number>>;
  readonly saves: Readonly<Record<Ability, number>>;
  readonly abilityMods: Readonly<Record<Ability, number>>;
  /** Check targets this character rolls with advantage, keyed by `checkTargetKey`. */
  readonly advantages: ReadonlySet<string>;
  readonly speeds: Readonly<Partial<Record<SpeedKind, number>>>;
  readonly senses: Readonly<Partial<Record<SenseKind, number>>>;
  /** Flat adjustment fed into the battle model. */
  readonly battleBonus: number;
}
