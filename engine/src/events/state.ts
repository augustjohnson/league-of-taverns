import type { Modifier } from '../characters';
import type { ChallengeResult, FinaleResult, VoteResult, VotingStrategy } from '../contest/types';
import type { SeasonConfig } from '../league';
import type { CrEighths } from '../vocabulary';
import type { ManagerAccount, PayloadByType } from './types';

/**
 * League state as folded from the event log. In-memory only: it is never
 * written to disk, so there is nothing to drift from the log.
 *
 * Maps and arrays keep insertion order, which is log order: `managers` is in
 * join order, `taverns` in the order they were chosen, `pool` in pooling
 * order (the cast order), and each roster in draft order.
 *
 * The contest's results (immunity, ballots, boots) are folded here; the vote
 * model's own state (affinity, grudges) needs the cards' stats and is
 * rebuilt from these results by `contestState` (selectors.ts).
 */
export interface LeagueState {
  readonly lastSeq: number;
  /**
   * sha256 of the last folded NDJSON line, or null before any line. Kept by
   * `replay` and `replayLog`, which see lines. `applyEvent` never sees the raw
   * line, so it leaves this unchanged.
   */
  readonly lastHash: string | null;
  readonly phase: 'empty' | 'preseason' | 'drafting' | 'contest' | 'complete';
  readonly config: SeasonConfig | null;
  /** The season's taverns from `season.created`, chosen or not. */
  readonly tavernList: PayloadByType['season.created']['taverns'];
  /** Each episode's challenge commitment, in episode order. */
  readonly commitments: PayloadByType['season.created']['challenges'];
  readonly abilityMix: PayloadByType['season.created']['abilityMix'] | null;
  /** Every manager who joined, in join order, with the tavern they chose (null until then). */
  readonly managers: ReadonlyMap<string, ManagerState>;
  /** The cast, in pooling order. */
  readonly pool: ReadonlyMap<string, PooledEntry>;
  /** The chosen taverns, in the order they were chosen. Rosters live here. */
  readonly taverns: ReadonlyMap<string, TavernState>;
  /** characterId → tavernId for every drafted monster. Absent = undrafted. */
  readonly owner: ReadonlyMap<string, string>;
  /**
   * `managerOrder` (manager ids) is empty until the first `tavern.chosen`
   * freezes it; taverns are chosen in its reverse. `order` (tavern ids, the
   * managers' taverns in `managerOrder`) is empty until the first pick
   * freezes it. `picks` counts picks made. `complete` flips after the last pick.
   */
  readonly draft: {
    readonly managerOrder: ReadonlyArray<string>;
    readonly order: ReadonlyArray<string>;
    readonly picks: number;
    readonly complete: boolean;
  };
  /** Still in the contest, in cast order. */
  readonly alive: ReadonlyArray<string>;
  /** Voted out, in the order they left. */
  readonly jury: ReadonlyArray<string>;
  /** Episodes in order; the last may be under way (challenge run, vote not yet). */
  readonly episodes: ReadonlyArray<EpisodeState>;
  /** Calls by episode, then tavern. */
  readonly calls: ReadonlyMap<number, ReadonlyMap<string, CallState>>;
  readonly finale: FinaleResult | null;
}

export interface PooledEntry {
  readonly base: string;
  readonly cr: CrEighths;
  readonly modifiers: ReadonlyArray<Modifier>;
  readonly strategy: VotingStrategy;
}

export interface EpisodeState {
  readonly episode: number;
  readonly challenge: { readonly id: string; readonly result: ChallengeResult } | null;
  readonly vote: VoteResult | null;
}

export interface CallState {
  readonly target: string;
  /** Made before the episode's challenge (and not changed after it): earns the early bonus when correct. */
  readonly early: boolean;
  /** seq of the `call.made` that set it. */
  readonly seq: number;
}

export interface ManagerState {
  readonly id: string;
  readonly account: ManagerAccount;
  /** The tavern chosen, or null before the tavern pick reaches them. */
  readonly tavern: string | null;
}

export interface TavernState {
  readonly id: string;
  readonly name: string;
  /** The manager's id (`manager.joined`). */
  readonly managerId: string;
  /** The manager's account: who may act for this tavern. */
  readonly manager: ManagerAccount;
  readonly roster: ReadonlyArray<string>;
}
