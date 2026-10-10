import { describe, expect, it } from 'vitest';
import {
  headToHeadSchedule,
  matchupWinner,
  standings,
  type Matchup,
  type SeasonConfig,
  type WeekResult,
} from '../src/league';
import { draftOrder, snakePickOwner } from '../src/roster';
import type { Rng } from '../src/rng';
import type { CrEighths } from '../src/vocabulary';

// T4.3, T4.6.

/** Deterministic stand-in for rngFor: cycles through `values`, counting draws. */
function fakeRng(values: ReadonlyArray<number>): Rng & { draws: number } {
  let i = 0;
  const rng = (() => {
    rng.draws++;
    return values[i++ % values.length]!;
  }) as Rng & { draws: number };
  rng.draws = 0;
  return rng;
}

function makeConfig(overrides: {
  order?: SeasonConfig['draft']['order'];
  tiebreakers?: SeasonConfig['scoring']['tiebreakers'];
} = {}): SeasonConfig {
  return {
    id: 'season-test',
    snapshot: 'open5e-test',
    modifierRegistryVersion: 1,
    weeks: 6,
    budget: { partyCr: (12 * 8) as CrEighths, modifierPointsPerCharacter: 3 },
    roster: { size: 7, starters: 4, ownership: 'exclusive' },
    draft: { format: 'snake', rounds: 7, order: overrides.order ?? { mode: 'seeded' }, pickWindowHours: 24, onTimeout: 'autopick' },
    matchups: { format: 'head_to_head', playoffs: { enabled: false, teams: 4, weeks: [] } },
    scoring: { pointsScale: 100, tiebreakers: overrides.tiebreakers ?? ['projected', 'checks_passed', 'seeded_coin'] },
    waivers: { priority: 'rolling', initialOrder: 'reverse_draft' },
    trades: { vetoWindowHours: 24, vetoBy: 'commissioner', deadlineWeek: 4 },
    missedLineup: 'carry_over',
    schedules: { lineupLock: '0 18 * * 4', weeklyRun: '15 18 * * 4', waivers: '0 12 * * 5' },
    secrecy: 'encrypted',
    seedSalt: 'none',
    missions: {} as SeasonConfig['missions'],
    carryover: { mode: 'none', keepersPerTavern: 0, keeperCost: 'none', championBonusKeepers: 0, maxModifierChangePoints: 0 },
  };
}

const taverns = (n: number): string[] => Array.from({ length: n }, (_, i) => `t${i}`);
const pairKey = (a: string, b: string): string => [a, b].sort().join('|');

