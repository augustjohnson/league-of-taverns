/**
 * Thin adapter from a verbatim Open5e record to the engine's `BaseStats`.
 *
 * Responsibilities:
 * - Read only what the engine needs: CR (exact, in eighths), abilities, skill
 *   and save modifiers with ability-mod fallback, speeds, senses, AC, HP,
 *   damage modifiers, and attack lines for the battle model.
 * - Parse Open5e's free-text fields (senses, damage resistances) into
 *   closed-vocabulary values. Text that cannot be parsed is ignored, never
 *   guessed, and reported in `warnings`.
 * - Never read or produce chrome. The creature's `name` is its type name
 *   ("Ogre"), which the story layer may show as `{battle_creature}`.
 *
 * This replaces the reshaped "lean" snapshot schema in docs/specs/02.
 * See docs/decisions.md Δ-04.
 */
import type { Ability, CrEighths, SenseKind, Skill, SpeedKind } from '../../vocabulary';
import { notImplemented } from '../../internal/not-implemented';
import type { Open5eMonster } from './types';

export type { Open5eMonster, Open5eAction, SnapshotManifestEntry } from './types';

/** One attack line, reduced to what an expected-value battle model needs. */
export interface AttackProfile {
  readonly name: string;
  readonly attackBonus: number;
  /** Mean damage per hit (dice average + bonus). */
  readonly averageDamage: number;
  /** Attacks per turn when a Multiattack line names this attack. Defaults to 1. */
  readonly perTurn: number;
}

/** Mechanical view of an Open5e creature before season modifiers. */
export interface BaseStats {
  readonly slug: string;
  /** Type name from the stat block, e.g. "Ogre". Not chrome: it is SRD data. */
  readonly typeName: string;
  readonly cr: CrEighths;
  readonly size: string;
  readonly creatureType: string;
  readonly abilities: Readonly<Record<Ability, number>>;
  /** Every skill, proficient or not (unproficient = ability modifier). */
  readonly skills: Readonly<Record<Skill, number>>;
  /** Every save, proficient or not. */
  readonly saves: Readonly<Record<Ability, number>>;
  readonly speeds: Readonly<Partial<Record<SpeedKind, number>>>;
  readonly senses: Readonly<Partial<Record<SenseKind, number>>>;
  readonly ac: number;
  readonly hp: number;
  readonly attacks: ReadonlyArray<AttackProfile>;
  readonly damage: {
    readonly resist: ReadonlyArray<string>;
    readonly immune: ReadonlyArray<string>;
    readonly vulnerable: ReadonlyArray<string>;
  };
}

export interface AdaptResult {
  readonly stats: BaseStats;
  /** Fields the adapter could not interpret. Surfaced by `scripts/validate`. */
  readonly warnings: ReadonlyArray<string>;
}

/** Interpret one verbatim record. Pure. */
export function toBaseStats(_record: Open5eMonster): AdaptResult {
  return notImplemented('toBaseStats', 'T1.3');
}

/** Parse Open5e's CR forms ("1/4", 0.25, "10") to exact eighths. */
export function parseCr(_value: string | number): CrEighths {
  return notImplemented('parseCr', 'T1.3');
}

/** Index a snapshot by slug for lookups from character bases and encounters. */
export function indexSnapshot(_records: ReadonlyArray<Open5eMonster>): ReadonlyMap<string, Open5eMonster> {
  return notImplemented('indexSnapshot', 'T1.3');
}
