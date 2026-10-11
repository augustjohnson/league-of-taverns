/**
 * content/images/style.yaml: the fixed style every generated image shares.
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
import type { PixelateOptions } from './pixelate';

export const IMAGE_KINDS = ['portrait', 'cover'] as const;
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
const once = (token: string) => (s: string) => s.split(token).length === 2;

const text = z.string().min(1);
const size = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });

const prompts = {
  cutout: z.boolean(),
  positive: text.refine(once(SUBJECT), `must contain ${SUBJECT} exactly once`),
  negative: text,
};

const bodyPlan = z.strictObject({ anchor: text, framing: text, negative: text.exactOptional() });

const portraitSize = size.extend({
  bleed: z.array(z.enum(EDGES)).exactOptional(),
  minFooting: z.number().min(0).max(1).exactOptional(),
  counter: z.number().int().nonnegative().exactOptional(),
  framing: text.exactOptional(),
});

const styleSchema = z.strictObject({
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
    glass: z.strictObject({
      alpha: z.number().int().min(1).max(254),
      maxDistance: z.number().nonnegative(),
      minLightness: z.number().min(0).max(1),
      maxChroma: z.number().nonnegative(),
    }),
    minFooting: z.number().min(0).max(1),
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
  cover: z.strictObject({ output: size, ...prompts }),
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
  const { cell } = style.pixelate;
  const outputs: Array<[string, Size]> = [
    ...CREATURE_SIZES.map((s): [string, Size] => [`portrait.sizes.${s}`, style.portrait.sizes[s]]),
    ['cover.output', style.cover.output],
  ];
  const problems = outputs
    .filter(([, { width, height }]) => (width * cell) % 64 !== 0 || (height * cell) % 64 !== 0)
    .map(([path, { width, height }]) => `${label}: ${path}: ${width}×${height} renders at ${width * cell}×${height * cell}, which must be multiples of 64`);
  if (problems.length > 0) throw new ValidationFailure(problems.join('\n'));
  return style;
}

/** Normalise an Open5e size ("Large") to a `CreatureSize`, or undefined if it isn't one. */
export function creatureSize(openSize: string): CreatureSize | undefined {
  const lower = openSize.toLowerCase();
  return (CREATURE_SIZES as ReadonlyArray<string>).includes(lower) ? (lower as CreatureSize) : undefined;
}

/** The committed image's size in art pixels. Portraits need the creature size. */
export function outputSize(style: ImageStyle, kind: ImageKind, size?: CreatureSize): Size {
  if (kind === 'cover') return style.cover.output;
  if (size === undefined) throw new Error('a portrait needs a creature size');
  const { width, height } = style.portrait.sizes[size];
  return { width, height };
}

/** How a portrait of this size must sit on its canvas (./framing.ts). */
export function framingRules(style: ImageStyle, size: CreatureSize): FramingRules {
  const entry = style.portrait.sizes[size];
  return {
    bleed: entry.bleed ?? [],
    counter: entry.counter ?? style.portrait.counter,
    minFooting: entry.minFooting ?? style.portrait.minFooting,
    tolerance: style.portrait.tolerance,
  };
}

/** The ComfyUI render size: the output times the pixel cell. */
export function renderSize(style: ImageStyle, kind: ImageKind, size?: CreatureSize): Size {
  const { width, height } = outputSize(style, kind, size);
  return { width: width * style.pixelate.cell, height: height * style.pixelate.cell };
}

export function paletteOf(style: ImageStyle): ReadonlyArray<Rgb> {
  return PALETTES[style.palette];
}

/**
 * The full positive prompt for one subject. Portraits get their body plan's
 * anchor, and its framing unless the size has its own (a Tiny flagon).
 */
export function positivePrompt(style: ImageStyle, kind: ImageKind, subject: string, size?: CreatureSize, plan: BodyPlan = 'humanoid'): string {
  const filled = style[kind].positive.replace(SUBJECT, subject.trim().replace(/\.$/, ''));
  if (kind === 'cover') return filled;
  if (size === undefined) throw new Error('a portrait needs a creature size');
  const { anchor, framing } = style.portrait.bodyPlans[plan];
  return filled.replace(ANCHOR, anchor.trim()).replace(FRAMING, (style.portrait.sizes[size].framing ?? framing).trim());
}

/** The negative prompt, plus the body plan's own for portraits. */
export function negativePrompt(style: ImageStyle, kind: ImageKind, plan: BodyPlan = 'humanoid'): string {
  const extra = kind === 'portrait' ? style.portrait.bodyPlans[plan].negative : undefined;
  return extra === undefined ? style[kind].negative : `${style[kind].negative}, ${extra.trim()}`;
}

export function pixelateOptions(style: ImageStyle, kind: ImageKind, translucent = false): PixelateOptions {
  return {
    ...style.pixelate,
    palette: paletteOf(style),
    cutout: style[kind].cutout,
    anchorBottom: kind === 'portrait',
    ...(kind === 'portrait' && translucent ? { glass: style.portrait.glass } : {}),
  };
}

/** The one partial opacity a translucent portrait may use. */
export function glassAlpha(style: ImageStyle, kind: ImageKind, translucent = false): number | undefined {
  return kind === 'portrait' && translucent ? style.portrait.glass.alpha : undefined;
}
