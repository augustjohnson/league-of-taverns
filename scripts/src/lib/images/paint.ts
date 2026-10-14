/**
 * Painted mode: turn a render into the stored original, and check it.
 *
 * The original keeps the render's full resolution and colour. A portrait is
 * only cut out and trimmed to its figure; a cover is kept as rendered. Every
 * lossy step (scaling to the stage, pixel grids, fewer colours, hard edges)
 * is post-processing at display time (./postprocess.ts), so one original
 * serves a painted stage and pixel art at any zoom.
 */
import { mainShare, meanChroma } from './framing';
import { oklab } from './palette';
import type { RgbaImage } from './png';
import type { Size } from './style';

export interface GlassRule {
  readonly alpha: number;
  readonly minLightness: number;
  readonly maxChroma: number;
}

export type PaintOptions = { readonly kind: 'portrait'; readonly glass?: GlassRule } | { readonly kind: 'cover' };

/** Cut-out fringe fainter than this is dropped, so trimming finds the figure and not a haze around it. */
const FRINGE = 24;

export function paint(render: RgbaImage, options: PaintOptions): RgbaImage {
  const data = Uint8Array.from(render.data);
  if (options.kind === 'cover') {
    for (let i = 3; i < data.length; i += 4) data[i] = 255;
    return { width: render.width, height: render.height, data };
  }
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! < FRINGE) data.fill(0, i, i + 4);
  const image = { width: render.width, height: render.height, data };
  if (options.glass !== undefined) glaze(image, options.glass);
  const box = bounds(image, 0);
  return box === undefined ? { width: 1, height: 1, data: new Uint8Array(4) } : crop(image, box);
}

/** Pale, washed-out parts of a translucent figure (an ooze, a ghost) become see-through, at most `alpha`. */
function glaze({ data }: RgbaImage, rule: GlassRule): void {
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [l, a, b] = oklab([data[i]!, data[i + 1]!, data[i + 2]!]);
    if (l >= rule.minLightness && Math.hypot(a, b) <= rule.maxChroma) data[i + 3] = Math.min(data[i + 3]!, rule.alpha);
  }
}

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** The bounding box of pixels with alpha above `minAlpha`, or undefined when there are none. */
function bounds({ width, height, data }: RgbaImage, minAlpha: number): Box | undefined {
  let [left, top, right, bottom] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! <= minAlpha) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  return right < 0 ? undefined : { left, top, right, bottom };
}

function crop(image: RgbaImage, { left, top, right, bottom }: Box): RgbaImage {
  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) data.set(image.data.subarray(((top + y) * image.width + left) * 4, ((top + y) * image.width + right + 1) * 4), y * width * 4);
  return { width, height, data };
}

// ── checks ─────────────────────────────────────────────────────────────────

export interface PaintedRules {
  /** Pixels of the figure allowed on any edge of the render (a stray strand of hair). */
  readonly tolerance: number;
  /** Least share of the render's height the figure spans. */
  readonly minFill: number;
  readonly minMainShare: number;
  readonly minChroma: number;
}

/**
 * Problems with a cut-out portrait render, before it is trimmed. The stage
 * scales the whole figure to height, so it must be whole: inside the canvas
 * on every edge, the bottom too. It must also be one figure, big enough in
 * the frame to have detail, and in colour.
 */
export function paintedProblems(render: RgbaImage, rules: PaintedRules): string[] {
  const { width, height, data } = render;
  const solid = (x: number, y: number): boolean => data[(y * width + x) * 4 + 3]! > 127;
  const box = bounds(render, 127);
  if (box === undefined) return ['is empty: nothing survived the cutout'];
  const problems: string[] = [];
  const edges: Array<[string, number]> = [
    ['top', countRow(0)],
    ['bottom', countRow(height - 1)],
    ['left', countColumn(0)],
    ['right', countColumn(width - 1)],
  ];
  function countRow(y: number): number {
    let n = 0;
    for (let x = 0; x < width; x++) n += solid(x, y) ? 1 : 0;
    return n;
  }
  function countColumn(x: number): number {
    let n = 0;
    for (let y = 0; y < height; y++) n += solid(x, y) ? 1 : 0;
    return n;
  }
  for (const [edge, n] of edges) if (n > rules.tolerance) problems.push(`is cut off at the ${edge} (${n} pixels on the edge)`);
  const fill = (box.bottom - box.top + 1) / height;
  if (fill < rules.minFill) problems.push(`is too small in the frame (spans ${Math.round(100 * fill)}% of its height, needs ${Math.round(100 * rules.minFill)}%)`);
  const main = mainShare(render);
  if (main < rules.minMainShare) {
    problems.push(`shows more than one figure (the largest shape is only ${Math.round(100 * main)}% of the cutout; needs ${Math.round(100 * rules.minMainShare)}%)`);
  }
  const chroma = meanChroma(render);
  if (chroma < rules.minChroma) problems.push(`is nearly greyscale (mean chroma ${chroma.toFixed(3)}, needs ${rules.minChroma})`);
  return problems;
}

/**
 * Problems with a stored painted original. A portrait must be trimmed to one
 * figure, in colour; a cover must be exactly its render size and opaque.
 */
export function checkPainted(image: RgbaImage, expected: 'portrait' | Size, rules?: Pick<PaintedRules, 'minMainShare' | 'minChroma'>): string[] {
  const { width, height, data } = image;
  if (expected === 'portrait') {
    const box = bounds(image, 0);
    if (box === undefined) return ['is empty'];
    const problems: string[] = [];
    if (box.left > 0 || box.top > 0 || box.right < width - 1 || box.bottom < height - 1) problems.push('is not trimmed to its figure');
    if (rules !== undefined) {
      const main = mainShare(image);
      if (main < rules.minMainShare) problems.push(`shows more than one figure (the largest shape is only ${Math.round(100 * main)}%)`);
      const chroma = meanChroma(image);
      if (chroma < rules.minChroma) problems.push(`is nearly greyscale (mean chroma ${chroma.toFixed(3)})`);
    }
    return problems;
  }
  if (width !== expected.width || height !== expected.height) return [`is ${width}×${height}, expected ${expected.width}×${expected.height}`];
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return ['has transparent pixels; a cover must be opaque'];
  return [];
}
