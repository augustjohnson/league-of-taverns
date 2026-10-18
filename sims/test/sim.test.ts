import { describe, expect, it } from 'vitest';
import { contestSeed, episodesOf, replayLog, serializeEvent, verifyContest } from '@league-of-taverns/engine';
import { loadSeasonInput } from '../src/load';
import { ContestSession, aggregate, drawCast, runSeason, runSeed } from '../src/season-runner';

// The season runner on the lich season: a whole season with bots, start to finish.
const input = loadSeasonInput();
const sim1 = runSeason(input, { seed: 'sim-1' });
const { events, state, summary } = sim1;
const CAST = input.config.contest.castSize;
const VOTES = CAST - input.config.contest.finalists;
const ROUNDS = input.config.schedule.rounds.length;
const TAVERNS = input.managers.length;

describe('one seeded season', () => {
  it('runs from season.created to the last round and completes', () => {
    expect(events[0]!.type).toBe('season.created');
    expect(events.at(-1)).toMatchObject({ type: 'round.finalized', payload: { round: ROUNDS } });
    expect(state.phase).toBe('complete');
  });

  it('writes the events in lifecycle order', () => {
    const order = ['season.created', 'character.pooled', 'manager.joined', 'tavern.chosen', 'draft.pick', 'call.made', 'challenge.resolved', 'vote.resolved', 'finale.resolved', 'round.finalized'];
    const first = order.map((t) => events.findIndex((e) => e.type === t));
    expect(first.every((i) => i >= 0)).toBe(true);
    expect(first.slice(0, 5)).toEqual([...first.slice(0, 5)].sort((a, b) => a - b));
    expect(events.filter((e) => e.type === 'character.pooled')).toHaveLength(CAST);
    expect(events.filter((e) => e.type === 'vote.resolved')).toHaveLength(VOTES);
    expect(events.filter((e) => e.type === 'round.finalized')).toHaveLength(ROUNDS);
  });

  it('stamps contiguous seqs and ordered timestamps', () => {
    events.forEach((e, i) => expect(e.seq).toBe(i + 1));
    for (let i = 1; i < events.length; i++) expect(events[i]!.at >= events[i - 1]!.at).toBe(true);
  });

  it('replays from its NDJSON to the built state, and the contest follows from its seed', () => {
    expect(sim1.audit).toEqual({ replayMatches: true, mismatches: [] });
    expect(replayLog(sim1.ndjson).lastHash).toBe(state.lastHash);
    expect(verifyContest(events, input.statsOf)).toEqual([]);
    const challenge = events.find((e) => e.type === 'challenge.resolved')!;
    expect(challenge.type === 'challenge.resolved' && challenge.payload.seed).toBe(contestSeed(input.config.id, 'sim-1'));
  });

  it('drafts 3 each, closes a round after its last episode, and every tavern plays every other once', () => {
    expect([...state.taverns.values()].every((t) => t.roster.length === 3)).toBe(true);
    const rounds = events.flatMap((e, i) => (e.type === 'round.finalized' ? [{ round: e.payload.round, i }] : []));
    for (const { round, i } of rounds.slice(0, -1)) {
      const last = episodesOf(input.config, round).at(-1)!;
      expect(events[i - 1]).toMatchObject({ type: 'vote.resolved', payload: { episode: last } });
    }
    expect(summary.matchups).toBe((TAVERNS * (TAVERNS - 1)) / 2);
  });

  it('summarizes the cast with places 1..cast, the winner first', () => {
    expect(summary.cast.map((c) => c.place).sort((a, b) => a - b)).toEqual(Array.from({ length: CAST }, (_, i) => i + 1));
    expect(summary.cast.find((c) => c.place === 1)!.id).toBe(summary.winner);
    expect(summary.episodes).toHaveLength(VOTES);
  });
});

describe('determinism', () => {
  it('the same seed gives byte-identical NDJSON; another seed, another cast', () => {
    expect(runSeason(input, { seed: 'sim-1' }).ndjson).toBe(sim1.ndjson);
    expect(drawCast(input, 'sim-2')).not.toEqual(drawCast(input, 'sim-1'));
    expect(drawCast(input, 'sim-1')).toHaveLength(CAST);
  });

  it('every event is canonical', () => {
    expect(sim1.ndjson).toBe(`${events.map(serializeEvent).join('\n')}\n`);
  });

  it('run seeds: the base seed, then <seed>~<n>', () => {
    expect([1, 2, 3].map((n) => runSeed('x', n))).toEqual(['x', 'x~2', 'x~3']);
  });
});

describe('aggregate', () => {
  it('rolls seasons up per bot and for the contest', () => {
    const totals = aggregate([summary]);
    expect(totals.runs).toBe(1);
    expect(Object.values(totals.byBot).reduce((n, b) => n + b.seats, 0)).toBe(TAVERNS);
    expect(Object.values(totals.byBot).reduce((n, b) => n + b.titles, 0)).toBeCloseTo(1, 10);
    expect(totals.favouriteRate).toBeGreaterThanOrEqual(0);
    expect(totals.distinctWinners).toBe(1);
    expect(totals.powerPlacement).toBeGreaterThan(-1);
  });
});

describe('a session', () => {
  it('rejects a draft for a season with too few in the pool', () => {
    expect(() => new ContestSession({ ...input, pool: input.pool.slice(0, 5) }, { seed: 's' })).toThrow(/fewer than the cast/);
  });
});
