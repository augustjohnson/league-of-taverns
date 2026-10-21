import { describe, expect, it } from 'vitest';
import { applyEvent, InvalidEventError } from '../src/events/reducers';
import { aliveAt, episodeScore, episodeStage, finaleScore, seasonStandings, tavernPoints } from '../src/events/selectors';
import type { LeagueState } from '../src/events/state';
import type { EventOf, EventType } from '../src/events/types';
import { CAST, CHALLENGES, COMMISSIONER, LogBuilder, MANAGER, TAVERNS, draft, miniConfig, miniSeason, preseason, SEED } from './support/league-log';
import { challengeSha256, lineHash } from '../src/events/canonical';
import type { CrEighths } from '../src/vocabulary';

/** Apply one event to `state` at the next seq, and return the error code it is rejected with (or null). */
function codeOf<T extends EventType>(state: LeagueState, type: T, payload: EventOf<T>['payload']): string | null {
  const event = { v: 1, seq: state.lastSeq + 1, type, season: 'season-01', at: '2026-11-02T18:04:11Z', actor: COMMISSIONER, prev: null, payload } as unknown as EventOf<T>;
  try {
    applyEvent(state, event);
    return null;
  } catch (error) {
    if (error instanceof InvalidEventError) return error.code;
    throw error;
  }
}

const season = miniSeason();
const { afterPreseason, afterDraft, midEpisode1, final } = season;

describe('setup', () => {
  it('season.created checks the config and one commitment per episode', () => {
    const log = new LogBuilder();
    const empty = log.state;
    const base = { configSha256: lineHash('c'), engineVersion: '0', taverns: TAVERNS.map((id) => ({ id, name: id })), abilityMix: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0 } };
    const challenges = CHALLENGES.map((c, i) => ({ episode: i + 1, sha256: challengeSha256(c) }));
    expect(codeOf(empty, 'season.created', { ...base, config: miniConfig(), challenges })).toBeNull();
    expect(codeOf(empty, 'season.created', { ...base, config: miniConfig(), challenges: challenges.slice(1) })).toBe('season.bad_challenges');
    expect(codeOf(empty, 'season.created', { ...base, config: miniConfig({ roster: { size: 3 } }), challenges })).toBe('season.bad_config');
  });

  it('the cast fills to castSize, and the draft waits for it', () => {
    const log = new LogBuilder();
    preseason(log);
    expect(log.state.pool.size).toBe(10);
    expect(codeOf(log.state, 'character.pooled', { character: 'one-more', base: 'ogre', cr: 16 as CrEighths, modifiers: [], strategy: { kind: 'floater' } })).toBe('pool.cast_full');
  });

  it('the draft runs roster.size rounds, then the contest opens with everyone in', () => {
    expect(afterDraft.phase).toBe('contest');
    expect([...afterDraft.taverns.values()].every((t) => t.roster.length === 2)).toBe(true);
    expect(afterDraft.alive).toEqual(CAST.map((c) => c.id));
    expect(episodeStage(afterDraft)).toEqual({ episode: 1, stage: 'challenge' });
    expect(afterPreseason.phase).toBe('preseason');
  });
});

describe('calls', () => {
  const t = TAVERNS[1];

  it('a call before the challenge is early; one after it is late and replaces it', () => {
    const e1 = midEpisode1.calls.get(1)!;
    expect(e1.get(TAVERNS[1])!.early).toBe(true);
    const vote = final.calls.get(1)!.get(TAVERNS[0])!;
    expect(vote.early).toBe(false);
  });

  it('a call names a monster still in, for the open episode, never the immune one', () => {
    expect(codeOf(afterDraft, 'call.made', { episode: 1, tavern: t, target: 'char-03' })).toBeNull();
    expect(codeOf(afterDraft, 'call.made', { episode: 2, tavern: t, target: 'char-03' })).toBe('call.bad_episode');
    expect(codeOf(afterDraft, 'call.made', { episode: 1, tavern: 'the-nowhere', target: 'char-03' })).toBe('call.unknown_tavern');
    expect(codeOf(afterDraft, 'call.made', { episode: 1, tavern: t, target: 'char-99' })).toBe('call.not_in');
    const immune = midEpisode1.episodes[0]!.challenge!.result.winner;
    expect(codeOf(midEpisode1, 'call.made', { episode: 1, tavern: t, target: immune })).toBe('call.immune');
    expect(codeOf(afterPreseason, 'call.made', { episode: 1, tavern: t, target: 'char-03' })).toBe('call.wrong_phase');
  });
});

