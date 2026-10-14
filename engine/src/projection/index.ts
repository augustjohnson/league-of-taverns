/**
 * Projection: the exact expected score of a party on a mission, with no dice.
 *
 * Responsibilities:
 * - Forward-propagate probability through the layered DAG. The state per node
 *   is a distribution over loot banked so far, so the score distribution is
 *   exact (docs/decisions.md D-45, D-46), and so is a retreat order, which
 *   depends only on the loot banked (D-49).
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
import { battleOdds, checkOdds, lootScore, missionGraph, type BattleModel, type Party, type RunOptions } from '../resolution';
import { DEFAULT_RETREAT, retreatsBeforeBattle } from '../roster';

export interface Projection {
  readonly expectedScore: number;
  readonly pDnf: number;
  /** Probability of turning back before a battle by the retreat order (D-49). Not a DNF. */
  readonly pRetreat: number;
  /**
   * Probability of visiting each node. Every node is listed; unreachable ones
   * are 0. A party that turns back before a battle does not visit it.
   */
  readonly reach: Readonly<Record<string, number>>;
  /**
   * Exact distribution of final score, as [score, probability] pairs summing
   * to 1, sorted by score. A DNF or a retreat counts at the loot it banked.
   * Runs that bank the same loot are one entry. Only scores with positive
   * probability appear.
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
 * `fail` (both along `always` if that is its only edge). At a battle, mass
 * whose loot makes `options.retreat` turn back ends there, keeping its loot
 * (D-49). The rest fights: `pWin` of it goes along `win`, the battle's `loot`
 * richer (D-50), and the remainder ends as a DNF, keeping its loot. End nodes
 * collect the rest. Odds come from `checkOdds` and `battleOdds`, exactly as in
 * `runMission`, so the mean of many runs converges to `expectedScore`.
 *
 * `expectedScore` is Σ P(loot) × `lootScore(loot, missionHaul(mission))` over
 * end nodes, retreats and DNFs. `reach` is the mass that visits each node, so
 * end reach plus `pDnf` plus `pRetreat` is 1.
 *
 * Throws where `runMission` would, on a mission whose reachable part cannot
 * be walked.
 */
export function projectMission(
  party: Party,
  mission: Mission,
  baseOf: (slug: string) => BaseStats,
  model: BattleModel,
  options: RunOptions = {},
): Projection {
  const retreat = options.retreat ?? DEFAULT_RETREAT;
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
  let pRetreat = 0;

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
        // A party that turns back never visits the battle, so it leaves reach here.
        const fighting: Array<readonly [number, number]> = [];
        for (const [loot, prob] of states) {
          if (!retreatsBeforeBattle(retreat, loot)) fighting.push([loot, prob]);
          else {
            pRetreat += prob;
            addMass(finals, loot, prob);
          }
        }
        reach[id] = fighting.reduce((sum, [, prob]) => sum + prob, 0);
        if (fighting.length === 0) break;
        const { pWin } = battleOdds(party, node.encounter, baseOf, model);
        const onWin = pWin > 0 ? graph.next(node, 'win').id : undefined;
        const bounty = node.loot ?? 0;
        for (const [loot, prob] of fighting) {
          if (onWin !== undefined) send(onWin, loot + bounty, prob * pWin);
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

  return { expectedScore, pDnf, pRetreat, reach, distribution };
}

// ── internals ──────────────────────────────────────────────────────────────

function addMass(into: Map<number, number>, loot: number, prob: number): void {
  into.set(loot, (into.get(loot) ?? 0) + prob);
}
