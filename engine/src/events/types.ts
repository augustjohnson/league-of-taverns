import type { Modifier } from '../characters';
import type { SeasonConfig } from '../league';
import type { Mission } from '../missions';
import type { RunResult } from '../resolution';
import type { Lineup } from '../roster';
import type { CrEighths } from '../vocabulary';

/**
 * The event log is the only source of truth. Rosters, standings, records and
 * stats are folds over it and are never stored.
 *
 * One NDJSON line per event in seasons/<id>/events/events.ndjson, written only
 * by Actions. Field-level docs: docs/schema.md § Events.
 */
export interface EventEnvelope<T extends EventType, P> {
  /** Envelope schema version. */
  readonly v: 1;
  /** 1-based, contiguous, per season. */
  readonly seq: number;
  readonly type: T;
  readonly season: string;
  /** ISO-8601 UTC, stamped by the Action. Reducers never compare it to "now". */
  readonly at: string;
  readonly actor: Actor;
  readonly source?: EventSource;
  /** sha256 hex of the previous NDJSON line, or null for seq 1. Tamper evidence. */
  readonly prev: string | null;
  readonly payload: P;
}

export type Actor =
  | { readonly kind: 'manager'; readonly githubId: number; readonly login: string }
  | { readonly kind: 'commissioner'; readonly githubId: number; readonly login: string }
  | { readonly kind: 'system'; readonly workflow: string }
  | { readonly kind: 'bot'; readonly strategy: string };

export interface EventSource {
  readonly issue?: number;
  readonly comment?: number;
  readonly workflowRun?: number;
}

export interface PayloadByType {
  'season.created': {
    readonly config: SeasonConfig;
    /** sha256 of config.yaml at creation, so later edits are detectable. */
    readonly configSha256: string;
    readonly engineVersion: string;
    /** Public schedule plus each week's sealed-mission commitment (docs/decisions.md D-08). */
    readonly schedule: ReadonlyArray<{ readonly week: number; readonly title: string; readonly environment: string; readonly theme: string; readonly commitment: string | null }>;
  };
  'character.pooled': {
    readonly character: string;
    readonly base: string;
    readonly cr: CrEighths;
    readonly modifiers: ReadonlyArray<Modifier>;
  };
  'tavern.joined': {
    readonly tavern: string;
    readonly name: string;
    readonly manager: { readonly githubId: number; readonly login: string } | { readonly bot: string };
  };
  'character.retained': {
    readonly tavern: string;
    readonly character: string;
    readonly fromSeason: string;
    readonly basis: 'keeper' | 'champion_reward';
    /** Draft round forfeited for this keeper, or null if free. OPEN: docs/decisions.md D-11. */
    readonly costRound: number | null;
  };
  'draft.pick': {
    /** 0-based overall pick number. Must equal the number of prior picks. */
    readonly pick: number;
    readonly tavern: string;
    readonly character: string;
    readonly auto: boolean;
  };
  'lineup.set': {
    readonly tavern: string;
    readonly week: number;
    readonly lineup: Lineup;
  };
  'lineup.locked': {
    readonly week: number;
    /** Every tavern's lineup for the week, and where it came from. */
    readonly lineups: ReadonlyArray<{
      readonly tavern: string;
      readonly lineup: Lineup | null;
      readonly source: 'submitted' | 'carried' | 'fallback' | 'none';
    }>;
  };
  'waiver.claimed': {
    readonly claim: string;
    readonly tavern: string;
    readonly add: string;
    readonly drop: string | null;
  };
  'waiver.resolved': {
    /** Waivers resolve once per week, after that week's run. */
    readonly week: number;
    readonly outcomes: ReadonlyArray<{ readonly claim: string; readonly awarded: boolean; readonly reason: string }>;
    readonly priorityAfter: ReadonlyArray<string>;
  };
  'trade.proposed': {
    readonly trade: string;
    readonly from: string;
    readonly to: string;
    readonly give: ReadonlyArray<string>;
    readonly receive: ReadonlyArray<string>;
  };
  'trade.accepted': { readonly trade: string };
  'trade.vetoed': { readonly trade: string; readonly reason: string };
  /** Added beyond the brief: makes the end of the veto window an explicit event (docs/decisions.md D-41). */
  'trade.completed': { readonly trade: string };
  /** Added beyond the brief: declined, withdrawn, expired, or invalidated by roster changes (D-41). */
  'trade.cancelled': { readonly trade: string; readonly reason: 'declined' | 'withdrawn' | 'expired' | 'invalid' };
  'mission.revealed': {
    readonly week: number;
    readonly mission: Mission;
    /** sha256 of the canonical mission JSON. Must match the commitment in `season.created`. */
    readonly sha256: string;
    /** Per-week seed salt if the season uses one (D-13). */
    readonly salt: string | null;
  };
  'mission.resolved': {
    readonly week: number;
    readonly tavern: string;
    readonly mission: string;
    readonly seed: string;
    readonly engineVersion: string;
    readonly battleModel: string;
    readonly lineup: Lineup;
    /** The single seeded run: per-node rolls, actors, path, score. */
    readonly run: RunResult;
    readonly projected: { readonly expectedScore: number; readonly pDnf: number };
    readonly points: number;
    readonly projectedPoints: number;
  };
  'week.finalized': { readonly week: number };
}

export type EventType = keyof PayloadByType;

export type LeagueEvent = { [T in EventType]: EventEnvelope<T, PayloadByType[T]> }[EventType];

export type EventOf<T extends EventType> = Extract<LeagueEvent, { readonly type: T }>;
