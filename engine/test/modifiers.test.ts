import { describe, expect, it } from 'vitest';
import {
  TRAITS,
  checkTargetKey,
  modifierCost,
  validateModifiers,
  validateTraitRegistry,
  type Modifier,
  type ModifierIssueCode,
  type PooledCharacter,
  type TraitDefinition,
} from '../src/characters';
import { ModifierSchema, PoolEntrySchema } from '../src/characters/schema';

const BUDGET = 3;

function pooled(modifiers: ReadonlyArray<unknown>, id = 'test-character'): PooledCharacter {
  // Cast on purpose: validateModifiers must catch data the type system would reject.
  return { ref: { id, base: 'ogre' }, modifiers: modifiers as ReadonlyArray<Modifier> };
}

function codes(modifiers: ReadonlyArray<unknown>, budget = BUDGET, traits: ReadonlyArray<TraitDefinition> = TRAITS): ModifierIssueCode[] {
  return validateModifiers(pooled(modifiers), budget, traits).map((i) => i.code);
}

const BRUNO: ReadonlyArray<Modifier> = [
  { kind: 'skill_bonus', skill: 'intimidation', value: 2 },
  { kind: 'trait', trait: 'thick-skull' },
];

describe('checkTargetKey', () => {
  it('formats each target type', () => {
    expect(checkTargetKey({ type: 'skill', skill: 'stealth' })).toBe('skill:stealth');
    expect(checkTargetKey({ type: 'save', ability: 'dex' })).toBe('save:dex');
    expect(checkTargetKey({ type: 'ability', ability: 'str' })).toBe('ability:str');
  });
});

describe('modifierCost', () => {
  it('costs the Bruno example exactly 3', () => {
    expect(modifierCost(BRUNO, TRAITS)).toBe(3);
  });

  it('charges per point, flat, and per trait', () => {
    expect(modifierCost([{ kind: 'skill_bonus', skill: 'stealth', value: 3 }], TRAITS)).toBe(3);
    expect(modifierCost([{ kind: 'save_bonus', ability: 'wis', value: 2 }], TRAITS)).toBe(2);
    expect(modifierCost([{ kind: 'advantage', on: { type: 'save', ability: 'dex' } }], TRAITS)).toBe(2);
    expect(modifierCost([{ kind: 'grant_speed', speed: 'fly', feet: 30 }], TRAITS)).toBe(3);
    expect(modifierCost([{ kind: 'grant_sense', sense: 'darkvision', feet: 60 }], TRAITS)).toBe(1);
    expect(modifierCost([{ kind: 'trait', trait: 'amphibious' }], TRAITS)).toBe(2);
    expect(modifierCost([], TRAITS)).toBe(0);
  });

  it('throws on an unknown trait or kind', () => {
    expect(() => modifierCost([{ kind: 'trait', trait: 'nope' }], TRAITS)).toThrow(/unknown trait "nope"/);
    expect(() => modifierCost([{ kind: 'flight' } as unknown as Modifier], TRAITS)).toThrow(/unknown kind "flight"/);
  });
});

