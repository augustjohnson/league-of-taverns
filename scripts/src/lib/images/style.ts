/**
 * content/images/style.yaml: the fixed style every generated image shares,
 * in one of two modes: painted (full-colour illustrations scaled to height on
 * the stage) or pixel (palette-locked pixel art on fixed cards).
 */
import { join } from 'node:path';
import { toSchemaIssues } from '@league-of-taverns/engine';
import { z } from 'zod';
import { ValidationFailure } from '../main';
import { REPO_ROOT, issuesFailure, readYaml, rootDir } from '../repo';
import type { RepoRoot } from '../repo';
import { BODY_PLANS } from './body-plans';
import type { BodyPlan } from './body-plans';
import { EDGES } from './framing';
import type { FramingRules } from './framing';
import { PALETTES } from './palette';
import type { PaletteName, Rgb } from './palette';
import type { PaintOptions, PaintedRules } from './paint';
import type { PixelViewOptions } from './postprocess';
import type { PixelateOptions } from './pixelate';

export const IMAGE_KINDS = ['portrait', 'cover'] as const;
export const IMAGE_MODES = ['painted', 'pixel'] as const;
export type ImageMode = (typeof IMAGE_MODES)[number];
export type ImageKind = (typeof IMAGE_KINDS)[number];

/** Open5e creature sizes, lower-cased. */
export const CREATURE_SIZES = ['tiny', 'small', 'medium', 'large', 'huge', 'gargantuan'] as const;
export type CreatureSize = (typeof CREATURE_SIZES)[number];

export interface Size {
  readonly width: number;
  readonly height: number;
}

const SUBJECT = '{{subject}}';
const FRAMING = '{{framing}}';
const ANCHOR = '{{anchor}}';
const POSE = '{{pose}}';
const once = (token: string) => (s: string) => s.split(token).length === 2;

const text = z.string().min(1);
const size = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });

const prompts = {
  cutout: z.boolean(),
  positive: text.refine(once(SUBJECT), `must contain ${SUBJECT} exactly once`),
  negative: text,
};

const bodyPlan = z.strictObject({
  anchor: text,
  /** Card width as a share of its height, for height-based canvases. */
  aspect: z.number().positive().exactOptional(),
  framing: text,
  negative: text.exactOptional(),
  minFill: z.number().min(0).max(1).exactOptional(),
});

const portraitSize = size.extend({
  /** Render pixels per art pixel for this size, instead of pixelate.cell. */
  cell: z.number().int().positive().exactOptional(),
  bleed: z.array(z.enum(EDGES)).exactOptional(),
  minFooting: z.number().min(0).max(1).exactOptional(),
  counter: z.number().int().nonnegative().exactOptional(),
  framing: text.exactOptional(),
});

const view = z.strictObject({
  pxPerFt: z.number().positive(),
  colors: z.union([z.literal('palette'), z.number().int().min(2).max(64)]),
  outline: z.boolean(),
});

const painted = z.strictObject({
  views: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), view),
  portrait: z.strictObject({
    renders: z.strictObject({ tall: size, square: size, wide: size }),
    poses: z.strictObject({ default: text, ...Object.fromEntries(BODY_PLANS.map((p) => [p, text.exactOptional()])) } as Record<'default', typeof text> & Record<BodyPlan, ReturnType<typeof text.exactOptional>>),
    drift: z.strictObject({ words: z.array(text).min(1), negative: text }),
    tolerance: z.number().int().nonnegative(),
    minFill: z.number().min(0).max(1),
    positive: text
      .refine(once(SUBJECT), `must contain ${SUBJECT} exactly once`)
      .refine(once(POSE), `must contain ${POSE} exactly once`)
      .refine(once(ANCHOR), `must contain ${ANCHOR} exactly once`),
    negative: text,
  }),
  cover: z.strictObject({
    render: size,
    positive: text.refine(once(SUBJECT), `must contain ${SUBJECT} exactly once`),
    negative: text,
  }),
});

