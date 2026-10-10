/**
 * Test-only loaders for Open5e records: the verbatim per-slug fixtures in this
 * folder and the full pinned snapshot. Node I/O is fine here (tests only).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Open5eMonster } from '../../../src/adapters/open5e';

const FIXTURE_DIR = import.meta.dirname;

/** The pinned snapshot the fixtures were copied from. */
export const SNAPSHOT_ID = 'open5e-v1-2026-10';
export const SNAPSHOT_PATH = join(FIXTURE_DIR, '..', '..', '..', '..', 'data', 'open5e', SNAPSHOT_ID, 'monsters.json');

/** Every fixture slug, sorted. */
export const FIXTURE_SLUGS: ReadonlyArray<string> = readdirSync(FIXTURE_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.slice(0, -'.json'.length))
  .sort();

/** One verbatim record from `<slug>.json`. Unchecked cast: snapshot-types.test.ts checks the shape. */
export function loadFixture(slug: string): Open5eMonster {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, `${slug}.json`), 'utf8')) as Open5eMonster;
}

/** The whole pinned snapshot, unchecked, as parsed JSON. */
export function loadSnapshot(): ReadonlyArray<Open5eMonster> {
  return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as ReadonlyArray<Open5eMonster>;
}
