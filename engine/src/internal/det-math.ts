/**
 * Deterministic `ln` and `exp`, built only from + − × ÷ and comparisons.
 *
 * ECMAScript leaves `Math.exp`, `Math.log`, `Math.pow` and the trig functions
 * "implementation-approximated", and engines really do differ in the last bit:
 * Node and Chrome disagreed on `Math.exp` inside the battle model. IEEE 754
 * basic arithmetic is exactly rounded everywhere, so these versions give
 * bit-identical results in every JS engine. The engine must use them instead
 * of the `Math` versions (lint enforces this).
 *
 * Accuracy is within a few ulps of the true value over the ranges the engine
 * uses, which is far finer than any game decision needs. Bit-for-bit agreement
 * across runtimes is what matters.
 */

/** ln 2, split into a high part with trailing zero bits and a small correction (Cody–Waite). */
const LN2_HI = 6.93147180369123816490e-1;
const LN2_LO = 1.90821492927058770002e-10;
const SQRT1_2 = 0.7071067811865476;

/** Natural logarithm. `detLn(0)` is −Infinity; negatives and NaN give NaN. */
export function detLn(x: number): number {
  if (Number.isNaN(x) || x < 0) return NaN;
  if (x === 0) return -Infinity;
  if (x === Infinity) return Infinity;

  // x = m × 2^e with m in [√½, √2). Scaling by 2 is exact.
  let m = x;
  let e = 0;
  while (m >= 2) { m /= 2; e++; }
  while (m < 1) { m *= 2; e--; }
  if (m >= 2 * SQRT1_2) { m /= 2; e++; }

  // ln m = 2·atanh(s), with s = (m − 1)/(m + 1), |s| ≤ 0.1716.
  const s = (m - 1) / (m + 1);
  const s2 = s * s;
  let term = s;
  let sum = 0;
  for (let k = 1; k <= 41; k += 2) {
    sum += term / k;
    term *= s2;
  }
  return e * LN2_HI + (e * LN2_LO + 2 * sum);
}

/** e^x. Overflows to Infinity above about 709.78 and underflows to 0 below about −745. */
export function detExp(x: number): number {
  if (Number.isNaN(x)) return NaN;
  if (x === Infinity) return Infinity;
  if (x === -Infinity) return 0;
  if (x > 709.782712893384) return Infinity;
  if (x < -745.1332191019412) return 0;

  // x = k·ln2 + r with |r| ≤ ln2/2. k is an exact integer and the reduction uses Cody–Waite.
  const k = Math.round(x / (LN2_HI + LN2_LO));
  const r = x - k * LN2_HI - k * LN2_LO;

  // Taylor series for e^r; |r| ≤ 0.347 converges below one ulp well before 25 terms.
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 25; n++) {
    term = (term * r) / n;
    sum += term;
  }

  // Multiply by 2^k one exact step at a time, splitting near the limits.
  let result = sum;
  let p = k;
  while (p > 0) { result *= 2; p--; }
  while (p < 0) { result /= 2; p++; }
  return result;
}

/** 1 / (1 + e^−z), deterministic across runtimes. */
export function detLogistic(z: number): number {
  if (z === Infinity) return 1;
  if (z === -Infinity) return 0;
  return 1 / (1 + detExp(-z));
}