const styleSchema = z.strictObject({
  mode: z.enum(IMAGE_MODES),
  palette: z.enum(Object.keys(PALETTES) as [PaletteName, ...PaletteName[]]),
  model: z.strictObject({
    checkpoint: text,
    lora: text,
    loraStrength: z.number().min(0).max(2),
    steps: z.number().int().positive(),
    cfg: z.number().positive(),
    sampler: text,
    scheduler: text,
    backgroundRemoval: text,
  }),
  pixelate: z.strictObject({
    cell: z.number().int().positive(),
    colorGroups: z.number().int().min(2).max(256),
    chromaWeight: z.number().positive(),
  }),
  portrait: z.strictObject({
    sizes: z.strictObject(Object.fromEntries(CREATURE_SIZES.map((s) => [s, portraitSize])) as Record<CreatureSize, typeof portraitSize>),
    counter: z.number().int().nonnegative(),
    outline: z.boolean(),
    grade: z.strictObject({ contrast: z.number().positive(), saturation: z.number().nonnegative() }).exactOptional(),
    glass: z.strictObject({
      alpha: z.number().int().min(1).max(254),
      maxDistance: z.number().nonnegative(),
      minLightness: z.number().min(0).max(1),
      maxChroma: z.number().nonnegative(),
    }),
    minFooting: z.number().min(0).max(1),
    minMainShare: z.number().min(0).max(1),
    minChroma: z.number().nonnegative(),
    tolerance: z.number().int().nonnegative(),
    bodyPlans: z.strictObject(
      Object.fromEntries(BODY_PLANS.map((p) => [p, bodyPlan])) as Record<BodyPlan, typeof bodyPlan>,
    ),
    ...prompts,
    positive: text
      .refine(once(SUBJECT), `must contain ${SUBJECT} exactly once`)
      .refine(once(FRAMING), `must contain ${FRAMING} exactly once`)
      .refine(once(ANCHOR), `must contain ${ANCHOR} exactly once`),
  }),
  painted,
  stage: z.strictObject({
    barFt: z.number().positive(),
    frameFt: z.number().positive(),
    minHiddenFt: z.number().nonnegative(),
    onBarMaxFt: z.number().positive(),
    minShownFt: z.number().positive(),
    loomAboveFt: z.number().positive(),
    pxPerFt: z.number().positive(),
    headroom: z.number().int().nonnegative(),
    minVisibleFt: z.number().positive(),
    maxVisibleFt: z.number().positive(),
    minWidth: z.number().int().positive(),
    maxWidth: z.number().int().positive(),
    framing: z.array(z.strictObject({ upTo: z.number().positive(), text })).min(1),
  }),
  cover: z.strictObject({ output: size, ownColors: z.number().int().min(2).max(255).exactOptional(), ...prompts }),
});

export type ImageStyle = z.infer<typeof styleSchema>;

export function stylePath(root: RepoRoot = REPO_ROOT): string {
  return join(rootDir(root), 'content', 'images', 'style.yaml');
}

/** Load and check the style, including that every render (output × cell) is a multiple of 64 for SDXL. */
export function loadImageStyle(root: RepoRoot = REPO_ROOT): ImageStyle {
  const label = 'content/images/style.yaml';
  const result = styleSchema.safeParse(readYaml(stylePath(root), label));
  if (!result.success) throw issuesFailure(label, toSchemaIssues(result.error));
  const style = result.data;
  const renders: Array<[string, Size]> = [
    ...(['tall', 'square', 'wide'] as const).map((r): [string, Size] => [`painted.portrait.renders.${r}`, style.painted.portrait.renders[r]]),
    ['painted.cover.render', style.painted.cover.render],
  ];
  const outputs: Array<[string, Size, number]> = [
    ...renders.map(([path, s]): [string, Size, number] => [path, s, 1]),
    ...CREATURE_SIZES.map((s): [string, Size, number] => [`portrait.sizes.${s}`, style.portrait.sizes[s], style.portrait.sizes[s].cell ?? style.pixelate.cell]),
    ['cover.output', style.cover.output, style.pixelate.cell],
  ];
  const problems = outputs
    .filter(([, { width, height }, cell]) => (width * cell) % 64 !== 0 || (height * cell) % 64 !== 0)
    .map(([path, { width, height }, cell]) =>
      cell === 1
        ? `${label}: ${path}: ${width}×${height} must be multiples of 64`
        : `${label}: ${path}: ${width}×${height} renders at ${width * cell}×${height * cell}, which must be multiples of 64`,
    );
  if (problems.length > 0) throw new ValidationFailure(problems.join('\n'));
  return style;
}

