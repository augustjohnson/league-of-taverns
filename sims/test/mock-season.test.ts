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
    expect(state.finalizedWeeks).toEqual(new Set([1, 2, 3]));
    expect(state.waivers.resolvedWeeks).toEqual(new Set([1, 2]));
  });

  it('writes the events in lifecycle order', () => {
    const types = sim1.events.map((e) => e.type);
    const firstOf = (t: string): number => types.indexOf(t as (typeof types)[number]);
    expect(types.filter((t) => t === 'character.pooled')).toHaveLength(input.pool.length);
    expect(types.filter((t) => t === 'tavern.joined')).toHaveLength(input.taverns.length);
    expect(firstOf('tavern.joined')).toBeGreaterThan(types.lastIndexOf('character.pooled'));
    expect(firstOf('draft.pick')).toBeGreaterThan(types.lastIndexOf('tavern.joined'));
    expect(firstOf('lineup.set')).toBeGreaterThan(types.lastIndexOf('draft.pick'));
    expect(types.filter((t) => t === 'week.finalized')).toHaveLength(3);
    expect(types.filter((t) => t === 'waiver.resolved')).toHaveLength(2);
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

  it('pins the sim-1 champion', () => {
    expect(sim1.summary.champions).toEqual([{ tavern: 'the-gilded-flagon', bot: 'cr-greedy' }]);
    expect(sim1.summary.standings[0]!.tavern).toBe('the-gilded-flagon');
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
