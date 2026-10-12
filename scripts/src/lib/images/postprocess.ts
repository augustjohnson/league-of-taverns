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
