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
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { notImplemented } from '../internal/not-implemented';
import { formatIssuePath } from '../missions/schema';
import { eventSchema } from './schema';
import type { LeagueState } from './state';
import type { LeagueEvent } from './types';

/** A log line that is not valid JSON or does not match the event schema. */
export class LogParseError extends Error {
  constructor(
    /** 1-based line number in the NDJSON text. */
    readonly line: number,
    /** Field path of the first schema issue, e.g. `payload.lineup.allies[1]`, or null for bad JSON. */
    readonly path: string | null,
    message: string,
  ) {
    super(`events line ${line}: ${path === null ? '' : `${path}: `}${message}`);
    this.name = 'LogParseError';
  }
}

/**
 * NDJSON text → schema-checked events, in file order. One trailing empty line
 * (the final newline) is ignored; any other blank line is an error. Throws
 * `LogParseError` naming the line and field. Envelope sequencing and the
 * `prev` chain are checked by `replay`, not here.
 */
export function parseLog(ndjson: string): ReadonlyArray<LeagueEvent> {
  const lines = ndjson.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, index) => {
    const lineNumber = index + 1;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new LogParseError(lineNumber, null, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const result = eventSchema.safeParse(json);
    if (!result.success) {
      const issue = result.error.issues[0];
      const more = result.error.issues.length > 1 ? ` (+${result.error.issues.length - 1} more)` : '';
      throw new LogParseError(lineNumber, formatIssuePath(issue?.path ?? []), `${issue?.message ?? 'invalid event'}${more}`);
    }
    return result.data;
  });
}

/**
 * Serialize one event as a canonical NDJSON line: object keys sorted
 * recursively (UTF-16 code unit order), array order preserved, no whitespace,
 * no trailing newline. Equal events always give identical bytes, so `prev`
 * hashes are reproducible. Throws if the event does not match the schema, so
 * a line `parseLog` would reject is never produced.
 */
export function serializeEvent(event: LeagueEvent): string {
  const result = eventSchema.safeParse(event);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`serializeEvent: ${formatIssuePath(issue?.path ?? [])}: ${issue?.message ?? 'invalid event'}`);
  }
  return canonicalJson(event, '');
}

/** sha256 hex of one line's UTF-8 bytes. Used for `prev`. Pure JS, so it runs in the browser. */
export function lineHash(line: string): string {
  return bytesToHex(sha256(utf8ToBytes(line)));
}

function canonicalJson(value: unknown, at: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`serializeEvent: ${at || '(root)'}: non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => canonicalJson(item, `${at}[${i}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], at ? `${at}.${key}` : key)}`);
    return `{${fields.join(',')}}`;
  }
  throw new Error(`serializeEvent: ${at || '(root)'}: cannot serialize a ${typeof value}`);
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
