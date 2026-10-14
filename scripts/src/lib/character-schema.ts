/**
 * Schema for characters/<id>/character.yaml (docs/schema.md § Character).
 *
 * Lives in scripts/ because the file carries chrome, and the engine never
 * reads chrome. Only `id` and `base` cross into the engine, via
 * `loadCharacterRef` in ./repo.ts.
 */
import { kebabIdSchema } from '@league-of-taverns/engine';
import { z } from 'zod';
import { BODY_PLANS } from './images/body-plans';
import type { BodyPlan } from './images/body-plans';
import type { FaceWindow } from './images/face';
import type { AssertTrue, SchemaMatches } from '@league-of-taverns/engine';

export type CharacterStatus = 'active' | 'retired';
export type PortraitStatus = 'none' | 'prompt' | 'draft' | 'final';

/** Cosmetic layer: never affects the game, persists across seasons. */
export interface CharacterChrome {
  readonly name: string;
  readonly epithet?: string;
  readonly pronouns?: { readonly subject: string; readonly object: string; readonly possessive: string };
  readonly tagline?: string;
  /** Standing height in feet. Places the portrait at the bar (docs/images.md § Heights). */
  readonly height?: number;
  /** Path relative to the character's folder, e.g. `backstory.md`. */
  readonly backstory?: string;
  readonly portrait?: {
    readonly status: PortraitStatus;
    /** The subject only (who, wearing what, expression); content/images/style.yaml adds the style. */
    readonly prompt?: string;
    /** The accepted image, relative to the character's folder: `portrait.png` (D-10). */
    readonly path?: string;
    /** ComfyUI seed of the accepted image, so it can be re-rendered. */
    readonly seed?: number;
    /** What shape the character is, for framing (docs/images.md). Default humanoid. */
    readonly bodyPlan?: BodyPlan;
    /** See-through body (an ice-clear gelatinous cube): pale parts become glass. */
    readonly translucent?: boolean;
    /** The outside image an accepted portrait was imported from, instead of a ComfyUI seed. */
    readonly imported?: string;
    /**
     * Where the card's face crop sits, as fractions of the portrait: left, top and width (the height follows the
     * card's aspect). Only for portraits the default head-and-shoulders crop misses (./images/face.ts).
     */
    readonly face?: FaceWindow;
  };
  readonly history?: ReadonlyArray<string>;
}

/** The whole file as authored. */
export interface CharacterFile {
  /** kebab-case, equal to the folder name, never reused. */
  readonly id: string;
  /** Open5e slug, resolved against each season's pinned snapshot. */
  readonly base: string;
  readonly status: CharacterStatus;
  /** Season id the character first appeared in. */
  readonly debut?: string;
  readonly chrome: CharacterChrome;
}

const text = z.string().min(1);
const fraction = z.number().min(0).lt(1);

const chromeSchema = z.strictObject({
  name: text,
  epithet: text.exactOptional(),
  pronouns: z.strictObject({ subject: text, object: text, possessive: text }).exactOptional(),
  tagline: text.exactOptional(),
  height: z.number().positive().max(100).exactOptional(),
  backstory: text.exactOptional(),
  portrait: z
    .strictObject({
      status: z.enum(['none', 'prompt', 'draft', 'final']),
      prompt: text.exactOptional(),
      path: text.exactOptional(),
      seed: z.number().int().nonnegative().exactOptional(),
      bodyPlan: z.enum(BODY_PLANS).exactOptional(),
      translucent: z.boolean().exactOptional(),
      imported: text.exactOptional(),
      face: z
        .strictObject({ x: fraction, y: fraction, width: z.number().gt(0).max(1) })
        .refine((f) => f.x + f.width <= 1, { message: 'x + width must be at most 1 (the window must fit in the portrait)' })
        .exactOptional(),
    })
    .exactOptional(),
  history: z.array(z.string()).exactOptional(),
});

/** Validates a parsed character.yaml. Unknown keys are errors, so typos surface. */
export const characterFileSchema = z.strictObject({
  id: kebabIdSchema,
  base: text,
  status: z.enum(['active', 'retired']),
  debut: kebabIdSchema.exactOptional(),
  chrome: chromeSchema,
});

// Compile-time drift guard: the schema accepts exactly the declared shape.
type _FileMatches = AssertTrue<SchemaMatches<z.infer<typeof characterFileSchema>, CharacterFile>>;
