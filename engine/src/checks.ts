/**
 * Check math: the chance a d20 check passes, and the modifier a character
 * brings to one (docs/decisions.md D-38). Shared by the contest's
 * challenges, the bots and the playground.
 */
import type { CheckTarget, EffectiveStats } from './characters';
import { SKILL_ABILITY, type Ability } from './vocabulary';

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

/** A character's modifier for a check: `skills[skill]`, `saves[ability]` or `abilityMods[ability]`. */
export function modifierFor(stats: EffectiveStats, check: CheckTarget): number {
  switch (check.type) {
    case 'skill':
      return stats.skills[check.skill];
    case 'save':
      return stats.saves[check.ability];
    case 'ability':
      return stats.abilityMods[check.ability];
  }
}
