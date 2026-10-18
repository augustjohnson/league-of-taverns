import { describe, expect, it } from 'vitest';
import { configIssues, episodesOf, roundOf, roundRobin, standings, votesIn, type MatchupResult } from '../src/league';
import { miniConfig } from './support/league-log';

describe('the season shape', () => {
  const config = miniConfig();

  it('votes run until the finalists are left', () => {
    expect(votesIn(config)).toBe(8);
  });

  it('maps episodes to head-to-head rounds and back', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((e) => roundOf(config, e))).toEqual([1, 1, 1, 2, 2, 2, 3, 3]);
    expect(episodesOf(config, 2)).toEqual([4, 5, 6]);
    expect(() => roundOf(config, 9)).toThrow(/past the schedule/);
  });

  it('checks the contest fits the taverns and the schedule covers the votes', () => {
    expect(configIssues(config, 4)).toEqual([]);
    expect(configIssues(config, 6).join()).toMatch(/more than the cast/);
    expect(configIssues(miniConfig({ schedule: { rounds: [3, 3] } }), 4).join()).toMatch(/cover 6 episodes/);
    expect(configIssues(miniConfig({ contest: { castSize: 2, finalists: 2, lapDc: 1, model: {} } }), 1).join()).toMatch(/must be more than finalists/);
  });
});

describe('round-robin', () => {
  it('meets every pair exactly once in n − 1 rounds, each tavern once a round', () => {
    const taverns = ['a', 'b', 'c', 'd', 'e', 'f'];
    const rounds = roundRobin(taverns, 5);
    const pairs = new Set<string>();
    for (const round of rounds) {
      expect(round).toHaveLength(3);
      expect(new Set(round.flat()).size).toBe(6);
      for (const [x, y] of round) pairs.add([x, y].sort().join('-'));
    }
    expect(pairs.size).toBe(15);
  });

  it('gives one tavern a bye each round when the count is odd', () => {
    const rounds = roundRobin(['a', 'b', 'c'], 3);
    expect(rounds.every((r) => r.length === 1)).toBe(true);
    expect(new Set(rounds.map((r) => r[0]!.slice().sort().join('-'))).size).toBe(3);
  });
});

describe('standings', () => {
  const m = (round: number, home: string, away: string, h: number, a: number): MatchupResult => ({
    round,
    home,
    away,
    homePoints: h,
    awayPoints: a,
    winner: h === a ? null : h > a ? home : away,
  });

  it('ranks by record (a tie counts half), then points', () => {
    const rows = standings(['a', 'b', 'c', 'd'], [m(1, 'a', 'b', 10, 5), m(1, 'c', 'd', 7, 7), m(2, 'a', 'c', 4, 9), m(2, 'b', 'd', 8, 1)], new Map([['a', 14], ['b', 13], ['c', 16], ['d', 8]]));
    expect(rows.map((r) => [r.tavern, r.rank, r.wins, r.losses, r.ties])).toEqual([
      ['c', 1, 1, 0, 1],
      ['a', 2, 1, 1, 0],
      ['b', 3, 1, 1, 0],
      ['d', 4, 0, 1, 1],
    ]);
  });

  it('taverns level on record and points share a rank', () => {
    const rows = standings(['a', 'b'], [], new Map());
    expect(rows.map((r) => r.rank)).toEqual([1, 1]);
  });
});
