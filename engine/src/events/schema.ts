/**
 * Runtime schemas for the event log (T2.3): the envelope, every payload in
 * `PayloadByType`, and the engine types payloads embed (`SeasonConfig`,
 * `Mission`, `RunResult`, `Lineup`, `Modifier`).
 *
 * Shape only. Whether an event is legal against league state is the reducers'
 * job (T2.4). Compile-time checks below keep each schema and its TypeScript
 * type from drifting apart.
 */
import { z } from 'zod';
import type { Modifier } from '../characters';
import type { SeasonConfig } from '../league';
import { checkTargetSchema, kebabIdSchema, missionSchema } from '../missions/schema';
import type { AssertTrue, SchemaMatches } from '../missions/schema';
import type { RunResult } from '../resolution';
import type { Lineup } from '../roster';
import { ABILITIES, SENSES, SKILLS, SPEEDS } from '../vocabulary';
import type { CrEighths } from '../vocabulary';
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

const week = z.number().int().positive();
const text = z.string().min(1);
const githubId = z.number().int().positive();
const probability = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// Embedded engine types

/** A pooled character's modifier: a registry primitive or a named trait. Ranges and budget are T3.2's. */
export const modifierSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill_bonus'), skill: z.enum(SKILLS), value: z.number().int() }),
  z.strictObject({ kind: z.literal('save_bonus'), ability: z.enum(ABILITIES), value: z.number().int() }),
  z.strictObject({ kind: z.literal('advantage'), on: checkTargetSchema }),
  z.strictObject({ kind: z.literal('grant_speed'), speed: z.enum(SPEEDS), feet: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('grant_sense'), sense: z.enum(SENSES), feet: z.number().int().positive() }),
  z.strictObject({ kind: z.literal('battle_bonus'), value: z.number().int() }),
  z.strictObject({ kind: z.literal('trait'), trait: kebabIdSchema }),
]);

/** `never`, `avoid_battles`, or `{ bank: N }` (D-49). */
export const retreatOrderSchema = z.union([
  z.literal('never'),
  z.literal('avoid_battles'),
  z.strictObject({ bank: z.number().int().nonnegative() }),
]);

/** Exactly four starters and a retreat order (D-12, D-49). Legality against a roster is T4.2's. */
export const lineupSchema = z.strictObject({
  starters: z.tuple([kebabIdSchema, kebabIdSchema, kebabIdSchema, kebabIdSchema]),
  retreat: retreatOrderSchema,
});

const nodeRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    node: kebabIdSchema,
    kind: z.literal('check'),
    actor: kebabIdSchema,
    d20: z.number().int().min(1).max(20),
    modifier: z.number().int(),
    dc: z.number().int(),
    advantage: z.boolean(),
    outcome: z.enum(['pass', 'fail']),
  }),
  z.strictObject({
    node: kebabIdSchema,
    kind: z.literal('battle'),
    pWin: probability,
    roll: z.number(),
    outcome: z.enum(['win', 'lose']),
  }),
]);

/** The single seeded run, as recorded in `mission.resolved`. */
export const runResultSchema = z.strictObject({
  path: z.array(kebabIdSchema),
  nodes: z.array(nodeRecordSchema),
  dnf: z.boolean(),
  retreatedBefore: kebabIdSchema.nullable(),
  checksPassed: z.number().int().nonnegative(),
  checksAttempted: z.number().int().nonnegative(),
  loot: z.number().int().nonnegative(),
  score: probability,
  injury: z.strictObject({ character: kebabIdSchema, roll: z.number().min(0).lt(1) }).nullable(),
});

const minMax = z.strictObject({ min: z.number().int(), max: z.number().int() });

/** The normalized season config the engine receives (CR already in eighths). */
export const seasonConfigSchema = z.strictObject({
  id: kebabIdSchema,
  snapshot: text,
  modifierRegistryVersion: z.number().int().positive(),
  weeks: week,
  budget: z.strictObject({
    partyCr: crEighthsSchema,
    modifierPointsPerCharacter: z.number().int().nonnegative(),
  }),
  roster: z.strictObject({
    size: z.number().int().positive(),
    starters: z.literal(4),
    ownership: z.enum(['exclusive', 'shared']),
  }),
  draft: z.strictObject({
    format: z.literal('snake'),
    rounds: z.number().int().positive(),
    order: z.discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('seeded') }),
      z.strictObject({ mode: z.literal('manual'), managers: z.array(kebabIdSchema) }),
    ]),
    pickWindowHours: z.number().positive(),
    onTimeout: z.enum(['autopick', 'skip', 'wait']),
  }),
  scoring: z.strictObject({
    pointsScale: z.number().positive(),
    homeBonus: z.number().positive(),
  }),
  waivers: z.strictObject({ priority: z.enum(['rolling', 'reverse_standings']), initialOrder: z.literal('reverse_draft') }),
  trades: z.strictObject({
    vetoWindowHours: z.number().nonnegative(),
    vetoBy: z.literal('commissioner'),
    deadlineWeek: week.nullable(),
  }),
  missedLineup: z.literal('carry_over'),
  schedules: z.strictObject({ lineupLock: text, weeklyRun: text, waivers: text }),
  secrecy: z.enum(['open', 'private_repo', 'commit_reveal', 'encrypted']),
  seedSalt: z.enum(['none', 'revealed_with_mission']),
  missions: z.strictObject({
    dcBand: minMax,
    maxNodes: z.number().int().positive(),
    maxRank: z.number().int().nonnegative(),
    battlesPerPath: minMax,
    encounterCrRatio: z.number().positive(),
    haul: z.number().int().positive(),
    battleModel: text,
  }),
  carryover: z.strictObject({
    mode: z.enum(['none', 'keeper']),
    keepersPerTavern: z.number().int().nonnegative(),
    keeperCost: z.enum(['none', 'round_of_last_season_pick', 'fixed_round']),
    championBonusKeepers: z.number().int().nonnegative(),
    maxModifierChangePoints: z.number().int().nonnegative(),
  }),
});

