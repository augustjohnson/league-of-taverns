import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkSeasonImages } from '../src/lib/images/check';
import { renderGraph } from '../src/lib/images/comfyui';
import { accept, coverTargets, defaultSeed, portraitTargets, stage, writeReviewPage } from '../src/lib/images/drafts';
import { PALETTES } from '../src/lib/images/palette';
import type { Rgb } from '../src/lib/images/palette';
import { framingProblems } from '../src/lib/images/framing';
import type { Edge } from '../src/lib/images/framing';
import { PixelateError, checkSprite, pixelate } from '../src/lib/images/pixelate';
import type { PixelateOptions } from '../src/lib/images/pixelate';
import { PngError, decodePng, encodeIndexedPng } from '../src/lib/images/png';
import type { RgbaImage } from '../src/lib/images/png';
import {
  CREATURE_SIZES,
  creatureSize,
  loadImageStyle,
  outputSize,
  pixelateOptions,
  positivePrompt,
  renderSize,
  stylePath,
} from '../src/lib/images/style';
import { ValidationFailure } from '../src/lib/main';

const PALETTE = PALETTES['resurrect-64'];
const style = loadImageStyle();

/** A render of `cols`×`rows` cells, each `cell` pixels of one colour, with a noisy 1-pixel rim. */
function blockRender(colors: ReadonlyArray<ReadonlyArray<Rgb | null>>, cell = 8): RgbaImage {
  const rows = colors.length;
  const cols = colors[0]!.length;
  const width = cols * cell;
  const height = rows * cell;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const c = colors[Math.floor(y / cell)]![Math.floor(x / cell)]!;
      const rim = x % cell === 0 || y % cell === 0;
      const i = (y * width + x) * 4;
      if (c === null) data.set([250, 250, 250, 0], i);
      else data.set(rim ? [255 - c[0], 255 - c[1], 255 - c[2], 255] : [...c, 255], i);
    }
  }
  return { width, height, data };
}

function pixel(image: RgbaImage, x: number, y: number): number[] {
  const i = (y * image.width + x) * 4;
  return [...image.data.subarray(i, i + 4)];
}

const options = (overrides: Partial<PixelateOptions> = {}): PixelateOptions => ({
  cell: 8,
  colorGroups: 12,
  chromaWeight: 3,
  palette: PALETTE,
  cutout: false,
  anchorBottom: false,
  ...overrides,
});

describe('png', () => {
  it('round-trips an indexed image with transparency', () => {
    const png = encodeIndexedPng({
      width: 3,
      height: 2,
      indices: Uint8Array.from([0, 1, 2, 2, 1, 0]),
      palette: [
        [0, 0, 0, 0],
        [255, 0, 0, 255],
        [0, 128, 255, 255],
      ],
    });
    const image = decodePng(png);
    expect([image.width, image.height]).toEqual([3, 2]);
    expect(pixel(image, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(image, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(image, 0, 1)).toEqual([0, 128, 255, 255]);
  });

  it('decodes RGBA rows using every filter type', () => {
    const width = 4;
    const height = 5;
    const rows = Array.from({ length: height }, (_, y) => Uint8Array.from({ length: width * 4 }, (_, i) => (y * 37 + i * 11) % 256));
    const filtered: number[] = [];
    rows.forEach((row, y) => {
      const filter = y; // 0 none, 1 sub, 2 up, 3 average, 4 paeth
      filtered.push(filter);
      for (let x = 0; x < row.length; x++) {
        const a = x >= 4 ? row[x - 4]! : 0;
        const b = y > 0 ? rows[y - 1]![x]! : 0;
        const c = x >= 4 && y > 0 ? rows[y - 1]![x - 4]! : 0;
        const p = a + b - c;
        const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        const predictor = [0, a, b, (a + b) >> 1, paeth][filter]!;
        filtered.push((row[x]! - predictor) & 0xff);
      }
    });
    const chunk = (type: string, body: Buffer): Buffer => {
      const out = Buffer.alloc(12 + body.length);
      out.writeUInt32BE(body.length, 0);
      out.write(type, 4, 'latin1');
      body.copy(out, 8);
      out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)) >>> 0, 8 + body.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from(filtered))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(decodePng(png).data).toEqual(Uint8Array.from(rows.flatMap((r) => [...r])));
  });

  it('rejects files that are not PNGs', () => {
    expect(() => decodePng(Buffer.from('GIF89a'))).toThrow(PngError);
  });
});

