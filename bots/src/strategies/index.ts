/**
 * Named strategy presets. Each is a deliberately simple, legible heuristic so
 * the balance report can say which *idea* dominates, not which tuned blob.
 *
 * Planned presets (T9.1):
 * - draft `cr-greedy`: highest CR available.
 * - draft `skill-coverage`: maximize the number of skills where the roster
 *   has the league's best or second-best modifier.
 * - draft `value`: best (battle strength + skill breadth) per CR.
 * - draft `random`: seeded uniform pick. The baseline every other strategy must beat.
 * - lineup `max-cr`: spend the most CR possible under B.
 * - lineup `environment-fit`: weight skills by the public schedule's environment and theme.
 * - waivers `best-available`: claim the free agent that most improves the lineup score.
 */
import type { BotManager } from '../types';
import { notImplemented } from '@league-of-taverns/engine';

export const BOT_IDS = ['random', 'cr-greedy', 'skill-coverage', 'value'] as const;
export type BotId = (typeof BOT_IDS)[number];

export function botManager(_id: BotId): BotManager {
  return notImplemented('botManager', 'T9.1');
}
