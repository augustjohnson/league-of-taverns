/**
 * content/images/style.yaml: the fixed style every generated image shares.
 */
import { join } from 'node:path';
import { toSchemaIssues } from '@league-of-taverns/engine';
import { z } from 'zod';
import { ValidationFailure } from '../main';
import { REPO_ROOT, issuesFailure, readYaml, rootDir } from '../repo';
import type { RepoRoot } from '../repo';
import { PALETTES } from './palette';
import type { PaletteName, Rgb } from './palette';
import type { PixelateOptions } from './pixelate';

export const IMAGE_KINDS = ['portrait', 'cover'] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

const SUBJECT = '{{subject}}';

const text = z.string().min(1);
const size = z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive() });

const kindSchema = z.strictObject({
  render: size,
  output: size,
  cutout: z.boolean(),
  positive: text.refine((s) => s.split(SUBJECT).length === 2, `must contain ${SUBJECT} exactly once`),
  negative: text,
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
  portrait: kindSchema,
  cover: kindSchema,
});

export type ImageStyle = z.infer<typeof styleSchema>;
export type KindStyle = ImageStyle[ImageKind];

export function stylePath(root: RepoRoot = REPO_ROOT): string {
  return join(rootDir(root), 'content', 'images', 'style.yaml');
}

/** Load and check the style, including that each render divides into its output on the pixel grid. */
export function loadImageStyle(root: RepoRoot = REPO_ROOT): ImageStyle {
  const label = 'content/images/style.yaml';
  const result = styleSchema.safeParse(readYaml(stylePath(root), label));
  if (!result.success) {
    throw issuesFailure(label, toSchemaIssues(result.error));
  }
  const style = result.data;
  const { cell } = style.pixelate;
  const problems = IMAGE_KINDS.flatMap((kind) => {
    const { render, output } = style[kind];
    return render.width === output.width * cell && render.height === output.height * cell
      ? []
      : [`${label}: ${kind}: render ${render.width}×${render.height} must be output ${output.width}×${output.height} times the ${cell}-pixel cell`];
  });
  if (problems.length > 0) throw new ValidationFailure(problems.join('\n'));
  return style;
}

export function paletteOf(style: ImageStyle): ReadonlyArray<Rgb> {
  return PALETTES[style.palette];
}

/** The full positive prompt for one subject. */
export function positivePrompt(kind: KindStyle, subject: string): string {
  return kind.positive.replace(SUBJECT, subject.trim().replace(/\.$/, ''));
}

export function pixelateOptions(style: ImageStyle, kind: ImageKind): PixelateOptions {
  return {
    ...style.pixelate,
    palette: paletteOf(style),
    cutout: style[kind].cutout,
    anchorBottom: kind === 'portrait',
  };
}
