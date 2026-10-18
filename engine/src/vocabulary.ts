/**
 * Closed vocabularies shared by every module: abilities, skills, speeds,
 * senses, check outcomes, and the exact CR representation.
 *
 * Conventions (docs/schema.md § Conventions):
 * - Ids (characters, challenges, traits, taverns) are kebab-case.
 * - Vocabulary terms (skills, modifier kinds, outcomes) are snake_case.
 */

export const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'] as const;
export type Ability = (typeof ABILITIES)[number];

export const SKILLS = [
  'acrobatics',
  'animal_handling',
  'arcana',
  'athletics',
  'deception',
  'history',
  'insight',
  'intimidation',
  'investigation',
  'medicine',
  'nature',
  'perception',
  'performance',
  'persuasion',
  'religion',
  'sleight_of_hand',
  'stealth',
  'survival',
] as const;
export type Skill = (typeof SKILLS)[number];

/** The ability each skill keys off when a creature lacks proficiency. */
export const SKILL_ABILITY: Readonly<Record<Skill, Ability>> = {
  acrobatics: 'dex',
  animal_handling: 'wis',
  arcana: 'int',
  athletics: 'str',
  deception: 'cha',
  history: 'int',
  insight: 'wis',
  intimidation: 'cha',
  investigation: 'int',
  medicine: 'wis',
  nature: 'int',
  perception: 'wis',
  performance: 'cha',
  persuasion: 'cha',
  religion: 'int',
  sleight_of_hand: 'dex',
  stealth: 'dex',
  survival: 'wis',
};

export const SPEEDS = ['walk', 'fly', 'swim', 'climb', 'burrow'] as const;
export type SpeedKind = (typeof SPEEDS)[number];

export const SENSES = ['darkvision', 'blindsight', 'tremorsense', 'truesight'] as const;
export type SenseKind = (typeof SENSES)[number];

export type CheckOutcome = 'pass' | 'fail';

/**
 * Challenge rating stored exactly, as an integer count of eighths:
 * CR 1/8 → 1, 1/4 → 2, 1/2 → 4, 1 → 8, 12 → 96.
 *
 * Budget sums must be exact. Floats make `0.125 + 0.125 + 0.25 + 0.5` budget
 * checks fragile, so all CR arithmetic happens in eighths. Convert at the edges
 * (the Open5e adapter and the season-config loader). See docs/decisions.md D-16.
 */
export type CrEighths = number & { readonly __brand: 'CrEighths' };
