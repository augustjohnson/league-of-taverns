/**
 * Repo file access: the only module that knows the on-disk layout.
 *
 * Responsibilities:
 * - Resolve paths (seasons/<id>/config.yaml, characters/<id>/character.yaml,
 *   data/open5e/manifest.json, seasons/<id>/events/events.ndjson).
 * - Load and schema-check YAML, then hand the engine chrome-free data.
 *   `loadCharacterRef` returns `{ id, base }` only. Chrome is loaded
 *   separately by `loadCharacterChrome`, for display only.
 * - Load a pinned Open5e snapshot with its manifest sha256 verified
 *   (`loadSnapshot`). Season files (config, pool, managers, taverns,
 *   challenges) load through ./season.ts, which builds on the helpers here.
 * - Errors name the file (relative to the repo root) and the field path, and
 *   are `ValidationFailure`s so scripts exit 1.
 * - Append events (`appendEvent`): read the log, replay, apply the candidate
 *   event through the engine reducers, then append one canonical line
 *   atomically. It doesn't lock: callers must hold the season's Actions
 *   concurrency group.
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CharacterRef,
  EventOf,
  EventType,
  LeagueEvent,
  LeagueState,
  Open5eMonster,
  SchemaIssue,
} from '@league-of-taverns/engine';
import { applyEvent, kebabIdSchema, lineHash, parseLog, replayLog, serializeEvent, toSchemaIssues } from '@league-of-taverns/engine';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { characterFileSchema } from './character-schema';
import type { CharacterChrome, CharacterFile } from './character-schema';
import { ValidationFailure } from './main';

export const REPO_ROOT = new URL('../../../', import.meta.url);

/** Repo root as a file URL or a filesystem path. Loaders default to `REPO_ROOT`; tests pass a temp dir. */
export type RepoRoot = URL | string;

// Season files (config, pool, managers, schedule) load through ./season.ts.

/** data/open5e/manifest.json entries, shape-checked. Extra keys are allowed. */
const manifestSchema = z.looseObject({
  snapshots: z.array(
    z.looseObject({
      id: z.string().min(1),
      count: z.number().int().nonnegative(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase sha256 hex digest'),
      file: z.string().min(1),
    }),
  ),
});

/**
 * The records of a pinned snapshot, after checking the file against its
 * manifest entry: the sha256 of the bytes on disk and the record count must
 * both match. Fails on an unknown id, naming the ids that exist.
 */
export function loadSnapshot(snapshotId: string, root: RepoRoot = REPO_ROOT): ReadonlyArray<Open5eMonster> {
  const dataDir = join(rootDir(root), 'data', 'open5e');
  const manifestFile = join(dataDir, 'manifest.json');
  const manifestLabel = displayPath(manifestFile, root);
  const parsed = manifestSchema.safeParse(readJson(manifestFile, manifestLabel));
  if (!parsed.success) throw issuesFailure(manifestLabel, toSchemaIssues(parsed.error));
  const entry = parsed.data.snapshots.find((s) => s.id === snapshotId);
  if (entry === undefined) {
    const known = parsed.data.snapshots.map((s) => JSON.stringify(s.id)).join(', ') || 'none';
    throw new ValidationFailure(`${manifestLabel}: unknown snapshot ${JSON.stringify(snapshotId)} (known: ${known})`);
  }

  const file = resolve(dataDir, entry.file);
  const label = displayPath(file, root);
  const inside = relative(dataDir, file);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new ValidationFailure(`${manifestLabel}: snapshot ${JSON.stringify(snapshotId)}: file ${JSON.stringify(entry.file)} is outside data/open5e/`);
  }
  const bytes = readBytes(file, label);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) {
    throw new ValidationFailure(
      `${label}: sha256 is ${actual}, but ${manifestLabel} pins ${entry.sha256} for snapshot ${JSON.stringify(snapshotId)}. ` +
        'Snapshots are immutable: restore the file, or take a new snapshot under a new id.',
    );
  }
  const records = parseJson(bytes.toString('utf8'), label);
  if (!Array.isArray(records) || !records.every((r) => isRecord(r) && typeof r.slug === 'string')) {
    throw new ValidationFailure(`${label}: expected a JSON array of Open5e records, each with a string "slug"`);
  }
  if (records.length !== entry.count) {
    throw new ValidationFailure(`${label}: has ${records.length} records, but ${manifestLabel} says ${entry.count}`);
  }
  return records as ReadonlyArray<Open5eMonster>;
}

/**
 * Mechanical identity only: a fresh `{ id, base }`, never the parsed file, so
 * no chrome field can ride along into the engine.
 */
export function loadCharacterRef(characterId: string, root: RepoRoot = REPO_ROOT): CharacterRef {
  const file = loadCharacterFile(characterId, root);
  return { id: file.id, base: file.base };
}

/** Chrome for story rendering. Must never be passed into the engine. */
export function loadCharacterChrome(characterId: string, root: RepoRoot = REPO_ROOT): CharacterChrome {
  return loadCharacterFile(characterId, root).chrome;
}

/** characters/<id>/character.yaml, schema-checked, with the folder name matching `id`. */
function loadCharacterFile(characterId: string, root: RepoRoot): CharacterFile {
  if (!kebabIdSchema.safeParse(characterId).success) {
    throw new ValidationFailure(`invalid character id ${JSON.stringify(characterId)}: expected a kebab-case folder name`);
  }
  const file = join(rootDir(root), 'characters', characterId, 'character.yaml');
  const label = displayPath(file, root);
  const result = characterFileSchema.safeParse(readYaml(file, label));
  if (!result.success) throw issuesFailure(label, toSchemaIssues(result.error));
  if (result.data.id !== characterId) {
    throw new ValidationFailure(
      `${label}: id: ${JSON.stringify(result.data.id)} does not match its folder name ${JSON.stringify(characterId)}`,
    );
  }
  return result.data;
}