describe('validateModifiers', () => {
  it('accepts the Bruno example under budget 3', () => {
    expect(validateModifiers(pooled(BRUNO, 'bruno-the-bruiser'), 3, TRAITS)).toEqual([]);
  });

  it('accepts every primitive kind at its limits and no modifiers at all', () => {
    expect(codes([], 0)).toEqual([]);
    expect(
      codes(
        [
          { kind: 'skill_bonus', skill: 'stealth', value: 3 },
          { kind: 'save_bonus', ability: 'dex', value: 2 },
          { kind: 'advantage', on: { type: 'ability', ability: 'str' } },
          { kind: 'grant_speed', speed: 'climb', feet: 30 },
          { kind: 'grant_sense', sense: 'tremorsense', feet: 30 },
          { kind: 'trait', trait: 'keen-nose' },
        ],
        100,
      ),
    ).toEqual([]);
  });

  it('rejects an unknown kind', () => {
    expect(codes([{ kind: 'flight', feet: 30 }])).toEqual(['unknown_kind']);
  });

  it('rejects an unknown trait', () => {
    expect(codes([{ kind: 'trait', trait: 'iron-will' }])).toEqual(['unknown_trait']);
  });

  it('rejects a value outside min/max', () => {
    expect(codes([{ kind: 'skill_bonus', skill: 'stealth', value: 4 }], 10)).toEqual(['out_of_range']);
    expect(codes([{ kind: 'skill_bonus', skill: 'stealth', value: 0 }])).toEqual(['out_of_range']);
    expect(codes([{ kind: 'save_bonus', ability: 'dex', value: 3 }])).toEqual(['out_of_range']);
    expect(codes([{ kind: 'save_bonus', ability: 'wis', value: 3 }], 10)).toEqual(['out_of_range']);
    expect(codes([{ kind: 'skill_bonus', skill: 'stealth', value: 1.5 }])).toEqual(['out_of_range']);
    expect(codes([{ kind: 'grant_sense', sense: 'darkvision', feet: 0 }])).toEqual(['out_of_range']);
  });

  it('rejects the same primitive stacked beyond its max', () => {
    expect(
      codes([
        { kind: 'skill_bonus', skill: 'stealth', value: 2 },
        { kind: 'skill_bonus', skill: 'stealth', value: 2 },
      ], 10),
    ).toEqual(['stacking']);
    // Different targets don't stack with each other.
    expect(
      codes([
        { kind: 'skill_bonus', skill: 'stealth', value: 2 },
        { kind: 'skill_bonus', skill: 'athletics', value: 2 },
      ], 10),
    ).toEqual([]);
  });

  it('counts trait effects toward stacking', () => {
    // thick-skull is +1 Con save; with +2 more that is 3, over the save_bonus max of 2.
    expect(codes([{ kind: 'save_bonus', ability: 'con', value: 2 }, { kind: 'trait', trait: 'thick-skull' }])).toEqual([
      'stacking',
    ]);
  });

  it('rejects duplicate advantage on the same check target', () => {
    const stealth = { kind: 'advantage', on: { type: 'skill', skill: 'stealth' } };
    expect(codes([stealth, stealth], 10)).toEqual(['duplicate_advantage']);
    // keen-nose grants advantage on Perception.
    expect(codes([{ kind: 'advantage', on: { type: 'skill', skill: 'perception' } }, { kind: 'trait', trait: 'keen-nose' }], 10)).toEqual([
      'duplicate_advantage',
    ]);
    // A save and an ability check on the same ability are different targets.
    expect(
      codes([
        { kind: 'advantage', on: { type: 'save', ability: 'dex' } },
        { kind: 'advantage', on: { type: 'ability', ability: 'dex' } },
      ], 10),
    ).toEqual([]);
  });

  it('rejects invalid vocabulary for skills, abilities, speeds, senses and check types', () => {
    expect(codes([{ kind: 'skill_bonus', skill: 'Stealth', value: 1 }])).toEqual(['invalid_vocabulary']);
    expect(codes([{ kind: 'save_bonus', ability: 'luck', value: 1 }])).toEqual(['invalid_vocabulary']);
    expect(codes([{ kind: 'grant_speed', speed: 'teleport', feet: 30 }])).toEqual(['invalid_vocabulary']);
    expect(codes([{ kind: 'grant_sense', sense: 'xray', feet: 30 }])).toEqual(['invalid_vocabulary']);
    expect(codes([{ kind: 'advantage', on: { type: 'skill', skill: 'lockpicking' } }])).toEqual(['invalid_vocabulary']);
    expect(codes([{ kind: 'advantage', on: { type: 'attack' } }])).toEqual(['invalid_vocabulary']);
  });

  it('rejects a total cost over budget', () => {
    expect(codes([...BRUNO, { kind: 'grant_sense', sense: 'darkvision', feet: 60 }])).toEqual(['over_budget']);
    expect(codes(BRUNO, 2)).toEqual(['over_budget']);
  });

  it('rejects a referenced trait whose effects contain a trait', () => {
    const traits = [
      ...TRAITS,
      { id: 'nested', cost: 1, effects: [{ kind: 'trait', trait: 'thick-skull' }] } as unknown as TraitDefinition,
    ];
    expect(codes([{ kind: 'trait', trait: 'nested' }], BUDGET, traits)).toEqual(['invalid_trait']);
  });

  it('reports every violation together, not just the first', () => {
    const issues = validateModifiers(
      pooled(
        [
          { kind: 'trait', trait: 'iron-will' },
          { kind: 'skill_bonus', skill: 'stealth', value: 3 },
          { kind: 'skill_bonus', skill: 'stealth', value: 1 },
          { kind: 'save_bonus', ability: 'luck', value: 5 },
          { kind: 'advantage', on: { type: 'save', ability: 'wis' } },
          { kind: 'advantage', on: { type: 'save', ability: 'wis' } },
          { kind: 'flight' },
        ],
        'greedy-goblin',
      ),
      BUDGET,
      TRAITS,
    );
    expect(issues.map((i) => i.code).sort()).toEqual(
      ['unknown_trait', 'invalid_vocabulary', 'out_of_range', 'stacking', 'duplicate_advantage', 'unknown_kind', 'over_budget'].sort(),
    );
    expect(issues.every((i) => i.characterId === 'greedy-goblin')).toBe(true);
    expect(issues.find((i) => i.code === 'over_budget')?.message).toMatch(/cost 13, over the budget of 3/);
  });
});

