import type { Modifier } from '../characters';
import type { SeasonConfig } from '../league';
import type { Mission } from '../missions';
import type { Lineup } from '../roster';
import type { CrEighths } from '../vocabulary';
import type { PayloadByType } from './types';

/**
 * League state as folded from the event log. In-memory only: it is never
 * written to disk, so there is nothing to drift from the log.
 *
 * Maps and arrays keep insertion order, which is log order: `taverns` is in
 * join order, `pool` in pooling order, and each roster in acquisition order
 * (draft order first). Selectors and the fallback lineup rely on that.
 */
export interface LeagueState {
  readonly lastSeq: number;
  /**
   * sha256 of the last folded NDJSON line, or null before any line. Kept by
   * `replay` and `replayLog`, which see lines. `applyEvent` never sees the raw
   * line, so it leaves this unchanged.
   */
  readonly lastHash: string | null;
  readonly phase: 'empty' | 'preseason' | 'drafting' | 'regular' | 'complete';
  readonly config: SeasonConfig | null;
  /** The public schedule from `season.created`, including each week's commitment. */
  readonly schedule: PayloadByType['season.created']['schedule'];
  /** The sponsors from `season.created`: which god backs which tavern (D-44, D-47). */
  readonly sponsors: PayloadByType['season.created']['sponsors'];
  readonly pool: ReadonlyMap<string, { readonly base: string; readonly cr: CrEighths; readonly modifiers: ReadonlyArray<Modifier> }>;
  readonly taverns: ReadonlyMap<string, TavernState>;
  /** characterId → tavernId for every owned character. Absent = free agent. */
  readonly owner: ReadonlyMap<string, string>;
  /**
   * `order` is empty until the first pick freezes it. `picks` counts picks
   * made. `complete` flips after the last pick.
   */
  readonly draft: { readonly order: ReadonlyArray<string>; readonly picks: number; readonly complete: boolean };
  /** Keepers placed before the draft, in log order, with the round each forfeits (D-11, still OPEN). */
  readonly retained: ReadonlyArray<PayloadByType['character.retained']>;
  /** Lineups submitted (not yet locked), by week then tavern. */
  readonly pendingLineups: ReadonlyMap<number, ReadonlyMap<string, Lineup>>;
  readonly lockedLineups: ReadonlyMap<number, PayloadByType['lineup.locked']['lineups']>;
  readonly waivers: {
    readonly pending: ReadonlyArray<PayloadByType['waiver.claimed']>;
    /** Rolling priority, first = highest. Reverse draft order after the draft. */
    readonly priority: ReadonlyArray<string>;
    /** Weeks whose `waiver.resolved` has been applied. Waivers resolve once per week. */
    readonly resolvedWeeks: ReadonlySet<number>;
  };
  readonly trades: ReadonlyMap<string, TradeState>;
  readonly revealed: ReadonlyMap<number, Mission>;
  readonly results: ReadonlyMap<number, ReadonlyMap<string, PayloadByType['mission.resolved']>>;
  /**
   * characterId → the week it can't start, from an injury in the week before
   * (D-51). Injuries last one week and don't stack: a later one replaces the
   * entry. Read with `injuredFor`.
   */
  readonly injuries: ReadonlyMap<string, number>;
  readonly finalizedWeeks: ReadonlySet<number>;
}

export interface TavernState {
  readonly id: string;
  readonly name: string;
  readonly manager: PayloadByType['tavern.joined']['manager'];
  readonly roster: ReadonlyArray<string>;
}

export interface TradeState {
  readonly terms: PayloadByType['trade.proposed'];
  readonly status: 'proposed' | 'accepted' | 'vetoed' | 'completed' | 'cancelled';
}
