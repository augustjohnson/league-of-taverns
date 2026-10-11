/**
 * Resolution: odds for one check or battle, and the single seeded run.
 *
 * Responsibilities:
 * - Check odds: `p = clamp((21 − (DC − mod)) / 20, 0, 1)`, with advantage as
 *   `1 − (1 − p)²` (docs/decisions.md D-38).
 * - Best-fit assignment: each check goes to the starter with the best pass
 *   chance for it, so advantage counts. That starter is `{actor}`. Ties go to
 *   the captain, then lineup order (D-15). A `requires` gate limits who may
 *   attempt; if nobody qualifies the check auto-fails (D-39).
 * - Battle odds: a black-box `p(win)` from party vs encounter, using an
 *   expected-value model (docs/specs/05). Swappable behind `BattleModel`.
 * - The weekly run: walk the DAG once with per-node dice. Each passed check
 *   banks its loot. Losing a battle ends the run (DNF) and keeps the loot
 *   banked so far. Score = loot banked ÷ the mission's haul (docs/decisions.md
 *   D-45, D-46).
 *
 * Projection (exact expectation) lives in ../projection. Both must use these
 * same odds functions so they agree by construction.
 */
import type { BaseStats } from '../adapters/open5e';
import { checkTargetKey, type EffectiveStats } from '../characters';
import { missionHaul, type CheckSpec, type Encounter, type Mission, type MissionNode, type Requirement } from '../missions';
import { rollD20, type Rng } from '../rng';

/**
 * The four starters for a week. The captain is one of them.
 *
 * `members` is in lineup order: the order the manager listed the starters
 * (captain included, wherever it sits). Best-fit ties use it after the
 * captain (docs/decisions.md D-15).
 */
export interface Party {
  /** `characterId` of the captain. Must match one of `members`. */
  readonly captain: string;
  /** The starters, in lineup order. */
  readonly members: ReadonlyArray<EffectiveStats>;
}

