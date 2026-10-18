/**
 * A tavern's banner: the colours it flies in the playground and the Common
 * Room. Chrome only: it never reaches the engine. Authored per tavern in a
 * season's taverns.yaml.
 */
import { z } from 'zod';
import type { AssertTrue, SchemaMatches } from '@league-of-taverns/engine';

/**
 * The closed set of banner textures. Each is a pattern drawn in CSS with the
 * banner's own colours (sims/src/playground/page.html § Banners), so a new
 * tavern picks one and needs no new art or CSS.
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
  /** Strong, chart-safe colour, `#rrggbb`, distinct from every other tavern's in a season. */
  readonly mark: string;
  readonly texture: BannerTexture;
}

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

/** A banner as authored in taverns.yaml. */
export const bannerSchema = z.strictObject({
  field: pale,
  charge: pale,
  mark: hex,
  texture: z.enum(BANNER_TEXTURES),
});

// Compile-time drift guard: the schema accepts exactly the declared shape.
type _BannerMatches = AssertTrue<SchemaMatches<z.infer<typeof bannerSchema>, Banner>>;
