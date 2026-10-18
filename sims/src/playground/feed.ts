/**
 * The Common Room's messages: the league's event log, read out as the
 * contest's one running story. Pure (no DOM), so tests run it in Node;
 * play.ts renders each item as a message and paces their arrival.
 *
 * The room shows the league as someone at the bar would see it: every
 * tavern's picks, every challenge and every ballot, but no rival's call
 * until the vote is read (your own call shows to you at once). Items are
 * keyed, so a re-render keeps a message that hasn't changed.
 */
import { applyEvent, episodeScore, finaleScore, initialState, roundMatchups, seasonStandings } from '@league-of-taverns/engine';
import type { Challenge, ChallengeResult, FinaleResult, LeagueEvent, LeagueState, MatchupResult, ScoreLine, VoteResult } from '@league-of-taverns/engine';
import { draftCalls, tableMoves, type DraftCall } from './view';

export interface FeedTableRow {
  readonly tavern: string;
  readonly rank: number;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly points: number;
  /** The row the tavern stood in after the round before (0-based), and the places it rose since. */
  readonly wasRow: number;
  readonly rose: number;
}

/** One tavern at a vote: its call (null for none), and what it scored. */
export interface FeedCall {
  readonly tavern: string;
  readonly target: string | null;
  readonly early: boolean;
  readonly right: boolean;
  readonly score: ScoreLine;
}

export type FeedItem =
  | { readonly kind: 'divider'; readonly key: string; readonly label: string }
  | { readonly kind: 'season'; readonly key: string; readonly managers: ReadonlyArray<string>; readonly cast: ReadonlyArray<string> }
  | { readonly kind: 'tavern'; readonly key: string; readonly seq: number; readonly manager: string; readonly tavern: string }
  | {
      readonly kind: 'draft-round';
      readonly key: string;
      readonly round: number;
      readonly calls: ReadonlyArray<DraftCall & { readonly seq: number }>;
      /** Every tavern has picked in this round. */
      readonly complete: boolean;
    }
  | { readonly kind: 'draft-done'; readonly key: string; readonly rounds: number; readonly undrafted: ReadonlyArray<string> }
  | { readonly kind: 'episode-open'; readonly key: string; readonly episode: number; readonly round: number; readonly alive: ReadonlyArray<string> }
  | {
      readonly kind: 'call';
      readonly key: string;
      readonly seq: number;
      readonly episode: number;
      readonly tavern: string;
      /** Only for your own call; a rival's is sealed until the vote. */
      readonly target: string | null;
      readonly early: boolean;
      /** It replaces the tavern's earlier call this episode. */
      readonly change: boolean;
    }
  | { readonly kind: 'challenge'; readonly key: string; readonly seq: number; readonly episode: number; readonly challenge: Challenge; readonly result: ChallengeResult; readonly field: ReadonlyArray<string> }
  | {
      readonly kind: 'vote';
      readonly key: string;
      readonly seq: number;
      readonly episode: number;
      readonly immune: string;
      readonly vote: VoteResult;
      readonly calls: ReadonlyArray<FeedCall>;
      /** Monsters still in after the vote. */
      readonly left: number;
    }
  | { readonly kind: 'finale'; readonly key: string; readonly seq: number; readonly result: FinaleResult; readonly scores: ReadonlyArray<{ readonly tavern: string; readonly score: ScoreLine }> }
  | { readonly kind: 'round'; readonly key: string; readonly seq: number; readonly round: number; readonly matchups: ReadonlyArray<MatchupResult>; readonly rows: ReadonlyArray<FeedTableRow>; readonly final: boolean };

export type FeedKind = FeedItem['kind'];

export interface FeedOptions {
  /** Your tavern, or null (before you choose one, or a season of bots). Your own call shows at once; rivals' wait for the vote. */
  readonly me: string | null;
  /** Taverns in the season (= managers), for the draft's rounds. */
  readonly teams: number;
  /** Rounds in the draft. */
  readonly rounds: number;
  /** The scouts' rank of each cast member, for the crier's steals and reaches. */
  readonly ranks: ReadonlyMap<string, number>;
}

