/**
 * Small read-only helpers over a `PublicView`, shared by every strategy.
 */
import { DEFAULT_RETREAT, validateLineup, type CrEighths, type Lineup, type RetreatOrder, type SeasonConfig } from '@league-of-taverns/engine';
import type { PublicView } from './types';

/** The season config. Throws before `season.created`, when no decision makes sense. */
export function configOf(view: PublicView): SeasonConfig {
  const config = view.state.config;
  if (config === null) throw new Error(`bot ${view.tavern}: the league has no season config yet`);
  return config;
}

/** The bot's own roster, in draft order. Empty before its first pick. */
export function rosterOf(view: PublicView): ReadonlyArray<string> {
  return view.state.taverns.get(view.tavern)?.roster ?? [];
}

/** CR lookup: `view.crOf`, else the pool entry, else effective stats. */
export function crLookup(view: PublicView): (id: string) => CrEighths {
  if (view.crOf !== undefined) return view.crOf;
  return (id) => view.state.pool.get(id)?.cr ?? view.statsOf(id).cr;
}

/** Every pooled character id, sorted, so iteration never depends on event order. */
export function poolIds(view: PublicView): ReadonlyArray<string> {
  return [...view.state.pool.keys()].sort();
}

/** Stable id order for tiebreaks. */
export function byId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The week the next roster change first plays in: one past the latest week
 * that is locked or finalized (a claim resolved after week w's run first plays
 * in week w + 1, docs/decisions.md D-37), or week 1 before any lock.
 */
export function nextWeek(view: PublicView): number {
  let latest = 0;
  for (const week of view.state.finalizedWeeks) latest = Math.max(latest, week);
  for (const week of view.state.lockedLineups.keys()) latest = Math.max(latest, week);
  return latest + 1;
}

/** One legal 4-subset of a roster: its ids in roster order, and their total CR in eighths. */
export interface Subset {
  readonly ids: readonly [string, string, string, string];
  readonly total: number;
}

/**
 * Every 4-subset of `roster` whose total CR is within the budget, in
 * lexicographic order of roster indices (35 at most for 7 characters).
 * Duplicate ids and characters without a known CR are skipped.
 */
export function legalSubsets(view: PublicView, roster: ReadonlyArray<string>): ReadonlyArray<Subset> {
  const budget = configOf(view).budget.partyCr;
  const crOf = crLookup(view);
  const ids: string[] = [];
  const crs: number[] = [];
  for (const id of new Set(roster)) {
    let cr: number;
    try {
      cr = crOf(id);
    } catch {
      continue;
    }
    if (!Number.isInteger(cr) || cr < 0) continue;
    ids.push(id);
    crs.push(cr);
  }
  const out: Subset[] = [];
  const n = ids.length;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const total = crs[a]! + crs[b]! + crs[c]! + crs[d]!;
          if (total <= budget) out.push({ ids: [ids[a]!, ids[b]!, ids[c]!, ids[d]!], total });
        }
      }
    }
  }
  return out;
}

/**
 * A lineup from a subset: the starters in roster order, and `retreat`
 * (`never` unless a strategy picks one, D-49). Lineup order only breaks
 * best-fit ties (D-15).
 */
export function lineupFrom(subset: Subset, retreat: RetreatOrder = DEFAULT_RETREAT): Lineup {
  return { starters: subset.ids, retreat };
}

/** The lineup's starters in lineup order. */
export function startersOf(lineup: Lineup): ReadonlyArray<string> {
  return lineup.starters;
}

/** Throws unless `lineup` is legal for the bot's own roster. A guard: strategies should never trip it. */
export function assertLegal(view: PublicView, lineup: Lineup, strategy: string): Lineup {
  const roster = { tavern: view.tavern, characters: rosterOf(view) };
  const violations = validateLineup(lineup, roster, crLookup(view), configOf(view));
  if (violations.length > 0) {
    throw new Error(`bot ${view.tavern} (${strategy}): illegal lineup: ${violations.map((v) => v.message).join('; ')}`);
  }
  return lineup;
}
