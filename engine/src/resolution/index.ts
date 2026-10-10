/**
 * Resolution: odds for one check or battle, and the single seeded run.
 *
 * Responsibilities:
 * - Check odds: `p = clamp((21 − (DC − mod)) / 20, 0, 1)`, with advantage as
 *   `1 − (1 − p)²`.
 * - Best-fit assignment: each check goes to the starter with the highest
 *   modifier for it. That starter is `{actor}`. Ties break deterministically
 *   (docs/decisions.md D-15).
 * - Battle odds: a black-box `p(win)` from party vs encounter, using an
 *   expected-value model (docs/specs/05). Swappable behind `BattleModel`.
 * - The weekly run: walk the DAG once with dice from
 *   `rngFor(weekSeed, 'roll:' + nodeId)`. Losing any battle is a DNF and
 *   scores 0. Otherwise score = checks passed / checks attempted on the path.
 *
 * Projection (exact expectation) lives in ../projection. Both must use these
 * same odds functions so they agree by construction.
 */
import type { BaseStats } from '../adapters/open5e';
import type { EffectiveStats } from '../characters';
import type { CheckSpec, Encounter, Mission } from '../missions';
import type { Rng } from '../rng';
import { notImplemented } from '../internal/not-implemented';

/** The four starters for a week. The captain is one of them. */
export interface Party {
  readonly captain: string;
  readonly members: ReadonlyArray<EffectiveStats>;
}

export interface CheckOdds {
  readonly actor: string;
  readonly modifier: number;
  readonly advantage: boolean;
  /** False when a `requires` gate is unmet and the check auto-fails. */
  readonly eligible: boolean;
  readonly pPass: number;
}

export interface BattleOdds {
  readonly pWin: number;
}

/** A pluggable battle model. v0 is an expected-value time-to-kill comparison. */
export interface BattleModel {
  readonly id: string;
  pWin(party: Party, foes: ReadonlyArray<{ readonly stats: BaseStats; readonly count: number }>): number;
}

export function checkOdds(_party: Party, _check: CheckSpec): CheckOdds {
  return notImplemented('checkOdds', 'T6.1');
}

export function battleOdds(
  _party: Party,
  _encounter: Encounter,
  _baseOf: (slug: string) => BaseStats,
  _model: BattleModel,
): BattleOdds {
  return notImplemented('battleOdds', 'T6.2');
}

/** What happened at one node in the seeded run. Recorded verbatim in `mission.resolved`. */
export type NodeRecord =
  | { readonly node: string; readonly kind: 'check'; readonly actor: string; readonly d20: number; readonly modifier: number; readonly dc: number; readonly advantage: boolean; readonly outcome: 'pass' | 'fail' }
  | { readonly node: string; readonly kind: 'battle'; readonly pWin: number; readonly roll: number; readonly outcome: 'win' | 'lose' };

export interface RunResult {
  readonly path: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<NodeRecord>;
  readonly dnf: boolean;
  readonly checksPassed: number;
  readonly checksAttempted: number;
  /** 0 on DNF, else checksPassed / checksAttempted. */
  readonly score: number;
}

/**
 * One seeded traversal. `rngForNode(nodeId)` must return
 * `rngFor(weekSeed, 'roll:' + nodeId)`. Passing a factory keeps dice per node
 * independent of path order.
 */
export function runMission(
  _party: Party,
  _mission: Mission,
  _rngForNode: (nodeId: string) => Rng,
  _baseOf: (slug: string) => BaseStats,
  _model: BattleModel,
): RunResult {
  return notImplemented('runMission', 'T6.3');
}
