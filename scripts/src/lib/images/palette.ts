/**
 * League palettes and colour maths for the pixel-art pipeline.
 *
 * Every generated image is snapped to one fixed palette, which is what makes
 * dozens of separately generated sprites read as one set.
 */

export type Rgb = readonly [number, number, number];
export type Lab = readonly [number, number, number];

/**
 * Resurrect 64 by Kerrie Lake, https://lospec.com/palette-list/resurrect-64.
 * Credited in docs/images.md.
 */
const RESURRECT_64 = `
  2e222f 3e3546 625565 966c6c ab947a 694f62 7f708a 9babb2 c7dcd0 ffffff 6e2727 b33831 ea4f36
  f57d4a ae2334 e83b3b fb6b1d f79617 f9c22b 7a3045 9e4539 cd683d e6904e fbb954 4c3e24 676633
  a2a947 d5e04b fbff86 165a4c 239063 1ebc73 91db69 cddf6c 313638 374e4a 547e64 92a984 b2ba90
  0b5e65 0b8a8f 0eaf9b 30e1b9 8ff8e2 323353 484a77 4d65b4 4d9be6 8fd3ff 45293f 6b3e75 905ea9
  a884f3 eaaded 753c54 a24b6f cf657f ed8099 831c5d c32454 f04f78 f68181 fca790 fdcbb0`;

export const PALETTES = { 'resurrect-64': parseHex(RESURRECT_64) } as const satisfies Record<string, ReadonlyArray<Rgb>>;
export type PaletteName = keyof typeof PALETTES;

function parseHex(list: string): ReadonlyArray<Rgb> {
  return list
    .trim()
    .split(/\s+/)
    .map((hex) => [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)] as const);
}

/** sRGB (0–255) to OKLab, https://bottosson.github.io/posts/oklab/. Distances there track perceived difference. */
export function oklab([r, g, b]: Rgb): Lab {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073970367 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab back to sRGB (0–255), clamped. */
export function fromOklab([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const [r, g, bl] = lin.map((v) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255);
  }) as [number, number, number];
  return [r, g, bl];
}

/**
 * Index of the palette colour nearest to `lab`. `chromaWeight` > 1 favours
 * keeping hue over keeping lightness, so a mid green stays green rather than
 * turning into a grey of the same brightness.
 */
export function nearest(lab: Lab, paletteLab: ReadonlyArray<Lab>, chromaWeight: number): number {
  let best = 0;
  let bestDistance = Infinity;
  paletteLab.forEach(([l, a, b], i) => {
    const d = (lab[0] - l) ** 2 + chromaWeight * ((lab[1] - a) ** 2 + (lab[2] - b) ** 2);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  });
  return best;
}
