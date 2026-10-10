import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LogParseError, lineHash, parseLog, serializeEvent } from '../src/events/replay';
import type { EventOf, EventType, LeagueEvent } from '../src/events/types';
import type { SeasonConfig } from '../src/league';
import type { Mission } from '../src/missions';
import type { Lineup } from '../src/roster';
import type { CrEighths } from '../src/vocabulary';

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
    { id: 'find-path', rank: 1, kind: 'check', check: { type: 'skill', skill: 'survival', dc: 12, requires: { sense: 'darkvision' } } },
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

  it.todo('replay rejects a gap in seq');
  it.todo('replay rejects a broken prev hash chain');
  it.todo('replaying the same log twice yields deeply equal state');
  it.todo('verifyResolutions reports no mismatch for an honest log and flags an edited d20');
  it.todo('derived state is invariant to edits in character chrome (chrome never reaches the engine)');
});
