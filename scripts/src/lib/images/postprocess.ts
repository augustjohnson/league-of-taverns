/**
 * Post-processing: looks cut from a stored painted original at display time
 * (./paint.ts keeps the original at full resolution and colour).
 *
 * A pixel view scales the figure to a height in art pixels (the zoom),
 * then runs the pixel pipeline on it: one colour per art pixel, a colour
 * budget (the league palette or the image's own few colours), hard edges
 * with no anti-aliasing, and an outline. The same original makes coarse
 * pixel art for a crowded stage and finer pixel art for a close-up.
 */
import type { Rgb } from './palette';
import { pixelate } from './pixelate';
import type { GlassOptions } from './pixelate';
import type { IndexedImage, RgbaImage } from './png';
import { resizeArea } from './resample';

export interface PixelViewOptions {
  /** The figure's height in art pixels. */
  readonly heightPx: number;
  /** The league palette, or 'own': the image's own `colorGroups` colours. */
  readonly palette: ReadonlyArray<Rgb> | 'own';
  readonly colorGroups: number;
  readonly chromaWeight: number;
  readonly outline: boolean;
  readonly grade?: { readonly contrast: number; readonly saturation: number };
  /** A translucent figure: its see-through parts stay glass in the view. */
  readonly glass?: GlassOptions;
}

/** Source pixels per art pixel when the figure is resampled for pixelating: each art pixel takes the commonest colour of its block. */
const SUPERSAMPLE = 4;

export function pixelView(original: RgbaImage, options: PixelViewOptions): IndexedImage {
  const heightPx = Math.max(1, Math.round(options.heightPx));
  const widthPx = Math.max(1, Math.round((original.width * heightPx) / original.height));
  const s = SUPERSAMPLE;
  const figure = resizeArea(original, widthPx * s, heightPx * s);
  // One clear art pixel all round: room for the outline, and a background for the cutout.
  const width = (widthPx + 2) * s;
  const height = (heightPx + 2) * s;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < figure.height; y++) {
    const row = figure.data.subarray(y * figure.width * 4, (y + 1) * figure.width * 4);
    data.set(row, ((y + s) * width + s) * 4);
  }
  if (options.glass !== undefined) {
    // Glass parts are partly transparent in the original; make them solid so the glass rule can find them by colour.
    for (let i = 3; i < data.length; i += 4) if (data[i]! >= 24) data[i] = 255;
  }
  return pixelate(
    { width, height, data },
    {
      cell: s,
      colorGroups: options.colorGroups,
      chromaWeight: options.chromaWeight,
      palette: options.palette,
      cutout: true,
      anchorBottom: false,
      outline: options.outline,
      ...(options.grade === undefined ? {} : { grade: options.grade }),
      ...(options.glass === undefined ? {} : { glass: options.glass }),
    },
  );
}

/**
 * A web-sized copy of a painted original: scaled so its longest side is
 * `longSide` (never up), and reduced to at most `colors` colours of its own
 * by median cut. At 640 px and 256 colours it looks like the original at
 * about a tenth of the bytes.
 */
export function webImage(original: RgbaImage, longSide: number, colors: number): IndexedImage {
  const scale = Math.min(1, longSide / Math.max(original.width, original.height));
  const width = Math.max(1, Math.round(original.width * scale));
  const height = Math.max(1, Math.round(original.height * scale));
  return quantize(scale === 1 ? original : resizeArea(original, width, height), colors);
}

/**
 * Reduce to at most `colors` RGBA colours by median cut: keep splitting the
 * box of colours with the most spread, along its widest channel, at the
 * pixel-weighted median. Fully transparent pixels share entry 0.
 */
export function quantize(image: RgbaImage, colors: number): IndexedImage {
  const { width, height, data } = image;
  const counts = new Map<number, number>();
  let transparent = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) {
      transparent = true;
      continue;
    }
    const key = ((data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!) >>> 0;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const channel = (key: number, c: number): number => (key >>> (24 - 8 * c)) & 0xff;
  const budget = Math.max(1, colors - (transparent ? 1 : 0));

  interface Cut {
    readonly keys: number[];
    readonly spread: number;
    readonly widest: number;
  }
  const measure = (keys: number[]): Cut => {
    const lo = [255, 255, 255, 255];
    const hi = [0, 0, 0, 0];
    let weight = 0;
    for (const key of keys) {
      weight += counts.get(key)!;
      for (let c = 0; c < 4; c++) {
        const v = channel(key, c);
        if (v < lo[c]!) lo[c] = v;
        if (v > hi[c]!) hi[c] = v;
      }
    }
    const ranges = hi.map((h, c) => h - lo[c]!);
    const widest = ranges.indexOf(Math.max(...ranges));
    return { keys, widest, spread: keys.length > 1 ? ranges[widest]! * Math.sqrt(weight) : -1 };
  };
  const boxes: Cut[] = counts.size === 0 ? [] : [measure([...counts.keys()])];
  while (boxes.length < budget) {
    let pick = -1;
    for (let b = 0; b < boxes.length; b++) if (boxes[b]!.spread > 0 && (pick < 0 || boxes[b]!.spread > boxes[pick]!.spread)) pick = b;
    if (pick < 0) break;
    const { keys, widest } = boxes[pick]!;
    keys.sort((a, b) => channel(a, widest) - channel(b, widest));
    const half = keys.reduce((sum, key) => sum + counts.get(key)!, 0) / 2;
    let running = 0;
    let split = 1;
    for (; split < keys.length - 1; split++) {
      running += counts.get(keys[split - 1]!)!;
      if (running >= half) break;
    }
    boxes.splice(pick, 1, measure(keys.slice(0, split)), measure(keys.slice(split)));
  }

  const palette: Array<readonly [number, number, number, number]> = transparent ? [[0, 0, 0, 0]] : [];
  const entryOf = new Map<number, number>();
  for (const { keys } of boxes) {
    const sum = [0, 0, 0, 0];
    let weight = 0;
    for (const key of keys) {
      const n = counts.get(key)!;
      weight += n;
      for (let c = 0; c < 4; c++) sum[c]! += channel(key, c) * n;
      entryOf.set(key, palette.length);
    }
    const [r, g, b, a] = sum.map((v) => Math.round(v / weight)) as [number, number, number, number];
    palette.push([r, g, b, Math.max(1, a)]);
  }
  if (palette.length === 0) palette.push([0, 0, 0, 0]);
  const indices = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < indices.length; p++, i += 4) {
    if (data[i + 3] === 0) continue;
    indices[p] = entryOf.get(((data[i]! << 24) | (data[i + 1]! << 16) | (data[i + 2]! << 8) | data[i + 3]!) >>> 0)!;
  }
  return { width, height, indices, palette };
}
