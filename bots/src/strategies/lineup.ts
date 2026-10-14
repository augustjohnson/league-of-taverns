/**
 * Lineup strategies. Each enumerates every legal 4-subset of the roster (35
 * at most for 7 characters) and keeps the best under one objective. Every
 * lineup returned passes `validateLineup` by construction, and `lineup`
 * re-checks it anyway. Last week's injured never start (D-51).
 *
 * There is no captain (docs/decisions.md D-12), and lineup order only breaks
 * ties between equal pass chances, which leaves every pass chance unchanged.
 * So each subset is scored once, in roster order.
 */
import { hexOn, projectMission, type EffectiveStats, type Party } from '@league-of-taverns/engine';
import { checkFit, fitWeights } from '../environment';
import { referenceFoe } from '../metrics';
import type { LineupStrategy, PublicView, ScoredLineup } from '../types';
import { assertLegal, configOf, legalSubsets, lineupFrom, rosterOf, startable, type Subset } from '../view';

/** Scores closer than this are equal, so float noise never decides a lineup. */
const EPS = 1e-12;

/** The subset as a party for `week`, under any hex a rival has put on this tavern that week (D-52). */
function partyOf(view: PublicView, subset: Subset, week: number): Party {
  const members: EffectiveStats[] = subset.ids.map((id) => view.statsOf(id));
  const hex = hexOn(view.state, view.tavern, week);
  return hex === undefined ? { members } : { members, hex };
}

/** Wraps `best` into the `LineupStrategy` contract for the bot's own roster. */
function strategy(id: string, best: LineupStrategy['best']): LineupStrategy {
  return {
    id,
    best,
    lineup(view, week) {
      const chosen = best(view, rosterOf(view), week);
      return chosen === null ? null : assertLegal(view, chosen.lineup, id, week);
    },
  };
}

/**
 * The legal subset with the highest total CR, ties to the earliest in roster
 * order. Score: total CR in eighths.
 */
function bestByCr(view: PublicView, roster: ReadonlyArray<string>, week: number): ScoredLineup | null {
  let best: Subset | null = null;
  for (const subset of legalSubsets(view, startable(view, roster, week))) if (best === null || subset.total > best.total) best = subset;
  return best === null ? null : { lineup: lineupFrom(best), score: best.total };
}

/** `max-cr`: spend the most CR possible under B. */
export const maxCrLineup: LineupStrategy = strategy('max-cr', (view, roster, week) => bestByCr(view, roster, week));

/**
 * `projection`: with the week's mission known (open missions, D-08/D-42),
 * the legal subset with the highest exact `projectMission` expected score.
 * Ties go to the lower P(DNF), then the higher total CR, then roster order.
 * Score: expected score in [0, 1]. Without a mission it is `max-cr`, scored
 * as `max-cr` scores.
 */
export const projectionLineup: LineupStrategy = strategy('projection', (view, roster, week) => {
  const mission = view.missionFor(week);
  if (mission === null) return bestByCr(view, roster, week);
  let best: { subset: Subset; expected: number; pDnf: number } | null = null;
  for (const subset of legalSubsets(view, startable(view, roster, week))) {
    const { expectedScore: expected, pDnf } = projectMission(partyOf(view, subset, week), mission, view.baseOf, view.battleModel);
    const better =
      best === null ||
      expected > best.expected + EPS ||
      (expected > best.expected - EPS &&
        (pDnf < best.pDnf - EPS || (pDnf < best.pDnf + EPS && subset.total > best.subset.total)));
    if (better) best = { subset, expected, pDnf };
  }
  return best === null ? null : { lineup: lineupFrom(best.subset), score: best.expected };
});

/** The reference encounter's CR as a fraction of B. */
export const ENVIRONMENT_FOE_RATIO = 0.75;

/**
 * `environment-fit`: for when no mission is known. Scores a subset as
 * P(win) against a reference foe of 0.75 × B (from `view.battleModel`) times
 * its `checkFit` for the week's environment and theme: roughly "survive a
 * battle, then pass the checks this kind of week tends to set". Ties go to
 * the higher total CR, then roster order.
 */
export const environmentFitLineup: LineupStrategy = strategy('environment-fit', (view, roster, week) => {
  const weights = fitWeights(view.schedule.find((entry) => entry.week === week));
  const foes = [{ stats: referenceFoe(Math.round(ENVIRONMENT_FOE_RATIO * configOf(view).budget.partyCr)), count: 1 }];
  let best: { subset: Subset; score: number } | null = null;
  for (const subset of legalSubsets(view, startable(view, roster, week))) {
    const party = partyOf(view, subset, week);
    const score = view.battleModel.pWin(party, foes) * checkFit(party.members, weights);
    if (best === null || score > best.score + EPS || (score > best.score - EPS && subset.total > best.subset.total)) {
      best = { subset, score };
    }
  }
  return best === null ? null : { lineup: lineupFrom(best.subset), score: best.score };
});

export const LINEUP_STRATEGIES = {
  'max-cr': maxCrLineup,
  projection: projectionLineup,
  'environment-fit': environmentFitLineup,
} as const satisfies Record<string, LineupStrategy>;
