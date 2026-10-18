/**
 * The playground's data: a season as plain JSON, and the pure step back to a
 * run-ready `SeasonInput`.
 *
 * The build script (../build-playground.ts) loads the season in Node, calls
 * `serializeSeason` and inlines the result into the page. The page calls
 * `seasonInputFromData`, which is the same `seasonInput` the CLI uses, so a
 * seed gives the same NDJSON in both.
 *
 * No DOM and no Node here: this module is imported by the build script, the
 * tests and the browser bundle.
 */
import type { Open5eMonster } from '@league-of-taverns/engine';
import type { Banner } from '@league-of-taverns/scripts/lib/banner';
import { seasonInput, type SeasonInput, type SeasonParts } from '../season-runner';

/** Bumped when the shape changes. */
export const PLAYGROUND_DATA_VERSION = 8;

/** A character's chrome, for display only. It never reaches `seasonInput` or the engine. */
export interface PlaygroundChrome {
  readonly name: string;
  readonly epithet?: string;
  readonly tagline?: string;
  /** A thumbnail of the painted portrait, as a `data:image/png;base64,` URI. */
  readonly portrait?: string;
  /** The card's face crop of the painted portrait, as a `data:image/png;base64,` URI. */
  readonly face?: string;
}

/** A tavern's chrome: its banner and its regulars' toast. */
export interface TavernChrome {
  readonly banner: Banner;
  readonly toast?: string;
}

/** A challenge's chrome: its title, the Lich's words, and one line per check. */
export interface ChallengeChrome {
  readonly title: string;
  readonly story: string;
  readonly lines: ReadonlyArray<string>;
}

/** Everything the page needs, JSON-safe. A `SeasonParts` with the snapshot trimmed to the records it uses. */
export interface PlaygroundData extends SeasonParts {
  readonly version: typeof PLAYGROUND_DATA_VERSION;
  /** The season folder it was built from, relative to the repo root. */
  readonly source: string;
  /** The season's display name. */
  readonly name: string;
  /** Chrome by character id. A character without an entry shows as its id. */
  readonly chrome: Readonly<Record<string, PlaygroundChrome>>;
  /** Each tavern's chrome by tavern id. A tavern missing here shows with no banner. */
  readonly tavernChrome: Readonly<Record<string, TavernChrome>>;
  /** Each challenge's chrome, by episode. */
  readonly challengeChrome: Readonly<Record<number, ChallengeChrome>>;
}

/**
 * Reduce `parts` to what the page needs: snapshot records are kept verbatim,
 * in snapshot order, first record per slug, and only for pool bases. Throws if
 * a base has no record. The chrome rides along untouched, for display only.
 */
export function serializeSeason(
  parts: SeasonParts,
  source: string,
  name: string,
  chrome: PlaygroundData['chrome'] = {},
  tavernChrome: PlaygroundData['tavernChrome'] = {},
  challengeChrome: PlaygroundData['challengeChrome'] = {},
): PlaygroundData {
  const wanted = new Set(parts.pool.map((p) => p.character.ref.base));
  const kept = new Map<string, Open5eMonster>();
  for (const record of parts.snapshot) if (wanted.has(record.slug) && !kept.has(record.slug)) kept.set(record.slug, record);
  const missing = [...wanted].filter((slug) => !kept.has(slug));
  if (missing.length > 0) throw new Error(`serializeSeason: no snapshot record for ${missing.join(', ')}`);
  return { ...parts, version: PLAYGROUND_DATA_VERSION, source, name, snapshot: [...kept.values()], chrome, tavernChrome, challengeChrome };
}

/** Rebuild the `SeasonInput` from plain data. Pure. */
export function seasonInputFromData(data: PlaygroundData): SeasonInput {
  if (data.version !== PLAYGROUND_DATA_VERSION) throw new Error(`playground data version ${String(data.version)}, expected ${PLAYGROUND_DATA_VERSION}`);
  return seasonInput(data);
}
