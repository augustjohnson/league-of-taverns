/**
 * Hexes (docs/decisions.md D-52): once a season, curse a rival for one week
 * with disadvantage on every check and save using one ability.
 *
 * `leader`: a deliberately plain heuristic, so the balance report can say
 * whether hexing the leader pays.
 * - Hold the hex until the second half of the season, then use it on the
 *   first week a rival leads you; spend it in the last week regardless, since
 *   an unused hex is lost.
 * - Target the highest rival on the table that isn't already hexed that week
 *   (only the first hex on a target counts).
 * - Name the ability whose checks pay the most loot in that week's mission
 *   (`wis` when the mission isn't known).
 */
import { ABILITIES, checkAbility, hexOn, seasonStandings, type Ability } from '@league-of-taverns/engine';
import type { PublicView } from '../types';
import { configOf } from '../view';

export interface HexStrategy {
  readonly id: string;
  /** The hex to declare for `week` before its lock, or null to hold it. Never called after the bot's hex is used. */
  declare(view: PublicView, week: number): { readonly target: string; readonly ability: Ability } | null;
}

export const leaderHex: HexStrategy = {
  id: 'leader',
  declare(view, week) {
    const config = configOf(view);
    const table = seasonStandings(view.state);
    const mine = table.find((row) => row.tavern === view.tavern)?.points ?? 0;
    const rivals = table.filter((row) => row.tavern !== view.tavern && hexOn(view.state, row.tavern, week) === undefined);
    const top = rivals[0];
    if (top === undefined) return null;
    const last = week >= config.weeks;
    if (!last && (week <= Math.ceil(config.weeks / 2) || top.points <= mine)) return null;
    return { target: top.tavern, ability: costliestAbility(view, week) };
  },
};

/** The ability whose checks carry the most loot in `week`'s mission; `wis` if no mission is known. Ties go to `ABILITIES` order. */
export function costliestAbility(view: PublicView, week: number): Ability {
  const mission = view.missionFor(week);
  if (mission === null) return 'wis';
  const loot = new Map<Ability, number>(ABILITIES.map((a) => [a, 0]));
  for (const node of mission.nodes) if (node.kind === 'check') loot.set(checkAbility(node.check), loot.get(checkAbility(node.check))! + node.loot);
  let best: Ability = ABILITIES[0];
  for (const a of ABILITIES) if (loot.get(a)! > loot.get(best)!) best = a;
  return best;
}