describe('pixelate', () => {
  const [ink, moss, bone] = [PALETTE[0]!, PALETTE[30]!, PALETTE[8]!];

  it('reduces each cell to its colour, ignoring the rim, and keeps palette colours exact', () => {
    const sprite = pixelate(
      blockRender([
        [ink, moss, bone],
        [bone, ink, moss],
      ]),
      options(),
    );
    const image = decodePng(encodeIndexedPng(sprite));
    expect([image.width, image.height]).toEqual([3, 2]);
    expect(pixel(image, 0, 0)).toEqual([...ink, 255]);
    expect(pixel(image, 1, 0)).toEqual([...moss, 255]);
    expect(pixel(image, 2, 1)).toEqual([...moss, 255]);
    expect(checkSprite(image, { width: 3, height: 2 }, PALETTE)).toEqual([]);
  });

  it('snaps off-palette colours to the nearest palette colour', () => {
    const sprite = pixelate(blockRender([[[50, 36, 49]]]), options()); // near #2e222f
    expect(sprite.palette).toEqual([[...ink, 255]]);
  });

  it('uses the render alpha for the cutout and anchors portraits bottom-centre', () => {
    const render = blockRender([
      [null, moss, null, null, null],
      [null, moss, null, null, null],
      [null, null, null, null, null],
    ]);
    const sprite = decodePng(encodeIndexedPng(pixelate(render, options({ cutout: true, anchorBottom: true }))));
    expect(pixel(sprite, 1, 0)[3]).toBe(0);
    // A 1×2 figure in a 5×3 canvas: centred at x 2, bottom rows 1–2.
    expect(pixel(sprite, 2, 1)).toEqual([...moss, 255]);
    expect(pixel(sprite, 2, 2)).toEqual([...moss, 255]);
    expect(pixel(sprite, 2, 0)[3]).toBe(0);
  });

  it('refuses a cutout render with no transparency, and renders off the grid', () => {
    expect(() => pixelate(blockRender([[moss]]), options({ cutout: true }))).toThrow(PixelateError);
    expect(() => pixelate({ width: 9, height: 8, data: new Uint8Array(9 * 8 * 4) }, options())).toThrow(/8-pixel grid/);
  });

  it('is deterministic', () => {
    const render = blockRender([
      [ink, moss, [120, 90, 60]],
      [[200, 180, 150], ink, moss],
    ]);
    expect(encodeIndexedPng(pixelate(render, options()))).toEqual(encodeIndexedPng(pixelate(render, options())));
  });
});

describe('framing', () => {
  // 20×20 cards with a 4-row bar: the counter line is row 15.
  const rules = { bleed: [] as Edge[], counter: 4, minFooting: 0.5, tolerance: 2 };
  /** Opaque where `cell(x, y)` is true. */
  const shape = (width: number, height: number, cell: (x: number, y: number) => boolean): RgbaImage => ({
    width,
    height,
    data: Uint8Array.from({ length: width * height * 4 }, (_, i) => (i % 4 === 3 && cell((i >> 2) % width, Math.floor((i >> 2) / width)) ? 255 : 0)),
  });

  it('passes a bust that goes down behind the bar with room around it', () => {
    expect(framingProblems(shape(20, 20, (x, y) => x >= 3 && x <= 16 && y >= 4), rules)).toEqual([]);
  });

  it("doesn't care how the figure ends behind the bar", () => {
    // Wide at the counter line, tapering to a point under the bar.
    expect(framingProblems(shape(20, 20, (x, y) => y >= 4 && Math.abs(x - 10) <= (y <= 15 ? 7 : 19 - y)), rules)).toEqual([]);
  });

  it('flags clipping on the top and sides, unless that edge may bleed', () => {
    const tall = shape(20, 20, (x) => x <= 16);
    expect(framingProblems(tall, rules)).toEqual(['is clipped at the top (17 pixels on the edge)', 'is clipped at the left (20 pixels on the edge)']);
    expect(framingProblems(tall, { ...rules, bleed: ['top', 'left'] })).toEqual([]);
  });

  it('flags a floating head: a gap underneath, or a thin neck at the counter line', () => {
    expect(framingProblems(shape(20, 20, (x, y) => x >= 4 && x <= 15 && y >= 4 && y <= 14), rules)).toEqual([
      'floats: nothing reaches the bottom edge',
    ]);
    const neck = shape(20, 20, (x, y) => (x >= 4 && x <= 15 && y >= 4 && y <= 12) || (x >= 9 && x <= 10 && y > 12));
    expect(framingProblems(neck, rules)).toEqual(['floats: only 17% of its width is solid at the counter line (needs 50%)']);
  });

  it('drops a portrait onto the bottom edge, so a rounded bust ends behind the bar', () => {
    const moss = PALETTE[30]!;
    const sprite = decodePng(
      encodeIndexedPng(
        pixelate(
          blockRender(Array.from({ length: 6 }, (_, y) => Array.from({ length: 5 }, (_, x) => (x >= 1 && x <= 3 && y >= 1 && y <= 2 ? moss : null)))),
          options({ cutout: true, anchorBottom: true }),
        ),
      ),
    );
    expect(framingProblems(sprite, { ...rules, counter: 1 })).toEqual([]);
  });
});

