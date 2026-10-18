/**
 * Test builders for the contest: synthetic monsters with chosen modifiers,
 * strategies and tags, and small casts. Test-only.
 */
import { toBaseStats, type BaseStats } from '../../src/adapters/open5e';
import type { EffectiveStats } from '../../src/characters';
import { challengePower } from '../../src/contest/cards';
import type { Contestant, VotingStrategy } from '../../src/contest/types';
import { ABILITIES, SKILLS, type Ability, type SenseKind, type Skill, type SpeedKind } from '../../src/vocabulary';
import { loadFixture } from '../fixtures/open5e';

const BASES = new Map<string, BaseStats>();

/** Adapted base stats for an Open5e fixture slug, cached. */
export function baseOf(slug: string): BaseStats {
  let base = BASES.get(slug);
  if (base === undefined) {
    base = toBaseStats(loadFixture(slug)).stats;
    BASES.set(slug, base);
  }
  return base;
}

export interface MemberSpec {
  /** Added to every skill, save and ability modifier. */
  readonly all?: number;
  readonly skills?: Partial<Record<Skill, number>>;
  readonly saves?: Partial<Record<Ability, number>>;
  readonly abilityMods?: Partial<Record<Ability, number>>;
  /** `checkTargetKey`s, e.g. "skill:stealth". */
  readonly advantages?: ReadonlyArray<string>;
  readonly speeds?: Partial<Record<SpeedKind, number>>;
  readonly senses?: Partial<Record<SenseKind, number>>;
}

/**
 * Synthetic stats: every skill, save and ability modifier is `all` (0) unless
 * given, walk 30 ft, no senses, no advantages. The base is the ogre fixture,
 * only so the type is complete.
 */
export function member(id: string, spec: MemberSpec = {}): EffectiveStats {
  const flat = <K extends string>(keys: ReadonlyArray<K>): Record<K, number> => Object.fromEntries(keys.map((k) => [k, spec.all ?? 0])) as Record<K, number>;
  const base = baseOf('ogre');
  return {
    characterId: id,
    base,
    cr: base.cr,
    skills: { ...flat(SKILLS), ...spec.skills },
    saves: { ...flat(ABILITIES), ...spec.saves },
    abilityMods: { ...flat(ABILITIES), ...spec.abilityMods },
    advantages: new Set(spec.advantages ?? []),
    speeds: { walk: 30, ...spec.speeds },
    senses: { ...spec.senses },
  };
}

/** A contestant from synthetic stats, with the given strategy and tags (default: floater, no tags). */
export function card(id: string, spec: MemberSpec = {}, strategy: VotingStrategy = { kind: 'floater' }, tags: ReadonlyArray<string> = []): Contestant {
  const stats = member(id, spec);
  return { id, stats, strategy, tags, power: challengePower(stats) };
}

/** `n` plain floaters `m1`…`mn`, each one point stronger than the one before. */
export function castOf(n: number): ReadonlyArray<Contestant> {
  return Array.from({ length: n }, (_, i) => card(`m${i + 1}`, { all: i }));
}
