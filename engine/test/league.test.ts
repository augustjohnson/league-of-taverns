import { describe, expect, it } from 'vitest';
import { configIssues, standings, votesIn } from '../src/league';
import { miniConfig } from './support/league-log';

describe('the season shape', () => {
  const config = miniConfig();

  it('votes run until the finalists are left', () => {
    expect(votesIn(config)).toBe(8);
  });

  it('checks the contest fits the taverns', () => {
    expect(configIssues(config, 4)).toEqual([]);
    expect(configIssues(config, 6).join()).toMatch(/more than the cast/);
    expect(configIssues(miniConfig({ contest: { castSize: 2, finalists: 2, lapDc: 1, model: {} } }), 1).join()).toMatch(/must be more than finalists/);
  });
});

describe('standings', () => {
  it('ranks by total points; equal points share a rank, in the given order', () => {
    const rows = standings(['a', 'b', 'c', 'd'], new Map([['a', 14], ['b', 16], ['c', 14], ['d', 8]]));
    expect(rows.map((r) => [r.tavern, r.rank, r.points])).toEqual([
      ['b', 1, 16],
      ['a', 2, 14],
      ['c', 2, 14],
      ['d', 4, 8],
    ]);
  });

  it('gives every tavern a row, at zero before any points', () => {
    const rows = standings(['a', 'b'], new Map());
    expect(rows.map((r) => [r.tavern, r.rank, r.points])).toEqual([
      ['a', 1, 0],
      ['b', 1, 0],
    ]);
  });
});
