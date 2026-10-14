/**
 * Minimal PNG codec for the image pipeline: no dependencies, just node:zlib.
 *
 * Reads 8-bit, non-interlaced greyscale, RGB, RGBA and palette images, which
 * covers ComfyUI output and our own files. Writes palette (indexed) PNGs with
 * a tRNS chunk, so a 112×144 sprite in 64 colours stays a few KB, and
 * filtered true-colour PNGs for full-resolution paintings.
 */
import { crc32, deflateSync, inflateSync } from 'node:zlib';

/** Straight (non-premultiplied) RGBA, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** One palette index per pixel, row-major. */
export interface IndexedImage {
  readonly width: number;
  readonly height: number;
  readonly indices: Uint8Array;
  /** RGBA per entry, at most 256 entries. */
  readonly palette: ReadonlyArray<readonly [number, number, number, number]>;
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel and channel count for each colour type at bit depth 8. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export class PngError extends Error {
  override name = 'PngError';
}

/** Width and height from the IHDR chunk, without decoding the image. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw new PngError('not a PNG file');
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new PngError('not a PNG file');

  let width = 0;
  let height = 0;
  let colorType = -1;
  let palette: Buffer | undefined;
  let alpha: Buffer | undefined;
  const idat: Buffer[] = [];

  for (let at = 8; at < buf.length; ) {
    if (at + 12 > buf.length) throw new PngError('truncated chunk');
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (body.length !== length) throw new PngError(`truncated ${type} chunk`);
    at += 12 + length;
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      colorType = body[9] ?? -1;
      const interlace = body[12];
      if (depth !== 8) throw new PngError(`bit depth ${depth} is not supported (only 8)`);
      if (CHANNELS[colorType] === undefined) throw new PngError(`colour type ${colorType} is not supported`);
      if (interlace !== 0) throw new PngError('interlaced PNGs are not supported');
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      alpha = body;
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (width === 0 || height === 0) throw new PngError('missing IHDR');
  const channels = CHANNELS[colorType] ?? 0;
  if (colorType === 3 && palette === undefined) throw new PngError('palette image without PLTE');

  const raw = unfilter(inflateSync(Buffer.concat(idat)), width, height, channels);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = i * channels;
    const d = i * 4;
    switch (colorType) {
      case 0:
        data.set([raw[s]!, raw[s]!, raw[s]!, 255], d);
        break;
      case 2:
        data.set([raw[s]!, raw[s + 1]!, raw[s + 2]!, 255], d);
        break;
      case 3: {
        const p = raw[s]!;
        if (p * 3 + 2 >= palette!.length) throw new PngError(`palette index ${p} out of range`);
        data.set([palette![p * 3]!, palette![p * 3 + 1]!, palette![p * 3 + 2]!, alpha?.[p] ?? 255], d);
        break;
      }
      case 4:
        data.set([raw[s]!, raw[s]!, raw[s]!, raw[s + 1]!], d);
        break;
      default:
        data.set(raw.subarray(s, s + 4), d);
    }
  }
  return { width, height, data };
}

/** Undo the per-row filters (spec §9). Returns `height` rows of `width * channels` bytes. */
function unfilter(src: Buffer, width: number, height: number, bpp: number): Uint8Array {
  const stride = width * bpp;
  if (src.length < height * (stride + 1)) throw new PngError('image data is shorter than its size');
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = src[y * (stride + 1)];
    const row = src.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[o + x - bpp]! : 0;
      const b = y > 0 ? out[o - stride + x]! : 0;
      const c = x >= bpp && y > 0 ? out[o - stride + x - bpp]! : 0;
      let predictor: number;
      switch (filter) {
        case 0:
          predictor = 0;
          break;
        case 1:
          predictor = a;
          break;
        case 2:
          predictor = b;
          break;
        case 3:
          predictor = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new PngError(`unknown filter type ${filter} on row ${y}`);
      }
      out[o + x] = (row[x]! + predictor) & 0xff;
    }
  }
  return out;
}

/** Palette PNG with every row unfiltered; tRNS is written only when some entry isn't opaque. */
export function encodeIndexedPng(image: IndexedImage): Buffer {
  const { width, height, indices, palette } = image;
  if (palette.length === 0 || palette.length > 256) throw new PngError(`palette has ${palette.length} entries (1–256 allowed)`);
  if (indices.length !== width * height) throw new PngError('indices do not match the image size');

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 3, 0, 0, 0], 8);

  const plte = Buffer.from(palette.flatMap(([r, g, b]) => [r, g, b]));
  const trns = palette.some(([, , , a]) => a !== 255) ? Buffer.from(palette.map(([, , , a]) => a)) : undefined;

  const raw = Buffer.alloc(height * (width + 1));
  for (let y = 0; y < height; y++) raw.set(indices.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    ...(trns === undefined ? [] : [chunk('tRNS', trns)]),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A true-colour PNG: RGB when every pixel is opaque, else RGBA. Each row gets
 * the filter that leaves the smallest sum of residuals (the usual heuristic),
 * which is what keeps a full-resolution painting near 1 MB.
 */
export function encodeRgbaPng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  let opaque = true;
  for (let i = 3; i < data.length && opaque; i += 4) opaque = data[i] === 255;
  const bpp = opaque ? 3 : 4;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, opaque ? 2 : 6, 0, 0, 0], 8);
  const stride = width * bpp;
  const raw = Buffer.alloc(height * (stride + 1));
  let previous = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  const trial = new Uint8Array(stride);
  const best = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) for (let c = 0; c < bpp; c++) row[x * bpp + c] = data[(y * width + x) * 4 + c]!;
    let bestType = 0;
    let bestCost = Infinity;
    for (let type = 0; type < 5; type++) {
      let cost = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= bpp ? row[i - bpp]! : 0;
        const up = previous[i]!;
        const upLeft = i >= bpp ? previous[i - bpp]! : 0;
        const predicted = type === 0 ? 0 : type === 1 ? left : type === 2 ? up : type === 3 ? (left + up) >> 1 : paeth(left, up, upLeft);
        const residual = (row[i]! - predicted) & 0xff;
        trial[i] = residual;
        cost += residual < 128 ? residual : 256 - residual;
      }
      if (cost < bestCost) {
        bestCost = cost;
        bestType = type;
        best.set(trial);
      }
    }
    const at = y * (stride + 1);
    raw[at] = bestType;
    raw.set(best, at + 1);
    previous = Uint8Array.from(row);
  }
  return Buffer.concat([SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}
