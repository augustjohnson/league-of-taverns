import type { Modifier } from '../characters';
import type { SeasonConfig } from '../league';
import type { Mission } from '../missions';
import type { Lineup } from '../roster';
import type { CrEighths } from '../vocabulary';
import type { ManagerAccount, PayloadByType } from './types';

/**
 * League state as folded from the event log. In-memory only: it is never
 * written to disk, so there is nothing to drift from the log.
 *
 * Maps and arrays keep insertion order, which is log order: `managers` is in
 * join order, `taverns` in the order they were chosen, `pool` in pooling order, and each roster in acquisition order
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
  /** The season package's taverns from `season.created`, chosen or not (D-52). */
  readonly tavernList: PayloadByType['season.created']['taverns'];
  /** Every manager who joined, in join order, with the tavern they chose (null until then). */
  readonly managers: ReadonlyMap<string, ManagerState>;
  readonly pool: ReadonlyMap<string, { readonly base: string; readonly cr: CrEighths; readonly modifiers: ReadonlyArray<Modifier> }>;
  /** The chosen taverns, in the order they were chosen. Rosters live here. */
  readonly taverns: ReadonlyMap<string, TavernState>;
  /** characterId → tavernId for every owned character. Absent = free agent. */
  readonly owner: ReadonlyMap<string, string>;
  /**
   * `managerOrder` (manager ids) is empty until the first `tavern.chosen`
   * freezes it; taverns are chosen in its reverse (D-52). `order` (tavern ids,
   * the managers' taverns in `managerOrder`) is empty until the first pick
   * freezes it. `picks` counts picks made. `complete` flips after the last
   * pick.
   */
  readonly draft: {
    readonly managerOrder: ReadonlyArray<string>;
    readonly order: ReadonlyArray<string>;
    readonly picks: number;
    readonly complete: boolean;
  };
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
  /** Every declared hex, in log order (D-52). Read with `hexOn`. */
  readonly hexes: ReadonlyArray<PayloadByType['hex.declared']>;
  readonly finalizedWeeks: ReadonlySet<number>;
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

export interface TradeState {
  readonly terms: PayloadByType['trade.proposed'];
  readonly status: 'proposed' | 'accepted' | 'vetoed' | 'completed' | 'cancelled';
}
