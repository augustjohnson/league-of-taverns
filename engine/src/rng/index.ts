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

/**
 * Canonical seed for a season's contest: `<season>/contest`, plus
 * `/salt:<salt>` when a salt is given. Every die in the contest comes from
 * `rngFor(contestSeed, stream)`, one stream per challenge, vote and the finale
 * (contest/run.ts). Sims and the playground salt it with their own seed so
 * each run is a different contest.
 *
 * Throws if `season` is empty or contains `/`, or if `salt` is given but empty.
 */
export function contestSeed(season: string, salt?: string): string {
  assertSeedPart('contestSeed', 'season', season);
  const base = `${season}/contest`;
  if (salt === undefined) return base;
  if (typeof salt !== 'string' || salt.length === 0) {
    throw new Error(`contestSeed: salt must be a non-empty string when given, got ${JSON.stringify(salt)}`);
  }
  return `${base}/salt:${salt}`;
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
 * Seed for the snake-draft order when the season config says `order: seeded`:
 * `<season>/draft-order`. Callers draw from `rngFor(draftOrderSeed(season), 'order')`.
 * Throws if `season` is empty or contains `/`.
 */
export function draftOrderSeed(season: string): string {
  assertSeedPart('draftOrderSeed', 'season', season);
  return `${season}/draft-order`;
}
