/**
 * Selectors: derived views over `LeagueState`. Pure, never stored.
 *
 * Scoring (docs/lich-contest-plan.md §1): at each vote a tavern scores
 * `survive` for each of its monsters still in afterwards, `immunity` if one
 * of them won the challenge, and `call` (+ `earlyCallBonus` if made before
 * the challenge) for calling the boot. At the finale it scores `juryVote`
 * per jury vote its finalists receive and `winner` for the winner.
 */
import { applyEpisode, initialContest, type ContestState } from '../contest/state';
import type { VoteModel } from '../contest/model';
import type { Contestant } from '../contest/types';
import { episodesOf, roundRobin, standings, votesIn, type MatchupResult, type StandingRow } from '../league';
import { draftOrderSeed, rngFor } from '../rng';
import { draftOrder, snakePickOwner } from '../roster';
import { openEpisode } from './reducers';
import type { LeagueState } from './state';

/** Cast members nobody drafted, in cast order. */
export function freeAgents(state: LeagueState): ReadonlyArray<string> {
  return [...state.pool.keys()].filter((id) => !state.owner.has(id));
}

/**
 * The manager whose turn it is to choose a tavern, or null when no choice is
 * possible. Taverns are chosen in reverse draft order. Before the first
 * choice this is who would choose first if the pick started now.
 */
export function tavernPickOnTheClock(state: LeagueState): string | null {
  const config = state.config;
  if (config === null || state.phase !== 'preseason' || state.draft.picks > 0) return null;
  let order = state.draft.managerOrder;
  if (order.length === 0) {
    const joined = [...state.managers.keys()];
    if (joined.length === 0) return null;
    try {
      order = draftOrder(joined, config, rngFor(draftOrderSeed(config.id), 'order'));
    } catch {
      return null;
    }
  }
  return [...order].reverse()[state.taverns.size] ?? null;
}

/** The tavern whose draft pick is next, or null when no pick is possible. */
export function onTheClock(state: LeagueState): string | null {
  const config = state.config;
  if (config === null || state.draft.complete) return null;
  if (state.phase !== 'preseason' && state.phase !== 'drafting') return null;
  if (state.managers.size === 0 || [...state.managers.values()].some((m) => m.tavern === null)) return null;
  const order = state.draft.order.length > 0 ? state.draft.order : state.draft.managerOrder.map((id) => state.managers.get(id)!.tavern!);
  return snakePickOwner(order, state.draft.picks);
}

export { openEpisode };

/** Where the open episode stands: before its challenge, or between the challenge and the vote. Null when none is open. */
export function episodeStage(state: LeagueState): { readonly episode: number; readonly stage: 'challenge' | 'vote' } | null {
  const episode = openEpisode(state);
  if (episode === null) return null;
  return { episode, stage: state.episodes[episode - 1]?.challenge == null ? 'challenge' : 'vote' };
}

/** The immunity winner of `episode`, or null before its challenge. */
export function immuneAt(state: LeagueState, episode: number): string | null {
  return state.episodes[episode - 1]?.challenge?.result.winner ?? null;
}

/** Who was in the contest when `episode` began (before its vote), in cast order. */
export function aliveAt(state: LeagueState, episode: number): ReadonlyArray<string> {
  const gone = new Set(state.jury.slice(0, Math.max(0, episode - 1)));
  return [...state.pool.keys()].filter((id) => !gone.has(id));
}

/** One tavern's points for one vote, or for the finale. */
export interface ScoreLine {
  readonly survive: number;
  readonly immunity: number;
  readonly call: number;
  readonly early: number;
  readonly jury: number;
  readonly winner: number;
  readonly total: number;
}

const ZERO: ScoreLine = { survive: 0, immunity: 0, call: 0, early: 0, jury: 0, winner: 0, total: 0 };

function line(parts: Omit<ScoreLine, 'total'>): ScoreLine {
  return { ...parts, total: parts.survive + parts.immunity + parts.call + parts.early + parts.jury + parts.winner };
}

