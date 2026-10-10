/**
 * Runtime schema for mission files (T5.1). Shape only: field names, kinds and
 * vocabularies. Graph rules (one start, rank order, reachability, DC band,
 * encounter budget) belong to `validateMission` (T5.2).
 *
 * Missions are open (docs/decisions.md D-08), so there is no canonical form
 * or commitment hash here.
 */
import { z } from 'zod';
import { ABILITIES, SENSES, SKILLS, SPEEDS } from '../vocabulary';
import type { CheckTarget } from '../characters';
import type { Mission } from './types';

/** kebab-case id: lowercase letters and digits joined by single hyphens. */
export const kebabIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a kebab-case id, e.g. "find-path"');

/** What a check tests: a skill, a saving throw, or a raw ability check. Shared with modifiers. */
export const checkTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('skill'), skill: z.enum(SKILLS) }),
  z.strictObject({ type: z.literal('save'), ability: z.enum(ABILITIES) }),
  z.strictObject({ type: z.literal('ability'), ability: z.enum(ABILITIES) }),
]);

const requirementSchema = z.union([
  z.strictObject({ speed: z.enum(SPEEDS) }),
  z.strictObject({ sense: z.enum(SENSES) }),
]);

/** Every check has a DC and an optional party-level gate, whatever it tests. */
const checkFields = {
  dc: z.number().int(),
  requires: requirementSchema.exactOptional(),
};

const checkSpecSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('skill'), skill: z.enum(SKILLS), ...checkFields }),
  z.strictObject({ type: z.literal('save'), ability: z.enum(ABILITIES), ...checkFields }),
  z.strictObject({ type: z.literal('ability'), ability: z.enum(ABILITIES), ...checkFields }),
]);

const nodeFields = {
  id: kebabIdSchema,
  rank: z.number().int().nonnegative(),
};

const encounterSchema = z.strictObject({
  creatures: z
    .array(
      z.strictObject({
        /** Open5e slug. Presence in the pinned snapshot is checked by T5.2. */
        ref: z.string().min(1),
        count: z.number().int().positive(),
      }),
    )
    .min(1),
});

const missionNodeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...nodeFields, kind: z.literal('start') }),
  z.strictObject({ ...nodeFields, kind: z.literal('check'), check: checkSpecSchema }),
  z.strictObject({ ...nodeFields, kind: z.literal('battle'), encounter: encounterSchema }),
  z.strictObject({ ...nodeFields, kind: z.literal('end') }),
]);

const missionEdgeSchema = z.strictObject({
  from: kebabIdSchema,
  to: kebabIdSchema,
  on: z.enum(['always', 'pass', 'fail', 'win']),
});

/** A mission file as authored in seasons/<season>/missions/. */
export const missionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: kebabIdSchema,
  season: kebabIdSchema,
  environment: z.string().min(1),
  nodes: z.array(missionNodeSchema),
  edges: z.array(missionEdgeSchema),
});

/**
 * Compile-time drift guard: `Inferred` (a schema's output) and `Declared` (the
 * hand-written readonly type) must be identical once readonly modifiers are
 * stripped (zod infers mutable arrays). Catches missing, extra and retyped
 * fields in either direction. Shared with events/schema.ts.
 */
export type SchemaMatches<Inferred, Declared> = Identical<DeepWritable<Inferred>, DeepWritable<Declared>>;

type Identical<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/** Strips readonly recursively. Primitives (including branded ones like `CrEighths`) pass through. */
type DeepWritable<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : { -readonly [K in keyof T]: DeepWritable<T[K]> };

/** Fails to compile unless its argument is `true`. */
export type AssertTrue<T extends true> = T;

type _MissionMatches = AssertTrue<SchemaMatches<z.infer<typeof missionSchema>, Mission>>;
type _CheckTargetMatches = AssertTrue<SchemaMatches<z.infer<typeof checkTargetSchema>, CheckTarget>>;

/** One schema violation: a field path such as `nodes[2].check.skill`, and what is wrong there. */
export interface SchemaIssue {
  readonly path: string;
  readonly message: string;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: ReadonlyArray<SchemaIssue> };

/** Format a zod issue path as `a.b[2].c`, or `(root)` when empty. */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  if (path.length === 0) return '(root)';
  return path
    .map((key, i) => (typeof key === 'number' ? `[${key}]` : i === 0 ? String(key) : `.${String(key)}`))
    .join('');
}

/** zod issues → `SchemaIssue`s with readable paths. */
export function toSchemaIssues(error: z.ZodError): ReadonlyArray<SchemaIssue> {
  return error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message }));
}

/** Check the shape of parsed mission YAML or JSON. Reports every field error, not just the first. */
export function parseMission(input: unknown): ParseResult<Mission> {
  const result = missionSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: toSchemaIssues(result.error) };
}
