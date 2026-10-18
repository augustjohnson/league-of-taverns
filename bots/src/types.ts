import type { CallState, ContestState, Contestant, EpisodeOdds, LeagueState, Rng, SeasonConfig, VoteModel } from '@league-of-taverns/engine';
import type { TavernStrategy } from './strategies/tavern';

/**
 * What a bot is allowed to know: exactly what a person at the table could
 * see. The cards are public, every ballot is read out, and the vote model
 * is in the repo, so the odds of each boot can be worked out by anyone. The
 * challenges are secret until they run, and the seed is never in the view.
 *
 * Everything is read-only. A bot returns a decision and never mutates the
 * view. Every decision is then validated by the engine like any command.
 */
export interface PublicView {
  /** League state folded from the public event log. */
  readonly state: LeagueState;
  /** The tavern this bot manages. */
  readonly tavern: string;
  readonly config: SeasonConfig;
  /** The cast's cards, in cast order. */
  readonly cast: ReadonlyArray<Contestant>;
  /** The season's vote model (`voteModel(config.contest.model)`). */
  readonly model: VoteModel;
  /** The vote model's state after every vote so far. */
  contest(): ContestState;
  /**
   * The odds for the open episode's vote: before the challenge (`immune`
   * null) or after it. Shared by every bot at the table: it is public
   * arithmetic, worked out once.
   */
  odds(immune: string | null): EpisodeOdds;
  /** Bot-private randomness, from rngFor(simSeed, 'bot:' + tavern + ':' + decision). */
  readonly rng: Rng;
}

export interface DraftStrategy {
  readonly id: string;
  /** One of `available`. */
  pick(view: PublicView, available: ReadonlyArray<string>): string;
}

export interface CallStrategy {
  readonly id: string;
  /** Before the challenge: a call to make now, or null to wait. */
  early(view: PublicView, episode: number): string | null;
  /**
   * After the challenge: a call to make (new, or replacing `current`), or
   * null to keep `current` (or to make none, if there is none).
   */
  late(view: PublicView, episode: number, current: CallState | undefined): string | null;
}

/** A full bot manager: one strategy per decision. Named combinations live in ./strategies. */
export interface BotManager {
  readonly id: string;
  readonly tavern: TavernStrategy;
  readonly draft: DraftStrategy;
  readonly calls: CallStrategy;
}
