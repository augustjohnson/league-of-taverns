import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidEventError } from '../src/events/reducers';
import { LogParseError, ReplayError, lineHash, parseLog, replay, replayLog, serializeEvent, verifyResolutions } from '../src/events/replay';
import type { EventOf, EventType, LeagueEvent } from '../src/events/types';
import type { SeasonConfig } from '../src/league';
import type { Mission } from '../src/missions';
import type { Lineup } from '../src/roster';
import type { CrEighths } from '../src/vocabulary';
import { chained, miniSeason } from './support/league-log';

const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const system = { kind: 'system', workflow: 'weekly-run' } as const;
const manager = { kind: 'manager', githubId: 1234, login: 'someone' } as const;
const commissioner = { kind: 'commissioner', githubId: 1, login: 'gm' } as const;
const lineup: Lineup = { captain: 'bruno-the-bruiser', allies: ['moss-hag', 'tin-knight', 'pip-the-sly'] };

const config: SeasonConfig = {
  id: 'season-01',
  snapshot: 'open5e-v1-2026-10',
  modifierRegistryVersion: 1,
  weeks: 6,
  budget: { partyCr: 96 as CrEighths, modifierPointsPerCharacter: 3 },
  roster: { size: 7, starters: 4, ownership: 'exclusive' },
  draft: { format: 'snake', rounds: 7, order: { mode: 'seeded' }, pickWindowHours: 24, onTimeout: 'autopick' },
  matchups: { format: 'head_to_head', playoffs: { enabled: false, teams: 4, weeks: [] } },
  scoring: { pointsScale: 100, tiebreakers: ['projected', 'checks_passed', 'seeded_coin'] },
  waivers: { priority: 'rolling', initialOrder: 'reverse_draft' },
  trades: { vetoWindowHours: 24, vetoBy: 'commissioner', deadlineWeek: 4 },
  missedLineup: 'carry_over',
  schedules: { lineupLock: '0 18 * * 4', weeklyRun: '15 18 * * 4', waivers: '0 12 * * 5' },
  secrecy: 'encrypted',
  seedSalt: 'revealed_with_mission',
  missions: {
    dcBand: { min: 8, max: 20 },
    maxNodes: 14,
    maxRank: 8,
    battlesPerPath: { min: 0, max: 3 },
    encounterCrRatio: 1,
    haul: 100,
    battleModel: 'ev-ttk-v0',
  },
  carryover: {
    mode: 'keeper',
    keepersPerTavern: 1,
    keeperCost: 'round_of_last_season_pick',
    championBonusKeepers: 1,
    maxModifierChangePoints: 1,
  },
};

const mission: Mission = {
  schemaVersion: 1,
  id: 'tiny-toll',
  season: 'season-01',
  environment: 'swamp',
  nodes: [
    { id: 'start', rank: 0, kind: 'start' },
    { id: 'find-path', rank: 1, kind: 'check', check: { type: 'skill', skill: 'survival', dc: 12, requires: { sense: 'darkvision' } }, loot: 100 },
    { id: 'bog-ambush', rank: 2, kind: 'battle', encounter: { creatures: [{ ref: 'crocodile', count: 3 }] } },
    { id: 'crossed', rank: 3, kind: 'end' },
  ],
  edges: [
    { from: 'start', to: 'find-path', on: 'always' },
    { from: 'find-path', to: 'crossed', on: 'pass' },
    { from: 'find-path', to: 'bog-ambush', on: 'fail' },
    { from: 'bog-ambush', to: 'crossed', on: 'win' },
  ],
};

function envelope<T extends EventType>(type: T, seq: number, actor: LeagueEvent['actor'], payload: EventOf<T>['payload']) {
  return {
    v: 1 as const,
    seq,
    type,
    season: 'season-01',
    at: '2026-11-02T18:04:11Z',
    actor,
    prev: seq === 1 ? null : HASH,
    payload,
  };
}

