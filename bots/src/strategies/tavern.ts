/**
 * Tavern pick (docs/decisions.md D-52): before the draft, each manager
 * chooses one of the season's taverns, in reverse draft order.
 *
 * Until boons exist (T6.10), taverns differ only in which god's week is
 * theirs, and with no home bonus (D-47) that changes nothing. So every bot
 * chooses uniformly at random among the taverns still open, from `rng`. That
 * also spreads each tavern evenly across strategies, so per-tavern results in
 * the balance report aren't confounded with who chose it.
 */
import type { Rng } from '@league-of-taverns/engine';

export interface TavernStrategy {
  readonly id: string;
  /** One of `available` (in package order). Throws if it is empty. */
  choose(available: ReadonlyArray<string>, rng: Rng): string;
}

export const randomTavern: TavernStrategy = {
  id: 'random',
  choose(available, rng) {
    const tavern = available[Math.floor(rng() * available.length)];
    if (tavern === undefined) throw new Error('tavern pick: no tavern is left to choose');
    return tavern;
  },
};