/** The root as an absolute filesystem path. */
export function rootDir(root: RepoRoot): string {
  return typeof root === 'string' ? resolve(root) : fileURLToPath(root);
}

/** Path relative to the root when inside it, for short error messages. */
export function displayPath(file: string, root: RepoRoot): string {
  const rel = relative(rootDir(root), file);
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel;
}

/** Parsed YAML. A missing file or a syntax error is a `ValidationFailure` naming `label`. */
export function readYaml(file: string, label: string): unknown {
  const source = readBytes(file, label).toString('utf8');
  try {
    return parseYaml(source);
  } catch (error) {
    throw new ValidationFailure(`${label}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readJson(file: string, label: string): unknown {
  return parseJson(readBytes(file, label).toString('utf8'), label);
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new ValidationFailure(`${label}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readBytes(file: string, label: string): Buffer {
  try {
    return readFileSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ValidationFailure(`${label}: file not found`);
    throw error;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One line per issue: `<file>: <field path>: <message>`. */
export function issuesFailure(label: string, issues: ReadonlyArray<SchemaIssue>): ValidationFailure {
  return new ValidationFailure(issues.map((issue) => `${label}: ${issue.path}: ${issue.message}`).join('\n'));
}

// ── event log ──────────────────────────────────────────────────────────────

/** seasons/<season>/events/events.ndjson. Throws a `ValidationFailure` for a season id that isn't kebab-case. */
export function eventLogPath(season: string, root: RepoRoot = REPO_ROOT): string {
  if (!kebabIdSchema.safeParse(season).success) {
    throw new ValidationFailure(`invalid season id ${JSON.stringify(season)}: expected a kebab-case folder name`);
  }
  return join(rootDir(root), 'seasons', season, 'events', 'events.ndjson');
}

/** The season's event log as text, or `''` if the file doesn't exist yet. Not parsed or checked. */
export function readEventLog(season: string, root: RepoRoot = REPO_ROOT): string {
  try {
    return readFileSync(eventLogPath(season, root), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

/** An event as an Action builds it: everything but `seq` and `prev`, which `appendEvent` stamps. */
export type EventDraft = { [T in EventType]: Omit<EventOf<T>, 'seq' | 'prev'> }[EventType];

export interface AppendResult {
  /** State after the new event, with `lastHash` = the new line's hash (what `replayLog` of the new file gives). */
  readonly state: LeagueState;
  /** The event as written, with `seq` and `prev` stamped. */
  readonly event: LeagueEvent;
  /** The canonical line written, without its trailing newline. */
  readonly line: string;
}

/**
 * Validate one event against the replayed log and append it
 * (docs/schema.md § Reducers, "Validation path"; D-34).
 *
 * 1. Read the log and `replayLog` it. A corrupt log throws its
 *    `LogParseError` or `ReplayError`, naming the line, and nothing is written.
 * 2. Stamp `seq` = last seq + 1 and `prev` = `lineHash` of the last raw line
 *    (null for an empty log).
 * 3. Serialize it canonically (`serializeEvent`, which also schema-checks
 *    it), parse that line back, and fold it through `applyEvent`. An illegal
 *    event throws its `InvalidEventError` unchanged, and nothing is written.
 *    Folding the parsed line, not the draft, means the returned state is
 *    exactly what a later replay of the file produces.
 * 4. Append the line plus `\n` atomically: the old bytes and the new line go
 *    to a temp file in the same directory, which is fsynced and renamed over
 *    the log. A reader sees the old file or the new one, never half a line.
 *    The events directory is created if missing.
 *
 * Refuses (with a `ValidationFailure`, writing nothing) a draft for another
 * season, and a non-empty log that doesn't end in a newline, since appending
 * would then glue two lines together.
 *
 * **No locking.** This is read-modify-write. The caller must hold the
 * season's Actions concurrency group (D-34), so no other writer runs
 * between the read and the rename; two concurrent callers would lose one
 * event.
 */
export function appendEvent(season: string, draft: EventDraft, root: RepoRoot = REPO_ROOT): AppendResult {
  const file = eventLogPath(season, root);
  const label = displayPath(file, root);
  if (draft.season !== season) {
    throw new ValidationFailure(`${label}: event is for season ${JSON.stringify(draft.season)}, not ${JSON.stringify(season)}`);
  }
  const text = readEventLog(season, root);
  if (text !== '' && !text.endsWith('\n')) {
    throw new ValidationFailure(`${label}: does not end with a newline; refusing to append to a hand-edited log`);
  }
  const state = replayLog(text);

  const stamped = { ...draft, seq: state.lastSeq + 1, prev: state.lastHash } as LeagueEvent;
  const line = serializeEvent(stamped);
  const event = parseLog(line)[0]!;
  const next = applyEvent(state, event);

  mkdirSync(dirname(file), { recursive: true });
  writeAtomically(file, `${text}${line}\n`);
  return { state: { ...next, lastHash: lineHash(line) }, event, line };
}

/** Write `contents` to a temp file beside `file`, fsync it, and rename it over `file`. */
function writeAtomically(file: string, contents: string): void {
  const temp = join(dirname(file), `.${randomBytes(6).toString('hex')}.tmp`);
  try {
    const fd = openSync(temp, 'wx');
    try {
      writeSync(fd, contents);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}
