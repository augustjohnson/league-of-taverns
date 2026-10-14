import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { InvalidEventError, LogParseError, ReplayError, lineHash, replayLog } from '@league-of-taverns/engine';
import type { Actor, EventOf, EventType, LeagueEvent } from '@league-of-taverns/engine';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AT, COMMISSIONER, POOL, SEASON, miniConfig, schedule, sponsors, tavernList } from '../../engine/test/support/league-log';
import { ValidationFailure } from '../src/lib/main';
import { appendEvent, eventLogPath, readEventLog, type EventDraft } from '../src/lib/repo';

// T2.4: event-log file I/O.

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lot-events-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function draft<T extends EventType>(type: T, payload: EventOf<T>['payload'], actor: Actor = COMMISSIONER): EventDraft {
  return { v: 1, type, season: SEASON, at: AT, actor, payload } as EventDraft;
}

const created = draft('season.created', { config: miniConfig(), configSha256: lineHash('config'), engineVersion: '0.0.0', schedule: schedule(), sponsors: sponsors(), taverns: tavernList() });
const pooled = (i: number) => draft('character.pooled', { character: POOL[i]!.id, base: 'ogre', cr: POOL[i]!.cr, modifiers: [] });
const joined = (manager: string, githubId: number) => draft('manager.joined', { manager, account: { githubId, login: `m${githubId}` } });

const logFile = () => eventLogPath(SEASON, root);
const bytes = () => readFileSync(logFile());
const lines = () => readFileSync(logFile(), 'utf8').split('\n').slice(0, -1);

/** The error `fn` throws. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('eventLogPath and readEventLog', () => {
  it('resolves seasons/<id>/events/events.ndjson under the root', () => {
    expect(logFile()).toBe(join(root, 'seasons', SEASON, 'events', 'events.ndjson'));
    expect(() => eventLogPath('../escape', root)).toThrow(ValidationFailure);
  });

  it('reads a missing log as empty text', () => {
    expect(readEventLog(SEASON, root)).toBe('');
  });
});

describe('appendEvent', () => {
  it('appends season.created → character.pooled → manager.joined, creating the directory, and replays them', () => {
    const results = [created, pooled(0), joined('flagon-manager', 101)].map((d) => appendEvent(SEASON, d, root));
    const text = readEventLog(SEASON, root);
    expect(text).toBe(results.map((r) => `${r.line}\n`).join(''));

    const state = replayLog(text);
    expect(state.lastSeq).toBe(3);
    expect(state.phase).toBe('preseason');
    expect([...state.pool.keys()]).toEqual([POOL[0]!.id]);
    expect([...state.managers.keys()]).toEqual(['flagon-manager']);
    expect(results.at(-1)!.state).toEqual(state);
    expect(results.map((r) => r.event.seq)).toEqual([1, 2, 3]);
    expect(results.map((r) => r.event.type)).toEqual(['season.created', 'character.pooled', 'manager.joined']);
  });

  it('chains prev through several appends', () => {
    const results = [created, ...[0, 1, 2, 3].map(pooled), joined('nail-manager', 102)].map((d) => appendEvent(SEASON, d, root));
    const written = lines();
    expect(written).toEqual(results.map((r) => r.line));
    const events = written.map((l) => JSON.parse(l) as LeagueEvent);
    expect(events[0]!.prev).toBeNull();
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.prev, `line ${i + 1}`).toBe(lineHash(written[i - 1]!));
      expect(events[i]!.seq).toBe(i + 1);
    }
    expect(results.at(-1)!.state.lastHash).toBe(lineHash(written.at(-1)!));
    expect(replayLog(readEventLog(SEASON, root)).lastHash).toBe(lineHash(written.at(-1)!));
  });

  it('writes nothing for an event the reducers reject, and rethrows its InvalidEventError', () => {
    for (const d of [created, pooled(0), joined('flagon-manager', 101)]) appendEvent(SEASON, d, root);
    const before = bytes();
    const error = thrown(() => appendEvent(SEASON, joined('flagon-manager', 999), root));
    expect(error).toBeInstanceOf(InvalidEventError);
    expect((error as InvalidEventError).code).toBe('manager.duplicate');
    expect((error as InvalidEventError).seq).toBe(4);
    expect(bytes().equals(before)).toBe(true);
    expect(readdirSync(dirname(logFile()))).toEqual(['events.ndjson']);
  });

  it('writes nothing for a first event that is not season.created', () => {
    const error = thrown(() => appendEvent(SEASON, pooled(0), root));
    expect((error as InvalidEventError).code).toBe('season.not_created');
    expect(readEventLog(SEASON, root)).toBe('');
  });

  it('writes nothing for a draft that fails the event schema', () => {
    appendEvent(SEASON, created, root);
    const before = bytes();
    const bad = { ...pooled(0), payload: { character: 'Not Kebab', base: 'ogre', cr: -1, modifiers: [] } } as unknown as EventDraft;
    expect(() => appendEvent(SEASON, bad, root)).toThrow(/serializeEvent/);
    expect(bytes().equals(before)).toBe(true);
  });

  it('refuses a draft for another season', () => {
    expect(() => appendEvent(SEASON, { ...created, season: 'season-02' }, root)).toThrow(ValidationFailure);
    expect(readEventLog(SEASON, root)).toBe('');
  });

  it('a corrupted line makes the next append throw, naming the line, and writes nothing', () => {
    for (const d of [created, pooled(0), pooled(1)]) appendEvent(SEASON, d, root);
    const [first, second, third] = lines();
    // An edit to line 2 is caught by line 3's prev.
    writeFileSync(logFile(), `${first}\n${second!.replace('"ogre"', '"orge"')}\n${third}\n`);
    const edited = bytes();
    const error = thrown(() => appendEvent(SEASON, pooled(2), root));
    expect(error).toBeInstanceOf(ReplayError);
    expect((error as ReplayError).line).toBe(3);
    expect((error as ReplayError).code).toBe('chain.prev_mismatch');
    expect(String((error as Error).message)).toMatch(/^events line 3: /);
    expect(bytes().equals(edited)).toBe(true);

    // A line that isn't JSON is named directly.
    writeFileSync(logFile(), `${first}\n{not json\n${third}\n`);
    const parse = thrown(() => appendEvent(SEASON, pooled(2), root));
    expect(parse).toBeInstanceOf(LogParseError);
    expect((parse as LogParseError).line).toBe(2);
  });

  it('refuses to append to a log without a final newline', () => {
    appendEvent(SEASON, created, root);
    writeFileSync(logFile(), readEventLog(SEASON, root).trimEnd());
    const before = bytes();
    expect(() => appendEvent(SEASON, pooled(0), root)).toThrow(/newline/);
    expect(bytes().equals(before)).toBe(true);
  });

  it('appends to an existing empty log file', () => {
    mkdirSync(dirname(logFile()), { recursive: true });
    writeFileSync(logFile(), '');
    const { event } = appendEvent(SEASON, created, root);
    expect(event.prev).toBeNull();
    expect(lines()).toHaveLength(1);
  });
});
