/**
 * Turn an SDXL + pixel-art LoRA render into a clean, palette-locked sprite.
 *
 * The LoRA paints on SDXL's 8-pixel latent grid, so each art pixel is an
 * exact `cell`×`cell` block. The steps:
 *
 * 1. Downscale: each block becomes its most common colour (ignoring the
 *    block's 1-pixel rim, where neighbours bleed in).
 * 2. Mask: with `cutout`, a block is opaque when most of its pixels are in
 *    the render's alpha (BiRefNet's cutout, done in ComfyUI).
 * 3. Quantize: k-means to `colorGroups` colours in OKLab, then map each group
 *    to its nearest palette colour. Grouping first means one source colour
 *    always lands on one palette colour, which avoids speckle where a hue sits
 *    between two palette entries.
 * 4. Despeckle: a pixel whose four neighbours all agree on another colour
 *    takes that colour.
 * 4b. Glass (translucent characters only): inside the cutout, cells close to
 *    the render's own background colour, or pale and washed out, are the
 *    background showing through a clear body. They keep their palette colour
 *    at `glass.alpha` opacity; outlines and anything inside stay solid.
 * 5. Frame: portraits are dropped onto the bottom edge, where the bar hides
 *    how they end (./framing.ts), and centred unless they touch a side edge.
 *
 * Deterministic: the same render and options give the same bytes.
 */
import { nearest, oklab } from './palette';
import type { Lab, Rgb } from './palette';
import type { IndexedImage, RgbaImage } from './png';

export interface PixelateOptions {
  /** Render pixels per art pixel. */
  readonly cell: number;
  readonly colorGroups: number;
  readonly chromaWeight: number;
  readonly palette: ReadonlyArray<Rgb>;
  /** Make the background transparent using the render's alpha channel. */
  readonly cutout: boolean;
  /** Re-anchor the opaque area bottom-centre (portraits). */
  readonly anchorBottom: boolean;
  /** Turn see-through parts of the figure into glass (needs `cutout`). */
  readonly glass?: GlassOptions;
}

export interface GlassOptions {
  /** Opacity of glass pixels, 1–254. */
  readonly alpha: number;
  /** OKLab distance to the render's background colour within which a cell is glass. */
  readonly maxDistance: number;
  /** A cell at least this light (OKLab L) and at most `maxChroma` saturated is glass too: a pale, clear body. */
  readonly minLightness: number;
  readonly maxChroma: number;
}

/** Cell states: transparent, solid, or glass (partly transparent). */
const CLEAR = 0;
const SOLID = 1;
const GLASS = 2;

export class PixelateError extends Error {
  override name = 'PixelateError';
}

export function pixelate(render: RgbaImage, options: PixelateOptions): IndexedImage {
  const { cell } = options;
  if (render.width % cell !== 0 || render.height % cell !== 0) {
    throw new PixelateError(`render is ${render.width}×${render.height}, not a multiple of the ${cell}-pixel grid`);
  }
  const width = render.width / cell;
  const height = render.height / cell;
  const colors = downscale(render, cell);
  const opaque = options.cutout ? alphaCells(render, cell) : new Uint8Array(width * height).fill(1);
  if (options.cutout && !opaque.includes(0)) {
    throw new PixelateError('cutout requested, but the render has no transparent area; was it rendered without background removal?');
  }

  if (options.glass !== undefined) {
    if (!options.cutout) throw new PixelateError('glass needs a cutout: the background colour comes from the area the cutout removed');
    markGlass(render, colors, opaque, options.glass);
  }

  const paletteIndex = quantize(colors, opaque, options);
  despeckle(paletteIndex, opaque, width, height);
  const framed = options.anchorBottom ? anchorBottom(paletteIndex, opaque, width, height) : { paletteIndex, opaque };
  return toIndexed(framed.paletteIndex, framed.opaque, width, height, options.palette, options.glass?.alpha ?? 255);
}

