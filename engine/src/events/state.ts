import type { Modifier } from '../characters';
import type { SeasonConfig } from '../league';
import type { Mission } from '../missions';
import type { Lineup } from '../roster';
import type { CrEighths } from '../vocabulary';
import type { PayloadByType } from './types';

/**
 * League state as folded from the event log. In-memory only: it is never
 * written to disk, so there is nothing to drift from the log.
 */
export interface LeagueState {
  readonly lastSeq: number;
  readonly lastHash: string | null;
  readonly phase: 'empty' | 'preseason' | 'drafting' | 'regular' | 'complete';
  readonly config: SeasonConfig | null;
  readonly pool: ReadonlyMap<string, { readonly base: string; readonly cr: CrEighths; readonly modifiers: ReadonlyArray<Modifier> }>;
  readonly taverns: ReadonlyMap<string, TavernState>;
  /** characterId → tavernId for every owned character. Absent = free agent. */
  readonly owner: ReadonlyMap<string, string>;
  readonly draft: { readonly order: ReadonlyArray<string>; readonly picks: number; readonly complete: boolean };
  /** Lineups submitted (not yet locked), by week then tavern. */
  readonly pendingLineups: ReadonlyMap<number, ReadonlyMap<string, Lineup>>;
  readonly lockedLineups: ReadonlyMap<number, PayloadByType['lineup.locked']['lineups']>;
  readonly waivers: { readonly pending: ReadonlyArray<PayloadByType['waiver.claimed']>; readonly priority: ReadonlyArray<string> };
  readonly trades: ReadonlyMap<string, TradeState>;
  readonly revealed: ReadonlyMap<number, Mission>;
  readonly results: ReadonlyMap<number, ReadonlyMap<string, PayloadByType['mission.resolved']>>;
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
