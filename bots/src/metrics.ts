/**
 * Character metrics the strategies share: a battle-strength proxy, skill
 * breadth, the `value` rating, and per-skill pool thresholds. All are pure
 * functions of public data (the pool and its effective stats).
 */
import {
  ABILITIES,
  SKILLS,
  evTtkBreakdown,
  type BaseStats,
  type EffectiveStats,
  type Skill,
} from '@league-of-taverns/engine';
import type { PublicView } from './types';
import { configOf, poolIds } from './view';

/**
 * A synthetic single foe of roughly CR `cr` (in eighths), from the usual
 * 5e "monster statistics by CR" curves, rounded: AC 13 + CR/3, HP 15 per CR
 * + 25, one attack at +3 + CR/2 dealing 6 per CR + 5. Only a yardstick for
 * comparing parties and characters when no real encounter is known; it is
 * never a real creature.
 */
export function referenceFoe(cr: number): BaseStats {
  const units = cr / 8;
  const zeros = <K extends string>(keys: ReadonlyArray<K>): Record<K, number> =>
    Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
  return {
    slug: 'reference-foe',
    typeName: 'Reference foe',
    cr: cr as BaseStats['cr'],
    size: 'large',
    creatureType: 'monstrosity',
    abilities: { ...zeros(ABILITIES), str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    skills: zeros(SKILLS),
    saves: zeros(ABILITIES),
    speeds: { walk: 30 },
    senses: {},
    ac: Math.round(13 + units / 3),
    hp: Math.round(15 * units + 25),
    attacks: [{ name: 'reference', attackBonus: Math.round(3 + units / 2), averageDamage: 6 * units + 5, perTurn: 1 }],
    damage: { resist: [], immune: [], vulnerable: [] },
  };
}

/** The yardstick for single characters: a CR 3 foe (B / 4 in season 1). */
const CHARACTER_YARDSTICK = referenceFoe(24);

/**
 * Battle strength of one character, `sqrt(DPR × eHP)` as `ev-ttk-v0` computes
 * them (battle bonus and nonmagical resistance included) against the CR 3
 * yardstick. The square root makes it roughly linear in size, so it can be
 * divided by CR: party strength in the model is ΣDPR × ΣeHP.
 */
export function battleStrength(stats: EffectiveStats): number {
  const b = evTtkBreakdown({ captain: stats.characterId, members: [stats] }, [{ stats: CHARACTER_YARDSTICK, count: 1 }]);
  return Math.sqrt(b.partyDpr * b.partyEhp);
}

/** Everything a strategy wants to know about the pool, computed once per pool. */
export interface PoolInfo {
  readonly ids: ReadonlyArray<string>;
  readonly stats: ReadonlyMap<string, EffectiveStats>;
  /** Per skill, the second-highest distinct modifier in the pool (the top one if all are equal). */
  readonly topTwo: Readonly<Record<Skill, number>>;
  /** Per skill, the pool's median modifier. */
  readonly median: Readonly<Record<Skill, number>>;
  readonly strength: ReadonlyMap<string, number>;
  /** Skills where the character beats the pool median. */
  readonly breadth: ReadonlyMap<string, number>;
  /** The `value` rating: see `valueOf`. */
  readonly value: ReadonlyMap<string, number>;
}

/** Weight of skill breadth against battle strength in `value`, both normalised to the pool mean. */
export const BREADTH_WEIGHT = 0.5;

const CACHE = new WeakMap<object, WeakMap<object, PoolInfo>>();

/**
 * Pool-wide metrics, cached per (statsOf, pool) pair. Both are immutable for
 * a given league state, so the cache can never go stale.
 *
 * `value` = (strength / mean strength + BREADTH_WEIGHT × breadth / mean
 * breadth) / max(CR, B / 8). The CR floor (1.5 at B = 12, half an even
 * per-starter share) stops CR 0 and 1/8 fodder from winning on the ratio
 * alone, since unspent budget is worth nothing.
 */
export function poolInfo(view: PublicView): PoolInfo {
  let byPool = CACHE.get(view.statsOf);
  if (byPool === undefined) {
    byPool = new WeakMap();
    CACHE.set(view.statsOf, byPool);
  }
  const cached = byPool.get(view.state.pool);
  if (cached !== undefined) return cached;

  const ids = poolIds(view);
  const stats = new Map(ids.map((id) => [id, view.statsOf(id)] as const));
  const topTwo = {} as Record<Skill, number>;
  const median = {} as Record<Skill, number>;
  for (const skill of SKILLS) {
    const values = ids.map((id) => stats.get(id)!.skills[skill]).sort((a, b) => b - a);
    const distinct = [...new Set(values)];
    topTwo[skill] = distinct[1] ?? distinct[0] ?? 0;
    median[skill] = values.length === 0 ? 0 : values[Math.floor((values.length - 1) / 2)]!;
  }
  const strength = new Map(ids.map((id) => [id, battleStrength(stats.get(id)!)] as const));
  const breadth = new Map(
    ids.map((id) => [id, SKILLS.filter((skill) => stats.get(id)!.skills[skill] > median[skill]).length] as const),
  );
  const mean = (m: ReadonlyMap<string, number>): number => {
    const total = [...m.values()].reduce((sum, x) => sum + x, 0);
    return m.size === 0 || total === 0 ? 1 : total / m.size;
  };
  const meanStrength = mean(strength);
  const meanBreadth = mean(breadth);
  const crFloor = Math.max(1, configOf(view).budget.partyCr / 8);
  const value = new Map(
    ids.map((id) => {
      const rating = strength.get(id)! / meanStrength + (BREADTH_WEIGHT * breadth.get(id)!) / meanBreadth;
      return [id, rating / Math.max(stats.get(id)!.cr, crFloor)] as const;
    }),
  );

  const info: PoolInfo = { ids, stats, topTwo, median, strength, breadth, value };
  byPool.set(view.state.pool, info);
  return info;
}

/** Skills where a roster has a top-two pool modifier. */
export function coveredSkills(info: PoolInfo, roster: ReadonlyArray<EffectiveStats>): ReadonlySet<Skill> {
  const covered = new Set<Skill>();
  for (const skill of SKILLS) {
    if (roster.some((m) => m.skills[skill] >= info.topTwo[skill])) covered.add(skill);
  }
  return covered;
}

/** `value` for a character, or 0 for one outside the pool. */
export function valueOf(view: PublicView, id: string): number {
  return poolInfo(view).value.get(id) ?? 0;
}
