/**
 * Test builders for resolution and projection: synthetic starters, parties,
 * small missions and fake battle models. Test-only.
 */
import { toBaseStats, type BaseStats } from '../../src/adapters/open5e';
import type { EffectiveStats } from '../../src/characters';
import type { BattleNode, CheckNode, CheckSpec, Encounter, Mission, MissionEdge, MissionNode } from '../../src/missions';
import type { BattleModel, Party } from '../../src/resolution';
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
  readonly skills?: Partial<Record<Skill, number>>;
  readonly saves?: Partial<Record<Ability, number>>;
  readonly abilityMods?: Partial<Record<Ability, number>>;
  /** `checkTargetKey`s, e.g. "skill:stealth". */
  readonly advantages?: ReadonlyArray<string>;
  readonly speeds?: Partial<Record<SpeedKind, number>>;
  readonly senses?: Partial<Record<SenseKind, number>>;
}

/**
 * A synthetic starter: every skill, save and ability modifier is 0 unless
 * given, walk 30 ft, no senses, no advantages. The base is the ogre fixture,
 * only so the type is complete; resolution never reads it for checks.
 */
export function member(id: string, spec: MemberSpec = {}): EffectiveStats {
  const zeros = <K extends string>(keys: ReadonlyArray<K>): Record<K, number> =>
    Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  const base = baseOf('ogre');
  return {
    characterId: id,
    base,
    cr: base.cr,
    skills: { ...zeros(SKILLS), ...spec.skills },
    saves: { ...zeros(ABILITIES), ...spec.saves },
    abilityMods: { ...zeros(ABILITIES), ...spec.abilityMods },
    advantages: new Set(spec.advantages ?? []),
    speeds: { walk: 30, ...spec.speeds },
    senses: { ...spec.senses },
    battleBonus: 0,
  };
}

/** A party in lineup order. The captain defaults to the first member. */
export function partyOf(members: ReadonlyArray<EffectiveStats>, captain = members[0]?.characterId ?? ''): Party {
  return { captain, members };
}

// ── missions ────────────────────────────────────────────────────────────────

export const start = (id = 'start'): MissionNode => ({ id, rank: 0, kind: 'start' });
export const end = (id: string, rank: number): MissionNode => ({ id, rank, kind: 'end' });
export const check = (id: string, rank: number, spec: CheckSpec): CheckNode => ({ id, rank, kind: 'check', check: spec });
export const skillCheck = (id: string, rank: number, skill: Skill, dc: number): CheckNode =>
  check(id, rank, { type: 'skill', skill, dc });
export const battle = (id: string, rank: number, creatures: Encounter['creatures'] = [{ ref: 'bat', count: 1 }]): BattleNode => ({
  id,
  rank,
  kind: 'battle',
  encounter: { creatures },
});
export const edge = (from: string, to: string, on: MissionEdge['on']): MissionEdge => ({ from, to, on });

export function missionOf(nodes: ReadonlyArray<MissionNode>, edges: ReadonlyArray<MissionEdge>, id = 'test-mission'): Mission {
  return { schemaVersion: 1, id, season: 'season-01', environment: 'swamp', nodes, edges };
}

// ── fake battle models ──────────────────────────────────────────────────────

/** Always `p`. */
export function constantModel(p: number): BattleModel {
  return { id: `constant-${p}`, pWin: () => p };
}

/**
 * A simple deterministic stand-in for the real model (T6.2): a logistic in
 * (party CR + 2 × battle bonus − encounter CR), in eighths, clamped to
 * [0.05, 0.95]. Stronger party → higher p, more foes → lower p.
 */
export const crModel: BattleModel = {
  id: 'fake-cr-logistic',
  pWin(party, foes) {
    const partyCr = party.members.reduce((sum, m) => sum + m.cr + 2 * m.battleBonus, 0);
    const foeCr = foes.reduce((sum, f) => sum + f.count * f.stats.cr, 0);
    const p = 1 / (1 + Math.exp(-(partyCr - foeCr) / 24));
    return Math.min(0.95, Math.max(0.05, p));
  },
};
