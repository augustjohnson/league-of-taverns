/**
 * @league-of-taverns/bots
 *
 * Bot managers that play a season through the same commands people use:
 * choose a tavern, draft, and call the boot. Each decision is validated by
 * the engine's reducers. Bots never bypass rules and never see the seed or
 * a challenge before it runs.
 *
 * Used by sims/ for balance testing and by the playground for the rival
 * taverns.
 */
export type * from './types';
export {
  BOT_IDS,
  CALL_STRATEGIES,
  DRAFT_STRATEGIES,
  botManager,
  gossipCalls,
  hunchCalls,
  oracleCalls,
  powerDraft,
  randomCalls,
  randomDraft,
  randomTavern,
  scoutDraft,
  scoutSeed,
  socialDraft,
} from './strategies';
export type { BotId, TavernStrategy } from './strategies';
export { VALUE_RUNS, expectedPoints, warmth } from './value';
