/**
 * Shared schema helpers: ids, check targets, requirements, issue formatting,
 * and the compile-time guard that keeps a zod schema and its hand-written
 * type from drifting apart. Used by the contest's challenge schema, the
 * modifier schema and the event schema.
 */
import { z } from 'zod';
import { ABILITIES, SENSES, SKILLS, SPEEDS } from './vocabulary';

/** kebab-case id: lowercase letters and digits joined by single hyphens. */
export const kebabIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Expected a kebab-case id, e.g. "moat-swim"');

/** What a check tests: a skill, a saving throw, or a raw ability check. Shared with modifiers. */
export const checkTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('skill'), skill: z.enum(SKILLS) }),
  z.strictObject({ type: z.literal('save'), ability: z.enum(ABILITIES) }),
  z.strictObject({ type: z.literal('ability'), ability: z.enum(ABILITIES) }),
]);

/** A speed or a sense a contestant has (above 0 feet). */
export const requirementSchema = z.union([z.strictObject({ speed: z.enum(SPEEDS) }), z.strictObject({ sense: z.enum(SENSES) })]);

/**
 * Compile-time drift guard: `Inferred` (a schema's output) and `Declared` (the
 * hand-written readonly type) must be identical once readonly modifiers are
 * stripped (zod infers mutable arrays). Catches missing, extra and retyped
 * fields in either direction.
 */
export type SchemaMatches<Inferred, Declared> = Identical<DeepWritable<Inferred>, DeepWritable<Declared>>;

type Identical<A, B> = (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false;

/** Strips readonly recursively. Primitives (including branded ones like `CrEighths`) pass through. */
type DeepWritable<T> = T extends string | number | boolean | bigint | symbol | null | undefined
  ? T
  : { -readonly [K in keyof T]: DeepWritable<T[K]> };

/** Fails to compile unless its argument is `true`. */
export type AssertTrue<T extends true> = T;

/** One schema violation: a field path such as `checks[2].skill`, and what is wrong there. */
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
  return path.map((key, i) => (typeof key === 'number' ? `[${key}]` : i === 0 ? String(key) : `.${String(key)}`)).join('');
}

/** zod issues → `SchemaIssue`s with readable paths. */
export function toSchemaIssues(error: z.ZodError): ReadonlyArray<SchemaIssue> {
  return error.issues.map((issue) => ({ path: formatIssuePath(issue.path), message: issue.message }));
}
