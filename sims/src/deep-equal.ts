/**
 * Structural deep equality, for the season runner's replay self-check.
 *
 * A browser-safe stand-in for `node:util`'s `isDeepStrictEqual`, covering the
 * shapes a `LeagueState` is made of: primitives, arrays, plain objects, Maps
 * and Sets. It follows the same strict rules on those shapes:
 *
 * - Primitives compare with `Object.is`, so `NaN` equals `NaN` and `0` does
 *   not equal `-0`.
 * - Both sides must have the same prototype, so an array never equals an
 *   object with the same indices, and a Map never equals a plain object.
 * - Objects compare their own enumerable string keys as sets (order does not
 *   matter), then each value deeply. A key holding `undefined` is not the
 *   same as a missing key.
 * - Arrays compare length and then each index in order.
 * - Maps compare size and, for each entry, a deeply equal value under the
 *   same key. Primitive keys are looked up directly; an object key matches
 *   any deeply equal key on the other side. Insertion order does not matter.
 * - Sets compare size and membership the same way.
 * - Dates compare by time.
 *
 * Cycles are not supported (state has none).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;

  if (Array.isArray(a)) {
    const other = b as ReadonlyArray<unknown>;
    if (a.length !== other.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], other[i])) return false;
    return ownKeysEqual(a, other, true);
  }
  if (a instanceof Map) return mapsEqual(a, b as Map<unknown, unknown>);
  if (a instanceof Set) return setsEqual(a, b as Set<unknown>);
  if (a instanceof Date) return Object.is(a.getTime(), (b as Date).getTime());
  return ownKeysEqual(a as Record<string, unknown>, b as Record<string, unknown>, false);
}

/** Same own enumerable keys with deeply equal values. For arrays, only non-index keys are compared here. */
function ownKeysEqual(a: object, b: object, skipIndices: boolean): boolean {
  const keep = (key: string): boolean => !skipIndices || !/^(0|[1-9]\d*)$/.test(key);
  const ka = Object.keys(a).filter(keep);
  const kb = Object.keys(b).filter(keep);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(ra[key], rb[key])) return false;
  }
  return true;
}

function isObjectLike(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function mapsEqual(a: ReadonlyMap<unknown, unknown>, b: ReadonlyMap<unknown, unknown>): boolean {
  if (a.size !== b.size) return false;
  const unmatched: Array<[unknown, unknown]> = [];
  for (const [key, value] of a) {
    if (!isObjectLike(key)) {
      if (!b.has(key) || !deepEqual(value, b.get(key))) return false;
    } else {
      unmatched.push([key, value]);
    }
  }
  if (unmatched.length === 0) return true;
  const candidates = [...b].filter(([key]) => isObjectLike(key));
  for (const [key, value] of unmatched) {
    const i = candidates.findIndex(([k, v]) => deepEqual(key, k) && deepEqual(value, v));
    if (i < 0) return false;
    candidates.splice(i, 1);
  }
  return true;
}

function setsEqual(a: ReadonlySet<unknown>, b: ReadonlySet<unknown>): boolean {
  if (a.size !== b.size) return false;
  const unmatched: unknown[] = [];
  for (const value of a) {
    if (!isObjectLike(value)) {
      if (!b.has(value)) return false;
    } else {
      unmatched.push(value);
    }
  }
  if (unmatched.length === 0) return true;
  const candidates = [...b].filter(isObjectLike);
  for (const value of unmatched) {
    const i = candidates.findIndex((c) => deepEqual(value, c));
    if (i < 0) return false;
    candidates.splice(i, 1);
  }
  return true;
}
