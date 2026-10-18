/**
 * Canonical JSON and sha256: object keys sorted recursively (UTF-16 code
 * unit order), undefined fields dropped, arrays in order, no whitespace.
 * Equal values always give identical bytes, so hashes are reproducible.
 * Pure JS hashing, so it runs in the browser.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Challenge } from '../contest/types';

/** sha256 hex of a string's UTF-8 bytes. Used for `prev` and for commitments. */
export function lineHash(line: string): string {
  return bytesToHex(sha256(utf8ToBytes(line)));
}

/** `value` as canonical JSON. Throws on a non-finite number or a value JSON can't hold; `caller` prefixes the error. */
export function canonicalJson(value: unknown, caller = 'canonicalJson', at = ''): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${caller}: ${at || '(root)'}: non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => canonicalJson(item, caller, `${at}[${i}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], caller, at ? `${at}.${key}` : key)}`);
    return `{${fields.join(',')}}`;
  }
  throw new Error(`${caller}: ${at || '(root)'}: cannot serialize a ${typeof value}`);
}

/** The commitment for a challenge: sha256 of its canonical JSON. Sealed in `season.created`, checked at `challenge.resolved`. */
export function challengeSha256(challenge: Challenge): string {
  return lineHash(canonicalJson(challenge, 'challengeSha256'));
}
