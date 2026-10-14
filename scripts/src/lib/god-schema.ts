/**
 * Schema for gods/<id>/god.yaml (docs/schema.md § God).
 *
 * A god's file is chrome only. Which tavern a god blesses and which week it
 * sets are mechanical and live in the season's schedule.yaml (D-52), so
 * nothing here ever reaches the engine.
 */
import { kebabIdSchema } from '@league-of-taverns/engine';
import { z } from 'zod';
import type { AssertTrue, SchemaMatches } from '@league-of-taverns/engine';

/**
 * The closed set of banner textures. Each is a pattern drawn in CSS with the
 * banner's own colours (sims/src/playground/page.html § Banners), so a new god
 * picks one and needs no new art or CSS.
 */
export const BANNER_TEXTURES = ['rain', 'waves', 'thorns', 'stipple', 'crosshatch', 'rays'] as const;
export type BannerTexture = (typeof BANNER_TEXTURES)[number];

/**
 * The colours a tavern fights under. `field` and `charge` are pale fills
 * (the banner's ground and its pattern); they never carry text. `mark` is the
 * tavern's strong colour: its swatch, chart line and row edge, and the base
 * for banner text. Pass and fail keep their own colours: a banner never
 * stands in for them.
 */
export interface Banner {
  /** Pale ground, `#rrggbb`. */
  readonly field: string;
  /** Pale accent the texture is drawn in, `#rrggbb`. */
  readonly charge: string;
  /** Strong, chart-safe colour, `#rrggbb`, distinct from every other god's in a season. */
  readonly mark: string;
  readonly texture: BannerTexture;
}

/** Cosmetic layer: never affects the game. */
export interface GodChrome {
  /** e.g. "The Storm Crow". */
  readonly name: string;
  /** What the god says when a barkeep takes its tavern, e.g. "You fight under the banner of the Storm Crow!" */
  readonly call?: string;
  readonly banner: Banner;
}

/** The whole file as authored. */
export interface GodFile {
  /** kebab-case, equal to the folder name and to the `god` in schedule.yaml. */
  readonly id: string;
  readonly chrome: GodChrome;
}

const text = z.string().min(1);
const hex = z.string().regex(/^#[0-9a-f]{6}$/, 'expected a lowercase colour like "#cfe3f5"');

/** WCAG relative luminance of `#rrggbb`, 0 (black) to 1 (white). */
export function luminance(color: string): number {
  const channel = (i: number): number => {
    const c = Number.parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Field and charge are fills behind dark text in the light theme, so they must be pale. */
export const PALE_LUMINANCE = 0.6;
const pale = hex.refine((c) => luminance(c) >= PALE_LUMINANCE, {
  message: `too dark for a banner fill: use a pale colour (relative luminance at least ${PALE_LUMINANCE})`,
});

const bannerSchema = z.strictObject({
  field: pale,
  charge: pale,
  mark: hex,
  texture: z.enum(BANNER_TEXTURES),
});

/** Validates a parsed god.yaml. Unknown keys are errors, so typos surface. */
export const godFileSchema = z.strictObject({
  id: kebabIdSchema,
  chrome: z.strictObject({
    name: text,
    call: text.exactOptional(),
    banner: bannerSchema,
  }),
});

// Compile-time drift guard: the schema accepts exactly the declared shape.
type _FileMatches = AssertTrue<SchemaMatches<z.infer<typeof godFileSchema>, GodFile>>;