/** Mark see-through solid cells as glass, judged against the median colour of the render's removed background. */
function markGlass(render: RgbaImage, colors: ReadonlyArray<Rgb>, opaque: Uint8Array, glass: GlassOptions): void {
  const channels: [number[], number[], number[]] = [[], [], []];
  for (let i = 0; i < render.data.length; i += 4 * 7) {
    if (render.data[i + 3]! > 127) continue;
    for (let c = 0; c < 3; c++) channels[c]!.push(render.data[i + c]!);
  }
  const median = (values: number[]): number => values.sort((a, b) => a - b)[values.length >> 1] ?? 255;
  const background = oklab([median(channels[0]), median(channels[1]), median(channels[2])]);
  colors.forEach((rgb, i) => {
    if (opaque[i] !== SOLID) return;
    const [l, a, b] = oklab(rgb);
    const distance = Math.hypot(l - background[0], a - background[1], b - background[2]);
    const pale = l >= glass.minLightness && Math.hypot(a, b) <= glass.maxChroma;
    if (distance <= glass.maxDistance || pale) opaque[i] = GLASS;
  });
}

/** Most common colour per cell, on 5-bit-per-channel bins, averaged within the winning bin. */
function downscale(render: RgbaImage, cell: number): Rgb[] {
  const width = render.width / cell;
  const height = render.height / cell;
  const inset = cell > 2 ? 1 : 0;
  const out: Rgb[] = [];
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      const bins = new Map<number, { count: number; r: number; g: number; b: number }>();
      for (let y = cy * cell + inset; y < (cy + 1) * cell - inset; y++) {
        for (let x = cx * cell + inset; x < (cx + 1) * cell - inset; x++) {
          const i = (y * render.width + x) * 4;
          const [r, g, b] = [render.data[i]!, render.data[i + 1]!, render.data[i + 2]!];
          const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          const bin = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
          bins.set(key, { count: bin.count + 1, r: bin.r + r, g: bin.g + g, b: bin.b + b });
        }
      }
      let top = { count: 0, r: 0, g: 0, b: 0 };
      for (const bin of bins.values()) if (bin.count > top.count) top = bin;
      out.push([Math.round(top.r / top.count), Math.round(top.g / top.count), Math.round(top.b / top.count)]);
    }
  }
  return out;
}

/** 1 where at least half of the cell's pixels have alpha above one half. */
function alphaCells(render: RgbaImage, cell: number): Uint8Array {
  const width = render.width / cell;
  const height = render.height / cell;
  const out = new Uint8Array(width * height);
  for (let cy = 0; cy < height; cy++) {
    for (let cx = 0; cx < width; cx++) {
      let solid = 0;
      for (let y = cy * cell; y < (cy + 1) * cell; y++) {
        for (let x = cx * cell; x < (cx + 1) * cell; x++) if (render.data[(y * render.width + x) * 4 + 3]! > 127) solid++;
      }
      out[cy * width + cx] = solid * 2 >= cell * cell ? 1 : 0;
    }
  }
  return out;
}

/** Palette index per cell (transparent cells get 0, unused). */
function quantize(colors: ReadonlyArray<Rgb>, opaque: Uint8Array, options: PixelateOptions): Uint8Array {
  const out = new Uint8Array(colors.length);
  const points: Lab[] = [];
  const at: number[] = [];
  colors.forEach((rgb, i) => {
    if (opaque[i] !== CLEAR) {
      points.push(oklab(rgb));
      at.push(i);
    }
  });
  if (points.length === 0) return out;

  const k = Math.min(options.colorGroups, points.length);
  // Evenly spaced starting points: deterministic, and spread over the image.
  let centres: Lab[] = Array.from({ length: k }, (_, i) => points[Math.floor((i * points.length) / k)]!);
  const label = new Int32Array(points.length);
  for (let iteration = 0; iteration < 25; iteration++) {
    let moved = false;
    points.forEach((p, i) => {
      const nearestCentre = nearest(p, centres, 1);
      if (nearestCentre !== label[i]) moved = true;
      label[i] = nearestCentre;
    });
    const sums = centres.map(() => [0, 0, 0, 0]);
    points.forEach((p, i) => {
      const s = sums[label[i]!]!;
      s[0]! += p[0];
      s[1]! += p[1];
      s[2]! += p[2];
      s[3]! += 1;
    });
    centres = centres.map((c, j) => {
      const [l, a, b, n] = sums[j]!;
      return n === 0 ? c : [l! / n!, a! / n!, b! / n!];
    });
    if (!moved && iteration > 0) break;
  }

  const paletteLab = options.palette.map(oklab);
  const groupToPalette = centres.map((c) => nearest(c, paletteLab, options.chromaWeight));
  at.forEach((cellIndex, i) => {
    out[cellIndex] = groupToPalette[label[i]!]!;
  });
  return out;
}