describe('checkSprite', () => {
  it('reports size, partial alpha and off-palette colours', () => {
    const image: RgbaImage = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 255, ...PALETTE[0]!, 128]) };
    expect(checkSprite(image, { width: 3, height: 1 }, PALETTE)).toEqual([
      'is 2×1, expected 3×1',
      'has 1 semi-transparent pixel; pixels must be fully opaque or fully transparent',
      'uses 1 colour outside the palette (#010203)',
    ]);
  });
});

describe('style and graph', () => {
  it('fills the subject into the fixed wrapper', () => {
    const prompt = positivePrompt(style, 'portrait', 'a green ogre in an apron. ', 'medium');
    expect(prompt).toContain('pixel art');
    expect(prompt).toContain('a green ogre in an apron,');
    expect(prompt).toContain(style.portrait.framing.trim());
    expect(prompt).not.toMatch(/\{\{/);
  });

  it("uses a size's own framing where it has one", () => {
    expect(positivePrompt(style, 'portrait', 'a stirge', 'tiny')).toContain('beer mug');
    expect(positivePrompt(style, 'portrait', 'a t-rex', 'huge')).toContain('from the top left');
    expect(positivePrompt(style, 'cover', 'a bog')).toContain('a bog');
  });

  it('cuts portraits out with BiRefNet and saves covers straight from the decoder', () => {
    const portrait = renderGraph(style, { kind: 'portrait', size: 'large', subject: 'an ogre', seed: 7, prefix: 'p' });
    expect(portrait['save']!.inputs['images']).toEqual(['rgba', 0]);
    expect(portrait['cutoutModel']!.inputs['bg_removal_name']).toBe(style.model.backgroundRemoval);
    expect(portrait['sample']!.inputs['seed']).toBe(7);
    expect(portrait['latent']!.inputs).toMatchObject(renderSize(style, 'portrait', 'large'));

    const cover = renderGraph(style, { kind: 'cover', subject: 'a swamp', seed: 1, prefix: 'c' });
    expect(cover['save']!.inputs['images']).toEqual(['decode', 0]);
    expect(cover['cutoutModel']).toBeUndefined();
    expect(cover['latent']!.inputs).toMatchObject({ width: 1728, height: 576 });
  });

  it('gives bigger creatures bigger canvases at the same pixel scale', () => {
    const heights = CREATURE_SIZES.map((size) => outputSize(style, 'portrait', size).height);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(new Set(heights).size).toBe(CREATURE_SIZES.length);
    expect(renderSize(style, 'portrait', 'medium')).toEqual({ width: 896, height: 1152 });
    expect(creatureSize('Gargantuan')).toBe('gargantuan');
    expect(creatureSize('Colossal')).toBeUndefined();
  });

  it('pixelates portraits with a cutout and covers without', () => {
    expect(pixelateOptions(style, 'portrait')).toMatchObject({ cutout: true, anchorBottom: true });
    expect(pixelateOptions(style, 'cover')).toMatchObject({ cutout: false, anchorBottom: false });
  });
});

describe('drafts and committed images', () => {
  let root: string;
  const { width: pw, height: ph } = style.portrait.sizes.large;
  const sizeOf = (base: string) => (base === 'ogre' ? ('large' as const) : undefined);
  const { width: cw, height: ch } = style.cover.output;
  /** A figure standing on the bottom edge with a 10-pixel margin on the other three sides. */
  const figure = (width: number, height: number): Uint8Array =>
    encodeIndexedPng({
      width,
      height,
      indices: Uint8Array.from({ length: width * height }, (_, i) => (i % width >= 10 && i % width < width - 10 && i >= 10 * width ? 1 : 0)),
      palette: [
        [0, 0, 0, 0],
        [...PALETTE[30]!, 255],
      ],
    });
  const solid = (width: number, height: number, transparentTop = 0): Uint8Array =>
    encodeIndexedPng({
      width,
      height,
      indices: Uint8Array.from({ length: width * height }, (_, i) => (i < transparentTop * width ? 0 : 1)),
      palette: [
        [0, 0, 0, 0],
        [...PALETTE[30]!, 255],
      ],
    });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lot-images-'));
    mkdirSync(join(root, 'content', 'images'), { recursive: true });
    copyFileSync(stylePath(), join(root, 'content', 'images', 'style.yaml'));
    mkdirSync(join(root, 'characters', 'ogre-one'), { recursive: true });
    writeFileSync(
      join(root, 'characters', 'ogre-one', 'character.yaml'),
      'id: ogre-one\nbase: ogre\nstatus: active\nchrome:\n  name: One\n  portrait:\n    status: prompt   # none | prompt | draft | final\n    prompt: a green ogre\n',
    );
    mkdirSync(join(root, 'characters', 'no-prompt'), { recursive: true });
    writeFileSync(join(root, 'characters', 'no-prompt', 'character.yaml'), 'id: no-prompt\nbase: ogre\nstatus: active\nchrome:\n  name: Two\n');
    mkdirSync(join(root, 'seasons', 's1', 'chrome'), { recursive: true });
    writeFileSync(join(root, 'seasons', 's1', 'chrome', 'bog.yaml'), 'mission: bog\nstatus: draft\nimagePrompts:\n  cover: a misty bog at dusk\n');
    writeFileSync(join(root, 'seasons', 's1', 'chrome', 'throughlines.yaml'), 'season: s1\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds portrait and cover targets', () => {
    expect(portraitTargets('all', sizeOf, root).map((t) => t.id)).toEqual(['ogre-one']);
    expect(() => portraitTargets(['no-prompt'], sizeOf, root)).toThrow(ValidationFailure);
    expect(coverTargets('s1', [], root)).toMatchObject([{ kind: 'cover', id: 'bog', season: 's1', subject: 'a misty bog at dusk' }]);
    expect(() => coverTargets('s1', ['moor'], root)).toThrow(/moor/);
  });

  it('gives each target a stable default seed', () => {
    expect(defaultSeed({ kind: 'portrait', id: 'ogre-one' })).toBe(defaultSeed({ kind: 'portrait', id: 'ogre-one' }));
    expect(defaultSeed({ kind: 'portrait', id: 'ogre-one' })).not.toBe(defaultSeed({ kind: 'portrait', id: 'ogre-two' }));
  });

  it('accepts a staged portrait into the repo and records it, keeping comments', () => {
    const [target] = portraitTargets(['ogre-one'], sizeOf, root);
    expect(target!.size).toBe('large');
    expect(stage(target!, 42, new Uint8Array([1]), figure(pw, ph), style, root)).toEqual([]);
    expect(stage(target!, 43, new Uint8Array([1]), solid(pw, ph, 10), style, root)).toEqual([
      `is clipped at the left (${ph - 10} pixels on the edge)`,
      `is clipped at the right (${ph - 10} pixels on the edge)`,
    ]);
    expect(writeReviewPage(style, root)).toMatch(/index\.html$/);
    const page = readFileSync(join(root, '.image-drafts', 'index.html'), 'utf8');
    expect(page).toContain('accept --character ogre-one --seed 42');
    expect(page).toContain('✗ is clipped at the left');
    expect(() => accept(target!, 43, style, root)).toThrow(/can't be layered cleanly/);

    expect(accept(target!, 42, style, root)).toBe('characters/ogre-one/portrait.png');
    const yaml = readFileSync(join(root, 'characters', 'ogre-one', 'character.yaml'), 'utf8');
    expect(yaml).toContain('status: draft # none | prompt | draft | final');
    expect(yaml).toContain('path: portrait.png');
    expect(yaml).toContain('seed: 42');
    expect(checkSeasonImages('s1', [{ id: 'ogre-one', size: 'large' }], root)).toEqual([]);
    const { width: mw, height: mh } = style.portrait.sizes.medium;
    expect(checkSeasonImages('s1', [{ id: 'ogre-one', size: 'medium' }], root)).toEqual([
      `characters/ogre-one/portrait.png: is ${pw}×${ph}, expected ${mw}×${mh}`,
    ]);
    expect(() => accept(target!, 44, style, root)).toThrow(/no staged portrait/);
  });

  it('flags missing, wrong-sized and orphaned images', () => {
    writeFileSync(
      join(root, 'characters', 'ogre-one', 'character.yaml'),
      'id: ogre-one\nbase: ogre\nstatus: active\nchrome:\n  name: One\n  portrait:\n    status: final\n',
    );
    writeFileSync(join(root, 'seasons', 's1', 'chrome', 'bog.cover.png'), solid(cw, ch - 1));
    writeFileSync(join(root, 'seasons', 's1', 'chrome', 'moor.cover.png'), solid(cw, ch));
    expect(checkSeasonImages('s1', [{ id: 'ogre-one', size: 'large' }], root)).toEqual([
      'characters/ogre-one/character.yaml: chrome.portrait: status is final but no path is set',
      'seasons/s1/chrome/moor.cover.png: no moor.yaml chrome file next to it',
      `seasons/s1/chrome/bog.cover.png: is ${cw}×${ch - 1}, expected ${cw}×${ch}`,
    ]);
  });
});
