import { describe, expect, it } from 'vitest';
import { standings, type SeasonConfig, type WeekResult } from '../src/league';
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

function makeConfig(overrides: { order?: SeasonConfig['draft']['order'] } = {}): SeasonConfig {
  return {
    id: 'season-test',
    snapshot: 'open5e-test',
    modifierRegistryVersion: 1,
    weeks: 6,
    budget: { partyCr: (12 * 8) as CrEighths, modifierPointsPerCharacter: 3 },
    roster: { size: 7, starters: 4, ownership: 'exclusive' },
    draft: { format: 'snake', rounds: 7, order: overrides.order ?? { mode: 'seeded' }, pickWindowHours: 24, onTimeout: 'autopick' },
    scoring: { pointsScale: 100 },
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

describe('standings', () => {
  const result = (week: number, tavern: string, points: number): WeekResult => ({ week, tavern, points, projected: 0, checksPassed: 0 });

  it('ranks by total points over all weeks', () => {
    const rows = standings(['a', 'b', 'c'], [result(1, 'a', 50), result(1, 'b', 70), result(1, 'c', 10), result(2, 'a', 40), result(2, 'b', 5), result(2, 'c', 90)]);
    expect(rows).toEqual([
      { rank: 1, tavern: 'c', points: 100 },
      { rank: 2, tavern: 'a', points: 90 },
      { rank: 3, tavern: 'b', points: 75 },
    ]);
  });

  it('equal totals share a rank, with no tiebreak; display order falls back to tavern id', () => {
    const rows = standings(['d', 'c', 'b', 'a'], [result(1, 'd', 60), result(1, 'c', 60), result(1, 'b', 30), result(1, 'a', 30)]);
    expect(rows.map((r) => [r.rank, r.tavern])).toEqual([
      [1, 'c'],
      [1, 'd'],
      [3, 'a'],
      [3, 'b'],
    ]);
  });

  it('includes taverns with no results, and taverns only seen in results', () => {
    const rows = standings(['a', 'z'], [result(1, 'a', 10), result(1, 'q', 20)]);
    expect(rows).toEqual([
      { rank: 1, tavern: 'q', points: 20 },
      { rank: 2, tavern: 'a', points: 10 },
      { rank: 3, tavern: 'z', points: 0 },
    ]);
    expect(standings([], [])).toEqual([]);
  });

  it('rejects duplicate results for one tavern-week', () => {
    expect(() => standings(['h'], [result(1, 'h', 1), result(1, 'h', 2)])).toThrow(/duplicate/);
  });
});
