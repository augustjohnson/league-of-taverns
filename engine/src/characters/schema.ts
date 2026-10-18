/**
 * Runtime schemas (zod, D-22) for authored modifiers and pool entries, so a
 * loader can parse pool.yaml into engine types.
 *
 * These check shape and vocabulary only. Ranges, stacking, trait lookup and
 * cost depend on the registry version, so `validateModifiers` checks those.
 */
import { z } from 'zod';
import { votingStrategySchema } from '../contest/schema';
import { ABILITIES, SENSES, SKILLS, SPEEDS } from '../vocabulary';
import type { CheckTarget, Modifier, ModifierEffect } from './types';

const skill = z.enum(SKILLS);
const ability = z.enum(ABILITIES);

/** What a check tests: `{ type: skill, skill }`, `{ type: save, ability }` or `{ type: ability, ability }`. */
export const CheckTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('skill'), skill }),
  z.strictObject({ type: z.literal('save'), ability }),
  z.strictObject({ type: z.literal('ability'), ability }),
]);

/** A primitive modifier effect. One branch per registry kind. */
export const ModifierEffectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('skill_bonus'), skill, value: z.number().int() }),
  z.strictObject({ kind: z.literal('save_bonus'), ability, value: z.number().int() }),
  z.strictObject({ kind: z.literal('advantage'), on: CheckTargetSchema }),
  z.strictObject({ kind: z.literal('grant_speed'), speed: z.enum(SPEEDS), feet: z.number().int() }),
  z.strictObject({ kind: z.literal('grant_sense'), sense: z.enum(SENSES), feet: z.number().int() }),
]);

/** A modifier as authored in pool.yaml: a primitive effect or `{ kind: trait, trait: <id> }`. */
export const ModifierSchema = z.union([
  ModifierEffectSchema,
  z.strictObject({ kind: z.literal('trait'), trait: z.string().min(1) }),
]);

/** One `characters[]` entry in pool.yaml: the monster, its season modifiers (may be omitted for none) and its voting strategy. */
export const PoolEntrySchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'id must be kebab-case'),
  modifiers: z.array(ModifierSchema).default([]),
  strategy: votingStrategySchema,
});

/** A parsed pool.yaml entry. The loader pairs `id` with the character's base to build a `PooledCharacter`. */
export type PoolEntry = z.infer<typeof PoolEntrySchema>;

// Compile-time check that the schemas and the hand-written types agree in both
// directions. If either side changes alone, typecheck fails here.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _checkTargetMatches: MutuallyAssignable<z.infer<typeof CheckTargetSchema>, CheckTarget> = true;
const _effectMatches: MutuallyAssignable<z.infer<typeof ModifierEffectSchema>, ModifierEffect> = true;
const _modifierMatches: MutuallyAssignable<z.infer<typeof ModifierSchema>, Modifier> = true;
