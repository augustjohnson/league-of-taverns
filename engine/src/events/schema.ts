/**
 * Runtime schemas for the event log: the envelope, every payload in
 * `PayloadByType`, and the engine types payloads embed (`SeasonConfig`,
 * challenges and their results, votes, `Modifier`).
 *
 * Shape only. Whether an event is legal against league state is the
 * reducers' job. Compile-time checks below keep each schema and its
 * TypeScript type from drifting apart.
 */
import { z } from 'zod';
import type { Modifier } from '../characters';
import { challengeSchema, votingStrategySchema } from '../contest/schema';
import { VOTE_MODEL, type VoteModel } from '../contest/model';
import type { ChallengeResult, FinaleResult, VoteResult } from '../contest/types';
import type { SeasonConfig } from '../league';
import { checkTargetSchema, kebabIdSchema, type AssertTrue, type SchemaMatches } from '../schema-kit';
import { ABILITIES, SENSES, SKILLS, SPEEDS } from '../vocabulary';
import type { Ability, CrEighths } from '../vocabulary';
import type { EventType, LeagueEvent, PayloadByType } from './types';

// ---------------------------------------------------------------------------
// Shared building blocks

/** Lowercase sha256 hex digest. */
export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase sha256 hex digest');

/**
 * Exact CR as a non-negative integer count of eighths. The `CrEighths` brand is
 * phantom (a plain number at runtime), so the cast only restores the type.
 */
export const crEighthsSchema = z.number().int().nonnegative() as unknown as z.ZodType<CrEighths, number>;

const text = z.string().min(1);
const githubId = z.number().int().positive();
const positiveInt = z.number().int().positive();
const count = z.number().int().nonnegative();
const unit = z.number().min(0).lt(1);

// ---------------------------------------------------------------------------
// Embedded engine types

/** A pooled character's modifier: a registry primitive or a named trait. Ranges and budget are `validateModifiers`'. */
export const modifierSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill_bonus'), skill: z.enum(SKILLS), value: z.number().int() }),
  z.strictObject({ kind: z.literal('save_bonus'), ability: z.enum(ABILITIES), value: z.number().int() }),
  z.strictObject({ kind: z.literal('advantage'), on: checkTargetSchema }),
  z.strictObject({ kind: z.literal('grant_speed'), speed: z.enum(SPEEDS), feet: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('grant_sense'), sense: z.enum(SENSES), feet: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('trait'), trait: kebabIdSchema }),
]);

/** Every vote-model dial, optional: a season overrides only what it names. */
const voteModelSchema = z.strictObject(
  Object.fromEntries(Object.keys(VOTE_MODEL).map((key) => [key, z.number().exactOptional()])) as {
    [K in keyof VoteModel]: z.ZodExactOptional<z.ZodNumber>;
  },
);

export const seasonConfigSchema = z.strictObject({
  id: kebabIdSchema,
  snapshot: text,
  modifierRegistryVersion: positiveInt,
  budget: z.strictObject({ modifierPointsPerCharacter: count }),
  roster: z.strictObject({ size: positiveInt }),
  draft: z.strictObject({
    format: z.literal('snake'),
    order: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('seeded') }),
      z.strictObject({ mode: z.literal('manual'), managers: z.array(kebabIdSchema).min(1) }),
    ]),
  }),
  contest: z.strictObject({
    castSize: positiveInt,
    finalists: positiveInt,
    lapDc: count,
    model: voteModelSchema,
  }),
  scoring: z.strictObject({
    survive: count,
    immunity: count,
    juryVote: count,
    winner: count,
    call: count,
    earlyCallBonus: count,
  }),
});

const challengeRollSchema = z.strictObject({
  id: kebabIdSchema,
  d20: z.number().int().min(1).max(20),
  modifier: z.number().int(),
  advantage: z.boolean(),
  eligible: z.boolean(),
  pass: z.boolean(),
});

export const challengeResultSchema = z.strictObject({
  rounds: z.array(
    z.strictObject({
      check: count,
      lap: count,
      dc: z.number().int(),
      rolls: z.array(challengeRollSchema).min(1),
      out: z.array(kebabIdSchema),
      replay: z.boolean(),
    }),
  ),
  winner: kebabIdSchema,
});

const ballotSchema = z.strictObject({ voter: kebabIdSchema, target: kebabIdSchema });
const drawSchema = z.strictObject({ tied: z.array(kebabIdSchema).min(2), roll: unit });

export const voteResultSchema = z.strictObject({
  ballots: z.array(ballotSchema).min(1),
  revote: z.strictObject({ tied: z.array(kebabIdSchema).min(2), ballots: z.array(ballotSchema) }).nullable(),
  draw: drawSchema.nullable(),
  boot: kebabIdSchema,
});

