/**
 * The share: after each vote, a few lines of plain text you can paste into
 * a group chat, Wordle style. It says how your exit prediction did, how each
 * of your monsters did, and where your head-to-head stands. It names no one,
 * so it spoils nothing. Pure (no DOM): feed.ts builds one per vote and play.ts
 * shows it under the vote with a Copy button.
 */
import { aliveAt, roundOf, roundPoints, schedule, seasonVotes } from '@league-of-taverns/engine';
import type { LeagueState } from '@league-of-taverns/engine';

/** Your exit prediction at a vote. */
export const CALL_MARKS = {
  early: '🎯',
  right: '✅',
  close: '🤏',
  missed: '❌',
  none: '💤',
} as const;

/** One of your monsters at a vote, or at the finale. */
export const FACES = {
  safe: '😌',
  scared: '😰',
  immune: '🛡️',
  out: '💀',
  gone: '🪦',
  winner: '👑',
  finalist: '🏅',
} as const;

export type CallMark = (typeof CALL_MARKS)[keyof typeof CALL_MARKS];
export type Face = (typeof FACES)[keyof typeof FACES];

/** What each emoji means, for teaching it the first time it shows up. */
export const MEANINGS: Readonly<Record<CallMark | Face, string>> = {
  '🎯': 'Exit prediction right, made before the challenge',
  '✅': 'Exit prediction right',
  '🤏': 'Close: your pick drew votes but stayed',
  '❌': 'Missed: your pick drew no votes',
  '💤': 'No prediction made',
  '😌': 'Safe: no votes against',
  '😰': 'Survived, but drew votes',
  '🛡️': 'Won immunity',
  '💀': 'Voted out at this vote',
  '🪦': 'Voted out earlier',
  '👑': "Won the contest: the Lich's new assistant",
  '🏅': 'Reached the final',
};

export interface HeadToHead {
  readonly mine: number;
  readonly theirs: number;
  /** The rival's tavern name, or null when you have no matchup this round. */
  readonly rival: string | null;
}

export type Share =
  | { readonly kind: 'vote'; readonly episode: number; readonly votes: number; readonly call: CallMark; readonly faces: ReadonlyArray<Face>; readonly h2h: HeadToHead | null }
  | { readonly kind: 'finale'; readonly right: number; readonly votes: number; readonly faces: ReadonlyArray<Face>; readonly h2h: HeadToHead | null };

/** `me`'s share for `episode`'s vote, from the state just after it. Null before the vote or without a tavern. */
export function voteShare(state: LeagueState, me: string, episode: number): Share | null {
  const config = state.config;
  const entry = state.episodes[episode - 1];
  const tavern = state.taverns.get(me);
  if (config === null || tavern === undefined || entry?.vote == null || entry.challenge === null) return null;
  const { vote } = entry;
  const drew = new Set([...vote.ballots, ...(vote.revote?.ballots ?? [])].map((b) => b.target));
  const call = state.calls.get(episode)?.get(me);
  const mark: CallMark =
    call === undefined ? CALL_MARKS.none
    : call.target === vote.boot ? (call.early ? CALL_MARKS.early : CALL_MARKS.right)
    : drew.has(call.target) ? CALL_MARKS.close
    : CALL_MARKS.missed;
  const alive = new Set(aliveAt(state, episode));
  const faces = tavern.roster.map((id): Face =>
    !alive.has(id) ? FACES.gone
    : id === vote.boot ? FACES.out
    : id === entry.challenge!.result.winner ? FACES.immune
    : drew.has(id) ? FACES.scared
    : FACES.safe,
  );
  return { kind: 'vote', episode, votes: seasonVotes(state), call: mark, faces, h2h: headToHead(state, me, roundOf(config, episode)) };
}

/** `me`'s share for the finale. Null before it or without a tavern. */
export function finaleShare(state: LeagueState, me: string): Share | null {
  const config = state.config;
  const finale = state.finale;
  const tavern = state.taverns.get(me);
  if (config === null || finale === null || tavern === undefined) return null;
  let right = 0;
  for (const [i, entry] of state.episodes.entries()) {
    if (entry.vote != null && state.calls.get(i + 1)?.get(me)?.target === entry.vote.boot) right++;
  }
  const faces = tavern.roster.map((id): Face => (id === finale.winner ? FACES.winner : finale.finalists.includes(id) ? FACES.finalist : FACES.gone));
  return { kind: 'finale', right, votes: seasonVotes(state), faces, h2h: headToHead(state, me, config.schedule.rounds.length) };
}

function headToHead(state: LeagueState, me: string, round: number): HeadToHead | null {
  const pair = schedule(state)[round - 1]?.find(([home, away]) => home === me || away === me);
  if (pair === undefined) return null;
  const rival = pair[0] === me ? pair[1] : pair[0];
  return { mine: roundPoints(state, me, round), theirs: roundPoints(state, rival, round), rival: state.taverns.get(rival)?.name ?? rival };
}

/**
 * The longest line, in characters, that fits a chat bubble on a small phone
 * without wrapping (an iMessage bubble on a 375-point screen holds about 28).
 */
export const SHARE_LINE_MAX = 28;

/** The head-to-head score, with the rival on its own line when one line would wrap. */
function scoreLines(h2h: HeadToHead): ReadonlyArray<string> {
  const score = `${h2h.mine}–${h2h.theirs}`;
  if (h2h.rival === null) return [score];
  const line = `${score} (${h2h.rival})`;
  return [...line].length <= SHARE_LINE_MAX ? [line] : [score, `(${h2h.rival})`];
}

/** The share as the text you paste. */
export function shareText(share: Share): string {
  return [
    share.kind === 'vote' ? `Vote ${share.episode} of ${share.votes}` : 'The finale',
    'Exit Prediction:',
    share.kind === 'vote' ? share.call : `${share.right} of ${share.votes}`,
    'My Tavern:',
    share.faces.join(''),
    ...(share.h2h === null ? [] : ['Head to Head:', ...scoreLines(share.h2h)]),
  ].join('\n');
}

/** The emoji in a share, in the order MEANINGS lists them. */
export function shareEmoji(share: Share): ReadonlyArray<CallMark | Face> {
  const used = new Set<string>([...(share.kind === 'vote' ? [share.call] : []), ...share.faces]);
  return (Object.keys(MEANINGS) as Array<CallMark | Face>).filter((e) => used.has(e));
}
