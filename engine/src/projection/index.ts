/**
 * Projection: the exact expected score of a party on a mission, with no dice.
 *
 * Responsibilities:
 * - Forward-propagate probability through the layered DAG. The state per node
 *   is a distribution over (checksPassed, checksAttempted), so the expectation
 *   of the ratio is exact, not a ratio of expectations.
 * - Return the expected score, P(DNF), P(reaching each node), and the full
 *   score distribution. The difficulty report and the bots consume these.
 * - Use the same `checkOdds` / `battleOdds` as resolution. A property test
 *   (T6.5) asserts the propagated mean matches the mean of many seeded runs.
 *
 * Projected points are published alongside actual points after the run.
 * Missions are hidden before then, so managers never see projections pre-lock.
 */
import type { BaseStats } from '../adapters/open5e';
import type { Mission } from '../missions';
import type { BattleModel, Party } from '../resolution';
import { notImplemented } from '../internal/not-implemented';

export interface Projection {
  readonly expectedScore: number;
  readonly pDnf: number;
  /** Probability of visiting each node. */
  readonly reach: Readonly<Record<string, number>>;
  /** Exact distribution of final score, as [score, probability] pairs summing to 1. */
  readonly distribution: ReadonlyArray<readonly [number, number]>;
}

export function projectMission(
  _party: Party,
  _mission: Mission,
  _baseOf: (slug: string) => BaseStats,
  _model: BattleModel,
): Projection {
  return notImplemented('projectMission', 'T6.4');
}
