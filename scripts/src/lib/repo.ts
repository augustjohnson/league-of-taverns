/**
 * Repo file access: the only module that knows the on-disk layout.
 *
 * Responsibilities:
 * - Resolve paths (seasons/<id>/config.yaml, characters/<id>/character.yaml,
 *   data/open5e/manifest.json, seasons/<id>/events/events.ndjson).
 * - Load and schema-check YAML, then hand the engine chrome-free data.
 *   `loadCharacterRef` returns `{ id, base }` only. Chrome is loaded
 *   separately by `loadCharacterChrome`, which only the publish and chrome
 *   scripts call.
 * - Load mission YAML and shape-check it with the engine's `parseMission`.
 * - Load a pinned Open5e snapshot with its manifest sha256 verified
 *   (`loadSnapshot`). Season files (config, pool, managers, schedule) load
 *   through ./season.ts, which builds on the helpers here.
 * - Errors name the file (relative to the repo root) and the field path, and
 *   are `ValidationFailure`s so scripts exit 1.
 * - Append events: read the log, replay, apply the candidate event through the
 *   engine reducers, then append one canonical line. Callers must hold the
 *   season's Actions concurrency group.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CharacterRef,
  LeagueEvent,
  LeagueState,
  Mission,
  Open5eMonster,
  SchemaIssue,
} from '@league-of-taverns/engine';
import { kebabIdSchema, notImplemented, parseMission, toSchemaIssues } from '@league-of-taverns/engine';
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

/**
 * Load and shape-check a mission file (seasons/<season>/missions/…). Relative
 * paths resolve against the repo root. Graph rules are `validateMission`'s.
 */
export function loadMission(path: string, root: RepoRoot = REPO_ROOT): Mission {
  const file = resolve(rootDir(root), path);
  const label = displayPath(file, root);
  const result = parseMission(readYaml(file, label));
  if (!result.ok) throw issuesFailure(label, result.issues);
  return result.value;
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

export function readEventLog(_season: string): string {
  return notImplemented('readEventLog', 'T2.4');
}

/**
 * Validate `event` against replayed state and append it. Throws
 * `InvalidEventError` without writing if the event is illegal. Returns the new state.
 */
export function appendEvent(_season: string, _event: Omit<LeagueEvent, 'seq' | 'prev'>): LeagueState {
  return notImplemented('appendEvent', 'T2.4');
}
