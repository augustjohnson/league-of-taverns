import type { Modifier } from '../characters';
import type { Challenge, ChallengeResult, FinaleResult, VoteResult, VotingStrategy } from '../contest/types';
import type { SeasonConfig } from '../league';
import type { Ability, CrEighths } from '../vocabulary';

/**
 * The event log is the only source of truth. Rosters, scores and
 * standings are folds over it and are never stored.
 *
 * One NDJSON line per event. Field-level docs: docs/lich-contest-plan.md §3.
 */
export interface EventEnvelope<T extends EventType, P> {
  /** Envelope schema version. */
  readonly v: 1;
  /** 1-based, contiguous, per season. */
  readonly seq: number;
  readonly type: T;
  readonly season: string;
  /** ISO-8601 UTC, stamped by the writer. Reducers never compare it to "now". */
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

/** Who a manager is: a GitHub account, or a bot strategy in sims. */
export type ManagerAccount = { readonly githubId: number; readonly login: string } | { readonly bot: string };

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
    /** The season's taverns: team names, chosen by managers in reverse draft order. At most `MAX_TAVERNS`. */
    readonly taverns: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    /**
     * One commitment per episode: the sha256 of its challenge's canonical
     * JSON, sealed before the season. `challenge.resolved` must match it.
     */
    readonly challenges: ReadonlyArray<{ readonly episode: number; readonly sha256: string }>;
    /** The public hint: how many checks across the season's challenges use each ability. */
    readonly abilityMix: Readonly<Record<Ability, number>>;
  };
  /** A monster joins the cast, with its card's mechanical data. */
  'character.pooled': {
    readonly character: string;
    readonly base: string;
    readonly cr: CrEighths;
    readonly modifiers: ReadonlyArray<Modifier>;
    readonly strategy: VotingStrategy;
  };
  /** A manager joins the league. They choose a tavern later, in reverse draft order. */
  'manager.joined': {
    /** The manager's id in managers.yaml (kebab-case), stable for the season. */
    readonly manager: string;
    readonly account: ManagerAccount;
  };
  /** A manager takes one of the season's taverns. */
  'tavern.chosen': {
    readonly manager: string;
    readonly tavern: string;
  };
  'draft.pick': {
    /** 0-based overall pick number. Must equal the number of prior picks. */
    readonly pick: number;
    readonly tavern: string;
    readonly character: string;
    readonly auto: boolean;
  };
  /**
   * A tavern calls the boot for an episode: who it thinks is voted out. A
   * later call replaces an earlier one. Sealed until the vote.
   */
  'call.made': {
    readonly episode: number;
    readonly tavern: string;
    readonly target: string;
  };
  /** The Lich's task for an episode: the challenge, revealed, and its run. */
  'challenge.resolved': {
    readonly episode: number;
    readonly challenge: Challenge;
    /** Must match the episode's commitment in `season.created`. */
    readonly sha256: string;
    /** The contest seed the dice came from (`contestSeed`). */
    readonly seed: string;
    readonly result: ChallengeResult;
  };
  /** The vote: every ballot, any revote or draw, and the boot. */
  'vote.resolved': {
    readonly episode: number;
    readonly vote: VoteResult;
  };
  /** The jury picks the Lich's new assistant. */
  'finale.resolved': {
    readonly result: FinaleResult;
  };
}

export type EventType = keyof PayloadByType;

export type LeagueEvent = { [T in EventType]: EventEnvelope<T, PayloadByType[T]> }[EventType];

export type EventOf<T extends EventType> = Extract<LeagueEvent, { readonly type: T }>;