export const finaleResultSchema = z.strictObject({
  finalists: z.array(kebabIdSchema).min(1),
  ballots: z.array(z.strictObject({ juror: kebabIdSchema, finalist: kebabIdSchema })),
  draw: drawSchema.nullable(),
  winner: kebabIdSchema,
});

// ---------------------------------------------------------------------------
// Payloads

export const payloadSchemas = {
  'season.created': z.strictObject({
    config: seasonConfigSchema,
    configSha256: sha256HexSchema,
    engineVersion: text,
    taverns: z.array(z.strictObject({ id: kebabIdSchema, name: text })).min(1),
    challenges: z.array(z.strictObject({ episode: positiveInt, sha256: sha256HexSchema })),
    abilityMix: z.strictObject(Object.fromEntries(ABILITIES.map((a) => [a, count])) as Record<Ability, typeof count>),
  }),
  'character.pooled': z.strictObject({
    character: kebabIdSchema,
    base: text,
    cr: crEighthsSchema,
    modifiers: z.array(modifierSchema),
    strategy: votingStrategySchema,
  }),
  'manager.joined': z.strictObject({
    manager: kebabIdSchema,
    account: z.union([z.strictObject({ githubId, login: text }), z.strictObject({ bot: text })]),
  }),
  'tavern.chosen': z.strictObject({ manager: kebabIdSchema, tavern: kebabIdSchema }),
  'draft.pick': z.strictObject({ pick: count, tavern: kebabIdSchema, character: kebabIdSchema, auto: z.boolean() }),
  'call.made': z.strictObject({ episode: positiveInt, tavern: kebabIdSchema, target: kebabIdSchema }),
  'challenge.resolved': z.strictObject({
    episode: positiveInt,
    challenge: challengeSchema,
    sha256: sha256HexSchema,
    seed: text,
    result: challengeResultSchema,
  }),
  'vote.resolved': z.strictObject({ episode: positiveInt, vote: voteResultSchema }),
  'finale.resolved': z.strictObject({ result: finaleResultSchema }),
} as const;

// ---------------------------------------------------------------------------
// The envelope

const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manager'), githubId, login: text }),
  z.strictObject({ kind: z.literal('commissioner'), githubId, login: text }),
  z.strictObject({ kind: z.literal('system'), workflow: text }),
  z.strictObject({ kind: z.literal('bot'), strategy: text }),
]);

const sourceSchema = z.strictObject({
  issue: positiveInt.exactOptional(),
  comment: positiveInt.exactOptional(),
  workflowRun: positiveInt.exactOptional(),
});

const envelopeFields = {
  v: z.literal(1),
  seq: positiveInt,
  season: kebabIdSchema,
  /** ISO-8601 UTC with a `Z` suffix. Checked by pattern only; nothing here reads a clock. */
  at: z.iso.datetime(),
  actor: actorSchema,
  source: sourceSchema.exactOptional(),
  prev: sha256HexSchema.nullable(),
};

function envelope<T extends EventType>(type: T) {
  return z.strictObject({ ...envelopeFields, type: z.literal(type), payload: payloadSchemas[type] });
}

/** One event line: the envelope, discriminated on `type`, with that type's payload. */
export const eventSchema = z.discriminatedUnion('type', [
  envelope('season.created'),
  envelope('character.pooled'),
  envelope('manager.joined'),
  envelope('tavern.chosen'),
  envelope('draft.pick'),
  envelope('call.made'),
  envelope('challenge.resolved'),
  envelope('vote.resolved'),
  envelope('finale.resolved'),
]);

// ---------------------------------------------------------------------------
// Compile-time drift guards. A mismatch fails `tsc` and names the offender.

type AssertNever<T extends never> = T;

type _PayloadMismatches = AssertNever<
  {
    [T in EventType]: SchemaMatches<z.infer<(typeof payloadSchemas)[T]>, PayloadByType[T]> extends true ? never : T;
  }[EventType]
>;
type _EventMatches = AssertTrue<SchemaMatches<z.infer<typeof eventSchema>, LeagueEvent>>;
type _SeasonConfigMatches = AssertTrue<SchemaMatches<z.infer<typeof seasonConfigSchema>, SeasonConfig>>;
type _ChallengeResultMatches = AssertTrue<SchemaMatches<z.infer<typeof challengeResultSchema>, ChallengeResult>>;
type _VoteResultMatches = AssertTrue<SchemaMatches<z.infer<typeof voteResultSchema>, VoteResult>>;
type _FinaleResultMatches = AssertTrue<SchemaMatches<z.infer<typeof finaleResultSchema>, FinaleResult>>;
type _ModifierMatches = AssertTrue<SchemaMatches<z.infer<typeof modifierSchema>, Modifier>>;
