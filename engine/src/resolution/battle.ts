/**
 * Battle model v0, `ev-ttk-v0`: an expected-value time-to-kill comparison
 * squashed through a logistic (docs/specs/05 § Battle resolution, D-28).
 *
 * No dice and no rounds. Each side is reduced to two numbers, damage per
 * round (DPR) and effective HP (eHP), and the party's odds come from how many
 * rounds each side needs to grind the other down:
 *
 * ```
 * P(hit)     = clamp((21 − (targetAC − attackBonus)) / 20, 0.05, 0.95)
 * DPR        = Σ creatures × count Σ attacks perTurn × P(hit) × averageDamage
 * partyDPR  *= max(0, 1 + 0.05 × Σ members' battleBonus)
 * eHP        = Σ creatures × count  hp × nonmagicalFactor
 * TTK_party  = foeEHP / partyDPR        (rounds for the party to win)
 * TTK_foe    = partyEHP / foeDPR        (rounds for the foes to win)
 * p          = clamp(logistic(K × ln(TTK_foe / TTK_party)), 0.02, 0.98)
 * ```
 *
 * Choices, all v0 and up for revision in T9.3:
 * - **Target AC.** Each side attacks the other side's HP-weighted mean AC
 *   (weight = hp × count). A side spends most of its rounds hitting whatever
 *   holds most of the opposing HP, so a big armoured brute should count for
 *   more than a 1-HP bat beside it. Simple averaging would let swarms of
 *   low-AC chaff drag the target AC down.
 * - **Square law.** ln(TTK_foe / TTK_party) = ln(partyDPR × partyEHP) −
 *   ln(foeDPR × foeEHP), so strength is DPR × eHP. Doubling a side's numbers
 *   quadruples its strength, as in Lanchester's square law for aimed fire.
 * - **battleBonus** scales party DPR by +5% per point, summed over members
 *   (`BATTLE_BONUS_DPR_PER_POINT`). Every point is worth the same whoever
 *   carries it, so the modifier has one price. Applied to DPR, not to the
 *   logistic input, so its effect shrinks near the clamps like any other
 *   strength gain.
 * - **Damage types.** `AttackProfile` carries none, so typed resistances,
 *   immunities and vulnerabilities are ignored. One coarse exception: every
 *   creature here attacks with natural or mundane weapons, which are
 *   nonmagical, so a creature resistant or immune to "bludgeoning, piercing,
 *   and slashing from nonmagical attacks" gets its HP scaled by
 *   `NONMAGICAL_EHP_FACTOR` (1.25 resistant, 1.5 immune). Deliberately modest
 *   (true resistance would double eHP) because some attacks are spells or
 *   carry elemental riders. Applied to both sides alike.
 * - **K = 1.25.** Calibrated by sims/src/battle-calibration.ts: random legal
 *   parties (total CR 9–12) win about 0.89 on average against encounters of
 *   0.25× their total CR, 0.79 at 0.5×, 0.65 at 0.75×, 0.53 at 1.0× and 0.31
 *   at 1.5×. K = 1 gives 0.85 at 0.25×; K = 1.4 pins 13% of the 0.25× fights
 *   at the upper clamp.
 * - **Zero damage.** A side that deals no damage can't win: if the party's
 *   DPR is 0, p is the lower clamp. Otherwise if the foes' DPR is 0, or there
 *   is no foe HP to chew through, p is the upper clamp.
 *
 * Known undervaluation: only weapon and spell attacks are parsed, so breath
 * weapons, save-based actions, Spellcasting, legendary actions and auras
 * count for nothing. Casters (mage, archmage, lich, priest, druid) and
 * poison-rider creatures look far weaker than their CR.
 */
import type { BaseStats } from '../adapters/open5e';
import type { BattleModel, Party } from './index';

type Foes = Parameters<BattleModel['pWin']>[1];

/** Logistic slope on ln(TTK_foe / TTK_party). */
export const EV_TTK_V0_K = 1.25;
/** Party DPR multiplier per point of summed `battleBonus`. */
export const BATTLE_BONUS_DPR_PER_POINT = 0.05;
/** eHP multipliers for resistance or immunity to nonmagical bludgeoning, piercing and slashing. */
export const NONMAGICAL_EHP_FACTOR = { resist: 1.25, immune: 1.5 } as const;
/** `pWin` is clamped to this range: no battle is ever certain. */
export const P_WIN_RANGE = { min: 0.02, max: 0.98 } as const;

