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
 * - Errors name the file (relative to the repo root) and the field path, and
 *   are `ValidationFailure`s so scripts exit 1.
 * - Append events: read the log, replay, apply the candidate event through the
 *   engine reducers, then append one canonical line. Callers must hold the
 *   season's Actions concurrency group.
 */
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
  SeasonConfig,
} from '@league-of-taverns/engine';
import { kebabIdSchema, notImplemented, parseMission, toSchemaIssues } from '@league-of-taverns/engine';
import { parse as parseYaml } from 'yaml';
import { characterFileSchema } from './character-schema';
import type { CharacterChrome, CharacterFile } from './character-schema';
import { ValidationFailure } from './main';

export const REPO_ROOT = new URL('../../../', import.meta.url);

/** Repo root as a file URL or a filesystem path. Loaders default to `REPO_ROOT`; tests pass a temp dir. */
export type RepoRoot = URL | string;

export function loadSeasonConfig(_season: string): SeasonConfig {
  return notImplemented('loadSeasonConfig', 'T3.4');
}

export function loadSnapshot(_snapshotId: string): ReadonlyArray<Open5eMonster> {
  return notImplemented('loadSnapshot', 'T1.4');
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

function rootDir(root: RepoRoot): string {
  return typeof root === 'string' ? resolve(root) : fileURLToPath(root);
}

/** Path relative to the root when inside it, for short error messages. */
function displayPath(file: string, root: RepoRoot): string {
  const rel = relative(rootDir(root), file);
  return rel.startsWith('..') || isAbsolute(rel) ? file : rel;
}

function readYaml(file: string, label: string): unknown {
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ValidationFailure(`${label}: file not found`);
    throw error;
  }
  try {
    return parseYaml(source);
  } catch (error) {
    throw new ValidationFailure(`${label}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** One line per issue: `<file>: <field path>: <message>`. */
function issuesFailure(label: string, issues: ReadonlyArray<SchemaIssue>): ValidationFailure {
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