/**
 * What a portrait's canvas and framing depend on: creature size, body plan
 * and, when known, height in feet. Small to Large characters with a height
 * get a canvas sized from it (`stage`); Tiny and Huge keep their size's.
 */
export interface PortraitShape {
  readonly size: CreatureSize;
  readonly plan?: BodyPlan;
  readonly heightFt?: number;
}

type ShapeArg = CreatureSize | PortraitShape;

function shapeOf(arg: ShapeArg): PortraitShape {
  return typeof arg === 'string' ? { size: arg } : arg;
}

const HEIGHT_SIZES: ReadonlyArray<CreatureSize> = ['small', 'medium', 'large'];
const up8 = (n: number): number => Math.ceil(n / 8) * 8;

/**
 * Where a height-based portrait stands: feet showing above the bar (short
 * characters stand on a stool behind it, very tall ones are capped) and the
 * canvas that holds them, headroom on top and `counter` rows behind the bar.
 * Undefined when the canvas comes from the size table instead.
 */
export function stageFit(style: ImageStyle, arg: ShapeArg): { readonly visibleFt: number; readonly card: Size } | undefined {
  const { size, plan = 'humanoid', heightFt } = shapeOf(arg);
  if (heightFt === undefined || !HEIGHT_SIZES.includes(size)) return undefined;
  const { stage } = style;
  const visibleFt = Math.min(stage.maxVisibleFt, Math.max(stage.minVisibleFt, heightFt - stage.barFt));
  const height = up8(visibleFt * stage.pxPerFt + style.portrait.counter + stage.headroom);
  const aspect = style.portrait.bodyPlans[plan].aspect ?? 0.9;
  const width = up8(Math.min(stage.maxWidth, Math.max(stage.minWidth, height * aspect)));
  return { visibleFt, card: { width, height } };
}

/** Normalise an Open5e size ("Large") to a `CreatureSize`, or undefined if it isn't one. */
export function creatureSize(openSize: string): CreatureSize | undefined {
  const lower = openSize.toLowerCase();
  return (CREATURE_SIZES as ReadonlyArray<string>).includes(lower) ? (lower as CreatureSize) : undefined;
}

/** The committed image's size in art pixels. Portraits need the creature size (and height, when known). */
export function outputSize(style: ImageStyle, kind: ImageKind, arg?: ShapeArg): Size {
  if (kind === 'cover') return style.cover.output;
  if (arg === undefined) throw new Error('a portrait needs a creature size');
  const fit = stageFit(style, arg);
  if (fit !== undefined) return fit.card;
  const { width, height } = style.portrait.sizes[shapeOf(arg).size];
  return { width, height };
}

/** How a portrait of this size and body plan must sit on its canvas (./framing.ts). */
export function framingRules(style: ImageStyle, arg: ShapeArg, planArg?: BodyPlan): FramingRules {
  const { size, plan: shapePlan } = shapeOf(arg);
  const plan = planArg ?? shapePlan ?? 'humanoid';
  const entry = style.portrait.sizes[size];
  const pinned = stageFit(style, { ...shapeOf(arg), plan }) !== undefined;
  return {
    reachBottom: !pinned,
    bleed: entry.bleed ?? [],
    counter: entry.counter ?? style.portrait.counter,
    minFooting: entry.minFooting ?? style.portrait.minFooting,
    tolerance: style.portrait.tolerance,
    minMainShare: style.portrait.minMainShare,
    minChroma: style.portrait.minChroma,
    // A size with its own framing (a tankard perch) isn't a waist-up portrait.
    minFill: entry.framing === undefined ? (style.portrait.bodyPlans[plan].minFill ?? 0) : 0,
  };
}

