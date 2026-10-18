/**
 * Runtime schemas for challenges and voting strategies: shape only. A
 * challenge file's chrome (its title and story) is stripped by the loader
 * before it gets here.
 */
import { z } from 'zod';
import { kebabIdSchema, requirementSchema, toSchemaIssues, type AssertTrue, type ParseResult, type SchemaMatches } from '../schema-kit';
import { ABILITIES, SKILLS } from '../vocabulary';
import type { Challenge, ChallengeCheck, VotingStrategy } from './types';

/** A tag as `<axis>:<value>`, e.g. `type:undead` (cards.ts `cardTags`). */
export const tagSchema = z.string().regex(/^(type|subtype|law|moral|size):[a-z][a-z -]*$/, 'Expected a tag like "type:undead" or "subtype:goblinoid"');

export const votingStrategySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('loyal'), tag: tagSchema }),
  z.strictObject({ kind: z.literal('threat') }),
  z.strictObject({ kind: z.literal('coattails') }),
  z.strictObject({ kind: z.literal('grudge') }),
  z.strictObject({ kind: z.literal('floater') }),
]);

const checkFields = {
  dc: z.number().int().min(1).max(30),
  advantage: requirementSchema.exactOptional(),
  requires: requirementSchema.exactOptional(),
};

export const challengeCheckSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('skill'), skill: z.enum(SKILLS), ...checkFields }),
  z.strictObject({ type: z.literal('save'), ability: z.enum(ABILITIES), ...checkFields }),
  z.strictObject({ type: z.literal('ability'), ability: z.enum(ABILITIES), ...checkFields }),
]);

export const challengeSchema = z.strictObject({
  id: kebabIdSchema,
  checks: z.array(challengeCheckSchema).min(1),
});

type _StrategyMatches = AssertTrue<SchemaMatches<z.infer<typeof votingStrategySchema>, VotingStrategy>>;
type _CheckMatches = AssertTrue<SchemaMatches<z.infer<typeof challengeCheckSchema>, ChallengeCheck>>;
type _ChallengeMatches = AssertTrue<SchemaMatches<z.infer<typeof challengeSchema>, Challenge>>;

/** Check the shape of a parsed challenge (chrome already removed). Reports every field error. */
export function parseChallenge(input: unknown): ParseResult<Challenge> {
  const result = challengeSchema.safeParse(input);
  return result.success ? { ok: true, value: result.data } : { ok: false, issues: toSchemaIssues(result.error) };
}