/** Everything `ev-ttk-v0` computes on the way to `pWin`, for inspectors and calibration. */
export interface EvTtkBreakdown {
  readonly partyDpr: number;
  readonly foeDpr: number;
  readonly partyEhp: number;
  readonly foeEhp: number;
  /** AC the party attacks: the foes' HP-weighted mean AC. */
  readonly partyTargetAc: number;
  /** AC the foes attack: the party's HP-weighted mean AC. */
  readonly foeTargetAc: number;
  /** Rounds for the party to drop every foe. Infinity when the party deals no damage. */
  readonly ttkParty: number;
  /** Rounds for the foes to drop the party. Infinity when the foes deal no damage. */
  readonly ttkFoe: number;
  /** `K × ln(ttkFoe / ttkParty)` before squashing. ±Infinity in the zero-damage cases. */
  readonly logit: number;
  /** The clamped win probability. */
  readonly pWin: number;
}

/** P(an attack with `attackBonus` hits `ac`): a natural 1 always misses and a natural 20 always hits. */
export function attackHitChance(attackBonus: number, ac: number): number {
  return clamp((21 - (ac - attackBonus)) / 20, 0.05, 0.95);
}

/** Every intermediate of `ev-ttk-v0` for one party against one encounter. Pure. */
export function evTtkBreakdown(party: Party, foes: Foes): EvTtkBreakdown {
  for (const foe of foes) {
    if (!Number.isInteger(foe.count) || foe.count < 0) {
      throw new RangeError(`${foe.stats.slug}: count ${foe.count} must be a non-negative integer`);
    }
  }
  const partySide: ReadonlyArray<Combatant> = party.members.map((m) => ({ stats: m.base, count: 1 }));
  const foeSide: ReadonlyArray<Combatant> = foes;

  const partyTargetAc = weightedAc(foeSide);
  const foeTargetAc = weightedAc(partySide);
  const battleBonus = party.members.reduce((sum, m) => sum + m.battleBonus, 0);
  const partyDpr = sideDpr(partySide, partyTargetAc) * Math.max(0, 1 + BATTLE_BONUS_DPR_PER_POINT * battleBonus);
  const foeDpr = sideDpr(foeSide, foeTargetAc);
  const partyEhp = sideEhp(partySide);
  const foeEhp = sideEhp(foeSide);

  const ttkParty = foeEhp === 0 ? 0 : partyDpr === 0 ? Infinity : foeEhp / partyDpr;
  const ttkFoe = partyEhp === 0 ? 0 : foeDpr === 0 ? Infinity : partyEhp / foeDpr;

  let logit: number;
  if (partyDpr === 0 && foeEhp > 0) logit = -Infinity;
  else if (foeDpr === 0 || foeEhp === 0) logit = Infinity;
  else if (partyEhp === 0) logit = -Infinity;
  else logit = EV_TTK_V0_K * Math.log(ttkFoe / ttkParty);

  const pWin = clamp(1 / (1 + Math.exp(-logit)), P_WIN_RANGE.min, P_WIN_RANGE.max);
  return { partyDpr, foeDpr, partyEhp, foeEhp, partyTargetAc, foeTargetAc, ttkParty, ttkFoe, logit, pWin };
}

/** Battle model v0: expected-value time-to-kill, logistic-squashed. See the module comment. */
export const evTtkV0: BattleModel = {
  id: 'ev-ttk-v0',
  pWin: (party, foes) => evTtkBreakdown(party, foes).pWin,
};

/** Battle models by id. A mission run records which one it used. */
export const BATTLE_MODELS: Readonly<Record<string, BattleModel>> = {
  [evTtkV0.id]: evTtkV0,
};

// ── internals ──────────────────────────────────────────────────────────────

interface Combatant {
  readonly stats: BaseStats;
  readonly count: number;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Mean AC weighted by hp × count. 10 for a side with no HP (it is never attacked anyway). */
function weightedAc(side: ReadonlyArray<Combatant>): number {
  let hp = 0;
  let acHp = 0;
  for (const { stats, count } of side) {
    hp += stats.hp * count;
    acHp += stats.ac * stats.hp * count;
  }
  return hp > 0 ? acHp / hp : 10;
}

/** Expected damage per round against `targetAc`, per the `AttackProfile.perTurn` contract. */
function sideDpr(side: ReadonlyArray<Combatant>, targetAc: number): number {
  let dpr = 0;
  for (const { stats, count } of side) {
    for (const attack of stats.attacks) {
      dpr += count * attack.perTurn * attackHitChance(attack.attackBonus, targetAc) * attack.averageDamage;
    }
  }
  return dpr;
}

function sideEhp(side: ReadonlyArray<Combatant>): number {
  return side.reduce((sum, { stats, count }) => sum + stats.hp * count * nonmagicalFactor(stats), 0);
}

/** `NONMAGICAL_EHP_FACTOR` for a creature resistant or immune to nonmagical weapon damage, else 1. */
function nonmagicalFactor(stats: BaseStats): number {
  const covers = (token: string): boolean => token.includes('nonmagical') && /bludgeoning|piercing|slashing/.test(token);
  if (stats.damage.immune.some(covers)) return NONMAGICAL_EHP_FACTOR.immune;
  if (stats.damage.resist.some(covers)) return NONMAGICAL_EHP_FACTOR.resist;
  return 1;
}