/** The room's items for `events`, in the order they happened. */
export function feedItems(events: ReadonlyArray<LeagueEvent>, opts: FeedOptions): ReadonlyArray<FeedItem> {
  const items: FeedItem[] = [];
  const managers: string[] = [];
  const cast: string[] = [];
  let seasonShown = false;
  const picks: Array<{ pick: number; tavern: string; character: string; seq: number }> = [];
  let state: LeagueState = initialState();
  let lastTable: ReadonlyArray<{ tavern: string; rank: number }> | null = null;
  const called = new Map<string, number>();

  const showSeason = (): void => {
    if (seasonShown) return;
    seasonShown = true;
    items.push({ kind: 'divider', key: 'divider:season', label: 'Before the contest' }, { kind: 'season', key: 'season', managers: [...managers], cast: [...cast] });
  };
  const openEpisode = (episode: number): void => {
    const round = roundIndex(state, episode);
    items.push({ kind: 'divider', key: `divider:episode:${episode}`, label: `Episode ${episode}` }, { kind: 'episode-open', key: `episode-open:${episode}`, episode, round, alive: [...state.alive] });
  };
  /** Draft picks so far, as rounds: a round's item grows pick by pick, so it is rebuilt each time. */
  const roundItem = (round: number): FeedItem => {
    const seqOf = new Map(picks.map((p) => [p.pick, p.seq]));
    const calls = draftCalls(picks, opts.ranks)
      .filter((c) => Math.floor(c.pick / opts.teams) === round)
      .map((c) => ({ ...c, seq: seqOf.get(c.pick)! }));
    return { kind: 'draft-round', key: `draft-round:${round}`, round: round + 1, calls, complete: calls.length === opts.teams };
  };

  for (const e of events) {
    state = applyEvent(state, e);
    switch (e.type) {
      case 'character.pooled':
        cast.push(e.payload.character);
        break;
      case 'manager.joined':
        managers.push(e.payload.manager);
        break;
      case 'tavern.chosen':
        showSeason();
        if (!items.some((it) => it.key === 'divider:taverns')) items.push({ kind: 'divider', key: 'divider:taverns', label: 'The tavern pick' });
        items.push({ kind: 'tavern', key: `tavern:${e.payload.tavern}`, seq: e.seq, manager: e.payload.manager, tavern: e.payload.tavern });
        break;
      case 'draft.pick': {
        const { pick, tavern, character } = e.payload;
        if (picks.length === 0) items.push({ kind: 'divider', key: 'divider:draft', label: 'The draft' });
        picks.push({ pick, tavern, character, seq: e.seq });
        const round = Math.floor(pick / opts.teams);
        const at = items.findIndex((it) => it.key === `draft-round:${round}`);
        if (at < 0) items.push(roundItem(round));
        else items[at] = roundItem(round);
        if (state.draft.complete) {
          items.push({ kind: 'draft-done', key: 'draft-done', rounds: opts.rounds, undrafted: cast.filter((id) => !state.owner.has(id)) });
          openEpisode(1);
        }
        break;
      }
      case 'call.made': {
        const { episode, tavern, target } = e.payload;
        const k = `${episode}:${tavern}`;
        const n = (called.get(k) ?? 0) + 1;
        called.set(k, n);
        const early = state.episodes[episode - 1]?.challenge == null;
        const mine = opts.me !== null && tavern === opts.me;
        items.push({ kind: 'call', key: `call:${e.seq}`, seq: e.seq, episode, tavern, target: mine ? target : null, early, change: n > 1 });
        break;
      }
      case 'challenge.resolved': {
        const { episode, challenge, result } = e.payload;
        items.push({ kind: 'challenge', key: `challenge:${episode}`, seq: e.seq, episode, challenge, result, field: result.rounds[0]?.rolls.map((r) => r.id) ?? [result.winner] });
        break;
      }
      case 'vote.resolved': {
        const { episode, vote } = e.payload;
        const immune = state.episodes[episode - 1]!.challenge!.result.winner;
        const standing = state.calls.get(episode);
        const calls = [...state.taverns.keys()].map((tavern): FeedCall => {
          const c = standing?.get(tavern);
          return { tavern, target: c?.target ?? null, early: c?.early ?? false, right: c !== undefined && c.target === vote.boot, score: episodeScore(state, tavern, episode) };
        });
        items.push({ kind: 'vote', key: `vote:${episode}`, seq: e.seq, episode, immune, vote, calls, left: state.alive.length });
        if (state.config !== null && state.jury.length < state.config.contest.castSize - state.config.contest.finalists) openEpisode(episode + 1);
        break;
      }
      case 'finale.resolved':
        items.push({ kind: 'divider', key: 'divider:finale', label: 'The finale' });
        items.push({ kind: 'finale', key: 'finale', seq: e.seq, result: e.payload.result, scores: [...state.taverns.keys()].map((tavern) => ({ tavern, score: finaleScore(state, tavern) })) });
        break;
      case 'round.finalized': {
        const { round } = e.payload;
        const table = seasonStandings(state);
        const moves = tableMoves(lastTable ?? table, table);
        const final = state.phase === 'complete';
        items.push({
          kind: 'round',
          key: `round:${round}`,
          seq: e.seq,
          round,
          matchups: roundMatchups(state, round),
          rows: table.map((r) => ({ tavern: r.tavern, rank: r.rank, wins: r.wins, losses: r.losses, ties: r.ties, points: r.points, wasRow: moves.get(r.tavern)?.wasRow ?? 0, rose: moves.get(r.tavern)?.rose ?? 0 })),
          final,
        });
        lastTable = table;
        break;
      }
      default:
        break;
    }
  }
  if (!seasonShown && managers.length > 0) showSeason();
  return items;
}

/** The head-to-head round an episode is in (1-based). */
function roundIndex(state: LeagueState, episode: number): number {
  const rounds = state.config?.schedule.rounds ?? [];
  let end = 0;
  for (const [i, n] of rounds.entries()) {
    end += n;
    if (episode <= end) return i + 1;
  }
  return rounds.length;
}

/** The round of the latest draft pick in `items`, or 0 before the draft: earlier rounds fold once the next starts. */
export function currentDraftRound(items: ReadonlyArray<FeedItem>): number {
  let round = 0;
  for (const it of items) if (it.kind === 'draft-round') round = it.round;
  return round;
}

/** The latest episode opened in `items`, or 0: its messages stay open, earlier ones fold away. */
export function latestEpisode(items: ReadonlyArray<FeedItem>): number {
  let episode = 0;
  for (const it of items) if (it.kind === 'episode-open') episode = it.episode;
  return episode;
}