/** Render pixels per art pixel: a size's own cell (Tiny draws on a coarser grid), else pixelate.cell. */
export function cellOf(style: ImageStyle, kind: ImageKind, arg?: ShapeArg): number {
  return (kind === 'portrait' && arg !== undefined ? style.portrait.sizes[shapeOf(arg).size].cell : undefined) ?? style.pixelate.cell;
}

/** Body plans drawn standing upright: a tall canvas and the upright pose. */
const UPRIGHT: ReadonlyArray<BodyPlan> = ['humanoid', 'plant'];

/**
 * The ComfyUI render size. Painted: by pose (upright figures tall, Huge beasts
 * wide, the rest square). Pixel: the output times the pixel cell.
 */
export function renderSize(style: ImageStyle, kind: ImageKind, arg?: ShapeArg): Size {
  if (style.mode === 'painted') {
    if (kind === 'cover') return style.painted.cover.render;
    if (arg === undefined) throw new Error('a portrait needs a creature size');
    const { size, plan = 'humanoid' } = shapeOf(arg);
    const { renders } = style.painted.portrait;
    if (UPRIGHT.includes(plan)) return renders.tall;
    return size === 'huge' || size === 'gargantuan' ? renders.wide : renders.square;
  }
  const { width, height } = outputSize(style, kind, arg);
  const cell = cellOf(style, kind, arg);
  return { width: width * cell, height: height * cell };
}

/** The palette an image of this kind snaps to: the league palette, or 'own' for a background that keeps its colours. */
export function paletteOf(style: ImageStyle, kind: ImageKind = 'portrait'): ReadonlyArray<Rgb> | 'own' {
  return kind === 'cover' && style.cover.ownColors !== undefined ? 'own' : PALETTES[style.palette];
}

/**
 * The full positive prompt for one subject. Portraits get their body plan's
 * anchor, and its framing unless the size has its own (a Tiny flagon). A
 * height-based humanoid is framed by how much of them shows above the bar:
 * chest-up for a dwarf on a stool, waist-up for a person, thigh-up for an ogre.
 */
export function positivePrompt(style: ImageStyle, kind: ImageKind, subject: string, arg?: ShapeArg, planArg?: BodyPlan): string {
  if (style.mode === 'painted') return paintedPositive(style, kind, subject, arg, planArg);
  const filled = style[kind].positive.replace(SUBJECT, subject.trim().replace(/\.$/, ''));
  if (kind === 'cover') return filled;
  if (arg === undefined) throw new Error('a portrait needs a creature size');
  const shape = shapeOf(arg);
  const plan = planArg ?? shape.plan ?? 'humanoid';
  const { anchor, framing } = style.portrait.bodyPlans[plan];
  let text = style.portrait.sizes[shape.size].framing ?? framing;
  const fit = stageFit(style, { ...shape, plan });
  if (fit !== undefined && plan === 'humanoid') {
    // Share of the body inside the card: what shows above the bar plus the hidden counter rows, over real height.
    const shown = (fit.visibleFt + style.portrait.counter / style.stage.pxPerFt) / shape.heightFt!;
    text = (style.stage.framing.find((band) => shown <= band.upTo) ?? style.stage.framing.at(-1)!).text;
  }
  return filled.replace(ANCHOR, anchor.trim()).replace(FRAMING, text.trim());
}

/**
 * Painted: the body plan's anchor and the pose for it (the whole figure,
 * so the stage can scale it to height). No size framing: a Tiny creature is
 * drawn whole and placed on the bar by the stage, not perched in the picture.
 */
function paintedPositive(style: ImageStyle, kind: ImageKind, subject: string, arg?: ShapeArg, planArg?: BodyPlan): string {
  const { portrait, cover } = style.painted;
  const clean = subject.trim().replace(/\.$/, '');
  if (kind === 'cover') return cover.positive.replace(SUBJECT, clean);
  if (arg === undefined) throw new Error('a portrait needs a creature size');
  const plan = planArg ?? shapeOf(arg).plan ?? 'humanoid';
  const pose = portrait.poses[plan] ?? portrait.poses.default;
  return portrait.positive.replace(ANCHOR, style.portrait.bodyPlans[plan].anchor.trim()).replace(POSE, pose.trim()).replace(SUBJECT, clean);
}

