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
 * - The weekly run: walk the DAG once with per-node dice. Losing any battle is
 *   a DNF and scores 0. Otherwise score = checks passed / checks attempted on
 *   the path.
 *
 * Projection (exact expectation) lives in ../projection. Both must use these
 * same odds functions so they agree by construction.
 */
import type { BaseStats } from '../adapters/open5e';
import { checkTargetKey, type EffectiveStats } from '../characters';
import type { CheckSpec, Encounter, Mission, Requirement } from '../missions';
import type { Rng } from '../rng';
import { notImplemented } from '../internal/not-implemented';

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
