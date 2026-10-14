/**
 * The playground's data: a season as plain JSON, and the pure step back to a
 * run-ready `SeasonInput`.
 *
 * The build script (../build-playground.ts) loads the mock season in Node,
 * calls `serializeSeason` and inlines the result into the page. The page
 * calls `seasonInputFromData`, which is the same `seasonInput` the Node path
 * (`loadMockSeason`) uses, so a seed gives the same NDJSON in both.
 *
 * No DOM and no Node here: this module is imported by the build script, the
 * tests and the browser bundle.
 */
import type { Mission, Open5eMonster } from '@league-of-taverns/engine';
import type { GodChrome } from '@league-of-taverns/scripts/lib/god-schema';
import { seasonInput, type SeasonInput, type SeasonParts } from '../season-runner';

/** Bumped when the shape changes. */
export const PLAYGROUND_DATA_VERSION = 5;

/** Everything the page needs, JSON-safe. A `SeasonParts` with the snapshot trimmed to the records it uses. */
export interface PlaygroundData extends SeasonParts {
  readonly version: typeof PLAYGROUND_DATA_VERSION;
  /** The season folder it was built from, relative to the repo root. */
  readonly source: string;
  /** Display names (chrome) by character id, for the page only: they never reach the engine. Ids missing here show as ids. */
  readonly names: Readonly<Record<string, string>>;
  /** Each god's chrome (name, call, banner) by god id, for the page only. Gods missing here show as ids, with no banner. */
  readonly gods: Readonly<Record<string, GodChrome>>;
}

/** Every Open5e slug a season touches: each pool base and each encounter creature. */
export function usedSlugs(pool: SeasonParts['pool'], missions: ReadonlyArray<{ readonly mission: Mission }>): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const { character } of pool) slugs.add(character.ref.base);
  for (const { mission } of missions) {
    for (const node of mission.nodes) {
      if (node.kind === 'battle') for (const creature of node.encounter.creatures) slugs.add(creature.ref);
    }
  }
  return slugs;
}

/**
 * Reduce `parts` to what the page needs. Snapshot records are kept verbatim,
 * in snapshot order, first record per slug, and only for slugs the season
 * uses (`usedSlugs`). Throws if a used slug has no record. `names` are the
 * pooled characters' chrome names and `gods` the gods' chrome, both carried
 * for display.
 */
export function serializeSeason(
  parts: SeasonParts,
  source: string,
  names: Readonly<Record<string, string>> = {},
  gods: Readonly<Record<string, GodChrome>> = {},
): PlaygroundData {
  const wanted = usedSlugs(parts.pool, parts.missions);
  const kept = new Map<string, Open5eMonster>();
  for (const record of parts.snapshot) if (wanted.has(record.slug) && !kept.has(record.slug)) kept.set(record.slug, record);
  const missing = [...wanted].filter((slug) => !kept.has(slug));
  if (missing.length > 0) throw new Error(`serializeSeason: no snapshot record for ${missing.join(', ')}`);
  return {
    version: PLAYGROUND_DATA_VERSION,
    source,
    names,
    gods,
    config: parts.config,
    configSha256: parts.configSha256,
    engineVersion: parts.engineVersion,
    schedule: parts.schedule,
    sponsors: parts.sponsors,
    pool: parts.pool,
    taverns: parts.taverns,
    managers: parts.managers,
    commissioner: parts.commissioner,
    missions: parts.missions,
    snapshot: [...kept.values()],
  };
}

/** Rebuild the `SeasonInput` (with `statsOf`, `baseOf` and the battle model) from plain data. Pure. */
export function seasonInputFromData(data: PlaygroundData): SeasonInput {
  if (data.version !== PLAYGROUND_DATA_VERSION) throw new Error(`playground data version ${String(data.version)}, expected ${PLAYGROUND_DATA_VERSION}`);
  return seasonInput(data);
}
