import type { CheckTarget, EffectiveStats } from '../characters';
import type { SenseKind, SpeedKind } from '../vocabulary';

/**
 * The Lich's contest (docs/survivor-format.md, docs/lich-contest-plan.md):
 * about twenty monsters, one challenge and one vote per episode, a jury of
 * the voted-out at the end. Everything here is mechanical. A challenge's
 * story and a strategy's wording are chrome and live elsewhere.
 */

/** A speed or sense a contestant has (above 0 feet). */
export type Requirement = { readonly speed: SpeedKind } | { readonly sense: SenseKind };

/**
 * One check in a challenge: what it tests and its DC. `advantage` gives
 * advantage to contestants with that speed or sense; `requires` fails anyone
 * without it.
 */
export type ChallengeCheck = CheckTarget & {
  readonly dc: number;
  readonly advantage?: Requirement;
  readonly requires?: Requirement;
};

/**
 * One of the Lich's tasks: a series of checks with one winner. Elimination
 * rounds (`runChallenge`): everyone still in makes the next check, those who
 * fail drop out. The list repeats, a little harder each lap, until one is left.
 */
export interface Challenge {
  readonly id: string;
  readonly checks: ReadonlyArray<ChallengeCheck>;
}

/**
 * How a monster votes. A fixed list, shown openly on the card
 * (survivor-format.md §4.4).
 *
 * - `loyal`: protects monsters with `tag` ("I want a goblinoid to win") and
 *   goes after the most dangerous outsider.
 * - `threat`: cuts down whoever is strongest and winning.
 * - `coattails`: flatters the strong (who carry it, `VoteModel.flattery`)
 *   and votes out the weakest, until late in the contest
 *   (`VoteModel.betrayAt`), when it turns on the strongest.
 * - `grudge`: goes after whoever voted against it.
 * - `floater`: votes with the biggest bloc.
 */
export type VotingStrategy =
  | { readonly kind: 'loyal'; readonly tag: string }
  | { readonly kind: 'threat' }
  | { readonly kind: 'coattails' }
  | { readonly kind: 'grudge' }
  | { readonly kind: 'floater' };

export const STRATEGY_KINDS = ['loyal', 'threat', 'coattails', 'grudge', 'floater'] as const;
export type StrategyKind = VotingStrategy['kind'];

/** A monster as the contest sees it: its stats, its card's tags and its voting strategy. */
export interface Contestant {
  readonly id: string;
  readonly stats: EffectiveStats;
  readonly strategy: VotingStrategy;
  /** `cardTags(stats.base)`: type, subtype, law, morals, size. */
  readonly tags: ReadonlyArray<string>;
  /** `challengePower(stats)`: the mean modifier over every skill and save. */
  readonly power: number;
}

// ── results ───────────────────────────────────────────────────────────────

/** One contestant's roll in a challenge round. */
export interface ChallengeRoll {
  readonly id: string;
  readonly d20: number;
  readonly modifier: number;
  readonly advantage: boolean;
  /** False when the check `requires` something the contestant lacks: an automatic fail. */
  readonly eligible: boolean;
  readonly pass: boolean;
}

export interface ChallengeRound {
  /** Index into `challenge.checks`. */
  readonly check: number;
  /** 0 on the first pass through the list; the DC is `check.dc + lap × lapDc`. */
  readonly lap: number;
  readonly dc: number;
  readonly rolls: ReadonlyArray<ChallengeRoll>;
  /** Who dropped out, in roll order. Empty when nobody failed, or everyone did (then the round is replayed). */
  readonly out: ReadonlyArray<string>;
  /** Everyone failed, so nobody drops out. */
  readonly replay: boolean;
}

export interface ChallengeResult {
  readonly rounds: ReadonlyArray<ChallengeRound>;
  readonly winner: string;
}

export interface Ballot {
  readonly voter: string;
  readonly target: string;
}

export interface VoteResult {
  readonly ballots: ReadonlyArray<Ballot>;
  /** On a tie: the tied, and the revote among them by everyone else. Null without a tie. */
  readonly revote: { readonly tied: ReadonlyArray<string>; readonly ballots: ReadonlyArray<Ballot> } | null;
  /** Still tied after the revote: the Lich draws a name. Null otherwise. */
  readonly draw: { readonly tied: ReadonlyArray<string>; readonly roll: number } | null;
  readonly boot: string;
}

export interface FinaleResult {
  readonly finalists: ReadonlyArray<string>;
  readonly ballots: ReadonlyArray<{ readonly juror: string; readonly finalist: string }>;
  /** A tie between finalists: the Lich draws. Null otherwise. */
  readonly draw: { readonly tied: ReadonlyArray<string>; readonly roll: number } | null;
  readonly winner: string;
}

/** One finished episode: who won immunity and how the vote went. */
export interface EpisodeResult {
  readonly episode: number;
  readonly immune: string;
  readonly vote: VoteResult;
}
