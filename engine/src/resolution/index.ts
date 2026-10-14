/**
 * Resolution: odds for one check or battle, and the single seeded run.
 *
 * Responsibilities:
 * - Check odds: `p = clamp((21 − (DC − mod)) / 20, 0, 1)`, with advantage as
 *   `1 − (1 − p)²` (docs/decisions.md D-38).
 * - Best-fit assignment: each check goes to the starter with the best pass
 *   chance for it, so advantage counts. That starter is `{actor}`. Ties go by
 *   lineup order (D-15; there is no captain, D-12). A `requires` gate
 *   limits who may attempt; if nobody qualifies the check auto-fails (D-39).
 * - Battle odds: a black-box `p(win)` from party vs encounter, using an
 *   expected-value model (docs/specs/05). Swappable behind `BattleModel`.
 * - The weekly run: walk the DAG once with per-node dice. Each passed check
 *   banks its loot, and so does each battle won (D-50). Losing a battle ends
 *   the run (DNF) and keeps the loot banked so far. Just before each battle
 *   the lineup's retreat order may turn the party back, keeping its loot
 *   without a DNF (D-49). A DNF injures one starter, picked by a recorded
 *   roll (D-51). Score = loot banked ÷ the mission's haul (docs/decisions.md
 *   D-45, D-46).
 *
 * Projection (exact expectation) lives in ../projection. Both must use these
 * same odds functions so they agree by construction.
 */
import type { BaseStats } from '../adapters/open5e';
import { checkTargetKey, type CheckTarget, type EffectiveStats } from '../characters';
import { SKILL_ABILITY, type Ability } from '../vocabulary';
import { missionHaul, type CheckSpec, type Encounter, type Mission, type MissionNode, type Requirement } from '../missions';
import { rollD20, type Rng } from '../rng';
import { DEFAULT_RETREAT, retreatsBeforeBattle, type RetreatOrder } from '../roster';

/**
 * The four starters for a week, in lineup order: the order the manager listed
 * them. Best-fit ties use that order (docs/decisions.md D-15). There is no
 * captain (D-12).
 */
export interface Party {
  /** The starters, in lineup order. */
  readonly members: ReadonlyArray<EffectiveStats>;
  /**
   * The ability a rival's hex names for this week, if any (D-52): the party
   * has disadvantage on every check and save that uses it, which cancels
   * advantage. Battles are unaffected.
   */
  readonly hex?: Ability;
}

export interface CheckOdds {
  /** `characterId` of the starter who makes the check. */
  readonly actor: string;
  readonly modifier: number;
  readonly advantage: boolean;
  /** Disadvantage from a hex (D-52). Never true together with `advantage`: the two cancel. */
  readonly disadvantage: boolean;
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
 * higher) it is `1 − (1 − p)²`, and with disadvantage (keep the lower) `p²`.
 * Both at once cancel, as in 5e.
 */
export function passChance(modifier: number, dc: number, advantage: boolean, disadvantage = false): number {
  const p = Math.min(1, Math.max(0, (21 - (dc - modifier)) / 20));
  if (advantage === disadvantage) return p;
  return advantage ? 1 - (1 - p) * (1 - p) : p * p;
}

/** The ability a check uses: a skill's ability (`SKILL_ABILITY`), or the save's or ability check's own. */
export function checkAbility(check: CheckTarget): Ability {
  return check.type === 'skill' ? SKILL_ABILITY[check.skill] : check.ability;
}

/**
 * Who makes `check` and with what odds.
 *
 * Each starter's modifier is `skills[skill]` for a skill check, `saves[ability]`
 * for a save, and `abilityMods[ability]` for an ability check. A starter has
 * advantage when `advantages` holds `checkTargetKey(check)`. When the party
 * is hexed on `checkAbility(check)`, every starter has disadvantage, which
 * cancels a starter's advantage (D-52).
 *
 * The actor is the eligible starter with the highest `pPass` (so advantage
 * beats an equal modifier). Ties go to the earliest of `members`, in lineup
 * order (D-15).
 *
 * A `requires` gate (D-39) limits eligibility to starters with that speed or
 * sense above 0 feet. If none qualifies the check auto-fails: `eligible` is
 * false and `pPass` is 0, and the actor is still chosen best-fit from every
 * starter, only so the story has someone to fail it.
 *
 * Throws if the party is empty.
 */