/** One fixture per event type. The mapped type makes a missing type a compile error. */
const fixtures: { readonly [T in EventType]: EventOf<T> } = {
  'season.created': envelope('season.created', 1, commissioner, {
    config,
    configSha256: HASH,
    engineVersion: '0.0.0',
    schedule: [{ week: 1, title: 'The Drowned Toll', environment: 'swamp', theme: 'A flooded toll road.', commitment: null }],
  }),
  'character.pooled': envelope('character.pooled', 2, commissioner, {
    character: 'bruno-the-bruiser',
    base: 'ogre',
    cr: 16 as CrEighths,
    modifiers: [
      { kind: 'skill_bonus', skill: 'intimidation', value: 2 },
      { kind: 'save_bonus', ability: 'con', value: 1 },
      { kind: 'advantage', on: { type: 'save', ability: 'wis' } },
      { kind: 'grant_speed', speed: 'swim', feet: 30 },
      { kind: 'grant_sense', sense: 'darkvision', feet: 60 },
      { kind: 'battle_bonus', value: 1 },
      { kind: 'trait', trait: 'thick-skull' },
    ],
  }),
  'tavern.joined': envelope('tavern.joined', 3, commissioner, {
    tavern: 'the-gilded-flagon',
    name: 'The Gilded Flagon',
    manager: { githubId: 1234, login: 'someone' },
  }),
  'character.retained': {
    ...envelope('character.retained', 4, commissioner, {
      tavern: 'the-gilded-flagon',
      character: 'bruno-the-bruiser',
      fromSeason: 'season-00',
      basis: 'keeper',
      costRound: null,
    }),
    source: { issue: 7 },
  },
  'draft.pick': {
    ...envelope('draft.pick', 5, manager, { pick: 0, tavern: 'the-gilded-flagon', character: 'moss-hag', auto: false }),
    source: { issue: 42, comment: 900 },
  },
  'lineup.set': envelope('lineup.set', 6, manager, { tavern: 'the-gilded-flagon', week: 1, lineup }),
  'lineup.locked': envelope('lineup.locked', 7, system, {
    week: 1,
    lineups: [
      { tavern: 'the-gilded-flagon', lineup, source: 'submitted' },
      { tavern: 'the-rusty-nail', lineup: null, source: 'none' },
    ],
  }),
  'waiver.claimed': envelope('waiver.claimed', 8, manager, {
    claim: 'claim-1',
    tavern: 'the-gilded-flagon',
    add: 'grim-gull',
    drop: null,
  }),
  'waiver.resolved': envelope('waiver.resolved', 9, system, {
    week: 1,
    outcomes: [{ claim: 'claim-1', awarded: true, reason: 'highest priority' }],
    priorityAfter: ['the-rusty-nail', 'the-gilded-flagon'],
  }),
  'trade.proposed': envelope('trade.proposed', 10, manager, {
    trade: 'trade-1',
    from: 'the-gilded-flagon',
    to: 'the-rusty-nail',
    give: ['moss-hag'],
    receive: ['iron-ox', 'tin-knight'],
  }),
  'trade.accepted': envelope('trade.accepted', 11, { kind: 'manager', githubId: 5678, login: 'other' }, { trade: 'trade-1' }),
  'trade.vetoed': envelope('trade.vetoed', 12, commissioner, { trade: 'trade-1', reason: 'lopsided' }),
  'trade.completed': {
    ...envelope('trade.completed', 13, system, { trade: 'trade-2' }),
    source: { workflowRun: 123456789 },
  },
  'trade.cancelled': envelope('trade.cancelled', 14, manager, { trade: 'trade-3', reason: 'withdrawn' }),
  'mission.revealed': envelope('mission.revealed', 15, system, { week: 1, mission, sha256: HASH, salt: 'pepper' }),
  'mission.resolved': envelope('mission.resolved', 16, system, {
    week: 1,
    tavern: 'the-gilded-flagon',
    mission: 'tiny-toll',
    seed: 'season-01/week-1/tavern:the-gilded-flagon/salt:pepper',
    engineVersion: '0.0.0',
    battleModel: 'ev-ttk-v0',
    lineup,
    run: {
      path: ['start', 'find-path', 'bog-ambush', 'crossed'],
      nodes: [
        { node: 'find-path', kind: 'check', actor: 'moss-hag', d20: 7, modifier: 3, dc: 12, advantage: false, outcome: 'fail' },
        { node: 'bog-ambush', kind: 'battle', pWin: 0.62, roll: 0.41, outcome: 'win' },
      ],
      dnf: false,
      checksPassed: 0,
      checksAttempted: 1,
      loot: 0,
      score: 0,
    },
    projected: { expectedScore: 0.55, pDnf: 0.2 },
    points: 0,
    projectedPoints: 55,
  }),
  'week.finalized': envelope('week.finalized', 17, { kind: 'bot', strategy: 'value' }, { week: 1 }),
};

const allEvents: ReadonlyArray<LeagueEvent> = Object.values(fixtures);

