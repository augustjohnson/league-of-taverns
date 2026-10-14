import { describe, expect, it } from 'vitest';
import { FACE_ASPECT, cropImage, faceRect, figureBounds } from '../src/lib/images/face';
import type { RgbaImage } from '../src/lib/images/png';

/** A `width` × `height` transparent image with `paint(x, y)` pixels made opaque. */
function image(width: number, height: number, paint: (x: number, y: number) => boolean): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (paint(x, y)) data.set([200, 100, 50, 255], (y * width + x) * 4);
  return { width, height, data };
}

describe('card face crop', () => {
  // A figure on a 200 × 300 canvas: a head at x 120–160 from y 40, over a body at x 60–180 from y 80.
  const figure = image(200, 300, (x, y) => (y >= 40 && y < 80 && x >= 120 && x < 160) || (y >= 80 && y < 290 && x >= 60 && x < 180));

  it('finds the figure inside its transparent canvas', () => {
    expect(figureBounds(figure)).toEqual({ x: 60, y: 40, width: 120, height: 250 });
    expect(figureBounds(image(10, 10, () => false))).toEqual({ x: 0, y: 0, width: 10, height: 10 });
  });

  it('by default centres a head-and-shoulders window on the top of the figure, at the card aspect', () => {
    const r = faceRect(figure);
    expect(r.width / r.height).toBeCloseTo(FACE_ASPECT, 1);
    expect(r.width).toBe(Math.round(120 * 0.45));
    // Centred on the head (x 120–160), not on the body (60–180), and starting just above it.
    expect(r.x + r.width / 2).toBeCloseTo(140, 0);
    expect(r.y).toBeLessThanOrEqual(40);
    expect(r.y).toBeGreaterThanOrEqual(30);
  });

  it("takes a character's own window, as fractions, and keeps it inside the image", () => {
    expect(faceRect(figure, { x: 0.5, y: 0.1, width: 0.4 })).toEqual({ x: 100, y: 30, width: 80, height: Math.round(80 / FACE_ASPECT) });
    const low = faceRect(figure, { x: 0.5, y: 0.99, width: 0.5 });
    expect(low.y + low.height).toBeLessThanOrEqual(300);
    const wide = faceRect(image(100, 20, () => true), { x: 0, y: 0, width: 1 });
    expect(wide.height).toBeLessThanOrEqual(20);
    expect(wide.width / wide.height).toBeCloseTo(FACE_ASPECT, 1);
  });

  it('copies the window out', () => {
    const src = image(4, 3, (x, y) => x === 2 && y === 1);
    const out = cropImage(src, { x: 1, y: 1, width: 2, height: 2 });
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    expect([...out.data.subarray(4, 8)]).toEqual([200, 100, 50, 255]);
    expect(out.data[3]).toBe(0);
  });
});