// ---------------------------------------------------------------------------
// Payloads

/** One payload schema per event type. `satisfies` rejects a missing or extra type. */
export const payloadSchemas = {
  'season.created': z.strictObject({
    config: seasonConfigSchema,
    configSha256: sha256HexSchema,
    engineVersion: text,
    schedule: z.array(
      z.strictObject({
        week,
        title: text,
        environment: text,
        theme: z.string(),
        commitment: sha256HexSchema.nullable(),
        sponsor: kebabIdSchema.nullable(),
      }),
    ),
    sponsors: z.array(z.strictObject({ id: kebabIdSchema, tavern: kebabIdSchema })),
    taverns: z.array(z.strictObject({ id: kebabIdSchema, name: text })),
  }),
  'character.pooled': z.strictObject({
    character: kebabIdSchema,
    base: text,
    cr: crEighthsSchema,
    modifiers: z.array(modifierSchema),
  }),
  'manager.joined': z.strictObject({
    manager: kebabIdSchema,
    account: z.union([z.strictObject({ githubId, login: text }), z.strictObject({ bot: text })]),
  }),
  'tavern.chosen': z.strictObject({ manager: kebabIdSchema, tavern: kebabIdSchema }),
  'character.retained': z.strictObject({
    tavern: kebabIdSchema,
    character: kebabIdSchema,
    fromSeason: kebabIdSchema,
    basis: z.enum(['keeper', 'champion_reward']),
    costRound: z.number().int().nonnegative().nullable(),
  }),
  'draft.pick': z.strictObject({
    pick: z.number().int().nonnegative(),
    tavern: kebabIdSchema,
    character: kebabIdSchema,
    auto: z.boolean(),
  }),
  'lineup.set': z.strictObject({ tavern: kebabIdSchema, week, lineup: lineupSchema }),
  'lineup.locked': z.strictObject({
    week,
    lineups: z.array(
      z.strictObject({
        tavern: kebabIdSchema,
        lineup: lineupSchema.nullable(),
        source: z.enum(['submitted', 'carried', 'fallback', 'none']),
      }),
    ),
  }),
  'waiver.claimed': z.strictObject({
    claim: text,
    tavern: kebabIdSchema,
    add: kebabIdSchema,
    drop: kebabIdSchema.nullable(),
  }),
  'waiver.resolved': z.strictObject({
    week,
    outcomes: z.array(z.strictObject({ claim: text, awarded: z.boolean(), reason: z.string() })),
    priorityAfter: z.array(kebabIdSchema),
  }),
  'trade.proposed': z.strictObject({
    trade: text,
    from: kebabIdSchema,
    to: kebabIdSchema,
    give: z.array(kebabIdSchema),
    receive: z.array(kebabIdSchema),
  }),
  'trade.accepted': z.strictObject({ trade: text }),
  'trade.vetoed': z.strictObject({ trade: text, reason: z.string() }),
  'trade.completed': z.strictObject({ trade: text }),
  'trade.cancelled': z.strictObject({ trade: text, reason: z.enum(['declined', 'withdrawn', 'expired', 'invalid']) }),
  'mission.revealed': z.strictObject({
    week,
    mission: missionSchema,
    sha256: sha256HexSchema,
    salt: z.string().nullable(),
  }),
  'mission.resolved': z.strictObject({
    week,
    tavern: kebabIdSchema,
    mission: kebabIdSchema,
    seed: text,
    engineVersion: text,
    battleModel: text,
    lineup: lineupSchema,
    run: runResultSchema,
    projected: z.strictObject({ expectedScore: probability, pDnf: probability }),
    /** round(score × pointsScale). */
    points: z.number().int().nonnegative(),
    projectedPoints: z.number().nonnegative(),
  }),
  'week.finalized': z.strictObject({ week }),
} satisfies { readonly [T in EventType]: z.ZodType };

// ---------------------------------------------------------------------------
// Envelope

const actorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('manager'), githubId, login: text }),
  z.strictObject({ kind: z.literal('commissioner'), githubId, login: text }),
  z.strictObject({ kind: z.literal('system'), workflow: text }),
  z.strictObject({ kind: z.literal('bot'), strategy: text }),
]);

const positiveInt = z.number().int().positive();

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
  envelope('character.retained'),
  envelope('draft.pick'),
  envelope('lineup.set'),
  envelope('lineup.locked'),
  envelope('waiver.claimed'),
  envelope('waiver.resolved'),
  envelope('trade.proposed'),
  envelope('trade.accepted'),
  envelope('trade.vetoed'),
  envelope('trade.completed'),
  envelope('trade.cancelled'),
  envelope('mission.revealed'),
  envelope('mission.resolved'),
  envelope('week.finalized'),
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
type _RunResultMatches = AssertTrue<SchemaMatches<z.infer<typeof runResultSchema>, RunResult>>;
type _LineupMatches = AssertTrue<SchemaMatches<z.infer<typeof lineupSchema>, Lineup>>;
type _ModifierMatches = AssertTrue<SchemaMatches<z.infer<typeof modifierSchema>, Modifier>>;
