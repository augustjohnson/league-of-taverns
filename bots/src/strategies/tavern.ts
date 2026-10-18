/**
 * The tavern pick: before the draft, each manager chooses one of the
 * season's taverns, in reverse draft order. Taverns are team names and
 * banners, so nothing rides on the choice: every bot chooses uniformly at
 * random among those still open, from `rng`.
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
