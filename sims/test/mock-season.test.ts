import { isDeepStrictEqual } from 'node:util';
import { lineHash, replay, replayLog, serializeEvent, verifyResolutions } from '@league-of-taverns/engine';
import { describe, expect, it } from 'vitest';
import { loadMockSeason } from '../src/load';
import { aggregate, missionSha256, runMockSeason, runSeed } from '../src/season-runner';

// T9.2, the critical-path milestone: the hand-built 3-mission mock season
// (sims/fixtures/mock-season/) runs end to end with bots through the real
// reducers, and its log replays to the same state.

const input = loadMockSeason();
const sim1 = runMockSeason(input, { seed: 'sim-1' });

describe('one seeded mock season', () => {
  it('runs from season.created to the final week.finalized and completes', () => {
    const { events, state } = sim1;
    expect(state.phase).toBe('complete');
    expect(events[0]!.type).toBe('season.created');
    expect(events.at(-1)!.type).toBe('week.finalized');
    expect(state.finalizedWeeks).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(state.waivers.resolvedWeeks).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it('writes the events in lifecycle order', () => {
    const types = sim1.events.map((e) => e.type);
    const firstOf = (t: string): number => types.indexOf(t as (typeof types)[number]);
    expect(types.filter((t) => t === 'character.pooled')).toHaveLength(input.pool.length);
    expect(types.filter((t) => t === 'manager.joined')).toHaveLength(input.managers.length);
    expect(types.filter((t) => t === 'tavern.chosen')).toHaveLength(input.managers.length);
    expect(firstOf('manager.joined')).toBeGreaterThan(types.lastIndexOf('character.pooled'));
    expect(firstOf('tavern.chosen')).toBeGreaterThan(types.lastIndexOf('manager.joined'));
    expect(firstOf('draft.pick')).toBeGreaterThan(types.lastIndexOf('tavern.chosen'));
    expect(firstOf('lineup.set')).toBeGreaterThan(types.lastIndexOf('draft.pick'));
    expect(types.filter((t) => t === 'week.finalized')).toHaveLength(6);
    expect(types.filter((t) => t === 'waiver.resolved')).toHaveLength(5);
  });

  it('stamps proper envelopes: contiguous seq, a prev chain, ordered timestamps, system/commissioner/bot actors', () => {
    const lines = sim1.ndjson.trimEnd().split('\n');
    expect(lines).toHaveLength(sim1.events.length);
    sim1.events.forEach((event, i) => {
      expect(event.seq).toBe(i + 1);
      expect(event.prev).toBe(i === 0 ? null : lineHash(lines[i - 1]!));
      expect(serializeEvent(event)).toBe(lines[i]);
      expect(['system', 'commissioner', 'bot']).toContain(event.actor.kind);
      if (i > 0) expect(event.at >= sim1.events[i - 1]!.at).toBe(true);
    });
    const actors = (type: string): Set<string> => new Set(sim1.events.filter((e) => e.type === type).map((e) => e.actor.kind));
    expect(actors('draft.pick')).toEqual(new Set(['bot']));
    expect(actors('lineup.set')).toEqual(new Set(['bot']));
    expect(actors('waiver.claimed')).toEqual(new Set(['bot']));
    expect(actors('mission.resolved')).toEqual(new Set(['system']));
  });

  it('replays from its NDJSON to the built state, and every resolution verifies', () => {
    expect(isDeepStrictEqual(replayLog(sim1.ndjson), sim1.state)).toBe(true);
    expect(verifyResolutions(sim1.events)).toEqual([]);
  });

  it('fills every roster to 7 in the draft', () => {
    const lastPick = sim1.events.map((e) => e.type).lastIndexOf('draft.pick');
    const drafted = replay(sim1.events.slice(0, lastPick + 1));
    expect(drafted.draft.complete).toBe(true);
    expect(drafted.taverns.size).toBe(6);
    for (const tavern of drafted.taverns.values()) expect(tavern.roster, tavern.id).toHaveLength(7);
    expect(sim1.summary.draft).toHaveLength(42);
  });

  it('reveals each week the mission scheduled for its environment, hashed canonically', () => {
    for (const event of sim1.events) {
      if (event.type !== 'mission.revealed') continue;
      const week = input.schedule.find((w) => w.week === event.payload.week)!;
      expect(event.payload.mission.environment).toBe(week.environment);
      expect(event.payload.sha256).toBe(missionSha256(event.payload.mission));
      expect(event.payload.salt).toBeNull();
    }
  });

  it('benches the injured: a DNF hurts one starter, who starts nowhere the next week (D-51)', () => {
    let injuries = 0;
    for (const seed of ['sim-1', 'sim-2', 'sim-3']) {
      const { events, state } = seed === 'sim-1' ? sim1 : runMockSeason(input, { seed });
      for (const event of events) {
        if (event.type !== 'mission.resolved') continue;
        const { run, week, lineup } = event.payload;
        expect(run.injury === null, `${seed} week ${week} ${event.payload.tavern}`).toBe(!run.dnf);
        if (run.injury === null) continue;
        injuries++;
        expect(lineup.starters).toContain(run.injury.character);
        for (const next of state.lockedLineups.get(week + 1) ?? []) expect(next.lineup?.starters ?? []).not.toContain(run.injury.character);
      }
      expect(verifyResolutions(events)).toEqual([]);
    }
    expect(injuries).toBeGreaterThan(10);
  });

  it('refuses a lineup with last week\'s injured starter', () => {
    // An injury before the last week whose character is still on a roster after that week's waivers.
    const found = sim1.events.flatMap((e) => {
      if (e.type !== 'mission.resolved' || e.payload.run.injury === null || e.payload.week >= 6) return [];
      const { week, run } = e.payload;
      // The state just after that week's waivers: the next week's lineups are open.
      const cut = sim1.events.findIndex((x) => x.type === 'waiver.resolved' && x.payload.week === week);
      const before = replay(sim1.events.slice(0, cut + 1));
      const owner = before.owner.get(run.injury!.character);
      return owner === undefined ? [] : [{ week, character: run.injury!.character, cut, before, owner }];
    })[0];
    if (found === undefined) throw new Error('expected a kept injured character before the last week');
    const { week, character, cut, before, owner } = found;
    const others = before.taverns.get(owner)!.roster.filter((id) => id !== character).slice(0, 3);
    const bad = { ...sim1.events[cut]!, seq: cut + 2, type: 'lineup.set', payload: { tavern: owner, week: week + 1, lineup: { starters: [character, ...others], retreat: 'never' } } };
    expect(() => replay([...sim1.events.slice(0, cut + 1), bad as (typeof sim1.events)[number]])).toThrow(/lineup\.injured/);
  });

  it('pins the sim-1 champion', () => {
    expect(sim1.summary.champions).toEqual([{ tavern: 'the-drowned-rat', bot: 'cr-greedy' }]);
    expect(sim1.summary.standings[0]!.tavern).toBe('the-drowned-rat');
  });
});

describe('determinism', () => {
  it('gives byte-identical NDJSON for the same seed', () => {
    expect(runMockSeason(input, { seed: 'sim-1' }).ndjson).toBe(sim1.ndjson);
  });

  it('gives a different log for a different seed', () => {
    expect(runMockSeason(input, { seed: 'sim-2' }).ndjson).not.toBe(sim1.ndjson);
  });

  it('rejects a seed that would break the week-seed grammar', () => {
    expect(() => runMockSeason(input, { seed: 'a/b' })).toThrow(/no "\/"/);
  });
});

describe('many seasons', () => {
  it('runs 20 seasons without errors and aggregates them', () => {
    const summaries = Array.from({ length: 20 }, (_, i) => runMockSeason(input, { seed: runSeed('batch', i + 1) }).summary);
    const totals = aggregate(summaries);
    expect(totals.runs).toBe(20);
    expect(Object.values(totals.byBot).reduce((n, b) => n + b.titles, 0)).toBeCloseTo(20);
    expect(Object.values(totals.byBot).reduce((n, b) => n + b.seats, 0)).toBe(120);
    expect(totals.bestProjectedTops.share).toBeGreaterThan(0);
    expect(totals.dnfRate).toBeGreaterThanOrEqual(0);
    expect(totals.dnfRate).toBeLessThan(1);
  });
});
