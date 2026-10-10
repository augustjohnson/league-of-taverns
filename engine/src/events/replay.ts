/**
 * Replay: NDJSON text → validated events → folded state.
 *
 * Responsibilities:
 * - Parse NDJSON without I/O. The caller reads the file and passes a string.
 * - Check the envelope: contiguous seq, matching season, and a `prev` hash
 *   chain where each line commits to the previous line's sha256.
 * - Fold through `applyEvent`.
 * - `verifyResolutions` re-runs every `mission.resolved` with the recorded
 *   seed, lineup and engine version, and reports mismatches. The recorded run
 *   is the historical fact. Verification proves it was honest.
 *
 * Hashing must be pure JS so it runs in the browser (T2.3).
 */
import { notImplemented } from '../internal/not-implemented';
import type { LeagueState } from './state';
import type { LeagueEvent } from './types';

export function parseLog(_ndjson: string): ReadonlyArray<LeagueEvent> {
  return notImplemented('parseLog', 'T2.3');
}

/** Serialize one event as a canonical NDJSON line (stable key order, no trailing spaces). */
export function serializeEvent(_event: LeagueEvent): string {
  return notImplemented('serializeEvent', 'T2.3');
}

/** sha256 hex of one canonical line. Used for `prev`. */
export function lineHash(_line: string): string {
  return notImplemented('lineHash', 'T2.3');
}

export function replay(_events: ReadonlyArray<LeagueEvent>): LeagueState {
  return notImplemented('replay', 'T2.5');
}

export interface ResolutionMismatch {
  readonly seq: number;
  readonly week: number;
  readonly tavern: string;
  readonly field: string;
}

export function verifyResolutions(_events: ReadonlyArray<LeagueEvent>): ReadonlyArray<ResolutionMismatch> {
  return notImplemented('verifyResolutions', 'T2.5');
}