/** `tavern`'s points at `episode`'s vote, or zero if the vote hasn't happened. */
export function episodeScore(state: LeagueState, tavern: string, episode: number): ScoreLine {
  const config = state.config;
  const entry = state.episodes[episode - 1];
  const roster = state.taverns.get(tavern)?.roster ?? [];
  if (config === null || entry?.vote == null || entry.challenge === null) return ZERO;
  const { scoring } = config;
  const before = aliveAt(state, episode);
  const boot = entry.vote.boot;
  const survivors = roster.filter((id) => before.includes(id) && id !== boot).length;
  const immune = roster.includes(entry.challenge.result.winner) ? 1 : 0;
  const call = state.calls.get(episode)?.get(tavern);
  const right = call !== undefined && call.target === boot;
  return line({
    survive: survivors * scoring.survive,
    immunity: immune * scoring.immunity,
    call: right ? scoring.call : 0,
    early: right && call.early ? scoring.earlyCallBonus : 0,
    jury: 0,
    winner: 0,
  });
}

/** `tavern`'s points at the finale, or zero before it. */
export function finaleScore(state: LeagueState, tavern: string): ScoreLine {
  const config = state.config;
  const finale = state.finale;
  if (config === null || finale === null) return ZERO;
  const roster = state.taverns.get(tavern)?.roster ?? [];
  const votes = finale.ballots.filter((b) => roster.includes(b.finalist)).length;
  return line({ survive: 0, immunity: 0, call: 0, early: 0, jury: votes * config.scoring.juryVote, winner: roster.includes(finale.winner) ? config.scoring.winner : 0 });
}

/** `tavern`'s points over round `round`'s episodes, plus the finale in the last round. */
export function roundPoints(state: LeagueState, tavern: string, round: number): number {
  const config = state.config;
  if (config === null) return 0;
  let total = 0;
  for (const e of episodesOf(config, round)) total += episodeScore(state, tavern, e).total;
  if (round === config.schedule.rounds.length) total += finaleScore(state, tavern).total;
  return total;
}

/** The head-to-head schedule: each round's pairs, by the round-robin over the snake order. Empty before the draft. */
export function schedule(state: LeagueState): ReadonlyArray<ReadonlyArray<readonly [string, string]>> {
  const config = state.config;
  if (config === null || state.draft.order.length === 0) return [];
  return roundRobin(state.draft.order, config.schedule.rounds.length);
}

/** The matchups of round `round`, scored as they stand (final once the round is finalized). */
export function roundMatchups(state: LeagueState, round: number): ReadonlyArray<MatchupResult> {
  return (schedule(state)[round - 1] ?? []).map(([home, away]) => {
    const homePoints = roundPoints(state, home, round);
    const awayPoints = roundPoints(state, away, round);
    return { round, home, away, homePoints, awayPoints, winner: homePoints === awayPoints ? null : homePoints > awayPoints ? home : away };
  });
}

/** Every finalized round's matchups, in order. */
export function matchups(state: LeagueState): ReadonlyArray<MatchupResult> {
  return [...state.finalizedRounds].sort((a, b) => a - b).flatMap((r) => roundMatchups(state, r));
}

/** Each tavern's total points over the finalized rounds. */
export function seasonPoints(state: LeagueState): ReadonlyMap<string, number> {
  const rounds = [...state.finalizedRounds];
  return new Map([...state.taverns.keys()].map((t) => [t, rounds.reduce((sum, r) => sum + roundPoints(state, t, r), 0)]));
}

/** The table over the finalized rounds: wins, then points. */
export function seasonStandings(state: LeagueState): ReadonlyArray<StandingRow> {
  const order = state.draft.order.length > 0 ? state.draft.order : [...state.taverns.keys()];
  return standings(order, matchups(state), seasonPoints(state));
}

/** The number of votes in the season (0 before `season.created`). */
export function seasonVotes(state: LeagueState): number {
  return state.config === null ? 0 : votesIn(state.config);
}

/**
 * The vote model's state after every vote in the log: replay the recorded
 * results through `applyEpisode` from the cast's cards. The cards (stats and
 * strategies) come from outside, since the log holds slugs, not stat blocks.
 */
export function contestState(state: LeagueState, cast: ReadonlyArray<Contestant>, model: VoteModel): ContestState {
  let s = initialContest(cast, model);
  for (const e of state.episodes) {
    if (e.challenge === null || e.vote === null) break;
    s = applyEpisode(s, { episode: e.episode, immune: e.challenge.result.winner, vote: e.vote }, model);
  }
  return s;
}
