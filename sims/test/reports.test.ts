import { describe, expect, it } from 'vitest';
import { loadMockSeason } from '../src/load';
import { ReportContext, aggregateLuck, benchReport, luckReport, luckSeason, midPercentile, titleOdds } from '../src/reports';
import { SeasonSession, runMockSeason } from '../src/season-runner';

const input = loadMockSeason();
const sim = runMockSeason(input, { seed: 'sim-1' });
const ctx = new ReportContext(input, sim.summary.taverns, sim.events, sim.state);
const weeks = input.config.weeks;

describe('midPercentile', () => {
  it('counts the mass below plus half the mass at the value', () => {
    const d = [
      [0, 0.2],
      [50, 0.5],
      [100, 0.3],
    ] as const;
    expect(midPercentile(d, 0)).toBeCloseTo(0.1);
    expect(midPercentile(d, 50)).toBeCloseTo(0.45);
    expect(midPercentile(d, 100)).toBeCloseTo(0.85);
    expect(midPercentile(d, 75)).toBeCloseTo(0.7);
  });
});

describe('luckReport', () => {
  const luck = luckReport(ctx);

  it('sums loot minus projection over every week, luckiest first', () => {
    expect(luck).toHaveLength(input.taverns.length);
    for (const row of luck) {
      const results = sim.summary.weeks.map((w) => w.results.find((x) => x.tavern === row.tavern)!);
      expect(row.pointsAbove).toBeCloseTo(results.reduce((s, r) => s + r.points - r.projectedPoints, 0), 9);
      expect(row.points).toBe(sim.summary.standings.find((s) => s.tavern === row.tavern)!.points);
      expect(row.points).toBeCloseTo(row.projected + row.pointsAbove, 9);
      expect(row.weeks).toHaveLength(weeks);
    }
    for (let i = 1; i < luck.length; i++) expect(luck[i - 1]!.pointsAbove).toBeGreaterThanOrEqual(luck[i]!.pointsAbove);
  });

  it('ranks by actual loot as the standings do, and by projected loot', () => {
    for (const row of luck) expect(row.rank).toBe(sim.summary.standings.find((s) => s.tavern === row.tavern)!.rank);
    const byProjected = [...luck].sort((a, b) => b.projected - a.projected);
    expect(byProjected[0]!.projectedRank).toBe(1);
  });

  it('marks home weeks and keeps every percentile in [0, 1]', () => {
    for (const row of luck) {
      for (const w of row.weeks) {
        expect(w.home).toBe(sim.summary.weeks[w.week - 1]!.home === row.tavern);
        expect(w.percentile!).toBeGreaterThanOrEqual(0);
        expect(w.percentile!).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('titleOdds', () => {
  const odds = titleOdds(ctx, { seed: 'sim-1', sims: 300 });

  it('has a point after the draft and after each week, each summing to 1', () => {
    expect(odds.map((p) => p.afterWeek)).toEqual(Array.from({ length: weeks + 1 }, (_, k) => k));
    for (const p of odds) expect([...p.odds.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });

  it('ends certain: the champions share 1, with the final totals', () => {
    const last = odds.at(-1)!;
    for (const c of sim.summary.champions) expect(last.odds.get(c.tavern)).toBeCloseTo(1 / sim.summary.champions.length, 9);
    for (const s of sim.summary.standings) expect(last.expectedPoints.get(s.tavern)).toBe(s.points);
  });

  it('is deterministic for a seed', () => {
    const again = titleOdds(new ReportContext(input, sim.summary.taverns, sim.events, sim.state), { seed: 'sim-1', sims: 300 });
    expect(again).toEqual(odds);
  });

  it('works mid-season, and is empty before the draft completes', () => {
    const session = new SeasonSession(input, { seed: 'sim-1' });
    expect(titleOdds(new ReportContext(input, sim.summary.taverns, session.events, session.state), { seed: 'x', sims: 50 })).toEqual([]);
    session.advanceDraft();
    session.playWeek();
    session.playWeek();
    const mid = titleOdds(new ReportContext(input, sim.summary.taverns, session.events, session.state), { seed: 'x', sims: 50 });
    expect(mid.map((p) => p.afterWeek)).toEqual([0, 1, 2]);
  });
});

describe('benchReport', () => {
  const bench = benchReport(ctx);
  const all = bench.flatMap((b) => b.weeks);

  it('replays every sim week with the same dice', () => {
    for (const w of all) if (w.played !== null) expect(w.sameDice).toBe(true);
  });

  it('never finds a best lineup worse than the one played', () => {
    for (const w of all) {
      if (w.played === null) continue;
      expect(w.bestSameDice!.points!).toBeGreaterThanOrEqual(w.points);
      expect(w.bestProjected!.projected).toBeGreaterThanOrEqual(w.projected - 1e-9);
      if (w.bestSwap !== null) expect(w.bestSameDice!.points!).toBeGreaterThanOrEqual(w.bestSwap.points!);
      expect(w.rankWithBest!).toBeLessThanOrEqual(w.rank);
    }
  });

  it('leaves no projected loot on the bench for bots, which field the best projection', () => {
    for (const b of bench) expect(b.projectedOnBench).toBeCloseTo(0, 6);
  });

  it('counts season ranks with the hindsight loot added', () => {
    for (const b of bench) {
      expect(b.rank).toBe(sim.summary.standings.find((s) => s.tavern === b.tavern)!.rank);
      expect(b.rankWithBest).toBeLessThanOrEqual(b.rank);
    }
  });
});

describe('aggregateLuck', () => {
  const seasons = ['sim-1', 'sim-2', 'sim-3', 'sim-4'].map((seed) => {
    const run = seed === 'sim-1' ? sim : runMockSeason(input, { seed });
    return luckSeason(run.summary, luckReport(new ReportContext(input, run.summary.taverns, run.events, run.state)));
  });
  const agg = aggregateLuck(seasons);

  it('hands each title to the luck and strength ranks, splitting shared titles', () => {
    expect(agg.seasons).toBe(4);
    expect(agg.taverns).toBe(input.taverns.length);
    expect(agg.titlesByLuckRank.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(agg.titlesBySkillRank.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });

  it('splits the spread of totals into luck, strength and twice their covariance', () => {
    const { luck, skill, cov } = agg.variance;
    expect(luck + skill + 2 * cov).toBeCloseTo(1, 9);
    expect(luck).toBeGreaterThan(0);
    expect(skill).toBeGreaterThan(0);
  });

  it('counts every seat by manager', () => {
    expect(Object.values(agg.byBot).reduce((a, b) => a + b.seats, 0)).toBe(4 * input.taverns.length);
  });
});