/**
 * The negative prompt, plus the body plan's own for portraits. Painted
 * portraits also push back the style's drift (green orcs) unless the subject
 * asks for it.
 */
export function negativePrompt(style: ImageStyle, kind: ImageKind, plan: BodyPlan = 'humanoid', subject = ''): string {
  const base = style.mode === 'painted' ? style.painted[kind].negative : style[kind].negative;
  const extras = kind === 'portrait' ? [style.portrait.bodyPlans[plan].negative] : [];
  if (style.mode === 'painted' && kind === 'portrait') {
    const { words, negative } = style.painted.portrait.drift;
    const lower = subject.toLowerCase();
    if (!words.some((word) => lower.includes(word.toLowerCase()))) extras.push(negative);
  }
  return [base, ...extras.filter((e): e is string => e !== undefined).map((e) => e.trim())].join(', ');
}

export function pixelateOptions(style: ImageStyle, kind: ImageKind, translucent = false, arg?: ShapeArg): PixelateOptions {
  const own = kind === 'cover' ? style.cover.ownColors : undefined;
  // A height-based portrait pins the top of the head `headroom` rows down, so heads land at the right height.
  const pinned = kind === 'portrait' && arg !== undefined && stageFit(style, arg) !== undefined;
  return {
    ...style.pixelate,
    cell: cellOf(style, kind, arg),
    ...(own === undefined ? {} : { colorGroups: own }),
    ...(kind === 'portrait' && style.portrait.outline ? { outline: true } : {}),
    palette: paletteOf(style, kind),
    cutout: style[kind].cutout,
    anchorBottom: kind === 'portrait',
    ...(pinned ? { anchorTop: style.stage.headroom } : {}),
    ...(kind === 'portrait' && style.portrait.grade !== undefined ? { grade: style.portrait.grade } : {}),
    ...(kind === 'portrait' && translucent ? { glass: style.portrait.glass } : {}),
  };
}

/** The one partial opacity a translucent portrait may use. */
export function glassAlpha(style: ImageStyle, kind: ImageKind, translucent = false): number | undefined {
  return kind === 'portrait' && translucent ? style.portrait.glass.alpha : undefined;
}

/** Painted mode: how a render becomes the stored original (./paint.ts). */
export function paintOptions(style: ImageStyle, kind: ImageKind, translucent = false): PaintOptions {
  if (kind === 'cover') return { kind };
  const { alpha, minLightness, maxChroma } = style.portrait.glass;
  return { kind, ...(translucent ? { glass: { alpha, minLightness, maxChroma } } : {}) };
}

/**
 * Post-processing options for one of the style's views of a painted portrait
 * drawn `shownFt` tall on the stage (./postprocess.ts).
 */
export function pixelViewOptions(style: ImageStyle, name: string, shownFt: number, translucent = false): PixelViewOptions {
  const view = style.painted.views[name];
  if (view === undefined) throw new Error(`no view ${JSON.stringify(name)} in the style (has ${Object.keys(style.painted.views).join(', ')})`);
  return {
    heightPx: shownFt * view.pxPerFt,
    palette: view.colors === 'palette' ? PALETTES[style.palette] : 'own',
    colorGroups: view.colors === 'palette' ? style.pixelate.colorGroups : view.colors,
    chromaWeight: style.pixelate.chromaWeight,
    outline: view.outline,
    ...(style.portrait.grade === undefined ? {} : { grade: style.portrait.grade }),
    ...(translucent ? { glass: style.portrait.glass } : {}),
  };
}

/** Painted mode: the checks a portrait render must pass to be scaled onto the stage (./paint.ts). */
export function paintedRules(style: ImageStyle): PaintedRules {
  const { tolerance, minFill } = style.painted.portrait;
  return { tolerance, minFill, minMainShare: style.portrait.minMainShare, minChroma: style.portrait.minChroma };
}
