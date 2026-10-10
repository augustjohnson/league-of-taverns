/**
 * The modifier registry: costs and limits for primitive effects, and the list
 * of named traits. Versioned. A season pins a registry version in config.yaml.
 *
 * Values here are placeholders that show the shape. Real costs come out of
 * balance work in T3.2 and T9.3.
 */
import type { ModifierEffect, TraitDefinition } from './types';

export const REGISTRY_VERSION = 1;

/** Cost and allowed range per primitive kind. `value` scales cost where noted. */
export interface PrimitiveRule {
  readonly kind: ModifierEffect['kind'];
  /** Cost per point of `value`, or a flat cost for kinds without a value. */
  readonly cost: number;
  readonly perPoint: boolean;
  readonly min?: number;
  readonly max?: number;
}

export const PRIMITIVE_RULES: ReadonlyArray<PrimitiveRule> = [
  { kind: 'skill_bonus', cost: 1, perPoint: true, min: 1, max: 3 },
  { kind: 'save_bonus', cost: 1, perPoint: true, min: 1, max: 2 },
  { kind: 'advantage', cost: 2, perPoint: false },
  { kind: 'grant_speed', cost: 3, perPoint: false },
  { kind: 'grant_sense', cost: 1, perPoint: false },
  { kind: 'battle_bonus', cost: 2, perPoint: true, min: 1, max: 1 },
];

/** Named traits. Effects must be primitives, never other traits. */
export const TRAITS: ReadonlyArray<TraitDefinition> = [
  {
    id: 'amphibious',
    cost: 2,
    effects: [{ kind: 'grant_speed', speed: 'swim', feet: 30 }],
  },
  {
    id: 'keen-nose',
    cost: 2,
    effects: [{ kind: 'advantage', on: { type: 'skill', skill: 'perception' } }],
  },
  {
    id: 'thick-skull',
    cost: 1,
    effects: [{ kind: 'save_bonus', ability: 'con', value: 1 }],
  },
];