export interface CheckOdds {
  /** `characterId` of the starter who makes the check. */
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

/**
 * `clamp((21 − (dc − mod)) / 20, 0, 1)`: the chance that `d20 + mod ≥ dc` on
 * one d20 with no natural-20 rule. With advantage (roll twice, keep the
 * higher) it is `1 − (1 − p)²`.
 */
export function passChance(modifier: number, dc: number, advantage: boolean): number {
  const p = Math.min(1, Math.max(0, (21 - (dc - modifier)) / 20));
  return advantage ? 1 - (1 - p) * (1 - p) : p;
}

/**
 * Who makes `check` and with what odds.
 *
 * Each starter's modifier is `skills[skill]` for a skill check, `saves[ability]`
 * for a save, and `abilityMods[ability]` for an ability check. A starter has
 * advantage when `advantages` holds `checkTargetKey(check)`.
 *
 * The actor is the eligible starter with the highest `pPass` (so advantage
 * beats an equal modifier). Ties go to the captain, then to `members` in
 * lineup order (D-15). The captain has no other effect (D-12).
 *
 * A `requires` gate (D-39) limits eligibility to starters with that speed or
 * sense above 0 feet. If none qualifies the check auto-fails: `eligible` is
 * false and `pPass` is 0, and the actor is still chosen best-fit from every
 * starter, only so the story has someone to fail it.
 *
 * Throws if the party is empty or the captain is not one of its members.
 */
export function checkOdds(party: Party, check: CheckSpec): CheckOdds {
  const order = tiebreakOrder(party);
  const key = checkTargetKey(check);
  const requires = check.requires;
  const eligibleMembers = requires === undefined ? order : order.filter((m) => meets(m, requires));
  const eligible = eligibleMembers.length > 0;

  let best: CheckOdds | undefined;
  for (const member of eligible ? eligibleMembers : order) {
    const modifier = modifierFor(member, check);
    const advantage = member.advantages.has(key);
    const pPass = passChance(modifier, check.dc, advantage);
    // Strictly greater: on a tie the earlier member in tiebreak order keeps it.
    if (best === undefined || pPass > best.pPass) {
      best = { actor: member.characterId, modifier, advantage, eligible, pPass };
    }
  }
  if (best === undefined) throw new Error('checkOdds: the party has no members');
  return eligible ? best : { ...best, pPass: 0 };
}

/**
 * The party's odds in one battle: `model.pWin` over the encounter's creatures,
 * each as `{ stats: baseOf(ref), count }`, clamped to [0, 1]. Throws if the
 * model returns NaN.
 */
export function battleOdds(
  party: Party,
  encounter: Encounter,
  baseOf: (slug: string) => BaseStats,
  model: BattleModel,
): BattleOdds {
  const foes = encounter.creatures.map((creature) => ({ stats: baseOf(creature.ref), count: creature.count }));
  const p = model.pWin(party, foes);
  if (Number.isNaN(p)) throw new Error(`battleOdds: battle model "${model.id}" returned NaN`);
  return { pWin: Math.min(1, Math.max(0, p)) };
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
  /** Loot banked: the sum of `loot` over passed checks, DNF or not (D-45, D-46). */
  readonly loot: number;
  /** `lootScore(loot, missionHaul(mission))`: in [0, 1], and 1 on the best path. */
  readonly score: number;
}

/**
 * One traversal of `mission` by `party`, with dice from `rngForNode`.
 *
 * Starts at the start node and follows its `always` edge. At a check, with
 * `rng = rngForNode(node.id)`, the actor from `checkOdds` rolls
 * `d20 = rollD20(rng)`; with advantage a second d20 comes from the same stream
 * and the higher is kept. The check passes iff it is eligible and
 * `d20 + modifier ≥ dc`. There is no natural-20 rule, matching `passChance`.
 * An auto-failed (ineligible) check still draws and records its die. At a
 * battle, `roll = rngForNode(node.id)()` and the party wins iff
 * `roll < pWin` from `battleOdds`. Losing ends the run as a DNF.
 *
 * `path` lists every visited node, start and end included (on a DNF it ends at
 * the lost battle). Each passed check banks its `loot`, and a DNF keeps what
 * was banked. Score is `lootScore(loot, missionHaul(mission))`.
 *
 * `rngForNode` is a factory so each node's dice depend only on its id, never
 * on path order. Sims, tests and the difficulty report pass
 * `(id) => rngFor(weekSeed, 'roll:' + id)`. A live week (docs/decisions.md
 * D-13) may pass a factory backed by real randomness instead; its rolls are
 * then recorded in the event, since they cannot be recomputed.
 *
 * Throws on a mission whose shape breaks the walk: not exactly one start
 * node, a missing outgoing edge, or an edge to a node that does not exist or
 * is not at a higher rank.
 */
export function runMission(
  party: Party,
  mission: Mission,
  rngForNode: (nodeId: string) => Rng,
  baseOf: (slug: string) => BaseStats,
  model: BattleModel,
): RunResult {
  const graph = missionGraph(mission, 'runMission');
  const path: string[] = [];
  const nodes: NodeRecord[] = [];
  let checksPassed = 0;
  let checksAttempted = 0;
  let loot = 0;
  const haul = missionHaul(mission);

  let node: MissionNode | undefined = graph.start;
  while (node !== undefined) {
    path.push(node.id);
    switch (node.kind) {
      case 'start':
        node = graph.next(node, 'always');
        break;
      case 'check': {
        const odds = checkOdds(party, node.check);
        const rng = rngForNode(node.id);
        const first = rollD20(rng);
        const d20 = odds.advantage ? Math.max(first, rollD20(rng)) : first;
        const passed = odds.eligible && d20 + odds.modifier >= node.check.dc;
        nodes.push({
          node: node.id,
          kind: 'check',
          actor: odds.actor,
          d20,
          modifier: odds.modifier,
          dc: node.check.dc,
          advantage: odds.advantage,
          outcome: passed ? 'pass' : 'fail',
        });
        checksAttempted++;
        if (passed) {
          checksPassed++;
          loot += node.loot;
        }
        node = graph.next(node, passed ? 'pass' : 'fail');
        break;
      }
      case 'battle': {
        const { pWin } = battleOdds(party, node.encounter, baseOf, model);
        const roll = rngForNode(node.id)();
        const won = roll < pWin;
        nodes.push({ node: node.id, kind: 'battle', pWin, roll, outcome: won ? 'win' : 'lose' });
        if (!won) return { path, nodes, dnf: true, checksPassed, checksAttempted, loot, score: lootScore(loot, haul) };
        node = graph.next(node, 'win');
        break;
      }
      case 'end':
        node = undefined;
        break;
    }
  }
  return { path, nodes, dnf: false, checksPassed, checksAttempted, loot, score: lootScore(loot, haul) };
}

/**
 * A run's score: `loot / haul`, or 0 when the haul is 0. Shared with
 * projection, the reducers and replay.
 */
export function lootScore(loot: number, haul: number): number {
  return haul === 0 ? 0 : loot / haul;
}

/** A mission indexed for walking. Shared by `runMission` and `projectMission`. */
export interface MissionGraph {
  readonly start: MissionNode;
  /**
   * The node an outcome leads to. A check follows its `pass` or `fail` edge,
   * or else its `always` edge. Throws if there is no such edge, or it points
   * to a missing node or to a rank that is not higher.
   */
  next(from: MissionNode, on: 'always' | 'pass' | 'fail' | 'win'): MissionNode;
}

/** Index `mission` for walking. Throws unless it has exactly one start node. `caller` prefixes errors. */
export function missionGraph(mission: Mission, caller: string): MissionGraph {
  const byId = new Map<string, MissionNode>();
  for (const node of mission.nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const starts = mission.nodes.filter((node) => node.kind === 'start');
  const start = starts[0];
  if (start === undefined || starts.length !== 1) {
    throw new Error(`${caller}: mission "${mission.id}" needs exactly one start node, found ${starts.length}`);
  }
  return {
    start,
    next(from, on) {
      const out = mission.edges.filter((edge) => edge.from === from.id);
      // A check with a single `always` edge goes there whatever the outcome.
      const edge = out.find((e) => e.on === on) ?? (from.kind === 'check' ? out.find((e) => e.on === 'always') : undefined);
      if (edge === undefined) {
        throw new Error(`${caller}: ${from.kind} "${from.id}" in mission "${mission.id}" has no \`${on}\` edge`);
      }
      const to = byId.get(edge.to);
      if (to === undefined) throw new Error(`${caller}: edge ${from.id} → ${edge.to} points to a node that does not exist`);
      if (to.rank <= from.rank) {
        throw new Error(`${caller}: edge ${from.id} → ${to.id} does not go to a higher rank (${from.rank} → ${to.rank})`);
      }
      return to;
    },
  };
}

// ── internals ──────────────────────────────────────────────────────────────

/** Members in tiebreak order: the captain, then the rest in lineup order. */
function tiebreakOrder(party: Party): ReadonlyArray<EffectiveStats> {
  if (party.members.length === 0) throw new Error('checkOdds: the party has no members');
  const captain = party.members.find((m) => m.characterId === party.captain);
  if (captain === undefined) {
    throw new Error(`checkOdds: captain "${party.captain}" is not one of the party's members`);
  }
  return [captain, ...party.members.filter((m) => m !== captain)];
}

function modifierFor(member: EffectiveStats, check: CheckSpec): number {
  switch (check.type) {
    case 'skill':
      return member.skills[check.skill];
    case 'save':
      return member.saves[check.ability];
    case 'ability':
      return member.abilityMods[check.ability];
  }
}

function meets(member: EffectiveStats, requirement: Requirement): boolean {
  if ('speed' in requirement) return (member.speeds[requirement.speed] ?? 0) > 0;
  return (member.senses[requirement.sense] ?? 0) > 0;
}
