/**
 * Fit an outside image (Gemini, a hand drawing) onto a portrait's render
 * canvas, so it can go through the normal pixelate pipeline: trim to the
 * cutout, scale with area averaging to fit inside the margins, and place it
 * bottom-centre, where the bar will hide how it ends.
 */
import type { RgbaImage } from './png';

/** Area-average resize. Colours are weighted by alpha so transparent pixels don't darken edges. */
export function resizeArea(src: RgbaImage, width: number, height: number): RgbaImage {
  const out = new Uint8Array(width * height * 4);
  const sx = src.width / width;
  const sy = src.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * sy;
    const y1 = (y + 1) * sy;
    for (let x = 0; x < width; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      let [r, g, b, a, area] = [0, 0, 0, 0, 0];
      for (let py = Math.floor(y0); py < Math.ceil(y1); py++) {
        const wy = Math.min(py + 1, y1) - Math.max(py, y0);
        for (let px = Math.floor(x0); px < Math.ceil(x1); px++) {
          const w = wy * (Math.min(px + 1, x1) - Math.max(px, x0));
          const i = (py * src.width + px) * 4;
          const alpha = src.data[i + 3]! * w;
          r += src.data[i]! * alpha;
          g += src.data[i + 1]! * alpha;
          b += src.data[i + 2]! * alpha;
          a += alpha;
          area += w;
        }
      }
      const o = (y * width + x) * 4;
      if (a > 0) out.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / area)], o);
    }
  }
  return { width, height, data: out };
}

export interface FitMargins {
  /** Empty columns kept on each side, in render pixels. */
  readonly side: number;
  /** Empty rows kept above the figure, in render pixels. */
  readonly top: number;
}

/** Trim `image` to its opaque area, scale it to fit `width`×`height` inside the margins, and place it bottom-centre. */
export function fitToCanvas(image: RgbaImage, width: number, height: number, margins: FitMargins): RgbaImage {
  let [left, right, top, bottom] = [image.width, -1, image.height, -1];
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3]! <= 127) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const out = new Uint8Array(width * height * 4);
  if (right < 0) return { width, height, data: out };
  const bw = right - left + 1;
  const bh = bottom - top + 1;
  const crop = new Uint8Array(bw * bh * 4);
  for (let y = 0; y < bh; y++) crop.set(image.data.subarray(((top + y) * image.width + left) * 4, ((top + y) * image.width + right + 1) * 4), y * bw * 4);
  const scale = Math.min((width - 2 * margins.side) / bw, (height - margins.top) / bh);
  const tw = Math.max(1, Math.round(bw * scale));
  const th = Math.max(1, Math.round(bh * scale));
  const scaled = resizeArea({ width: bw, height: bh, data: crop }, tw, th);
  const ox = Math.floor((width - tw) / 2);
  const oy = height - th;
  for (let y = 0; y < th; y++) out.set(scaled.data.subarray(y * tw * 4, (y + 1) * tw * 4), ((oy + y) * width + ox) * 4);
  return { width, height, data: out };
}
