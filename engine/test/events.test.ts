import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { lineHash } from '../src/events/canonical';
import { InvalidEventError } from '../src/events/reducers';
import { LogParseError, ReplayError, parseLog, replay, replayLog, serializeEvent, verifyContest } from '../src/events/replay';
import type { EventOf, EventType, LeagueEvent } from '../src/events/types';
import { miniSeason, statsOf } from './support/league-log';

const { log } = miniSeason();
const TYPES: ReadonlyArray<EventType> = ['season.created', 'character.pooled', 'manager.joined', 'tavern.chosen', 'draft.pick', 'call.made', 'challenge.resolved', 'vote.resolved', 'finale.resolved'];
const fixtures = Object.fromEntries(TYPES.map((t) => [t, log.events.find((e) => e.type === t)!])) as { [T in EventType]: EventOf<T> };
const ndjson = (lines: ReadonlyArray<string>): string => `${lines.join('\n')}\n`;

/** `events` re-serialized with a fresh prev chain, so only the reducers can object. */
function chained(events: ReadonlyArray<LeagueEvent>): string {
  const lines: string[] = [];
  for (const e of events) lines.push(serializeEvent({ ...e, prev: lines.length === 0 ? null : lineHash(lines.at(-1)!) }));
  return ndjson(lines);
}

function replayError(text: string): ReplayError {
  try {
    replayLog(text);
  } catch (error) {
    if (error instanceof ReplayError) return error;
    throw error;
  }
  throw new Error('expected replayLog to throw');
}

describe('events', () => {
  it('the mini season has every event type', () => {
    for (const t of TYPES) expect(fixtures[t], t).toBeDefined();
  });

  it.each(TYPES)('parseLog(serializeEvent(e)) round-trips %s', (type) => {
    const event = fixtures[type];
    const line = serializeEvent(event);
    expect(parseLog(line)).toEqual([event]);
    expect(parseLog(`${line}\n`)).toEqual([event]);
  });

  it('round-trips a whole log in order', () => {
    expect(parseLog(log.ndjson)).toEqual(log.events);
    expect(parseLog('')).toEqual([]);
  });

  it('serializes canonically: sorted keys, no whitespace, no trailing newline', () => {
    const line = serializeEvent(fixtures['call.made']);
    expect(line).toMatch(/^\{"actor":\{"kind":"bot","strategy":"test"\},"at":"[0-9T:-]+Z","payload":\{"episode":1,"target":"[a-z0-9-]+","tavern":"[a-z0-9-]+"\},"prev":"[0-9a-f]{64}","season":"season-01","seq":\d+,"type":"call\.made","v":1\}$/);
  });

  it('refuses to serialize an event that does not match the schema', () => {
    const bad = { ...fixtures['draft.pick'], payload: { ...fixtures['draft.pick'].payload, pick: -1 } };
    expect(() => serializeEvent(bad)).toThrow('payload.pick');
  });

  it('lineHash is sha256 hex of the UTF-8 line', () => {
    expect(lineHash('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const line = 'Le Café Brûlé 🍺';
    expect(lineHash(line)).toBe(createHash('sha256').update(line, 'utf8').digest('hex'));
  });

  it('reports the line number and field path of a schema violation', () => {
    const broken = { ...fixtures['vote.resolved'], payload: { ...fixtures['vote.resolved'].payload, vote: { ...fixtures['vote.resolved'].payload.vote, boot: 'Not An Id' } } };
    let caught: unknown;
    try {
      parseLog([serializeEvent(fixtures['season.created']), JSON.stringify(broken)].join('\n'));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LogParseError);
    expect((caught as LogParseError).line).toBe(2);
    expect((caught as LogParseError).path).toBe('payload.vote.boot');
  });

  it('rejects an unknown event type and a strategy off the list', () => {
    expect(() => parseLog(JSON.stringify({ ...fixtures['call.made'], type: 'round.finalized' }))).toThrow(/^events line 1: type: /);
    const pooled = fixtures['character.pooled'];
    expect(() => parseLog(JSON.stringify({ ...pooled, payload: { ...pooled.payload, strategy: { kind: 'kingmaker' } } }))).toThrow(/payload\.strategy/);
  });

  it('chrome never reaches the engine: the log rejects chrome fields', () => {
    const pooled = fixtures['character.pooled'];
    for (const chrome of [{ name: 'Bruno' }, { epithet: 'the Bruiser' }]) {
      expect(() => parseLog(JSON.stringify({ ...pooled, payload: { ...pooled.payload, ...chrome } }))).toThrow(/^events line 1: payload: /);
    }
    for (const entry of replay(log.events).pool.values()) expect(Object.keys(entry).sort()).toEqual(['base', 'cr', 'modifiers', 'strategy']);
  });
});

describe('replay and the seed audit', () => {
  it('replay rejects a gap in seq, a reordered log and a broken chain', () => {
    const gapped = [...log.events.slice(0, 10), ...log.events.slice(11)];
    expect(() => replay(gapped)).toThrow(InvalidEventError);
    expect(replayError(ndjson([...log.lines.slice(0, 10), ...log.lines.slice(11)]))).toMatchObject({ line: 11, code: 'chain.prev_mismatch' });
    expect(replayError(chained(gapped))).toMatchObject({ line: 11, code: 'envelope.seq' });
    const lines = [...log.lines];
    lines[0] = serializeEvent({ ...log.events[0]!, prev: lineHash('genesis') });
    expect(replayError(ndjson(lines))).toMatchObject({ line: 1, code: 'chain.first_prev' });
  });

  it('detects an edited line at the line after it, even a whitespace-only edit', () => {
    const padded = [...log.lines];
    padded[3] = `${log.lines[3]!} `;
    expect(replayError(ndjson(padded))).toMatchObject({ line: 5, code: 'chain.prev_mismatch' });
  });

  it('replaying the same log twice yields deeply equal state', () => {
    const first = replayLog(log.ndjson);
    expect(replayLog(log.ndjson)).toEqual(first);
    expect(replay(parseLog(log.ndjson))).toEqual(first);
    expect(first.lastHash).toBe(lineHash(log.lines.at(-1)!));
    expect(first.phase).toBe('complete');
  });

  it('verifyContest finds nothing in an honest log, and flags a vote the seed did not give', () => {
    expect(verifyContest(log.events, statsOf)).toEqual([]);
    const i = log.events.findIndex((e) => e.type === 'vote.resolved');
    const vote = log.events[i] as EventOf<'vote.resolved'>;
    // A shuffled ballot order is still legal, but it is not what the seed gave.
    const edited = { ...vote, payload: { ...vote.payload, vote: { ...vote.payload.vote, ballots: [...vote.payload.vote.ballots].reverse() } } };
    const found = verifyContest(log.events.map((e, k) => (k === i ? edited : e)), statsOf);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ what: 'vote', episode: 1 });
  });
});
