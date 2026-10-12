import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { checkPainted, paint, paintedProblems } from '../src/lib/images/paint';
import { pixelView } from '../src/lib/images/postprocess';
import { PngError, decodePng, encodeIndexedPng, encodeRgbaPng } from '../src/lib/images/png';
import { placeOnStage } from '../src/lib/images/stage';
import { fitToCanvas } from '../src/lib/images/resample';
import type { RgbaImage } from '../src/lib/images/png';
import {
  CREATURE_SIZES,
  creatureSize,
  framingRules,
  loadImageStyle,
  outputSize,
  pixelateOptions,
  negativePrompt,
  paintOptions,
  paintedRules,
  pixelViewOptions,
  positivePrompt,
  renderSize,
  stageFit,
  stylePath,
} from '../src/lib/images/style';
import type { ImageStyle } from '../src/lib/images/style';
import { ValidationFailure } from '../src/lib/main';

const PALETTE = PALETTES['resurrect-64'];
const repoStyle = loadImageStyle();
/** Each suite pins the mode it tests; the repo's style may be in either. */
const style: ImageStyle = { ...repoStyle, mode: 'pixel' };
const painted: ImageStyle = { ...repoStyle, mode: 'painted' };
/** A copy of the repo's style file in the given mode, for a temporary root. */
const styleFileIn = (mode: ImageStyle['mode']): string => readFileSync(stylePath(), 'utf8').replace(/^mode: \w+$/m, `mode: ${mode}`);

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

  it('turns see-through parts of a translucent figure into glass, keeping the rest solid', () => {
    const [ice, ink] = [PALETTE[8]!, PALETTE[0]!]; // pale #c7dcd0, dark #2e222f
    // A 3×3 figure on a white background: dark outline, a pale interior cell.
    const render = blockRender([
      [null, null, null, null, null],
      [null, ink, ink, ink, null],
      [null, ink, ice, ink, null],
      [null, ink, ink, ink, null],
    ]);
    const glass = { alpha: 112, maxDistance: 0.1, minLightness: 0.78, maxChroma: 0.07 };
    const sprite = decodePng(encodeIndexedPng(pixelate(render, options({ cutout: true, glass }))));
    expect(pixel(sprite, 2, 2)).toEqual([...ice, 112]);
    expect(pixel(sprite, 1, 1)).toEqual([...ink, 255]);
    expect(pixel(sprite, 0, 0)[3]).toBe(0);
    expect(checkSprite(sprite, { width: 5, height: 4 }, PALETTE)).toEqual([
      'has 1 semi-transparent pixel; pixels must be fully opaque or fully transparent',
    ]);
    expect(checkSprite(sprite, { width: 5, height: 4 }, PALETTE, 112)).toEqual([]);
    expect(() => pixelate(render, options({ glass }))).toThrow(/glass needs a cutout/);
  });

  it('draws a 1-pixel outline in the darkest palette colour around the figure', () => {
    const render = blockRender([
      [null, null, null, null],
      [null, moss, moss, null],
      [null, moss, moss, null],
    ]);
    const sprite = decodePng(encodeIndexedPng(pixelate(render, options({ cutout: true, outline: true }))));
    expect(pixel(sprite, 1, 1)).toEqual([...moss, 255]);
    expect(pixel(sprite, 0, 1)).toEqual([...PALETTE[0]!, 255]); // #2e222f, Resurrect 64's darkest
    expect(pixel(sprite, 1, 0)).toEqual([...PALETTE[0]!, 255]);
    expect(pixel(sprite, 0, 0)[3]).toBe(0); // diagonal corners stay clear
  });

  it('grades contrast and saturation before snapping to the palette', () => {
    const lightGrey = blockRender([[[200, 200, 200]]]);
    const plain = pixelate(lightGrey, options());
    const graded = pixelate(lightGrey, options({ grade: { contrast: 2, saturation: 1 } }));
    expect(plain.palette[0]!.slice(0, 3)).not.toEqual([255, 255, 255]);
    expect(graded.palette[0]!.slice(0, 3)).toEqual([255, 255, 255]);
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
  const rules = { bleed: [] as Edge[], counter: 4, minFooting: 0.5, tolerance: 2, minMainShare: 0, minChroma: 0, minFill: 0 };
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

  it('flags a sprite sheet of copies and a greyscale sprite', () => {
    const coloured = (width: number, height: number, cell: (x: number, y: number) => boolean, rgb: number[]): RgbaImage => ({
      width,
      height,
      data: Uint8Array.from({ length: width * height * 4 }, (_, i) => {
        const p = i >> 2;
        const on = cell(p % width, Math.floor(p / width));
        return i % 4 === 3 ? (on ? 255 : 0) : on ? rgb[i % 4]! : 0;
      }),
    });
    const strict = { ...rules, minMainShare: 0.8, minChroma: 0.025 };
    const green = [60, 180, 80];
    const one = coloured(20, 20, (x, y) => x >= 3 && x <= 16 && y >= 4, green);
    expect(framingProblems(one, strict)).toEqual([]);
    // Two equal figures side by side.
    const two = coloured(20, 20, (x, y) => y >= 4 && ((x >= 2 && x <= 8) || (x >= 11 && x <= 17)), green);
    expect(framingProblems(two, strict)).toContain('shows more than one figure (the largest shape is only 50% of the sprite; needs 80%)');
    const grey = coloured(20, 20, (x, y) => x >= 3 && x <= 16 && y >= 4, [140, 140, 140]);
    expect(framingProblems(grey, strict)).toEqual(['is nearly greyscale (mean chroma 0.000, needs 0.025)']);
  });

  it('flags a person too small in the frame (a full-body pose)', () => {
    // A thin standing figure: 4 wide, 14 tall, in a 20×20 card with a 4-row bar.
    const standing = shape(20, 20, (x, y) => x >= 8 && x <= 11 && y >= 6);
    expect(framingProblems(standing, { ...rules, minFooting: 0, minFill: 0.35 })).toEqual([
      'is too small in the frame, likely full-body (fills 13% of the card above the bar, needs 35%)',
    ]);
    expect(framingRules(style, 'medium', 'humanoid').minFill).toBe(0.35);
    expect(framingRules(style, 'medium', 'blob').minFill).toBe(0);
    expect(framingRules(style, 'tiny', 'humanoid').minFill).toBe(0);
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

describe('import fitting', () => {
  it('trims, scales inside the margins and places the figure bottom-centre', () => {
    // A 40×20 opaque block in the middle of a 100×100 transparent image.
    const src: RgbaImage = {
      width: 100,
      height: 100,
      data: Uint8Array.from({ length: 100 * 100 * 4 }, (_, i) => {
        const p = i >> 2;
        const [x, y] = [p % 100, Math.floor(p / 100)];
        return x >= 30 && x < 70 && y >= 40 && y < 60 ? (i % 4 === 3 ? 255 : 120) : 0;
      }),
    };
    const fitted = fitToCanvas(src, 64, 80, { side: 4, top: 8 });
    const opaque = (x: number, y: number) => fitted.data[(y * 64 + x) * 4 + 3]! > 127;
    // Width-limited: 56 wide (64 - 2×4), 28 tall, flush with the bottom.
    expect(opaque(4, 79)).toBe(true);
    expect(opaque(59, 79)).toBe(true);
    expect(opaque(3, 79)).toBe(false);
    expect(opaque(60, 79)).toBe(false);
    expect(opaque(30, 52)).toBe(true);
    expect(opaque(30, 51)).toBe(false);
  });

  it('round-trips an RGBA PNG', () => {
    const img: RgbaImage = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 4, 250, 251, 252, 253]) };
    expect(decodePng(encodeRgbaPng(img)).data).toEqual(img.data);
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
    expect(prompt).toContain(style.portrait.bodyPlans.humanoid.framing.trim());
    expect(prompt).toContain('tavern patron');
    expect(prompt).not.toMatch(/\{\{/);
  });

  it("uses a size's own framing where it has one", () => {
    expect(positivePrompt(style, 'portrait', 'a stirge', 'tiny')).toContain('pewter beer tankard');
    expect(positivePrompt(style, 'portrait', 'a t-rex', 'huge')).toContain('from the top left');
    expect(positivePrompt(style, 'cover', 'a bog')).toContain('a bog');
  });

  it('anchors non-humanoids as creatures and keeps people out of them', () => {
    const bear = positivePrompt(style, 'portrait', 'a brown bear', 'large', 'beast');
    expect(bear).toContain('animal anatomy');
    expect(bear).not.toContain('tavern patron');
    expect(negativePrompt(style, 'portrait', 'beast')).toMatch(/human, person/);
    expect(negativePrompt(style, 'portrait', 'humanoid')).not.toMatch(/human, person/);
    // A size's framing wins over the body plan's: a tiny dragon still perches on a flagon.
    expect(positivePrompt(style, 'portrait', 'a tiny dragon', 'tiny', 'winged')).toContain('pewter beer tankard');
    const graph = renderGraph(style, { kind: 'portrait', size: 'large', bodyPlan: 'blob', subject: 'a jelly cube', seed: 1, prefix: 'b' });
    expect(graph['negative']!.inputs['text']).toMatch(/humanoid body/);
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

describe('heights', () => {
  const { stage } = style;
  const cardHeight = (visibleFt: number) => Math.ceil((visibleFt * stage.pxPerFt + style.portrait.counter + stage.headroom) / 8) * 8;

  it('sizes Small to Large canvases from height, with a stool for the short and a cap for the tall', () => {
    expect(stageFit(style, { size: 'medium', heightFt: 6 })).toEqual({ visibleFt: 2.5, card: { width: Math.ceil((cardHeight(2.5) * 0.9) / 8) * 8, height: cardHeight(2.5) } });
    // A 4 ft dwarf stands on a stool: at least minVisibleFt shows.
    expect(stageFit(style, { size: 'medium', heightFt: 4 })!.visibleFt).toBe(stage.minVisibleFt);
    // A 13 ft ettin is capped.
    expect(stageFit(style, { size: 'large', heightFt: 13 })!.visibleFt).toBe(stage.maxVisibleFt);
    // Taller characters get taller cards, and every render is on the 64-pixel grid.
    const heights = [4.5, 5.5, 6.5, 8, 9.5].map((h) => outputSize(style, 'portrait', { size: 'medium', heightFt: h }).height);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    for (const h of heights) expect((h * style.pixelate.cell) % 64).toBe(0);
    // Tiny and Huge, and anyone without a height, keep the size table.
    expect(stageFit(style, { size: 'tiny', heightFt: 1 })).toBeUndefined();
    expect(stageFit(style, { size: 'huge', heightFt: 20 })).toBeUndefined();
    expect(outputSize(style, 'portrait', { size: 'medium' })).toEqual({ width: 112, height: 144 });
  });

  it('frames a humanoid by how much of them shows above the bar', () => {
    // A dwarf on a stool shows about half of himself; a tall human shows less, so is closer.
    expect(positivePrompt(style, 'portrait', 'a dwarf', { size: 'medium', heightFt: 4.5 })).toContain('waist-up');
    expect(positivePrompt(style, 'portrait', 'a tall human', { size: 'medium', heightFt: 7 })).toContain('waist-up');
    expect(positivePrompt(style, 'portrait', 'a giant', { size: 'large', heightFt: 16 })).toContain('head, shoulders and upper chest');
    expect(positivePrompt(style, 'portrait', 'a halfling', { size: 'small', heightFt: 3 })).toContain('thigh-up');
    expect(positivePrompt(style, 'portrait', 'a bear', { size: 'large', heightFt: 8, plan: 'beast' })).not.toContain('thigh-up');
  });

  it('pins the top of the head headroom rows down, and leaves a short figure floating for the checks', () => {
    const moss = PALETTE[30]!;
    const render = (rows: (y: number) => boolean) =>
      blockRender(Array.from({ length: 8 }, (_, y) => Array.from({ length: 5 }, (_, x) => (x >= 1 && x <= 3 && rows(y) ? moss : null))));
    const tall = decodePng(encodeIndexedPng(pixelate(render((y) => y >= 0), options({ cutout: true, anchorBottom: true, anchorTop: 2 }))));
    expect(pixel(tall, 2, 1)[3]).toBe(0);
    expect(pixel(tall, 2, 2)[3]).toBe(255);
    expect(pixel(tall, 2, 7)[3]).toBe(255);
    // A short figure pinned at the top no longer reaches the bottom edge.
    const short = decodePng(encodeIndexedPng(pixelate(render((y) => y >= 4 && y <= 5), options({ cutout: true, anchorBottom: true, anchorTop: 2 }))));
    expect(pixel(short, 2, 2)[3]).toBe(255);
    expect(pixel(short, 2, 7)[3]).toBe(0);
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
    writeFileSync(join(root, 'content', 'images', 'style.yaml'), styleFileIn('pixel'));
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

// ── painted mode ───────────────────────────────────────────────────────────

/** An RGBA render with opaque rectangles [x, y, w, h, colour] on a transparent canvas. */
function rectRender(width: number, height: number, rects: ReadonlyArray<readonly [number, number, number, number, Rgb]>): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (const [x0, y0, w, h, c] of rects) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set([...c, 255], (y * width + x) * 4);
  }
  return { width, height, data };
}
const RUST: Rgb = [180, 70, 40];
const MOSS: Rgb = [70, 140, 60];

describe('painted style and graph', () => {
  it('asks for the whole figure in the painted wrapper, with the body plan anchor', () => {
    const ogre = positivePrompt(painted, 'portrait', 'a green ogre in an apron. ', 'large');
    expect(ogre).toContain('World of Warcraft');
    expect(ogre).toContain('(a green ogre in an apron:1.35)');
    expect(ogre).toContain(painted.painted.portrait.poses.humanoid!.trim());
    expect(ogre).toContain('tavern patron');
    expect(ogre).not.toMatch(/\{\{|pixel art,/);
    // No size framing: a tiny dragon is drawn whole, and the stage puts it on the bar.
    const dragon = positivePrompt(painted, 'portrait', 'a tiny dragon', 'tiny', 'winged');
    expect(dragon).not.toContain('tankard');
    expect(dragon).toContain(painted.painted.portrait.poses.default.trim());
    expect(positivePrompt(painted, 'cover', 'a bog')).toContain('a bog');
  });

  it('pushes back green orcs unless the subject asks for one', () => {
    expect(negativePrompt(painted, 'portrait', 'humanoid', 'a dusty tan mummy')).toContain('(orc, green skin:1.3)');
    expect(negativePrompt(painted, 'portrait', 'humanoid', 'a scarred orc bouncer')).not.toContain('(orc, green skin:1.3)');
    expect(negativePrompt(painted, 'portrait', 'beast', 'a bear')).toMatch(/human, person/);
    expect(negativePrompt(painted, 'cover')).not.toContain('orc');
  });

  it('renders upright figures tall, Huge beasts wide, the rest square, with no LoRA', () => {
    const { renders } = painted.painted.portrait;
    expect(renderSize(painted, 'portrait', 'medium')).toEqual(renders.tall);
    expect(renderSize(painted, 'portrait', { size: 'huge', plan: 'beast' })).toEqual(renders.wide);
    expect(renderSize(painted, 'portrait', { size: 'large', plan: 'blob' })).toEqual(renders.square);
    expect(renderSize(painted, 'cover')).toEqual(painted.painted.cover.render);
    const graph = renderGraph(painted, { kind: 'portrait', size: 'medium', subject: 'a dwarf', seed: 3, prefix: 'p' });
    expect(graph['lora']).toBeUndefined();
    expect(graph['sample']!.inputs['model']).toEqual(['checkpoint', 0]);
    expect(graph['positive']!.inputs['clip']).toEqual(['checkpoint', 1]);
    expect(graph['latent']!.inputs).toMatchObject(renders.tall);
    expect(graph['save']!.inputs['images']).toEqual(['rgba', 0]);
    expect(renderGraph(style, { kind: 'portrait', size: 'medium', subject: 'a dwarf', seed: 3, prefix: 'p' })['lora']).toBeDefined();
  });
});

describe('paint', () => {
  it('keeps a portrait at full resolution, trimmed to its figure', () => {
    const render = rectRender(100, 200, [[30, 20, 40, 160, RUST]]);
    const original = paint(render, { kind: 'portrait' });
    expect([original.width, original.height]).toEqual([40, 160]);
    const decoded = decodePng(encodeRgbaPng(original));
    expect(pixel(decoded, 20, 80)).toEqual([...RUST, 255]);
    expect(checkPainted(decoded, 'portrait', paintedRules(painted))).toEqual([]);
    expect(checkPainted(render, 'portrait')).toEqual(['is not trimmed to its figure']);
  });

  it('drops faint cutout fringe before trimming, and turns pale parts of a translucent figure to glass', () => {
    const render = rectRender(60, 60, [[10, 10, 40, 40, MOSS], [20, 20, 20, 20, [235, 240, 238]]]);
    render.data[3] = 10; // a faint speck in the corner
    expect([paint(render, { kind: 'portrait' }).width, paint(render, { kind: 'portrait' }).height]).toEqual([40, 40]);
    const options = paintOptions(painted, 'portrait', true);
    expect(options).toMatchObject({ kind: 'portrait', glass: { alpha: painted.portrait.glass.alpha } });
    const glass = paint(render, options);
    expect(pixel(glass, 20, 20)[3]).toBe(painted.portrait.glass.alpha);
    expect(pixel(glass, 2, 2)[3]).toBe(255);
  });

  it('keeps a cover as rendered, opaque', () => {
    const cover = decodePng(encodeRgbaPng(paint(rectRender(80, 40, [[0, 0, 80, 20, MOSS]]), { kind: 'cover' })));
    expect(checkPainted(cover, { width: 80, height: 40 })).toEqual([]);
    expect(checkPainted(cover, { width: 80, height: 41 })).toEqual(['is 80×40, expected 80×41']);
    expect(checkPainted(rectRender(80, 40, [[0, 0, 80, 20, MOSS]]), { width: 80, height: 40 })).toEqual(['has transparent pixels; a cover must be opaque']);
  });

  it('writes filtered true-colour PNGs that round-trip, RGB when opaque', () => {
    const data = new Uint8Array(37 * 23 * 4);
    for (let i = 0; i < 37 * 23; i++) data.set([(i * 7) % 256, (i * 13) % 256, (i >> 3) % 256, 255], i * 4);
    const opaque = { width: 37, height: 23, data };
    const png = encodeRgbaPng(opaque);
    expect(png[25]).toBe(2); // colour type RGB
    expect(decodePng(png).data).toEqual(data);
    const clear = { ...opaque, data: Uint8Array.from(data, (v, i) => (i % 4 === 3 && i % 3 === 0 ? 0 : v)) };
    expect(encodeRgbaPng(clear)[25]).toBe(6);
    expect(decodePng(encodeRgbaPng(clear)).data).toEqual(clear.data);
  });

  it('flags a render that is cut off, too small, more than one figure or greyscale', () => {
    const rules = paintedRules(painted);
    expect(paintedProblems(rectRender(100, 200, [[30, 20, 40, 160, RUST]]), rules)).toEqual([]);
    expect(paintedProblems(rectRender(100, 200, [[30, 20, 40, 180, RUST]]), rules)).toEqual(['is cut off at the bottom (40 pixels on the edge)']);
    expect(paintedProblems(rectRender(100, 200, [[30, 20, 40, 40, RUST]]), rules)[0]).toMatch(/too small in the frame/);
    expect(paintedProblems(rectRender(100, 200, [[5, 20, 40, 160, RUST], [55, 20, 40, 160, RUST]]), rules)[0]).toMatch(/more than one figure/);
    // A swarm is many shapes by design.
    expect(paintedProblems(rectRender(100, 200, [[5, 20, 40, 160, RUST], [55, 20, 40, 160, RUST]]), paintedRules(painted, 'swarm'))).toEqual([]);
    expect(paintedProblems(rectRender(100, 200, [[30, 20, 40, 160, [120, 120, 120]]]), rules)[0]).toMatch(/greyscale/);
    expect(paintedProblems(rectRender(10, 10, []), rules)).toEqual(['is empty: nothing survived the cutout']);
  });
});

describe('post-processing', () => {
  /** A 2-colour figure at full resolution: rust top half, moss bottom half, with soft (anti-aliased) edges. */
  const original = (() => {
    const image = rectRender(90, 180, [[0, 0, 90, 90, RUST], [0, 90, 90, 90, MOSS]]);
    for (let y = 0; y < 180; y++) for (const x of [0, 89]) image.data[(y * 90 + x) * 4 + 3] = 100;
    return image;
  })();

  it('cuts pixel art at a zoom: the figure is heightPx art pixels tall, with a clear border for the outline', () => {
    const view = decodePng(encodeIndexedPng(pixelView(original, pixelViewOptions(painted, 'pixel', 1)))); // 1 ft at 28 px/ft
    expect(view.height).toBe(28 + 2);
    expect(view.width).toBe(14 + 2);
    const fine = pixelView(original, pixelViewOptions(painted, 'pixel-fine', 1));
    expect(fine.height).toBe(56 + 2);
  });

  it('drops to the colour budget with hard edges, and outlines the figure', () => {
    const view = decodePng(encodeIndexedPng(pixelView(original, pixelViewOptions(painted, 'pixel', 1))));
    const colours = new Set<string>();
    for (let i = 0; i < view.data.length; i += 4) {
      expect([0, 255]).toContain(view.data[i + 3]);
      if (view.data[i + 3] === 255) colours.add(view.data.slice(i, i + 3).join(','));
    }
    for (const c of colours) expect(PALETTE.map((p) => p.join(','))).toContain(c);
    // Outline: the border ring around the figure is one dark colour; the corners stay clear.
    expect(pixel(view, 0, 0)[3]).toBe(0);
    expect(pixel(view, 0, 10)[3]).toBe(255);
    expect(pixel(view, 0, 10)).toEqual(pixel(view, 8, 0));
    expect(pixel(view, 0, 10)).not.toEqual(pixel(view, 8, 6));
    // The figure itself keeps its two halves apart.
    expect(pixel(view, 8, 6)).not.toEqual(pixel(view, 8, 24));
  });

  it("can keep the image's own colours instead of the league palette", () => {
    const options = pixelViewOptions(painted, 'pixel-fine', 1);
    expect(options.palette).toBe('own');
    expect(options.colorGroups).toBe(painted.painted.views['pixel-fine']!.colors);
    expect(() => pixelViewOptions(painted, 'mosaic', 1)).toThrow(/no view "mosaic"/);
  });
});

describe('stage placement', () => {
  const { barFt, frameFt, minVisibleFt } = painted.stage;

  it('stands people on the floor at their height, short folk on a stool', () => {
    expect(placeOnStage(painted, 'medium', 6)).toEqual({ where: 'floor', shownFt: 6, topFt: 6 - barFt });
    expect(placeOnStage(painted, 'large', 9.5)).toEqual({ where: 'floor', shownFt: 9.5, topFt: 9.5 - barFt });
    expect(placeOnStage(painted, 'medium', 4.3)).toEqual({ where: 'floor', shownFt: 4.3, topFt: minVisibleFt });
    // A 3 ft creature still keeps half a foot hidden behind the bar.
    expect(placeOnStage(painted, 'medium', 3).topFt).toBeLessThanOrEqual(3 - painted.stage.minHiddenFt);
  });

  it('puts the smallest on the bar, at least minShownFt tall', () => {
    expect(placeOnStage(painted, 'tiny', 1.5)).toEqual({ where: 'bar', shownFt: 1.5, topFt: 1.5 });
    expect(placeOnStage(painted, 'tiny', 0.4)).toEqual({ where: 'bar', shownFt: painted.stage.minShownFt, topFt: painted.stage.minShownFt });
    expect(placeOnStage(painted, 'small', 2).where).toBe('bar');
  });

  it('looms anything too tall for the frame in from the top, at most twice its height', () => {
    expect(placeOnStage(painted, 'huge', 20)).toEqual({ where: 'loom', shownFt: 2 * frameFt, topFt: frameFt });
    expect(placeOnStage(painted, 'large', 13)).toEqual({ where: 'loom', shownFt: Math.min(13, 2 * frameFt), topFt: frameFt });
    expect(placeOnStage(painted, 'huge', 11).shownFt).toBe(11);
  });
});

describe('painted drafts and committed images', () => {
  let root: string;
  const sizeOf = (base: string) => (base === 'ogre' ? ('large' as const) : undefined);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lot-painted-'));
    mkdirSync(join(root, 'content', 'images'), { recursive: true });
    writeFileSync(join(root, 'content', 'images', 'style.yaml'), styleFileIn('painted'));
    mkdirSync(join(root, 'characters', 'ogre-one'), { recursive: true });
    writeFileSync(
      join(root, 'characters', 'ogre-one', 'character.yaml'),
      'id: ogre-one\nbase: ogre\nstatus: active\nchrome:\n  name: One\n  height: 8\n  portrait:\n    status: prompt\n    prompt: a green ogre\n',
    );
    mkdirSync(join(root, 'seasons', 's1', 'chrome'), { recursive: true });
    writeFileSync(join(root, 'seasons', 's1', 'chrome', 'bog.yaml'), 'mission: bog\nstatus: draft\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('stages candidates with their stage placement and views, accepts a whole figure and validates it', () => {
    const [target] = portraitTargets(['ogre-one'], sizeOf, root);
    const whole = rectRender(200, 300, [[60, 30, 80, 240, RUST]]);
    const cropped = rectRender(200, 300, [[60, 30, 80, 270, RUST]]);
    const finish = (render: RgbaImage) => encodeRgbaPng(paint(render, paintOptions(painted, 'portrait')));
    expect(stage(target!, 1, encodeRgbaPng(whole), finish(whole), painted, root)).toEqual([]);
    expect(stage(target!, 2, encodeRgbaPng(cropped), finish(cropped), painted, root)).toEqual(['is cut off at the bottom (80 pixels on the edge)']);
    const framing = JSON.parse(readFileSync(join(root, '.image-drafts', 'portrait', 'ogre-one', 's1.framing.json'), 'utf8')) as { placement: unknown };
    expect(framing.placement).toEqual({ where: 'floor', shownFt: 8, topFt: 8 - painted.stage.barFt, heightFt: 8 });
    writeReviewPage(painted, root);
    const page = readFileSync(join(root, '.image-drafts', 'index.html'), 'utf8');
    expect(page).toContain('class="stage floor"');
    expect(page).toContain('8 ft');
    // Each view is staged at the size the stage draws the figure: 8 ft at its px per foot, plus the border.
    for (const [name, view] of Object.entries(painted.painted.views)) {
      expect(page).toContain(`s1.${name}.png`);
      const staged = decodePng(readFileSync(join(root, '.image-drafts', 'portrait', 'ogre-one', `s1.${name}.png`)));
      expect(staged.height).toBe(8 * view.pxPerFt + 2);
    }

    expect(() => accept(target!, 2, painted, root)).toThrow(/cut off at the bottom/);
    expect(accept(target!, 1, painted, root)).toBe('characters/ogre-one/portrait.png');
    expect(checkSeasonImages('s1', [{ id: 'ogre-one', size: 'large' }], root)).toEqual([]);
  });

  it('flags an untrimmed portrait and a wrong-sized cover', () => {
    writeFileSync(
      join(root, 'characters', 'ogre-one', 'character.yaml'),
      'id: ogre-one\nbase: ogre\nstatus: active\nchrome:\n  name: One\n  portrait:\n    status: draft\n    path: portrait.png\n',
    );
    writeFileSync(join(root, 'characters', 'ogre-one', 'portrait.png'), encodeRgbaPng(rectRender(120, 200, [[10, 0, 100, 200, RUST]])));
    writeFileSync(join(root, 'seasons', 's1', 'chrome', 'bog.cover.png'), encodeRgbaPng(rectRender(216, 72, [[0, 0, 216, 72, MOSS]])));
    const { width, height } = painted.painted.cover.render;
    expect(checkSeasonImages('s1', [{ id: 'ogre-one', size: 'large' }], root)).toEqual([
      'characters/ogre-one/portrait.png: is not trimmed to its figure',
      `seasons/s1/chrome/bog.cover.png: is 216×72, expected ${width}×${height}`,
    ]);
  });
});
