/**
 * Schema for characters/<id>/character.yaml (docs/schema.md § Character).
 *
 * Lives in scripts/ because the file carries chrome, and the engine never
 * reads chrome. Only `id` and `base` cross into the engine, via
 * `loadCharacterRef` in ./repo.ts.
 */
import { kebabIdSchema, z } from '@league-of-taverns/engine';
import type { AssertTrue, SchemaMatches } from '@league-of-taverns/engine';

export type CharacterStatus = 'active' | 'retired';
export type PortraitStatus = 'none' | 'prompt' | 'draft' | 'final';

/** Cosmetic layer: never affects the game, persists across seasons. */
export interface CharacterChrome {
  readonly name: string;
  readonly epithet?: string;
  readonly pronouns?: { readonly subject: string; readonly object: string; readonly possessive: string };
  readonly tagline?: string;
  /** Path relative to the character's folder, e.g. `backstory.md`. */
  readonly backstory?: string;
  readonly portrait?: {
    readonly status: PortraitStatus;
    readonly prompt?: string;
    /** Storage location, once decided (docs/decisions.md D-10). */
    readonly path?: string;
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

const chromeSchema = z.strictObject({
  name: text,
  epithet: text.exactOptional(),
  pronouns: z.strictObject({ subject: text, object: text, possessive: text }).exactOptional(),
  tagline: text.exactOptional(),
  backstory: text.exactOptional(),
  portrait: z
    .strictObject({
      status: z.enum(['none', 'prompt', 'draft', 'final']),
      prompt: text.exactOptional(),
      path: text.exactOptional(),
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
