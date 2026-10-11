import { describe, expect, it } from 'vitest';
import { detExp, detLn, detLogistic } from '../src/internal/det-math';

/** Relative error against the host's Math, which is accurate but not bit-identical across engines. */
const rel = (a: number, b: number): number => Math.abs(a - b) / Math.max(Math.abs(b), Number.MIN_VALUE);

describe('deterministic math', () => {
  it('detLn matches Math.log to within 1e-15 relative over a wide range', () => {
    for (let i = -300; i <= 300; i++) {
      for (const f of [1, 1.37, 2.9, 7.123456]) {
        const x = f * 10 ** (i / 10);
        expect(rel(detLn(x), Math.log(x)), `x=${x}`).toBeLessThan(1e-15 + (Math.abs(Math.log(x)) < 1e-3 ? 1e-12 : 0));
      }
    }
  });

  it('detExp matches Math.exp to within 2e-15 relative over [-700, 700]', () => {
    for (let x = -700; x <= 700; x += 0.731) {
      expect(rel(detExp(x), Math.exp(x)), `x=${x}`).toBeLessThan(2e-15);
    }
  });

  it('handles special values', () => {
    expect(detLn(1)).toBe(0);
    expect(detLn(0)).toBe(-Infinity);
    expect(detLn(Infinity)).toBe(Infinity);
    expect(detLn(-1)).toBeNaN();
    expect(detExp(0)).toBe(1);
    expect(detExp(-Infinity)).toBe(0);
    expect(detExp(Infinity)).toBe(Infinity);
    expect(detExp(800)).toBe(Infinity);
    expect(detExp(-800)).toBe(0);
    expect(detLogistic(0)).toBe(0.5);
    expect(detLogistic(Infinity)).toBe(1);
    expect(detLogistic(-Infinity)).toBe(0);
  });

  it('pins exact bits for the value Node and Chrome disagreed on', () => {
    // Math.exp(0.4048199318411375) is ...674 in Node 26 and ...675 in Chrome 152.
    // detExp must give the same double everywhere; pin it.
    expect(detExp(0.4048199318411375)).toBe(DET_EXP_PIN);
    expect(detLn(2)).toBe(DET_LN2_PIN);
  });
});

const DET_EXP_PIN = 1.4990325477216433;
const DET_LN2_PIN = 0.6931471805599453;
