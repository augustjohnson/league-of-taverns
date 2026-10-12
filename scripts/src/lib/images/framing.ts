/**
 * Framing rules for portraits, so cards can be layered side by side over the
 * tavern scene without visible cuts. Every card stands behind the bar, which
 * covers its bottom `counter` rows, so how a bust or a pair of legs ends is
 * never seen.
 *
 * - Clipping: the figure may only leave the canvas through the bottom edge,
 *   plus any edges its size may bleed through (a Huge creature entering from
 *   the top left).
 * - Floating: the figure must reach the bottom edge, and at the counter line
 *   it must be solid across a fair share of its width. A head on a thin neck
 *   would sit on the bar like a bottle.
 */
import { oklab } from './palette';
import type { RgbaImage } from './png';

export const EDGES = ['top', 'left', 'right'] as const;
export type Edge = (typeof EDGES)[number];

export interface FramingRules {
  /** Edges this canvas may be cut by, besides the bottom. */
  readonly bleed: ReadonlyArray<Edge>;
  /** Rows at the bottom of the card hidden behind the bar; 0 for a card standing on top of the bar. */
  readonly counter: number;
  /** Least share of the figure's width that must be solid at the counter line. */
  readonly minFooting: number;
  /**
   * Whether the figure must reach the bottom edge. A head-pinned card only
   * needs to be solid at the counter line: rows below it are behind the bar.
   */
  readonly reachBottom?: boolean;
  /** Opaque pixels allowed on a forbidden edge (a stray hair, an antenna tip). */
  readonly tolerance: number;
  /**
   * Least share of the visible pixels in the largest connected shape. A
   * sprite sheet or a group of copies splits into many shapes; one figure,
   * even with a loose prop, stays one big shape.
   */
  readonly minMainShare: number;
  /** Least mean OKLab chroma of the visible pixels; below it the sprite reads as greyscale. */
  readonly minChroma: number;
  /**
   * Least share of the card above the bar that the figure fills. For people,
   * a small figure means a full-body pose instead of waist-up. 0 turns it off
   * (a crab or an ooze is meant to be low and wide).
   */
  readonly minFill: number;
}

/** Empty when the sprite can be layered cleanly; otherwise one line per problem. */
export function framingProblems(image: RgbaImage, rules: FramingRules): string[] {
  const { width, height, data } = image;
  const solid = (x: number, y: number): boolean => data[(y * width + x) * 4 + 3]! > 0;

  let [left, right] = [width, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!solid(x, y)) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
    }
  }
  if (right < 0) return ['is empty: nothing survived the cutout'];

  const problems: string[] = [];
  const count = (edge: Edge): number => {
    let n = 0;
    if (edge === 'top') for (let x = 0; x < width; x++) n += solid(x, 0) ? 1 : 0;
    else for (let y = 0; y < height; y++) n += solid(edge === 'left' ? 0 : width - 1, y) ? 1 : 0;
    return n;
  };
  for (const edge of EDGES) {
    if (rules.bleed.includes(edge)) continue;
    const n = count(edge);
    if (n > rules.tolerance) problems.push(`is clipped at the ${edge} (${n} pixels on the edge)`);
  }

  const rowWidth = (y: number): number => {
    let n = 0;
    for (let x = 0; x < width; x++) n += solid(x, y) ? 1 : 0;
    return n;
  };
  const figureWidth = right - left + 1;
  const line = Math.max(0, height - 1 - rules.counter);
  const footing = rowWidth(line);
  if (rules.reachBottom !== false && rowWidth(height - 1) === 0) {
    problems.push('floats: nothing reaches the bottom edge');
  } else if (footing < rules.minFooting * figureWidth) {
    problems.push(
      `floats: only ${Math.round((100 * footing) / figureWidth)}% of its width is solid at the counter line (needs ${Math.round(100 * rules.minFooting)}%)`,
    );
  }

  const main = mainShare(image);
  if (main < rules.minMainShare) {
    problems.push(`shows more than one figure (the largest shape is only ${Math.round(100 * main)}% of the sprite; needs ${Math.round(100 * rules.minMainShare)}%)`);
  }
  if (rules.minFill > 0) {
    let filled = 0;
    const above = Math.max(1, height - rules.counter);
    for (let y = 0; y < above; y++) for (let x = 0; x < width; x++) filled += solid(x, y) ? 1 : 0;
    const fill = filled / (above * width);
    if (fill < rules.minFill) {
      problems.push(`is too small in the frame, likely full-body (fills ${Math.round(100 * fill)}% of the card above the bar, needs ${Math.round(100 * rules.minFill)}%)`);
    }
  }
  const chroma = meanChroma(image);
  if (chroma < rules.minChroma) problems.push(`is nearly greyscale (mean chroma ${chroma.toFixed(3)}, needs ${rules.minChroma})`);
  return problems;
}

/** Share of visible pixels in the largest 4-connected shape. */
export function mainShare({ width, height, data }: RgbaImage): number {
  const seen = new Uint8Array(width * height);
  let total = 0;
  let largest = 0;
  for (let start = 0; start < width * height; start++) {
    if (seen[start] || data[start * 4 + 3] === 0) continue;
    let size = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const p = stack.pop()!;
      size++;
      const x = p % width;
      for (const q of [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (q < 0 || q >= width * height || seen[q] || data[q * 4 + 3] === 0) continue;
        seen[q] = 1;
        stack.push(q);
      }
    }
    total += size;
    largest = Math.max(largest, size);
  }
  return total === 0 ? 0 : largest / total;
}

/** Mean OKLab chroma of the visible pixels: below about 0.025 an image reads as greyscale. */
export function meanChroma({ data }: RgbaImage): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const [, a, b] = oklab([data[i]!, data[i + 1]!, data[i + 2]!]);
    sum += Math.hypot(a, b);
    n++;
  }
  return n === 0 ? 0 : sum / n;
}
