/**
 * Draft strategies. Each ranks the available characters by one legible idea,
 * then takes the best one that keeps the roster able to field a legal lineup
 * (`keepsLineupPossible`). Results never depend on the order of `available`.
 */
import { SKILLS } from '@league-of-taverns/engine';
import { coveredSkills, poolInfo } from '../metrics';
import type { DraftStrategy, PublicView } from '../types';
import { byId, configOf, crLookup, rosterOf } from '../view';

/**
 * Whether drafting `candidate` still leaves a way to start four characters
 * under the budget once the roster is full.
 *
 * The bot's own future picks are estimated pessimistically: before each of
 * them, assume the other taverns take the cheapest characters left (one
 * round's worth, `taverns − 1`), and that the bot then gets the next cheapest.
 * So future pick j gets the (j × taverns − 1)-th cheapest remaining CR
 * (0-based). The roster passes if the four cheapest of its characters plus
 * those estimates total at most B.
 */
export function keepsLineupPossible(view: PublicView, candidate: string, available: ReadonlyArray<string>): boolean {
  const config = configOf(view);
  const crOf = crLookup(view);
  const roster = rosterOf(view);
  const after = [...roster, candidate];
  const left = Math.max(0, config.roster.size - after.length);
  const taken = new Set(after);
  const rest = [...new Set(available)].filter((id) => !taken.has(id)).map(crOf).sort((a, b) => a - b);
  const taverns = Math.max(1, view.state.taverns.size);
  const crs = after.map(crOf);
  for (let j = 1; j <= left; j++) {
    const cr = rest[j * taverns - 1];
    if (cr === undefined) break;
    crs.push(cr);
  }
  if (crs.length < config.roster.starters) return false;
  crs.sort((a, b) => a - b);
  return crs.slice(0, config.roster.starters).reduce((sum, cr) => sum + cr, 0) <= config.budget.partyCr;
}

/**
 * The first of `ranked` that keeps a lineup possible. If none does (the
 * roster is already doomed), the cheapest available, ties by id, which is the
 * pick most likely to repair it.
 */
function firstSafe(view: PublicView, ranked: ReadonlyArray<string>, available: ReadonlyArray<string>): string {
  const safe = ranked.find((id) => keepsLineupPossible(view, id, available));
  if (safe !== undefined) return safe;
  const crOf = crLookup(view);
  return [...ranked].sort((a, b) => crOf(a) - crOf(b) || byId(a, b))[0]!;
}

/** Distinct available ids, sorted, so a strategy never depends on the caller's order. */
function candidates(view: PublicView, available: ReadonlyArray<string>, strategy: string): ReadonlyArray<string> {
  const owned = new Set(rosterOf(view));
  const ids = [...new Set(available)].filter((id) => !owned.has(id)).sort(byId);
  if (ids.length === 0) throw new Error(`bot ${view.tavern} (${strategy}): nothing available to draft`);
  return ids;
}

/** `random`: a seeded uniform pick among the safe candidates. Draws exactly one value from `view.rng`. */
export const randomDraft: DraftStrategy = {
  id: 'random',
  pick(view, available) {
    const ids = candidates(view, available, 'random');
    const safe = ids.filter((id) => keepsLineupPossible(view, id, available));
    const pool = safe.length > 0 ? safe : [firstSafe(view, ids, available)];
    return pool[Math.min(pool.length - 1, Math.floor(view.rng() * pool.length))]!;
  },
};

/** `cr-greedy`: the highest CR available, ties by id. */
export const crGreedyDraft: DraftStrategy = {
  id: 'cr-greedy',
  pick(view, available) {
    const crOf = crLookup(view);
    const ranked = [...candidates(view, available, 'cr-greedy')].sort((a, b) => crOf(b) - crOf(a) || byId(a, b));
    return firstSafe(view, ranked, available);
  },
};

/**
 * `skill-coverage`: the pick that maximises the number of skills where the
 * roster holds a best or second-best (distinct) modifier in the pool. Ties go
 * to the candidate who covers the most skills alone, then the lower CR (it
 * leaves budget), then id.
 */
export const skillCoverageDraft: DraftStrategy = {
  id: 'skill-coverage',
  pick(view, available) {
    const info = poolInfo(view);
    const crOf = crLookup(view);
    const roster = rosterOf(view).map((id) => view.statsOf(id));
    const scored = candidates(view, available, 'skill-coverage').map((id) => {
      const stats = view.statsOf(id);
      return {
        id,
        together: coveredSkills(info, [...roster, stats]).size,
        alone: SKILLS.filter((skill) => stats.skills[skill] >= info.topTwo[skill]).length,
        cr: crOf(id),
      };
    });
    scored.sort((a, b) => b.together - a.together || b.alone - a.alone || a.cr - b.cr || byId(a.id, b.id));
    return firstSafe(
      view,
      scored.map((s) => s.id),
      available,
    );
  },
};

/**
 * `value`: the best (battle strength + skill breadth) per CR, see `poolInfo`.
 * Ties by id. This is also the autopick on a draft timeout (docs/rules.md §4).
 */
export const valueDraft: DraftStrategy = {
  id: 'value',
  pick(view, available) {
    const info = poolInfo(view);
    const rate = (id: string): number => info.value.get(id) ?? 0;
    const ranked = [...candidates(view, available, 'value')].sort((a, b) => rate(b) - rate(a) || byId(a, b));
    return firstSafe(view, ranked, available);
  },
};

export const DRAFT_STRATEGIES = {
  random: randomDraft,
  'cr-greedy': crGreedyDraft,
  'skill-coverage': skillCoverageDraft,
  value: valueDraft,
} as const satisfies Record<string, DraftStrategy>;
