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
import { notImplemented } from '../internal/not-implemented';

/** A uniform float stream in [0, 1). Each call advances the stream. */
export type Rng = () => number;

/** String → four 32-bit seeds. Public-domain cyrb128. */
export function cyrb128(_input: string): [number, number, number, number] {
  return notImplemented('cyrb128', 'T2.1');
}

/** Four 32-bit seeds → uniform [0, 1) stream. Public-domain sfc32. */
export function sfc32(_a: number, _b: number, _c: number, _d: number): Rng {
  return notImplemented('sfc32', 'T2.1');
}

/** Independent substream for `key` under `seed`: `sfc32(...cyrb128(seed + '::' + key))`. */
export function rngFor(_seed: string, _key: string): Rng {
  return notImplemented('rngFor', 'T2.1');
}

/** One d20 roll from a stream: `1 + floor(20 * rng())`. */
export function rollD20(_rng: Rng): number {
  return notImplemented('rollD20', 'T2.1');
}

/** Inputs to the seed for one tavern's run of one week. */
export interface WeekSeedInput {
  readonly season: string;
  readonly week: number;
  readonly tavern: string;
  /**
   * Per-week secret revealed with the mission. Whether it is used is OPEN
   * (docs/decisions.md D-13). `undefined` means the seed is
   * (season, week, tavern) only.
   */
  readonly salt?: string;
}

/**
 * Canonical seed string for one tavern's weekly run, e.g.
 * `season-01/week-3/tavern:the-gilded-flagon`. Per-node dice then come from
 * `rngFor(weekSeed, 'roll:' + nodeId)`.
 */
export function weekSeed(_input: WeekSeedInput): string {
  return notImplemented('weekSeed', 'T2.2');
}

/** Seed for the snake-draft order when the season config says `order: seeded`. */
export function draftOrderSeed(_season: string): string {
  return notImplemented('draftOrderSeed', 'T2.2');
}