describe('draftOrder', () => {
  const four = ['a', 'b', 'c', 'd'] as const;

  it('same fake rng gives the same order, and it is a permutation drawing n − 1 values', () => {
    const values = [0.42, 0.17, 0.93, 0.6];
    const r1 = fakeRng(values);
    const r2 = fakeRng(values);
    const o1 = draftOrder(four, makeConfig(), r1);
    const o2 = draftOrder(four, makeConfig(), r2);
    expect(o1).toEqual(o2);
    expect([...o1].sort()).toEqual([...four]);
    expect(r1.draws).toBe(3);
  });

  it('is a Fisher–Yates shuffle of the input', () => {
    // j = i every step: identity.
    expect(draftOrder(four, makeConfig(), fakeRng([0.999]))).toEqual(['a', 'b', 'c', 'd']);
    // j = 0 every step: [d,b,c,a] → [c,b,d,a] → [b,c,d,a].
    expect(draftOrder(four, makeConfig(), fakeRng([0]))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('different rng streams can give different orders', () => {
    const orders = new Set([0, 0.3, 0.6, 0.999].map((v) => draftOrder(four, makeConfig(), fakeRng([v])).join()));
    expect(orders.size).toBeGreaterThan(1);
  });

  it('never mutates the input', () => {
    const input = ['a', 'b', 'c', 'd'];
    draftOrder(input, makeConfig(), fakeRng([0]));
    expect(input).toEqual(['a', 'b', 'c', 'd']);
  });

  it('manual mode returns the configured permutation without drawing', () => {
    const rng = fakeRng([0.5]);
    const config = makeConfig({ order: { mode: 'manual', taverns: ['c', 'a', 'd', 'b'] } });
    expect(draftOrder(four, config, rng)).toEqual(['c', 'a', 'd', 'b']);
    expect(rng.draws).toBe(0);
  });

  it('manual mode rejects lists that are not a permutation of the taverns', () => {
    const manual = (list: string[]) => () => draftOrder(four, makeConfig({ order: { mode: 'manual', taverns: list } }), fakeRng([0]));
    expect(manual(['a', 'b', 'c'])).toThrow(/missing.*"d"/);
    expect(manual(['a', 'b', 'c', 'd', 'e'])).toThrow(/unknown tavern "e"/);
    expect(manual(['a', 'b', 'c', 'c'])).toThrow(/"c" more than once/);
  });

  it('rejects duplicate taverns', () => {
    expect(() => draftOrder(['a', 'a'], makeConfig(), fakeRng([0]))).toThrow(/duplicates/);
  });
});

describe('snakePickOwner', () => {
  it('runs A B C C B A A B C … for three taverns', () => {
    const order = ['A', 'B', 'C'];
    expect(Array.from({ length: 9 }, (_, p) => snakePickOwner(order, p)).join(' ')).toBe('A B C C B A A B C');
  });

  it.each([3, 4, 5])('reverses on odd rounds for %i taverns across five rounds', (n) => {
    const order = taverns(n);
    const expected = Array.from({ length: 5 }, (_, round) => (round % 2 === 0 ? order : [...order].reverse())).flat();
    expect(expected.map((_, p) => snakePickOwner(order, p))).toEqual(expected);
  });

  it('gives each tavern exactly one pick per round', () => {
    const order = taverns(5);
    for (let round = 0; round < 7; round++) {
      const picks = order.map((_, slot) => snakePickOwner(order, round * order.length + slot));
      expect([...picks].sort()).toEqual([...order].sort());
    }
  });

  it('throws on a negative or non-integer pick, or an empty order', () => {
    expect(() => snakePickOwner(['a'], -1)).toThrow(/non-negative/);
    expect(() => snakePickOwner(['a'], 1.5)).toThrow(/non-negative integer/);
    expect(() => snakePickOwner([], 0)).toThrow(/empty/);
  });
});

describe('headToHeadSchedule', () => {
  it('never books a tavern twice in one week', () => {
    for (let n = 2; n <= 10; n++) {
      const schedule = headToHeadSchedule(taverns(n), 2 * n + 1);
      const byWeek = new Map<number, string[]>();
      for (const m of schedule) {
        expect(m.home).not.toBe(m.away);
        byWeek.set(m.week, [...(byWeek.get(m.week) ?? []), m.home, m.away]);
      }
      for (const booked of byWeek.values()) expect(new Set(booked).size).toBe(booked.length);
      expect(byWeek.size).toBe(2 * n + 1);
    }
  });

  it('with 4 taverns over 3 weeks, everyone plays everyone exactly once', () => {
    const schedule = headToHeadSchedule(['a', 'b', 'c', 'd'], 3);
    expect(schedule).toHaveLength(6);
    expect(new Set(schedule.map((m) => pairKey(m.home, m.away))).size).toBe(6);
    expect(new Set(schedule.map((m) => m.week))).toEqual(new Set([1, 2, 3]));
  });

  it.each([3, 5, 7])('with %i taverns, each tavern gets exactly one bye per cycle and meets everyone once', (n) => {
    const ts = taverns(n);
    const schedule = headToHeadSchedule(ts, n);
    expect(schedule).toHaveLength((n * (n - 1)) / 2);
    expect(new Set(schedule.map((m) => pairKey(m.home, m.away))).size).toBe((n * (n - 1)) / 2);
    for (const t of ts) {
      const weeksPlayed = schedule.filter((m) => m.home === t || m.away === t).map((m) => m.week);
      expect(weeksPlayed).toHaveLength(n - 1);
    }
    for (let week = 1; week <= n; week++) {
      expect(schedule.filter((m) => m.week === week)).toHaveLength((n - 1) / 2);
    }
  });

  it.each([4, 5, 6])('weeks beyond a cycle repeat it with home and away swapped (%i taverns)', (n) => {
    const cycle = n % 2 === 0 ? n - 1 : n;
    const schedule = headToHeadSchedule(taverns(n), 3 * cycle);
    const week = (w: number) => schedule.filter((m) => m.week === w);
    for (let w = 1; w <= cycle; w++) {
      const mirrored = week(w).map((m) => ({ week: w + cycle, home: m.away, away: m.home }));
      expect(week(w + cycle)).toEqual(mirrored);
      expect(week(w + 2 * cycle)).toEqual(week(w).map((m) => ({ ...m, week: w + 2 * cycle })));
    }
  });

  it('balances home and away: equal over two cycles, at most three in a row', () => {
    for (let n = 2; n <= 12; n++) {
      const ts = taverns(n);
      const cycle = n % 2 === 0 ? n - 1 : n;
      const schedule = headToHeadSchedule(ts, 2 * cycle);
      for (const t of ts) {
        const seq = schedule.filter((m) => m.home === t || m.away === t).map((m) => (m.home === t ? 'H' : 'A'));
        expect(seq.filter((x) => x === 'H').length).toBe(seq.length / 2);
        expect(seq.slice(0, seq.length / 2).join('')).not.toMatch(/HHHH|AAAA/);
      }
    }
  });

  it('is deterministic for a given input order', () => {
    expect(headToHeadSchedule(taverns(6), 6)).toEqual(headToHeadSchedule(taverns(6), 6));
  });

  it('handles degenerate input', () => {
    expect(headToHeadSchedule(taverns(4), 0)).toEqual([]);
    expect(headToHeadSchedule(['solo'], 3)).toEqual([]);
    expect(headToHeadSchedule([], 3)).toEqual([]);
    expect(() => headToHeadSchedule(taverns(4), -1)).toThrow();
    expect(() => headToHeadSchedule(['a', 'a'], 1)).toThrow(/duplicates/);
  });
});

describe('standings', () => {
  const result = (week: number, tavern: string, points: number, projected = 0, checksPassed = 0): WeekResult => ({
    week,
    tavern,
    points,
    projected,
    checksPassed,
  });
  const one: ReadonlyArray<Matchup> = [{ week: 1, home: 'h', away: 'a' }];
  const record = (rows: ReturnType<typeof standings>, tavern: string) => {
    const r = rows.find((x) => x.tavern === tavern)!;
    return `${r.wins}-${r.losses}-${r.ties}`;
  };

  it('higher points wins and points for/against accumulate', () => {
    const rows = standings(one, [result(1, 'h', 50), result(1, 'a', 70)], makeConfig(), fakeRng([0.1]));
    expect(rows).toEqual([
      { tavern: 'a', wins: 1, losses: 0, ties: 0, pointsFor: 70, pointsAgainst: 50 },
      { tavern: 'h', wins: 0, losses: 1, ties: 0, pointsFor: 50, pointsAgainst: 70 },
    ]);
  });

  it('projected breaks a points tie (higher wins)', () => {
    const rng = fakeRng([0.1]);
    const rows = standings(one, [result(1, 'h', 50, 40, 9), result(1, 'a', 50, 60, 0)], makeConfig(), rng);
    expect(record(rows, 'a')).toBe('1-0-0');
    expect(rng.draws).toBe(0);
  });

  it('checks_passed breaks a points and projected tie (higher wins)', () => {
    const rng = fakeRng([0.9]);
    const rows = standings(one, [result(1, 'h', 50, 60, 3), result(1, 'a', 50, 60, 2)], makeConfig(), rng);
    expect(record(rows, 'h')).toBe('1-0-0');
    expect(rng.draws).toBe(0);
  });

  it('seeded_coin decides a full tie from the rng: < 0.5 home, else away', () => {
    const tied = [result(1, 'h', 0, 60, 2), result(1, 'a', 0, 60, 2)];
    expect(record(standings(one, tied, makeConfig(), fakeRng([0.1])), 'h')).toBe('1-0-0');
    expect(record(standings(one, tied, makeConfig(), fakeRng([0.9])), 'a')).toBe('1-0-0');
  });

  it('applies tiebreakers in config order', () => {
    const rs = [result(1, 'h', 50, 60, 1), result(1, 'a', 50, 40, 5)];
    expect(record(standings(one, rs, makeConfig({ tiebreakers: ['projected', 'checks_passed'] }), fakeRng([0])), 'h')).toBe('1-0-0');
    expect(record(standings(one, rs, makeConfig({ tiebreakers: ['checks_passed', 'projected'] }), fakeRng([0])), 'a')).toBe('1-0-0');
  });

  it('counts a tie when no tiebreaker separates them', () => {
    const tied = [result(1, 'h', 50, 60, 2), result(1, 'a', 50, 60, 2)];
    const rng = fakeRng([0.1]);
    const rows = standings(one, tied, makeConfig({ tiebreakers: ['projected', 'checks_passed'] }), rng);
    expect(record(rows, 'h')).toBe('0-0-1');
    expect(record(rows, 'a')).toBe('0-0-1');
    expect(rng.draws).toBe(0);
    expect(matchupWinner(tied[0]!, tied[1]!, [], rng)).toBe('tie');
  });

  it('sorts by wins, then points for, then points against, then tavern id; includes taverns with no games', () => {
    const matchups: Matchup[] = [
      { week: 1, home: 'b', away: 'a' },
      { week: 1, home: 'd', away: 'c' },
      { week: 1, home: 'e', away: 'f' },
      { week: 2, home: 'a', away: 'c' },
      { week: 2, home: 'b', away: 'd' },
      { week: 2, home: 'e', away: 'z' }, // z never reports: skipped
    ];
    const results = [
      result(1, 'b', 80),
      result(1, 'a', 60),
      result(1, 'd', 70),
      result(1, 'c', 60),
      result(1, 'e', 70),
      result(1, 'f', 60),
      result(2, 'a', 40),
      result(2, 'c', 30),
      result(2, 'b', 10),
      result(2, 'd', 20),
      result(2, 'e', 99),
    ];
    const rows = standings(matchups, results, makeConfig(), fakeRng([0.5]));
    // a: 1-1 PF100 PA110 · b: 1-1 PF90 PA80 · c: 0-2 PF90 PA110 · d: 2-0 PF90 PA70
    // e: 1-0 PF70 PA60 (week 2 skipped) · f: 0-1 PF60 PA70 · z: no games.
    expect(rows.map((r) => r.tavern)).toEqual(['d', 'a', 'b', 'e', 'c', 'f', 'z']);
    expect(rows.find((r) => r.tavern === 'z')).toEqual({ tavern: 'z', wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 });
    expect(rows.find((r) => r.tavern === 'e')).toMatchObject({ wins: 1, pointsFor: 70, pointsAgainst: 60 });
  });

  it('breaks full standings ties by points against, then tavern id', () => {
    const matchups: Matchup[] = [
      { week: 1, home: 'p', away: 'q' },
      { week: 1, home: 'r', away: 's' },
      { week: 1, home: 'x', away: 'w' },
    ];
    const results = [result(1, 'p', 50), result(1, 'q', 10), result(1, 'r', 50), result(1, 's', 20), result(1, 'x', 50), result(1, 'w', 10)];
    const rows = standings(matchups, results, makeConfig(), fakeRng([0.5]));
    // p, r, x all 1-0 with PF 50. PA: p 10, x 10, r 20. p < x by id.
    expect(rows.map((r) => r.tavern)).toEqual(['p', 'x', 'r', 's', 'q', 'w']);
  });

  it('processes matchups in (week, home) order so coin flips are reproducible', () => {
    const matchups: Matchup[] = [
      { week: 2, home: 'c', away: 'd' },
      { week: 1, home: 'b', away: 'a' },
      { week: 1, home: 'a', away: 'b' },
    ];
    const level = (w: number, t: string) => result(w, t, 0, 0, 0);
    const results = [level(1, 'a'), level(1, 'b'), level(2, 'c'), level(2, 'd')];
    // Draw order: (1, a vs b) → 0.1 home a; (1, b vs a) → 0.9 away a; (2, c vs d) → 0.1 home c.
    const run = (ms: ReadonlyArray<Matchup>) => standings(ms, results, makeConfig(), fakeRng([0.1, 0.9, 0.1]));
    const rows = run(matchups);
    expect(record(rows, 'a')).toBe('2-0-0');
    expect(record(rows, 'c')).toBe('1-0-0');
    expect(run([...matchups].reverse())).toEqual(rows);
  });

  it('rejects duplicate results for one tavern-week', () => {
    expect(() => standings(one, [result(1, 'h', 1), result(1, 'h', 2)], makeConfig(), fakeRng([0]))).toThrow(/duplicate/);
  });
});
