/**
 * Projection: the exact expected score of a party on a mission, with no dice.
 *
 * Responsibilities:
 * - Forward-propagate probability through the layered DAG. The state per node
 *   is a distribution over loot banked so far, so the score distribution is
 *   exact (docs/decisions.md D-45, D-46).
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
import { missionHaul, topologicalOrder, type Mission, type MissionNode } from '../missions';
import { battleOdds, checkOdds, lootScore, missionGraph, type BattleModel, type Party } from '../resolution';

export interface Projection {
  readonly expectedScore: number;
  readonly pDnf: number;
  /** Probability of visiting each node. Every node is listed; unreachable ones are 0. */
  readonly reach: Readonly<Record<string, number>>;
  /**
   * Exact distribution of final score, as [score, probability] pairs summing
   * to 1, sorted by score. A DNF counts at the loot it banked. Runs that bank
   * the same loot are one entry. Only scores with positive probability appear.
   */
  readonly distribution: ReadonlyArray<readonly [number, number]>;
}

/**
 * Exact projection of `party` on `mission`, by forward propagation in
 * `topologicalOrder`.
 *
 * Each node holds the probability of arriving there with each amount of loot
 * banked. Start holds 0 with probability 1. A check sends `pPass` of its mass,
 * its `loot` richer, along its `pass` edge and the rest, unchanged, along
 * `fail` (both along `always` if that is its only edge). A battle sends `pWin`
 * along `win`, and the rest ends as a DNF, keeping its loot. End nodes collect
 * the rest. Odds come from `checkOdds` and `battleOdds`, exactly as in
 * `runMission`, so the mean of many runs converges to `expectedScore`.
 *
 * `expectedScore` is Σ P(loot) × `lootScore(loot, missionHaul(mission))` over
 * end nodes and DNFs. `reach` is the mass that arrives at each node, so end
 * reach plus `pDnf` is 1.
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

  /** Mass waiting at each node, keyed by loot banked. */
  const pending = new Map<string, Map<number, number>>();
  const send = (to: string, loot: number, prob: number): void => {
    if (prob <= 0) return;
    let states = pending.get(to);
    if (states === undefined) {
      states = new Map();
      pending.set(to, states);
    }
    addMass(states, loot, prob);
  };
  send(graph.start.id, 0, 1);

  const reach: Record<string, number> = {};
  const visited = new Set<string>();
  /** Final loot → probability, over end nodes and DNFs. */
  const finals = new Map<number, number>();
  let pDnf = 0;

  for (const id of topologicalOrder(mission)) {
    const node = byId.get(id);
    if (node === undefined || visited.has(id)) continue; // a duplicate id: the first node wins
    visited.add(id);
    const states = [...(pending.get(id) ?? [])];
    pending.delete(id);
    const mass = states.reduce((sum, [, prob]) => sum + prob, 0);
    reach[id] = mass;
    if (mass === 0) continue;

    switch (node.kind) {
      case 'start': {
        const to = graph.next(node, 'always').id;
        for (const [loot, prob] of states) send(to, loot, prob);
        break;
      }
      case 'check': {
        const { pPass } = checkOdds(party, node.check);
        const onPass = pPass > 0 ? graph.next(node, 'pass').id : undefined;
        const onFail = pPass < 1 ? graph.next(node, 'fail').id : undefined;
        for (const [loot, prob] of states) {
          if (onPass !== undefined) send(onPass, loot + node.loot, prob * pPass);
          if (onFail !== undefined) send(onFail, loot, prob * (1 - pPass));
        }
        break;
      }
      case 'battle': {
        const { pWin } = battleOdds(party, node.encounter, baseOf, model);
        const onWin = pWin > 0 ? graph.next(node, 'win').id : undefined;
        for (const [loot, prob] of states) {
          if (onWin !== undefined) send(onWin, loot, prob * pWin);
          const lost = prob * (1 - pWin);
          pDnf += lost;
          if (lost > 0) addMass(finals, loot, lost);
        }
        break;
      }
      case 'end':
        for (const [loot, prob] of states) addMass(finals, loot, prob);
        break;
    }
  }

  const haul = missionHaul(mission);
  let expectedScore = 0;
  for (const [loot, prob] of finals) expectedScore += prob * lootScore(loot, haul);
  const distribution = [...finals]
    .sort((a, b) => a[0] - b[0])
    .map(([loot, prob]) => [lootScore(loot, haul), prob] as const);

  return { expectedScore, pDnf, reach, distribution };
}

// ── internals ──────────────────────────────────────────────────────────────

function addMass(into: Map<number, number>, loot: number, prob: number): void {
  into.set(loot, (into.get(loot) ?? 0) + prob);
}