describe('the contest', () => {
  const challenge = (state: LeagueState, patch: Partial<EventOf<'challenge.resolved'>['payload']> = {}): string | null => {
    const real = season.log.events.find((e) => e.type === 'challenge.resolved' && e.payload.episode === 1) as EventOf<'challenge.resolved'>;
    return codeOf(state, 'challenge.resolved', { ...real.payload, ...patch });
  };
  const realVote = season.log.events.find((e) => e.type === 'vote.resolved' && e.payload.episode === 1) as EventOf<'vote.resolved'>;

  it('a challenge must match its commitment and eliminate down to its winner', () => {
    expect(challenge(afterDraft)).toBeNull();
    expect(challenge(afterDraft, { challenge: CHALLENGES[1]!, sha256: challengeSha256(CHALLENGES[1]!) })).toBe('challenge.commitment');
    const real = season.log.events.find((e) => e.type === 'challenge.resolved') as EventOf<'challenge.resolved'>;
    const loser = afterDraft.alive.find((id) => id !== real.payload.result.winner)!;
    expect(challenge(afterDraft, { result: { ...real.payload.result, winner: loser } })).toBe('challenge.result');
    expect(challenge(midEpisode1)).toBe('challenge.bad_episode');
  });

  it('a vote needs its challenge, legal ballots and the boot they give', () => {
    expect(codeOf(afterDraft, 'vote.resolved', realVote.payload)).toBe('vote.no_challenge');
    expect(codeOf(midEpisode1, 'vote.resolved', realVote.payload)).toBeNull();
    const other = midEpisode1.alive.find((id) => id !== realVote.payload.vote.boot && id !== midEpisode1.episodes[0]!.challenge!.result.winner)!;
    expect(codeOf(midEpisode1, 'vote.resolved', { episode: 1, vote: { ...realVote.payload.vote, boot: other } })).toBe('vote.result');
  });

  it('the finale comes after the last vote, once, and completes the season', () => {
    expect(codeOf(midEpisode1, 'finale.resolved', { result: final.finale! })).toBe('finale.votes_left');
    expect(codeOf(final, 'finale.resolved', { result: final.finale! })).toBe('finale.wrong_phase');
    expect(final.phase).toBe('complete');
  });

  it('the season ends with 8 voted out, 2 finalists and a winner', () => {
    expect(final.jury).toHaveLength(8);
    expect(final.alive).toHaveLength(2);
    expect(final.finale!.finalists).toEqual(final.alive);
  });
});

describe('scores and standings', () => {
  it('a vote scores survivors, immunity and a right call; the finale scores jury votes and the winner', () => {
    const { scoring } = miniConfig();
    for (const tavern of TAVERNS) {
      for (let e = 1; e <= 8; e++) {
        const roster = final.taverns.get(tavern)!.roster;
        const entry = final.episodes[e - 1]!;
        const survivors = roster.filter((id) => aliveAt(final, e).includes(id) && id !== entry.vote!.boot).length;
        const call = final.calls.get(e)!.get(tavern)!;
        const s = episodeScore(final, tavern, e);
        expect(s.survive).toBe(survivors * scoring.survive);
        expect(s.immunity).toBe(roster.includes(entry.challenge!.result.winner) ? scoring.immunity : 0);
        expect(s.call).toBe(call.target === entry.vote!.boot ? scoring.call : 0);
        expect(s.early).toBe(call.target === entry.vote!.boot && call.early ? scoring.earlyCallBonus : 0);
      }
    }
    const winner = final.finale!.winner;
    const owner = final.owner.get(winner);
    if (owner !== undefined) expect(finaleScore(final, owner).winner).toBe(miniConfig().scoring.winner);
  });

  it('the table ranks every tavern by its points over every vote and the finale', () => {
    const rows = seasonStandings(final);
    expect(rows.map((r) => r.tavern).sort()).toEqual([...TAVERNS].sort());
    for (const r of rows) {
      let sum = finaleScore(final, r.tavern).total;
      for (let e = 1; e <= 8; e++) sum += episodeScore(final, r.tavern, e).total;
      expect(r.points).toBe(sum);
      expect(tavernPoints(final, r.tavern)).toBe(sum);
    }
    expect(rows.map((r) => r.points)).toEqual([...rows.map((r) => r.points)].sort((a, b) => b - a));
    expect(rows[0]!.rank).toBe(1);
  });

  it('counts only votes held: before the first vote, every tavern is at zero', () => {
    for (const r of seasonStandings(midEpisode1)) expect(r.points).toBe(0);
  });
});

describe('a log with a person', () => {
  it('draft and contest work for any actor; the reducers never read it', () => {
    const log = new LogBuilder();
    preseason(log);
    draft(log);
    const t = TAVERNS[0];
    log.append('call.made', { episode: 1, tavern: t, target: log.state.alive[1]! }, MANAGER);
    expect(log.state.calls.get(1)!.get(t)!.target).toBe(log.state.alive[1]);
    expect(SEED).toBe('season-01/contest/salt:mini');
  });
});