function despeckle(index: Uint8Array, opaque: Uint8Array, width: number, height: number): void {
  const source = index.slice();
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (opaque[i] === CLEAR) continue;
      const around = [i - width, i + width, i - 1, i + 1];
      if (!around.every((n) => opaque[n] === opaque[i])) continue;
      const first = source[around[0]!]!;
      if (first !== source[i] && around.every((n) => source[n] === first)) index[i] = first;
    }
  }
}

/** Drop the opaque area onto the canvas bottom and centre it, unless it touches a side. */
function anchorBottom(
  paletteIndex: Uint8Array,
  opaque: Uint8Array,
  width: number,
  height: number,
): { paletteIndex: Uint8Array; opaque: Uint8Array } {
  let [left, right, top, bottom] = [width, -1, height, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (opaque[y * width + x] === CLEAR) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < 0) return { paletteIndex, opaque };
  const touchesSide = left === 0 || right === width - 1;
  const dx = touchesSide ? 0 : Math.floor((width - (right - left + 1)) / 2) - left;
  const dy = height - 1 - bottom;
  const movedIndex = new Uint8Array(width * height);
  const movedOpaque = new Uint8Array(width * height);
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const from = y * width + x;
      const to = (y + dy) * width + (x + dx);
      movedIndex[to] = paletteIndex[from]!;
      movedOpaque[to] = opaque[from]!;
    }
  }
  return { paletteIndex: movedIndex, opaque: movedOpaque };
}

/**
 * Compact palette: only the (colour, solid or glass) pairs used, plus one
 * transparent entry first when anything is transparent.
 */
function toIndexed(
  paletteIndex: Uint8Array,
  opaque: Uint8Array,
  width: number,
  height: number,
  palette: ReadonlyArray<Rgb>,
  glassAlpha: number,
): IndexedImage {
  const transparent = opaque.includes(CLEAR);
  const key = (i: number): number => paletteIndex[i]! * 4 + opaque[i]!;
  const used = [...new Set(Array.from(opaque.keys()).filter((i) => opaque[i] !== CLEAR).map(key))].sort((a, b) => a - b);
  const slot = new Map(used.map((k, i) => [k, i + (transparent ? 1 : 0)]));
  const entries: Array<readonly [number, number, number, number]> = [
    ...(transparent ? [[0, 0, 0, 0] as const] : []),
    ...used.map((k) => [...palette[k >> 2]!, (k & 3) === GLASS ? glassAlpha : 255] as const),
  ];
  const indices = new Uint8Array(width * height);
  for (let i = 0; i < indices.length; i++) indices[i] = opaque[i] === CLEAR ? 0 : slot.get(key(i))!;
  return { width, height, indices, palette: entries };
}

/**
 * Problems that would make a committed image not a league sprite: wrong size,
 * partial alpha (other than `glassAlpha`, for a translucent character), off-palette colours.
 */
export function checkSprite(
  image: RgbaImage,
  expected: { readonly width: number; readonly height: number },
  palette: ReadonlyArray<Rgb>,
  glassAlpha?: number,
): string[] {
  const problems: string[] = [];
  if (image.width !== expected.width || image.height !== expected.height) {
    problems.push(`is ${image.width}×${image.height}, expected ${expected.width}×${expected.height}`);
  }
  const allowed = new Set(palette.map(([r, g, b]) => (r << 16) | (g << 8) | b));
  let partial = 0;
  const off = new Set<string>();
  for (let i = 0; i < image.data.length; i += 4) {
    const a = image.data[i + 3]!;
    if (a === 0) continue;
    if (a !== 255 && a !== glassAlpha) partial++;
    const rgb = (image.data[i]! << 16) | (image.data[i + 1]! << 8) | image.data[i + 2]!;
    if (!allowed.has(rgb)) off.add(`#${rgb.toString(16).padStart(6, '0')}`);
  }
  if (partial > 0) problems.push(`has ${partial} semi-transparent pixel${partial === 1 ? '' : 's'}; pixels must be fully opaque or fully transparent`);
  if (off.size > 0) problems.push(`uses ${off.size} colour${off.size === 1 ? '' : 's'} outside the palette (${[...off].slice(0, 5).join(', ')}${off.size > 5 ? ', …' : ''})`);
  return problems;
}
