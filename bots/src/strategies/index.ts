/**
 * Named bot managers: a draft idea paired with a way of calling the boot.
 * Every strategy is deterministic given the view: all randomness comes from
 * `view.rng`, never `Math.random`.
 *
 * | Bot | Draft | Calls |
 * |---|---|---|
 * | `sharp` | `scout`: expected points | `oracle`: the odds, early when it pays |
 * | `scout` | `scout` | `hunch`: by gut, weighted by the odds |
 * | `brawn` | `power`: challenge power | `oracle` |
 * | `socialite` | `social`: the biggest bloc | `gossip`: who drew votes lately |
 * | `gossip` | `scout` | `gossip` |
 * | `random` | `random` | `random` |
 */
import type { BotManager } from '../types';
import { CALL_STRATEGIES } from './calls';
import { DRAFT_STRATEGIES } from './draft';
import { randomTavern } from './tavern';

export { CALL_STRATEGIES, ORACLE_BLUR, gossipCalls, hunchCalls, oracleCalls, randomCalls } from './calls';
export { DRAFT_STRATEGIES, powerDraft, randomDraft, scoutDraft, scoutSeed, socialDraft } from './draft';
export { randomTavern } from './tavern';
export type { TavernStrategy } from './tavern';

export const BOT_IDS = ['sharp', 'scout', 'brawn', 'socialite', 'gossip', 'random'] as const;
export type BotId = (typeof BOT_IDS)[number];

const manager = (id: BotId, draft: BotManager['draft'], calls: BotManager['calls']): BotManager => ({ id, tavern: randomTavern, draft, calls });

const MANAGERS: Readonly<Record<BotId, BotManager>> = {
  sharp: manager('sharp', DRAFT_STRATEGIES.scout, CALL_STRATEGIES.oracle),
  scout: manager('scout', DRAFT_STRATEGIES.scout, CALL_STRATEGIES.hunch),
  brawn: manager('brawn', DRAFT_STRATEGIES.power, CALL_STRATEGIES.oracle),
  socialite: manager('socialite', DRAFT_STRATEGIES.social, CALL_STRATEGIES.gossip),
  gossip: manager('gossip', DRAFT_STRATEGIES.scout, CALL_STRATEGIES.gossip),
  random: manager('random', DRAFT_STRATEGIES.random, CALL_STRATEGIES.random),
};

export function botManager(id: BotId): BotManager {
  const bot = MANAGERS[id];
  if (bot === undefined) throw new Error(`unknown bot "${String(id)}"; known: ${BOT_IDS.join(', ')}`);
  return bot;
}
