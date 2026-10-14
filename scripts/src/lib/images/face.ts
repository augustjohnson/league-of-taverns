/**
 * The face on a character card: a window cut from the painted portrait, at the
 * card art's aspect (sims/src/playground: charCard). Chrome only.
 *
 * By default the window is a head-and-shoulders crop found from the figure's
 * own outline: its width a share of the figure's width, centred on the top
 * band of the figure (where the head is, wherever the body leans) and
 * starting just above it. That suits most people; creatures whose face is
 * elsewhere (a rhino's, a dragon's) set `chrome.portrait.face` in their
 * character.yaml, as fractions of the image so it survives a re-render.
 */
import type { RgbaImage } from './png';

/** A crop window, as fractions of the portrait: its left and top edges and its width. */
export interface FaceWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** A crop window in pixels. */
export interface PixelRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The card's art window, width over height (148 × 104 CSS px). */
export const FACE_ASPECT = 148 / 104;

/** Alpha above this counts as figure, not background. */
const SOLID = 32;
/** The default window's width, as a share of the figure's width. */
const SHARE = 0.45;
/** The top band whose middle the default window centres on, as a share of the figure's height. */
const HEAD_BAND = 0.12;

/** The figure's bounding box: every pixel more opaque than `SOLID`. The whole image when nothing is. */
export function figureBounds({ width, height, data }: RgbaImage): PixelRect {
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! <= SOLID) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? { x: 0, y: 0, width, height } : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/**
 * The face window in pixels: `face` when the character sets one, else the
 * default head-and-shoulders crop. Either way it has the card's aspect and
 * lies inside the image (shrunk to fit if it must).
 */
export function faceRect(image: RgbaImage, face?: FaceWindow): PixelRect {
  const { width: W, height: H, data } = image;
  let x: number;
  let y: number;
  let w: number;
  if (face !== undefined) {
    x = face.x * W;
    y = face.y * H;
    w = face.width * W;
  } else {
    const fig = figureBounds(image);
    // The head's middle: the mean x of the figure's solid pixels in its top band.
    const bandEnd = fig.y + Math.max(1, Math.round(fig.height * HEAD_BAND));
    let sum = 0;
    let count = 0;
    for (let py = fig.y; py < bandEnd; py++) {
      for (let px = fig.x; px < fig.x + fig.width; px++) {
        if (data[(py * W + px) * 4 + 3]! > SOLID) {
          sum += px;
          count++;
        }
      }
    }
    const mid = count === 0 ? fig.x + fig.width / 2 : sum / count;
    w = fig.width * SHARE;
    x = mid - w / 2;
    y = fig.y - 0.04 * (w / FACE_ASPECT);
  }
  // Keep the aspect and stay inside the image.
  w = Math.min(w, W, H * FACE_ASPECT);
  const h = w / FACE_ASPECT;
  x = Math.min(Math.max(0, x), W - w);
  y = Math.min(Math.max(0, y), H - h);
  return { x: Math.round(x), y: Math.round(y), width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/** Copy `rect` out of `image`. */
export function cropImage(image: RgbaImage, rect: PixelRect): RgbaImage {
  const out = new Uint8Array(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.y + y) * image.width + rect.x) * 4;
    out.set(image.data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return { width: rect.width, height: rect.height, data: out };
}
