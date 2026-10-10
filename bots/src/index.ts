/**
 * @league-of-taverns/bots
 *
 * Bot managers that play a season headless through the same commands humans
 * use. Each decision returns a command that the engine reducers validate,
 * exactly like an issue form. Bots never bypass rules.
 *
 * Used by sims/ for balance testing, and possibly to fill empty seats in a
 * live league (docs/decisions.md D-36).
 */
export type * from './types';
export { BOT_IDS, botManager } from './strategies';
export type { BotId } from './strategies';