describe('trait registry', () => {
  it('the v1 registry is valid and its traits contain only primitives', () => {
    expect(validateTraitRegistry(TRAITS)).toEqual([]);
  });

  it('rejects a trait that contains a trait, unknown kinds, bad ids, costs and duplicates', () => {
    const bad = [
      { id: 'nested', cost: 1, effects: [{ kind: 'trait', trait: 'thick-skull' }] },
      { id: 'Bad_Id', cost: -1, effects: [{ kind: 'flight' }] },
      { id: 'thick-skull', cost: 1, effects: [{ kind: 'save_bonus', ability: 'con', value: 9 }] },
      { id: 'thick-skull', cost: 1, effects: [] },
    ] as unknown as ReadonlyArray<TraitDefinition>;
    const messages = validateTraitRegistry(bad).map((i) => `${i.traitId}: ${i.message}`);
    expect(messages).toEqual([
      'nested: effects[0] is a trait; traits may contain only primitives',
      'Bad_Id: id must be kebab-case',
      'Bad_Id: cost -1 must be a non-negative integer',
      'Bad_Id: effects[0] has unknown kind "flight"',
      'thick-skull: effects[0] (save_bonus): value 9 is outside 1..2',
      'thick-skull: duplicate trait id',
      'thick-skull: has no effects',
    ]);
  });
});

describe('schema', () => {
  it('parses the season-01 pool entry for Bruno', () => {
    const entry = PoolEntrySchema.parse({
      id: 'bruno-the-bruiser',
      strategy: { kind: 'loyal', tag: 'type:giant' },
      modifiers: [
        { kind: 'skill_bonus', skill: 'intimidation', value: 2 },
        { kind: 'trait', trait: 'thick-skull' },
      ],
    });
    expect(entry.modifiers).toEqual(BRUNO);
    expect(modifierCost(entry.modifiers, TRAITS)).toBe(3);
  });

  it('defaults missing modifiers to none, and needs a strategy', () => {
    expect(PoolEntrySchema.parse({ id: 'plain-ogre', strategy: { kind: 'floater' } }).modifiers).toEqual([]);
    expect(PoolEntrySchema.safeParse({ id: 'plain-ogre' }).success).toBe(false);
    expect(PoolEntrySchema.safeParse({ id: 'plain-ogre', strategy: { kind: 'loyal', tag: 'giants' } }).success).toBe(false);
  });

  it('parses every primitive kind', () => {
    const all = [
      { kind: 'skill_bonus', skill: 'stealth', value: 1 },
      { kind: 'save_bonus', ability: 'dex', value: 1 },
      { kind: 'advantage', on: { type: 'skill', skill: 'perception' } },
      { kind: 'advantage', on: { type: 'save', ability: 'wis' } },
      { kind: 'advantage', on: { type: 'ability', ability: 'str' } },
      { kind: 'grant_speed', speed: 'swim', feet: 30 },
      { kind: 'grant_sense', sense: 'darkvision', feet: 60 },
      { kind: 'trait', trait: 'amphibious' },
    ];
    for (const m of all) expect(ModifierSchema.parse(m)).toEqual(m);
  });

  it('rejects unknown kinds, vocabulary, extra keys and non-kebab ids', () => {
    expect(ModifierSchema.safeParse({ kind: 'flight', feet: 30 }).success).toBe(false);
    expect(ModifierSchema.safeParse({ kind: 'skill_bonus', skill: 'lockpicking', value: 1 }).success).toBe(false);
    expect(ModifierSchema.safeParse({ kind: 'skill_bonus', skill: 'stealth', value: 1, note: 'x' }).success).toBe(false);
    expect(ModifierSchema.safeParse({ kind: 'skill_bonus', skill: 'stealth', value: 1.5 }).success).toBe(false);
    expect(ModifierSchema.safeParse({ kind: 'advantage', on: { type: 'save', skill: 'stealth' } }).success).toBe(false);
    expect(PoolEntrySchema.safeParse({ id: 'Bruno', modifiers: [] }).success).toBe(false);
  });
});