/** Rebuild every object with its keys in reverse order, recursively. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys((value as Record<string, unknown>)[key])]));
  }
  return value;
}

describe('events', () => {
  it('has one fixture for every event type', () => {
    expect(allEvents).toHaveLength(17);
    expect(new Set(allEvents.map((event) => event.type)).size).toBe(17);
  });

  it.each(Object.entries(fixtures))('parseLog(serializeEvent(e)) round-trips %s', (_type, event) => {
    const line = serializeEvent(event);
    expect(parseLog(line)).toEqual([event]);
    expect(parseLog(`${line}\n`)).toEqual([event]);
  });

  it('round-trips a whole log in order', () => {
    const ndjson = `${allEvents.map(serializeEvent).join('\n')}\n`;
    expect(parseLog(ndjson)).toEqual(allEvents);
    expect(parseLog('')).toEqual([]);
  });

  it('serializes canonically: sorted keys, no whitespace, no trailing newline, arrays in order', () => {
    const line = serializeEvent(fixtures['week.finalized']);
    expect(line).toBe(
      `{"actor":{"kind":"bot","strategy":"value"},"at":"2026-11-02T18:04:11Z","payload":{"week":1},"prev":"${HASH}","season":"season-01","seq":17,"type":"week.finalized","v":1}`,
    );
    const priority = serializeEvent(fixtures['waiver.resolved']);
    expect(priority).toContain('"priorityAfter":["the-rusty-nail","the-gilded-flagon"]');
  });

  it.each(Object.entries(fixtures))('key order does not change the serialization of %s', (_type, event) => {
    expect(serializeEvent(reverseKeys(event) as LeagueEvent)).toBe(serializeEvent(event));
  });

  it('refuses to serialize an event that does not match the schema', () => {
    const bad = { ...fixtures['draft.pick'], payload: { ...fixtures['draft.pick'].payload, pick: -1 } };
    expect(() => serializeEvent(bad)).toThrow('payload.pick');
  });

  it('lineHash is sha256 hex of the UTF-8 line', () => {
    expect(lineHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(lineHash('abc')).toBe(HASH);
    const line = serializeEvent({ ...fixtures['tavern.joined'], payload: { ...fixtures['tavern.joined'].payload, name: 'Le Café Brûlé 🍺' } });
    expect(lineHash(line)).toBe(createHash('sha256').update(line, 'utf8').digest('hex'));
  });

  it('reports the line number of invalid JSON', () => {
    const ndjson = [serializeEvent(fixtures['season.created']), '{"v":1,', serializeEvent(fixtures['week.finalized'])].join('\n');
    expect(() => parseLog(ndjson)).toThrow(/^events line 2: invalid JSON/);
  });

  it('reports the line number and field path of a schema violation', () => {
    const broken = { ...fixtures['lineup.set'], payload: { ...fixtures['lineup.set'].payload, lineup: { captain: 'bruno-the-bruiser', allies: ['a', 'b'] } } };
    const ndjson = [serializeEvent(fixtures['season.created']), serializeEvent(fixtures['tavern.joined']), JSON.stringify(broken)].join('\n');
    let caught: unknown;
    try {
      parseLog(ndjson);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LogParseError);
    expect((caught as LogParseError).line).toBe(3);
    expect((caught as LogParseError).path).toBe('payload.lineup.allies');
    expect((caught as Error).message).toMatch(/^events line 3: payload\.lineup\.allies: /);
  });

  it('rejects an unknown event type, a blank line mid-log, and a CR given as a fraction', () => {
    const unknownType = JSON.stringify({ ...fixtures['week.finalized'], type: 'week.cancelled' });
    expect(() => parseLog(unknownType)).toThrow(/^events line 1: type: /);
    const blankMidLog = `${serializeEvent(fixtures['season.created'])}\n\n${serializeEvent(fixtures['week.finalized'])}\n`;
    expect(() => parseLog(blankMidLog)).toThrow(/^events line 2: invalid JSON/);
    const fractionalCr = JSON.stringify({ ...fixtures['character.pooled'], payload: { ...fixtures['character.pooled'].payload, cr: 0.5 } });
    expect(() => parseLog(fractionalCr)).toThrow(/^events line 1: payload\.cr: /);
  });

});

describe('replay and verification', () => {
  const { log } = miniSeason();
  const resolvedIndex = log.events.findIndex((e) => e.type === 'mission.resolved');
  const resolved = log.events[resolvedIndex] as EventOf<'mission.resolved'>;
  const revealedIndex = log.events.findIndex((e) => e.type === 'mission.revealed');
  const revealed = log.events[revealedIndex] as EventOf<'mission.revealed'>;
  const ndjson = (lines: ReadonlyArray<string>): string => `${lines.join('\n')}\n`;

  function replayError(text: string): ReplayError {
    try {
      replayLog(text);
    } catch (error) {
      if (error instanceof ReplayError) return error;
      throw error;
    }
    throw new Error('expected replayLog to throw');
  }

  /** The log with the first `mission.resolved` swapped for one with `run` patched. */
  function withResolution(patch: Partial<EventOf<'mission.resolved'>['payload']>): ReadonlyArray<LeagueEvent> {
    const edited = { ...resolved, payload: { ...resolved.payload, ...patch } };
    return log.events.map((e, i) => (i === resolvedIndex ? edited : e));
  }

  /** start → find-path (fail) → bog → crossed, with a recorded battle. */
  function battleRun(battle: { roll: number; outcome: 'win' | 'lose' }): EventOf<'mission.resolved'>['payload']['run'] {
    const lost = battle.outcome === 'lose';
    return {
      path: lost ? ['start', 'find-path', 'bog'] : ['start', 'find-path', 'bog', 'crossed'],
      nodes: [
        { node: 'find-path', kind: 'check', actor: resolved.payload.lineup.captain, d20: 2, modifier: 1, dc: 11, advantage: false, outcome: 'fail' },
        { node: 'bog', kind: 'battle', pWin: 0.6, roll: battle.roll, outcome: battle.outcome },
      ],
      dnf: lost,
      checksPassed: 0,
      checksAttempted: 1,
      loot: 0,
      score: 0,
    };
  }

  it('replay rejects a gap in seq', () => {
    const gapped = [...log.events.slice(0, 10), ...log.events.slice(11)];
    expect(() => replay(gapped)).toThrow(InvalidEventError);
    expect(() => replay(gapped)).toThrow(/^event 12: .*\[envelope\.seq\]/);
    // In a log file the missing line first breaks the chain at the line after the gap…
    const cut = replayError(ndjson([...log.lines.slice(0, 10), ...log.lines.slice(11)]));
    expect([cut.line, cut.code]).toEqual([11, 'chain.prev_mismatch']);
    expect(cut.message).toMatch(/^events line 11: /);
    // …and with the chain rebuilt around the gap, the seq check still names the line.
    const rechained = replayError(chained(gapped));
    expect([rechained.line, rechained.code]).toEqual([11, 'envelope.seq']);
    expect(rechained.cause).toBeInstanceOf(InvalidEventError);
  });

  it('replay rejects a reordered log', () => {
    const swap = <T>(xs: ReadonlyArray<T>): T[] => [...xs.slice(0, 4), xs[5]!, xs[4]!, ...xs.slice(6)];
    const raw = replayError(ndjson(swap(log.lines)));
    expect([raw.line, raw.code]).toEqual([5, 'chain.prev_mismatch']);
    const rechained = replayError(chained(swap(log.events)));
    expect([rechained.line, rechained.code]).toEqual([5, 'envelope.seq']);
  });

  it('replay rejects a broken prev hash chain', () => {
    const lines = [...log.lines];
    lines[0] = serializeEvent({ ...log.events[0]!, prev: lineHash('genesis') });
    expect(replayError(ndjson(lines))).toMatchObject({ line: 1, code: 'chain.first_prev' });

    for (const prev of [lineHash('elsewhere'), null]) {
      const broken = [...log.lines];
      broken[2] = serializeEvent({ ...log.events[2]!, prev });
      expect(replayError(ndjson(broken))).toMatchObject({ line: 3, code: 'chain.prev_mismatch' });
    }
  });

  it('detects an edited line at the line after it, even a whitespace-only edit', () => {
    const k = log.events.findIndex((e) => e.type === 'tavern.joined');
    const renamed = [...log.lines];
    renamed[k] = log.lines[k]!.replace('"name":"the-gilded-flagon"', '"name":"The Gilded Flagon"');
    expect(renamed[k]).not.toBe(log.lines[k]);
    expect(replayError(ndjson(renamed))).toMatchObject({ line: k + 2, code: 'chain.prev_mismatch' });

    const padded = [...log.lines];
    padded[k] = `${log.lines[k]!} `;
    expect(replayError(ndjson(padded))).toMatchObject({ line: k + 2, code: 'chain.prev_mismatch' });
  });

  it('names the line of an event the reducers reject', () => {
    const doubled = [...log.events.slice(0, 3), { ...log.events[2]!, seq: 4 }, ...log.events.slice(3)];
    const error = replayError(chained(doubled.map((e, i) => ({ ...e, seq: i + 1 }))));
    expect([error.line, error.code]).toEqual([4, 'pool.duplicate']);
  });

  it('replaying the same log twice yields deeply equal state', () => {
    const first = replayLog(log.ndjson);
    expect(replayLog(log.ndjson)).toEqual(first);
    expect(replay(parseLog(log.ndjson))).toEqual(first);
    expect(first.lastHash).toBe(lineHash(log.lines.at(-1)!));
    expect(replayLog('')).toEqual(replay([]));
  });

  it('verifyResolutions reports no mismatch for an honest log and flags an edited d20', () => {
    expect(verifyResolutions(log.events)).toEqual([]);
    const [first, ...rest] = resolved.payload.run.nodes;
    if (first?.kind !== 'check') throw new Error('expected the first node to be a check');
    const events = withResolution({ run: { ...resolved.payload.run, nodes: [{ ...first, d20: first.outcome === 'pass' ? 1 : 20 }, ...rest] } });
    // The reducers trust the record (D-20), so the edited log still replays…
    expect(() => replayLog(chained(events))).not.toThrow();
    // …and the audit catches it.
    expect(verifyResolutions(events)).toEqual([
      { seq: resolved.seq, week: 1, tavern: resolved.payload.tavern, field: 'run.nodes[0].outcome', message: expect.stringContaining('d20') },
    ]);
  });

  it('verifyResolutions checks battles, the path, the summary and the points', () => {
    const fields = (patch: Partial<EventOf<'mission.resolved'>['payload']>) => verifyResolutions(withResolution(patch)).map((m) => m.field);
    const won = battleRun({ roll: 0.3, outcome: 'win' });
    expect(fields({ run: won, points: 0 })).toEqual([]);
    expect(fields({ run: battleRun({ roll: 0.9, outcome: 'lose' }), points: 0 })).toEqual([]);
    expect(fields({ run: { ...won, nodes: [won.nodes[0]!, { ...won.nodes[1]!, roll: 0.9 } as (typeof won.nodes)[1]] }, points: 0 })).toEqual(['run.nodes[1].outcome']);
    expect(fields({ run: { ...won, path: ['start', 'find-path', 'crossed'] }, points: 0 })).toEqual(['run.path']);
    expect(fields({ run: { ...won, dnf: true }, points: 0 })).toEqual(['run.dnf']);
    expect(fields({ run: { ...won, checksPassed: 1, score: 1 }, points: 100 })).toEqual(['run.checksPassed', 'run.score']);
    expect(fields({ run: won, points: 7 })).toEqual(['points']);
    expect(fields({ run: { ...won, loot: 5 }, points: 0 })).toEqual(['run.loot']);
    expect(fields({ run: { ...won, nodes: won.nodes.slice(0, 1) }, points: 0 })).toEqual(['run.nodes[1]']);
    expect(fields({ run: { ...won, nodes: [{ ...won.nodes[0]!, actor: 'stranger' } as (typeof won.nodes)[0], won.nodes[1]!] }, points: 0 })).toEqual(['run.nodes[0].actor']);
    expect(fields({ mission: 'another-mission' })).toEqual(['mission']);
  });

  it('verifyResolutions lets a gated check fail on a high roll (nobody may have met the gate)', () => {
    const won = battleRun({ roll: 0.3, outcome: 'win' });
    const highFail = { ...won, nodes: [{ ...won.nodes[0]!, d20: 20 } as (typeof won.nodes)[0], won.nodes[1]!] };
    expect(verifyResolutions(withResolution({ run: highFail, points: 0 })).map((m) => m.field)).toEqual(['run.nodes[0].outcome']);
    const gated = {
      ...revealed,
      payload: {
        ...revealed.payload,
        mission: {
          ...revealed.payload.mission,
          nodes: revealed.payload.mission.nodes.map((n) => (n.kind === 'check' ? { ...n, check: { ...n.check, requires: { sense: 'darkvision' as const } } } : n)),
        },
      },
    };
    const events = withResolution({ run: highFail, points: 0 }).map((e, i) => (i === revealedIndex ? gated : e));
    expect(verifyResolutions(events)).toEqual([]);
  });

  it('chrome never reaches the engine: the log rejects chrome fields, and pooled state holds mechanics only', () => {
    const pooled = log.events.find((e) => e.type === 'character.pooled')!;
    for (const chrome of [{ name: 'Bruno' }, { epithet: 'the Bruiser' }, { portrait: 'bruno.png' }]) {
      expect(() => parseLog(JSON.stringify({ ...pooled, payload: { ...pooled.payload, ...chrome } }))).toThrow(/^events line 1: payload: /);
    }
    for (const entry of replay(log.events).pool.values()) expect(Object.keys(entry).sort()).toEqual(['base', 'cr', 'modifiers']);
  });
});
