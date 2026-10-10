import { describe, expect, it } from 'vitest';
import { cyrb128, draftOrderSeed, rngFor, rollD20, sfc32, weekSeed, type Rng } from '../src/rng';

/** The next `n` outputs of a stream as the raw 32-bit words sfc32 produced. */
function words(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => rng() * 2 ** 32);
}

// Reference values. No official test vectors exist for cyrb128 (it is a
// public-domain StackOverflow function), so these were produced by an
// independent Python transcription using unbounded ints masked to uint32,
// not by running this TypeScript:
// - cyrb128: bryc's JS (StackOverflow answer 47593316, current revision, whose
//   finaliser is `h1 ^= (h2 ^ h3 ^ h4), h2 ^= h1, h3 ^= h1, h4 ^= h1`).
// - sfc32: the PractRand reference step by Chris Doty-Humphrey
//   (`tmp = a + b + counter++; a = b ^ (b >> 9); b = c + (c << 3);
//   c = rotl(c, 21) + tmp; return tmp`), with `d` as the counter, as in
//   bryc/code jshash/PRNGs.md. sfc32(0, 0, 0, 0) → 0, 1, 2, 12 also checks by hand.
// If any of these change, every recorded week result changes with them.
const CYRB128_GOLDEN: ReadonlyArray<readonly [string, readonly [number, number, number, number]]> = [
  ['', [41608494, 3485963809, 1435736333, 1262568316]],
  ['a', [1589175524, 148824423, 2405369273, 1476957317]],
  ['apples', [1353502818, 2189370424, 187770103, 4227467030]],
  [
    'season-01/week-3/tavern:the-gilded-flagon::roll:gate',
    [719188793, 749840358, 3553410637, 3967180041],
  ],
];

const SFC32_GOLDEN: ReadonlyArray<readonly [readonly [number, number, number, number], readonly number[]]> = [
  [
    [0, 0, 0, 0],
    [0, 1, 2, 12, 18874399, 56669315],
  ],
  [
    [1, 2, 3, 4],
    [7, 34, 56623200, 188882296, 3431242869, 399395954],
  ],
  [
    [0xdeadbeef, 0xcafebabe, 0x12345678, 0x9abcdef0],
    [1147754653, 154119948, 3977009422, 2818562941, 1587816132, 2748357208],
  ],
];

describe('rng', () => {
  it('cyrb128 matches reference values for fixed inputs', () => {
    for (const [input, expected] of CYRB128_GOLDEN) {
      expect(cyrb128(input), JSON.stringify(input)).toEqual(expected);
    }
  });

  it('sfc32 matches reference values for fixed seeds', () => {
    for (const [seeds, expected] of SFC32_GOLDEN) {
      expect(words(sfc32(...seeds), expected.length), seeds.join(',')).toEqual(expected);
    }
  });

  it('sfc32 outputs are in [0, 1)', () => {
    const rng = sfc32(0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff);
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x >= 0 && x < 1).toBe(true);
    }
  });

  it('rngFor(seed, key) is sfc32(...cyrb128(seed + "::" + key)) with pinned first outputs', () => {
    const rng = rngFor('season-01/week-3/tavern:the-gilded-flagon', 'roll:gate');
    expect(words(rng, 5)).toEqual([1141241896, 2337344756, 3662022319, 1161652326, 414104496]);
    expect(words(rngFor('apples', ''), 3)).toEqual(words(sfc32(...cyrb128('apples::')), 3));
  });

  it('rngFor(seed, key) is stable across calls', () => {
    const a = rngFor('season-01', 'roll:n1');
    const b = rngFor('season-01', 'roll:n1');
    expect(words(a, 100)).toEqual(words(b, 100));
  });

  it('a substream does not depend on draws from another substream', () => {
    const fresh = words(rngFor('season-01', 'roll:n2'), 10);
    const other = rngFor('season-01', 'roll:n1');
    for (let i = 0; i < 37; i++) other();
    expect(words(rngFor('season-01', 'roll:n2'), 10)).toEqual(fresh);
  });

  it('different keys under one seed produce different, uncorrelated streams', () => {
    const n = 20_000;
    const xs = Array.from({ length: n }, rngFor('season-01', 'roll:a'));
    const ys = Array.from({ length: n }, rngFor('season-01', 'roll:b'));
    expect(xs.slice(0, 10)).not.toEqual(ys.slice(0, 10));
    expect(xs.filter((x, i) => x === ys[i]).length).toBe(0);

    const mean = (v: number[]): number => v.reduce((s, x) => s + x, 0) / v.length;
    const mx = mean(xs);
    const my = mean(ys);
    let cov = 0;
    let vx = 0;
    let vy = 0;
    for (let i = 0; i < n; i++) {
      const dx = (xs[i] ?? 0) - mx;
      const dy = (ys[i] ?? 0) - my;
      cov += dx * dy;
      vx += dx * dx;
      vy += dy * dy;
    }
    // |r| for independent uniforms has sd ≈ 1/sqrt(n) ≈ 0.007 here.
    expect(Math.abs(cov / Math.sqrt(vx * vy))).toBeLessThan(0.03);
  });

  it('rollD20 is uniform on 1..20 (chi-square over 100k rolls)', () => {
    const rolls = 100_000;
    const counts = new Array<number>(21).fill(0);
    const rng = rngFor('chi-square', 'd20');
    for (let i = 0; i < rolls; i++) {
      const r = rollD20(rng);
      expect(Number.isInteger(r) && r >= 1 && r <= 20).toBe(true);
      counts[r] = (counts[r] ?? 0) + 1;
    }
    const expected = rolls / 20;
    const chiSquare = counts.slice(1).reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
    // 19 degrees of freedom: p = 0.001 at 43.8. 50 is generous.
    expect(chiSquare).toBeLessThan(50);
    expect(counts[0]).toBe(0);
  });

  it('rollD20 maps the ends of [0, 1) to 1 and 20', () => {
    expect(rollD20(() => 0)).toBe(1);
    expect(rollD20(() => 0.05)).toBe(2);
    expect(rollD20(() => 0.999_999_999)).toBe(20);
  });

});

