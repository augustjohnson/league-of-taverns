/**
 * Seeded randomness. The only source of randomness in the repo.
 *
 * Responsibilities:
 * - `cyrb128` hashes a string into four 32-bit words, and `sfc32` turns them
 *   into a uniform [0, 1) stream (docs/specs/03-seeding.md, kept as-is).
 * - `rngFor(seed, key)` derives an independent substream per concern, so
 *   adding a roll in one place can never shift a roll somewhere else.
 * - Seed and key grammar for league play lives here too, so every caller
 *   formats keys the same way (docs/schema.md § Seeds).
 *
 * Never use Math.random anywhere (lint enforces this in engine/).
 */

/** A uniform float stream in [0, 1). Each call advances the stream. */
export type Rng = () => number;

/**
 * String → four 32-bit seeds. Public-domain cyrb128 by bryc (StackOverflow
 * answer 47593316, current revision with the `h1 ^= h2 ^ h3 ^ h4` finaliser).
 * Hashes UTF-16 code units, so every JS runtime agrees.
 */
export function cyrb128(input: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < input.length; i++) {
    const k = input.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * Four 32-bit seeds → uniform [0, 1) stream. Public-domain sfc32 (Chris
 * Doty-Humphrey's Small Fast Counting generator, JS form by bryc); `d` is the
 * counter. Each output is a 32-bit word divided by 2^32, so it is exact.
 */
export function sfc32(a: number, b: number, c: number, d: number): Rng {
  let sa = a | 0;
  let sb = b | 0;
  let sc = c | 0;
  let sd = d | 0;
  return () => {
    const t = (((sa + sb) | 0) + sd) | 0;
    sd = (sd + 1) | 0;
    sa = sb ^ (sb >>> 9);
    sb = (sc + (sc << 3)) | 0;
    sc = (sc << 21) | (sc >>> 11);
    sc = (sc + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** Independent substream for `key` under `seed`: `sfc32(...cyrb128(seed + '::' + key))`. */
export function rngFor(seed: string, key: string): Rng {
  return sfc32(...cyrb128(seed + '::' + key));
}

/** One d20 roll from a stream: `1 + floor(20 * rng())`. Advances the stream once. */
export function rollD20(rng: Rng): number {
  return 1 + Math.floor(20 * rng());
}

/** Inputs to the seed for one tavern's run of one week. */
export interface WeekSeedInput {
  /** Season id, e.g. `season-01`. Non-empty, no `/`. */
  readonly season: string;
  /** Week number, a positive integer. */
  readonly week: number;
  /** Tavern id. Non-empty, no `/`. */
  readonly tavern: string;
  /**
   * Optional per-week secret, appended as `/salt:<salt>`. `undefined` means
   * the seed is (season, week, tavern) only. Non-empty when given.
   */
  readonly salt?: string;
}

/** Throws unless `value` is a non-empty string with no `/` (the seed separator). */
function assertSeedPart(fn: string, field: string, value: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fn}: ${field} must be a non-empty string, got ${JSON.stringify(value)}`);
  }
  if (value.includes('/')) {
    throw new Error(`${fn}: ${field} must not contain "/", got ${JSON.stringify(value)}`);
  }
}

/**
 * Canonical seed string for one tavern's weekly run (docs/schema.md § Seeds):
 * `<season>/week-<n>/tavern:<tavern>`, plus `/salt:<salt>` when a salt is
 * given, e.g. `season-01/week-3/tavern:the-gilded-flagon`. Per-node dice come
 * from `rngFor(weekSeed, 'roll:' + nodeId)`.
 *
 * Per docs/decisions.md D-13, a live week's result may instead be a single
 * real random roll recorded in the event. This seed still drives sims, tests
 * and the difficulty report.
 *
 * Throws if `week` is not a positive integer, if `season` or `tavern` is empty
 * or contains `/`, or if `salt` is given but empty.
 */
export function weekSeed(input: WeekSeedInput): string {
  const { season, week, tavern, salt } = input;
  assertSeedPart('weekSeed', 'season', season);
  if (!Number.isInteger(week) || week < 1) {
    throw new Error(`weekSeed: week must be a positive integer, got ${String(week)}`);
  }
  assertSeedPart('weekSeed', 'tavern', tavern);
  const base = `${season}/week-${week}/tavern:${tavern}`;
  if (salt === undefined) return base;
  if (typeof salt !== 'string' || salt.length === 0) {
    throw new Error(`weekSeed: salt must be a non-empty string when given, got ${JSON.stringify(salt)}`);
  }
  return `${base}/salt:${salt}`;
}

/**
 * Seed for the snake-draft order when the season config says `order: seeded`:
 * `<season>/draft-order`. Callers draw from `rngFor(draftOrderSeed(season), 'order')`.
 * Throws if `season` is empty or contains `/`.
 */
export function draftOrderSeed(season: string): string {
  assertSeedPart('draftOrderSeed', 'season', season);
  return `${season}/draft-order`;
}