export function checkOdds(party: Party, check: CheckSpec): CheckOdds {
  const order = party.members;
  const key = checkTargetKey(check);
  const hexed = party.hex !== undefined && checkAbility(check) === party.hex;
  const requires = check.requires;
  const eligibleMembers = requires === undefined ? order : order.filter((m) => meets(m, requires));
  const eligible = eligibleMembers.length > 0;

  let best: CheckOdds | undefined;
  for (const member of eligible ? eligibleMembers : order) {
    const modifier = modifierFor(member, check);
    const has = member.advantages.has(key);
    const advantage = has && !hexed;
    const disadvantage = hexed && !has;
    const pPass = passChance(modifier, check.dc, advantage, disadvantage);
    // Strictly greater: on a tie the earlier member in tiebreak order keeps it.
    if (best === undefined || pPass > best.pPass) {
      best = { actor: member.characterId, modifier, advantage, disadvantage, eligible, pPass };
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
  | { readonly node: string; readonly kind: 'check'; readonly actor: string; readonly d20: number; readonly modifier: number; readonly dc: number; readonly advantage: boolean; readonly disadvantage: boolean; readonly outcome: 'pass' | 'fail' }
  | { readonly node: string; readonly kind: 'battle'; readonly pWin: number; readonly roll: number; readonly outcome: 'win' | 'lose' };

export interface RunResult {
  readonly path: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<NodeRecord>;
  readonly dnf: boolean;
  /**
   * The battle the party turned back before, by its retreat order (D-49), or
   * null if it never turned back. The battle is not on `path`. A retreat is
   * not a DNF.
   */
  readonly retreatedBefore: string | null;
  readonly checksPassed: number;
  readonly checksAttempted: number;
  /** Loot banked: the `loot` of every passed check and won battle, DNF or not (D-45, D-46, D-50). */
  readonly loot: number;
  /** `lootScore(loot, missionHaul(mission))`: in [0, 1], and 1 on the best path. */
  readonly score: number;
  /**
   * On a DNF, the starter who is hurt and can't start next week, and the roll
   * in [0, 1) that picked them: `members[floor(roll × members.length)]` in
   * lineup order (D-51). Null when there was no DNF, or injuries are off.
   */
  readonly injury: { readonly character: string; readonly roll: number } | null;
}

/** The die stream for the injury roll after losing `battleId`. The colon keeps it apart from every node id. */
export function injuryStream(battleId: string): string {
  return `injury:${battleId}`;
}

/** The starter an injury roll picks: `members[floor(roll × n)]`, in lineup order (D-51). */
export function injuredStarter<T>(members: ReadonlyArray<T>, roll: number): T {
  const member = members[Math.min(members.length - 1, Math.floor(roll * members.length))];
  if (member === undefined) throw new Error('injuredStarter: the party has no members');
  return member;
}

/** The lineup's orders for one run. */
export interface RunOptions {
  /** When the party turns back instead of fighting (D-49). Defaults to `never`. */
  readonly retreat?: RetreatOrder;
  /** Whether a DNF injures a starter (D-51). Defaults to true. */
  readonly injuries?: boolean;
}

/**
 * One traversal of `mission` by `party`, with dice from `rngForNode`.
 *
 * Starts at the start node and follows its `always` edge. At a check, with
 * `rng = rngForNode(node.id)`, the actor from `checkOdds` rolls
 * `d20 = rollD20(rng)`; with advantage (or disadvantage, from a hex) a second
 * d20 comes from the same stream and the higher (lower) is kept. The check
 * passes iff it is eligible and `d20 + modifier ≥ dc`. There is no natural-20
 * rule, matching `passChance`.
 * An auto-failed (ineligible) check still draws and records its die. At a
 * battle, `roll = rngForNode(node.id)()` and the party wins iff
 * `roll < pWin` from `battleOdds`. Losing ends the run as a DNF, and winning
 * banks the battle's `loot`, if any (D-50).
 *
 * Before a battle, `options.retreat` is checked against the loot banked so
 * far (`retreatsBeforeBattle`). If it says to turn back, the run ends there:
 * `retreatedBefore` names the battle, no die is drawn for it, and it is not a
 * DNF (D-49).
 *
 * On a DNF, one more draw, `rngForNode(injuryStream(battle.id))()`, picks the
 * injured starter with `injuredStarter`, unless `options.injuries` is false
 * (D-51).
 *
 * `path` lists every visited node, start and end included (on a DNF it ends at
 * the lost battle; on a retreat, at the node before the battle). Each passed
 * check banks its `loot`, and a DNF keeps what was banked. Score is
 * `lootScore(loot, missionHaul(mission))`.
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
  options: RunOptions = {},
): RunResult {
  const retreat = options.retreat ?? DEFAULT_RETREAT;
  const graph = missionGraph(mission, 'runMission');
  const path: string[] = [];
  const nodes: NodeRecord[] = [];
  let checksPassed = 0;
  let checksAttempted = 0;
  let loot = 0;
  const haul = missionHaul(mission);

  const result = (dnf: boolean, retreatedBefore: string | null, injury: RunResult['injury'] = null): RunResult => ({
    path,
    nodes,
    dnf,
    retreatedBefore,
    checksPassed,
    checksAttempted,
    loot,
    score: lootScore(loot, haul),
    injury,
  });

  let node: MissionNode | undefined = graph.start;
  while (node !== undefined) {
    if (node.kind === 'battle' && retreatsBeforeBattle(retreat, loot)) return result(false, node.id);
    path.push(node.id);
    switch (node.kind) {
      case 'start':
        node = graph.next(node, 'always');
        break;
      case 'check': {
        const odds = checkOdds(party, node.check);
        const rng = rngForNode(node.id);
        const first = rollD20(rng);
        const d20 = odds.advantage ? Math.max(first, rollD20(rng)) : odds.disadvantage ? Math.min(first, rollD20(rng)) : first;
        const passed = odds.eligible && d20 + odds.modifier >= node.check.dc;
        nodes.push({
          node: node.id,
          kind: 'check',
          actor: odds.actor,
          d20,
          modifier: odds.modifier,
          dc: node.check.dc,
          advantage: odds.advantage,
          disadvantage: odds.disadvantage,
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
        if (!won) {
          if (options.injuries === false) return result(true, null);
          const injuryRoll = rngForNode(injuryStream(node.id))();
          return result(true, null, { character: injuredStarter(party.members, injuryRoll).characterId, roll: injuryRoll });
        }
        loot += node.loot ?? 0;
        node = graph.next(node, 'win');
        break;
      }
      case 'end':
        node = undefined;
        break;
    }
  }
  return result(false, null);
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
