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
 * Missions are open (docs/decisions.md D-08), so managers can also compute
 * projections before the lock (D-42).
 */
import type { BaseStats } from '../adapters/open5e';
import { topologicalOrder, type Mission, type MissionNode } from '../missions';
import { battleOdds, checkOdds, missionGraph, runScore, type BattleModel, type Party } from '../resolution';

export interface Projection {
  readonly expectedScore: number;
  readonly pDnf: number;
  /** Probability of visiting each node. Every node is listed; unreachable ones are 0. */
  readonly reach: Readonly<Record<string, number>>;
  /**
   * Exact distribution of final score, as [score, probability] pairs summing
   * to 1, sorted by score. A DNF counts as score 0. Equal scores are merged by
   * reduced fraction (1/2 and 2/4 are one entry). Only scores with positive
   * probability appear.
   */
  readonly distribution: ReadonlyArray<readonly [number, number]>;
}

/**
 * Exact projection of `party` on `mission`, by forward propagation in
 * `topologicalOrder`.
 *
 * Each node holds the probability of arriving there with each
 * (checksPassed, checksAttempted) pair. Start holds (0, 0) with probability 1.
 * A check sends `pPass` of its mass, one pass and one attempt richer, along
 * its `pass` edge and the rest, one attempt richer, along `fail` (both along
 * `always` if that is its only edge). A battle sends `pWin` along `win`, and
 * the rest is DNF. End nodes collect the final pairs. Odds come from
 * `checkOdds` and `battleOdds`, exactly as in `runMission`, so the mean of
 * many runs converges to `expectedScore`.
 *
 * `expectedScore` is Σ P(pair) × passed / attempted over the end nodes; DNF
 * contributes 0. `reach` is the mass that arrives at each node, so end reach
 * plus `pDnf` is 1.
 *
 * Throws where `runMission` would, on a mission whose reachable part cannot
 * be walked.
 */
export function projectMission(
  party: Party,
  mission: Mission,
  baseOf: (slug: string) => BaseStats,
  model: BattleModel,
): Projection {
  const graph = missionGraph(mission, 'projectMission');
  const byId = new Map<string, MissionNode>();
  for (const node of mission.nodes) if (!byId.has(node.id)) byId.set(node.id, node);

  /** Mass waiting at each node, keyed by "passed/attempted". */
  const pending = new Map<string, Map<string, Tally>>();
  const send = (to: string, passed: number, attempted: number, prob: number): void => {
    if (prob <= 0) return;
    let states = pending.get(to);
    if (states === undefined) {
      states = new Map();
      pending.set(to, states);
    }
    addTally(states, passed, attempted, prob);
  };
  send(graph.start.id, 0, 0, 1);

  const reach: Record<string, number> = {};
  const visited = new Set<string>();
  const finals = new Map<string, Tally>();
  let pDnf = 0;

  for (const id of topologicalOrder(mission)) {
    const node = byId.get(id);
    if (node === undefined || visited.has(id)) continue; // a duplicate id: the first node wins
    visited.add(id);
    const states = [...(pending.get(id)?.values() ?? [])];
    pending.delete(id);
    const mass = states.reduce((sum, s) => sum + s.prob, 0);
    reach[id] = mass;
    if (mass === 0) continue;

    switch (node.kind) {
      case 'start': {
        const to = graph.next(node, 'always').id;
        for (const s of states) send(to, s.passed, s.attempted, s.prob);
        break;
      }
      case 'check': {
        const { pPass } = checkOdds(party, node.check);
        const onPass = pPass > 0 ? graph.next(node, 'pass').id : undefined;
        const onFail = pPass < 1 ? graph.next(node, 'fail').id : undefined;
        for (const s of states) {
          if (onPass !== undefined) send(onPass, s.passed + 1, s.attempted + 1, s.prob * pPass);
          if (onFail !== undefined) send(onFail, s.passed, s.attempted + 1, s.prob * (1 - pPass));
        }
        break;
      }
      case 'battle': {
        const { pWin } = battleOdds(party, node.encounter, baseOf, model);
        const onWin = pWin > 0 ? graph.next(node, 'win').id : undefined;
        for (const s of states) {
          if (onWin !== undefined) send(onWin, s.passed, s.attempted, s.prob * pWin);
          pDnf += s.prob * (1 - pWin);
        }
        break;
      }
      case 'end':
        for (const s of states) addTally(finals, s.passed, s.attempted, s.prob);
        break;
    }
  }

  let expectedScore = 0;
  /** Final score as a reduced fraction "n/d" → [n, d, probability]. */
  const scores = new Map<string, [number, number, number]>();
  const addScore = (n: number, d: number, prob: number): void => {
    const g = gcd(n, d);
    const key = `${n / g}/${d / g}`;
    const entry = scores.get(key);
    if (entry) entry[2] += prob;
    else scores.set(key, [n / g, d / g, prob]);
  };
  for (const s of finals.values()) {
    expectedScore += s.prob * runScore(s.passed, s.attempted);
    if (s.attempted === 0) addScore(0, 1, s.prob);
    else addScore(s.passed, s.attempted, s.prob);
  }
  if (pDnf > 0) addScore(0, 1, pDnf);

  const distribution = [...scores.values()]
    .sort((a, b) => a[0] * b[1] - b[0] * a[1])
    .map(([n, d, prob]) => [n / d, prob] as const);

  return { expectedScore, pDnf, reach, distribution };
}

// ── internals ──────────────────────────────────────────────────────────────

interface Tally {
  readonly passed: number;
  readonly attempted: number;
  prob: number;
}

function addTally(into: Map<string, Tally>, passed: number, attempted: number, prob: number): void {
  const key = `${passed}/${attempted}`;
  const tally = into.get(key);
  if (tally) tally.prob += prob;
  else into.set(key, { passed, attempted, prob });
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
