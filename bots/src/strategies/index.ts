/**
 * Named strategy presets. Each is a deliberately simple, legible heuristic so
 * the balance report can say which *idea* dominates, not which tuned blob.
 *
 * Draft (./draft.ts):
 * - `random`: seeded uniform pick. The baseline every other strategy must beat.
 * - `cr-greedy`: highest CR available, ties by id.
 * - `skill-coverage`: maximise the number of skills where the roster has the
 *   pool's best or second-best modifier.
 * - `value`: best (battle strength + skill breadth) per CR.
 * Every draft strategy skips picks that would leave the roster unable to
 * start four characters under B.
 *
 * Lineup (./lineup.ts):
 * - `max-cr`: spend the most CR possible under B.
 * - `projection`: maximise the exact projected score on the week's open
 *   mission (D-08, D-42), else `max-cr`.
 * - `environment-fit`: weight skills by the public schedule's environment and
 *   theme, for when no mission is known.
 *
 * Waivers (./waivers.ts):
 * - `best-available`: claim the free agent that most improves the lineup
 *   strategy's own score for next week, dropping the worst bench player.
 *
 * Tavern pick (./tavern.ts):
 * - `random`: a seeded uniform choice among the open taverns (D-52), until
 *   boons give taverns something to choose between.
 *
 * Hex (./hex.ts):
 * - `leader`: in the second half, hex the highest rival who leads you, on
 *   the ability with the most loot in that week's mission; in the last week
 *   regardless (D-52).
 *
 * Every strategy is deterministic given the view: all randomness comes from
 * `view.rng`, never `Math.random`.
 */
import type { BotManager } from '../types';
import { DRAFT_STRATEGIES } from './draft';
import { LINEUP_STRATEGIES } from './lineup';
import { leaderHex } from './hex';
import { randomTavern } from './tavern';
import { bestAvailable } from './waivers';

export { DRAFT_STRATEGIES, crGreedyDraft, keepsLineupPossible, randomDraft, skillCoverageDraft, valueDraft } from './draft';
export { ENVIRONMENT_FOE_RATIO, LINEUP_STRATEGIES, environmentFitLineup, maxCrLineup, projectionLineup } from './lineup';
export { MAX_FALLBACK_CLAIMS, bestAvailable } from './waivers';
export { randomTavern } from './tavern';
export { costliestAbility, leaderHex } from './hex';
export type { HexStrategy } from './hex';
export type { TavernStrategy } from './tavern';

/**
 * Bot managers. The first four pair a draft idea with the `projection`
 * lineup and `best-available` waivers. `projection-off` is the `value` draft
 * with the `max-cr` lineup (and waivers scored by it), so the balance report
 * can measure what reading the open mission is worth.
 */
export const BOT_IDS = ['random', 'cr-greedy', 'skill-coverage', 'value', 'projection-off'] as const;
export type BotId = (typeof BOT_IDS)[number];

function manager(id: BotId, draft: BotManager['draft'], lineup: BotManager['lineup']): BotManager {
  return { id, tavern: randomTavern, hex: leaderHex, draft, lineup, waivers: bestAvailable(lineup) };
}

const MANAGERS: Readonly<Record<BotId, BotManager>> = {
  random: manager('random', DRAFT_STRATEGIES.random, LINEUP_STRATEGIES.projection),
  'cr-greedy': manager('cr-greedy', DRAFT_STRATEGIES['cr-greedy'], LINEUP_STRATEGIES.projection),
  'skill-coverage': manager('skill-coverage', DRAFT_STRATEGIES['skill-coverage'], LINEUP_STRATEGIES.projection),
  value: manager('value', DRAFT_STRATEGIES.value, LINEUP_STRATEGIES.projection),
  'projection-off': manager('projection-off', DRAFT_STRATEGIES.value, LINEUP_STRATEGIES['max-cr']),
};

export function botManager(id: BotId): BotManager {
  const bot = MANAGERS[id];
  if (bot === undefined) throw new Error(`unknown bot "${String(id)}"; known: ${BOT_IDS.join(', ')}`);
  return bot;
}
