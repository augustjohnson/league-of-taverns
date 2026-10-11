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
import type { RgbaImage } from './png';

export const EDGES = ['top', 'left', 'right'] as const;
export type Edge = (typeof EDGES)[number];

export interface FramingRules {
  /** Edges this canvas may be cut by, besides the bottom. */
  readonly bleed: ReadonlyArray<Edge>;
  /** Rows at the bottom of every card hidden behind the bar. */
  readonly counter: number;
  /** Least share of the figure's width that must be solid at the counter line. */
  readonly minFooting: number;
  /** Opaque pixels allowed on a forbidden edge (a stray hair, an antenna tip). */
  readonly tolerance: number;
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
  if (rowWidth(height - 1) === 0) {
    problems.push('floats: nothing reaches the bottom edge');
  } else if (footing < rules.minFooting * figureWidth) {
    problems.push(
      `floats: only ${Math.round((100 * footing) / figureWidth)}% of its width is solid at the counter line (needs ${Math.round(100 * rules.minFooting)}%)`,
    );
  }
  return problems;
}
