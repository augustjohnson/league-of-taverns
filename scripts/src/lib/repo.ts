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
 * - Append events: read the log, replay, apply the candidate event through the
 *   engine reducers, then append one canonical line. Callers must hold the
 *   season's Actions concurrency group.
 */
import type { CharacterRef, LeagueEvent, LeagueState, Open5eMonster, SeasonConfig } from '@league-of-taverns/engine';
import { notImplemented } from '@league-of-taverns/engine';

export const REPO_ROOT = new URL('../../../', import.meta.url);

export function loadSeasonConfig(_season: string): SeasonConfig {
  return notImplemented('loadSeasonConfig', 'T3.4');
}

export function loadSnapshot(_snapshotId: string): ReadonlyArray<Open5eMonster> {
  return notImplemented('loadSnapshot', 'T1.4');
}

/** Mechanical identity only. Never returns chrome. */
export function loadCharacterRef(_characterId: string): CharacterRef {
  return notImplemented('loadCharacterRef', 'T3.1');
}

/** Chrome for story rendering. Must never be passed into the engine. */
export function loadCharacterChrome(_characterId: string): unknown {
  return notImplemented('loadCharacterChrome', 'T3.1');
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