describe('seeds', () => {
  it('weekSeed formats (season, week, tavern) canonically', () => {
    expect(weekSeed({ season: 'season-01', week: 3, tavern: 'the-gilded-flagon' })).toBe(
      'season-01/week-3/tavern:the-gilded-flagon',
    );
    expect(weekSeed({ season: 'season-01', week: 12, tavern: 'x' })).toBe('season-01/week-12/tavern:x');
  });

  it('weekSeed appends the salt when given, and the salt changes the seed and the dice', () => {
    const input = { season: 'season-01', week: 3, tavern: 'the-gilded-flagon' } as const;
    const salted = weekSeed({ ...input, salt: 'k3y' });
    expect(salted).toBe('season-01/week-3/tavern:the-gilded-flagon/salt:k3y');
    expect(salted).not.toBe(weekSeed(input));
    expect(weekSeed({ ...input, salt: 'other' })).not.toBe(salted);
    expect(words(rngFor(salted, 'roll:gate'), 5)).not.toEqual(words(rngFor(weekSeed(input), 'roll:gate'), 5));
  });

  it('weekSeed matches the seed pinned in the cyrb128 reference values', () => {
    const seed = weekSeed({ season: 'season-01', week: 3, tavern: 'the-gilded-flagon' });
    expect(cyrb128(seed + '::roll:gate')).toEqual([719188793, 749840358, 3553410637, 3967180041]);
  });

  it('weekSeed rejects a week that is not a positive integer', () => {
    for (const week of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => weekSeed({ season: 'season-01', week, tavern: 't' }), String(week)).toThrow(/week must be a positive integer/);
    }
  });

  it('weekSeed rejects an empty or slash-containing season or tavern, and an empty salt', () => {
    expect(() => weekSeed({ season: '', week: 1, tavern: 't' })).toThrow(/season must be a non-empty string/);
    expect(() => weekSeed({ season: 'a/b', week: 1, tavern: 't' })).toThrow(/season must not contain "\/"/);
    expect(() => weekSeed({ season: 's', week: 1, tavern: '' })).toThrow(/tavern must be a non-empty string/);
    expect(() => weekSeed({ season: 's', week: 1, tavern: 'x/salt:y' })).toThrow(/tavern must not contain "\/"/);
    expect(() => weekSeed({ season: 's', week: 1, tavern: 't', salt: '' })).toThrow(/salt must be a non-empty string/);
  });

  it('draftOrderSeed is <season>/draft-order and validates the season', () => {
    expect(draftOrderSeed('season-01')).toBe('season-01/draft-order');
    expect(() => draftOrderSeed('')).toThrow(/season must be a non-empty string/);
    expect(() => draftOrderSeed('season/01')).toThrow(/season must not contain "\/"/);
  });
});
