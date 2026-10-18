/**
 * Running the contest: one episode, the whole season, and the odds of each
 * boot by seeded sampling.
 *
 * A season's contest is a pure function of its seed, its cast and its
 * challenges. Each episode's dice come from their own stream, so an episode
 * never depends on how many numbers an earlier one drew:
 * `challenge:<n>` for the challenge, `vote:<n>` for the vote and `finale`
 * for the jury.
 */
import { rngFor } from '../rng';
import { genericChallenge, runChallenge } from './challenge';
import type { VoteModel } from './model';
import { applyEpisode, initialContest, type ContestState } from './state';
import type { Challenge, ChallengeResult, Contestant, EpisodeResult, FinaleResult, VoteResult } from './types';
import { castVotes, juryVote } from './vote';

export const challengeStream = (episode: number): string => `challenge:${episode}`;
export const voteStream = (episode: number): string => `vote:${episode}`;
export const FINALE_STREAM = 'finale';

/** A cast as a lookup, in cast order. */
export function castMap(cast: ReadonlyArray<Contestant>): ReadonlyMap<string, Contestant> {
  return new Map(cast.map((c) => [c.id, c]));
}

/** The challenge for an episode among those still in. */
export function playChallenge(s: ContestState, cast: ReadonlyMap<string, Contestant>, challenge: Challenge, seed: string, episode: number, lapDc = 1): ChallengeResult {
  return runChallenge(
    s.alive.map((id) => cast.get(id)!),
    challenge,
    rngFor(seed, challengeStream(episode)),
    lapDc,
  );
}

/** The vote for an episode, with `immune` safe. */
export function playVote(s: ContestState, cast: ReadonlyMap<string, Contestant>, immune: string, seed: string, episode: number, model: VoteModel): VoteResult {
  return castVotes(s, cast, immune, rngFor(seed, voteStream(episode)), model);
}

/** The jury vote. */
export function playFinale(s: ContestState, cast: ReadonlyMap<string, Contestant>, seed: string, model: VoteModel): FinaleResult {
  return juryVote(s, cast, rngFor(seed, FINALE_STREAM), model);
}

export interface ContestRun {
  readonly episodes: ReadonlyArray<EpisodeResult & { readonly challenge: ChallengeResult }>;
  readonly finale: FinaleResult;
  /** The contest after the last vote. */
  readonly state: ContestState;
}

export interface ContestOptions {
  /** How many face the jury. */
  readonly finalists: number;
  /** DC added per lap through a challenge's checks. */
  readonly lapDc?: number;
  readonly model: VoteModel;
}

/**
 * The whole contest: one episode per challenge until `finalists` are left,
 * then the jury. Throws if there are too few challenges for the cast.
 */
export function runContest(cast: ReadonlyArray<Contestant>, challenges: ReadonlyArray<Challenge>, seed: string, options: ContestOptions): ContestRun {
  const map = castMap(cast);
  const votes = cast.length - options.finalists;
  if (votes < 0) throw new Error(`runContest: ${cast.length} contestants can't leave ${options.finalists} finalists`);
  if (challenges.length < votes) throw new Error(`runContest: ${votes} votes need ${votes} challenges, got ${challenges.length}`);
  let s = initialContest(cast, options.model);
  const episodes: Array<EpisodeResult & { challenge: ChallengeResult }> = [];
  for (let episode = 1; episode <= votes; episode++) {
    const challenge = playChallenge(s, map, challenges[episode - 1]!, seed, episode, options.lapDc);
    const vote = playVote(s, map, challenge.winner, seed, episode, options.model);
    const result = { episode, immune: challenge.winner, vote };
    episodes.push({ ...result, challenge });
    s = applyEpisode(s, result, options.model);
  }
  return { episodes, finale: playFinale(s, map, seed, options.model), state: s };
}

export interface EpisodeOdds {
  /** Chance each monster still in is voted out at this episode's vote. */
  readonly boot: ReadonlyMap<string, number>;
  /** Chance each wins immunity: 1 for the known winner after the challenge. */
  readonly immunity: ReadonlyMap<string, number>;
}

/**
 * The odds for the coming vote by seeded sampling (`samples` draws, streams
 * `odds:<k>` under `seed`). With `immune` known (after the challenge), only
 * the vote's noise is sampled. Before the challenge (`immune` null), each
 * draw also runs a `genericChallenge` for immunity: the real challenge is
 * secret. Uses only public information.
 */
export function episodeOdds(
  s: ContestState,
  cast: ReadonlyMap<string, Contestant>,
  immune: string | null,
  model: VoteModel,
  seed: string,
  samples = 200,
): EpisodeOdds {
  const boot = new Map(s.alive.map((id) => [id, 0]));
  const immunity = new Map(s.alive.map((id) => [id, 0]));
  for (let k = 0; k < samples; k++) {
    const rng = rngFor(seed, `odds:${k}`);
    const safe = immune ?? runChallenge(s.alive.map((id) => cast.get(id)!), genericChallenge(rng), rng).winner;
    immunity.set(safe, immunity.get(safe)! + 1);
    const { boot: out } = castVotes(s, cast, safe, rng, model);
    boot.set(out, boot.get(out)! + 1);
  }
  const share = (m: Map<string, number>): ReadonlyMap<string, number> => new Map([...m].map(([id, n]) => [id, n / samples]));
  return { boot: share(boot), immunity: share(immunity) };
}
