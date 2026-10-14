/**
 * Selectors: derived views over `LeagueState`. Pure, never stored
 * (docs/schema.md § Reducers, "Derived views").
 */
import { reverseStandingsPriority, sponsoredTavern, standings, type StandingRow, type WeekResult } from '../league';
import { draftOrderSeed, rngFor } from '../rng';
import { draftOrder, snakePickOwner } from '../roster';
import type { Ability } from '../vocabulary';
import type { LeagueState } from './state';

/** The ability `tavern` is hexed on in `week`, or undefined (D-52). At most one hex per target per week. */
export function hexOn(state: LeagueState, tavern: string, week: number): Ability | undefined {
  return state.hexes.find((h) => h.target === tavern && h.week === week)?.ability;
}

/** Characters who can't start in `week`: hurt in a DNF the week before (D-51). */
export function injuredFor(state: LeagueState, week: number): ReadonlySet<string> {
  const out = new Set<string>();
  for (const [character, out_] of state.injuries) if (out_ === week) out.add(character);
  return out;
}

/** Pooled characters nobody owns, in pooling order. */
export function freeAgents(state: LeagueState): ReadonlyArray<string> {
  return [...state.pool.keys()].filter((id) => !state.owner.has(id));
}

/**
 * The manager whose turn it is to choose a tavern, or null when no choice is
 * possible (no season, no managers, every manager has chosen, or the draft
 * has started). Taverns are chosen in reverse draft order (D-52).
 *
 * Before the first choice the order isn't frozen yet, so this returns the
 * manager who would choose first if the pick started now, from the same
 * `draftOrder` call the first `tavern.chosen` makes. It can change while
 * managers are still joining. Null if that order can't be built (a manual
 * order that doesn't match the joined managers).
 */
export function tavernPickOnTheClock(state: LeagueState): string | null {
  const config = state.config;
  if (config === null || state.phase !== 'preseason' || state.draft.picks > 0) return null;
  let order = state.draft.managerOrder;
  if (order.length === 0) {
    const joined = [...state.managers.keys()];
    if (joined.length === 0) return null;
    try {
      order = draftOrder(joined, config, rngFor(draftOrderSeed(config.id), 'order'));
    } catch {
      return null;
    }
  }
  return [...order].reverse()[state.taverns.size] ?? null;
}

/**
 * The tavern whose draft pick is next, or null when no pick is possible (no
 * season, the tavern pick isn't finished, or the draft is over). Before the
 * first pick the snake order is the managers' taverns in draft order, as the
 * first `draft.pick` freezes it.
 */
export function onTheClock(state: LeagueState): string | null {
  const config = state.config;
  if (config === null || state.draft.complete) return null;
  if (state.phase !== 'preseason' && state.phase !== 'drafting') return null;
  let order = state.draft.order;
  if (state.draft.picks === 0) {
    const managers = [...state.managers.values()];
    if (managers.length === 0 || managers.some((m) => m.tavern === null)) return null;
    order = state.draft.managerOrder.map((id) => state.managers.get(id)!.tavern!);
  }
  return snakePickOwner(order, state.draft.picks);
}

/** The home tavern for `week`: the one whose sponsor set its mission, or null (no sponsor, or no season). */
export function homeTavern(state: LeagueState, week: number): string | null {
  return sponsoredTavern(state.sponsors, state.schedule, week);
}

/**
 * One finalized week's results, one row per tavern in the locked lineup
 * list (join order): points, projected points and checks passed, read from
 * the recorded `mission.resolved` (D-20). A tavern locked with no lineup
 * scores 0 on every count (rules §5). Empty unless the week is finalized,
 * so standings never count a half-run week.
 */
export function weekResults(state: LeagueState, week: number): ReadonlyArray<WeekResult> {
  if (!state.finalizedWeeks.has(week)) return [];
  const locked = state.lockedLineups.get(week) ?? [];
  const results = state.results.get(week);
  const order = [...state.taverns.keys()];
  return [...locked]
    .sort((a, b) => order.indexOf(a.tavern) - order.indexOf(b.tavern))
    .map(({ tavern }) => {
      const r = results?.get(tavern);
      return r === undefined
        ? { week, tavern, points: 0, projected: 0, checksPassed: 0, dnf: false }
        : { week, tavern, points: r.points, projected: r.projectedPoints, checksPassed: r.run.checksPassed, dnf: r.run.dnf };
    });
}

/**
 * Season standings over every finalized week: total loot, equal totals
 * sharing a rank (rules §8). No playoffs. Once the season is complete, a tie
 * for first goes to fewer DNFs, and co-champions only if that is tied too
 * (D-14).
 */
export function seasonStandings(state: LeagueState): ReadonlyArray<StandingRow> {
  if (state.config === null) return [];
  const weeks = [...state.finalizedWeeks].sort((a, b) => a - b);
  return standings([...state.taverns.keys()], weeks.flatMap((week) => weekResults(state, week)), {
    breakFirstTie: state.phase === 'complete',
  });
}

/**
 * The waiver priority the next `waiver.resolved` uses, first = highest.
 * `rolling`: the stored order (reverse draft order, then winners move to the
 * back). `reverse_standings` (D-05): the standings over the finalized weeks,
 * reversed, ties to reverse draft order. Empty before the draft completes.
 */
export function waiverPriority(state: LeagueState): ReadonlyArray<string> {
  if (state.config?.waivers.priority !== 'reverse_standings' || !state.draft.complete) return state.waivers.priority;
  const weeks = [...state.finalizedWeeks];
  const rows = standings([...state.taverns.keys()], weeks.flatMap((week) => weekResults(state, week)));
  return reverseStandingsPriority(rows, state.draft.order);
}
