import { describe, expect, it } from 'vitest';
import { toBaseStats, type BaseStats } from '../src/adapters/open5e';
import { TRAITS, effectiveStats, type Modifier, type PooledCharacter, type TraitDefinition } from '../src/characters';
import { loadFixture } from './fixtures/open5e';

const OGRE: BaseStats = toBaseStats(loadFixture('ogre')).stats;

function pooled(modifiers: ReadonlyArray<Modifier>, base = 'ogre', id = 'test-character'): PooledCharacter {
  return { ref: { id, base }, modifiers };
}

function apply(modifiers: ReadonlyArray<Modifier>, traits: ReadonlyArray<TraitDefinition> = TRAITS) {
  return effectiveStats(pooled(modifiers), OGRE, traits);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

describe('effectiveStats', () => {
  it('Bruno: ogre + intimidation 2 + thick-skull', () => {
    const bruno = effectiveStats(
      pooled(
        [
          { kind: 'skill_bonus', skill: 'intimidation', value: 2 },
          { kind: 'trait', trait: 'thick-skull' },
        ],
        'ogre',
        'bruno-the-bruiser',
      ),
      OGRE,
      TRAITS,
    );
    expect(bruno.characterId).toBe('bruno-the-bruiser');
    expect(OGRE.skills.intimidation).toBe(-2);
    expect(bruno.skills.intimidation).toBe(0);
    expect(OGRE.saves.con).toBe(3);
    expect(bruno.saves.con).toBe(4);
    expect(bruno.cr).toBe(OGRE.cr);
    expect(bruno.cr).toBe(16);
    // Everything else is the base.
    expect({ ...bruno.skills, intimidation: -2 }).toEqual(OGRE.skills);
    expect({ ...bruno.saves, con: 3 }).toEqual(OGRE.saves);
    expect(bruno.speeds).toEqual(OGRE.speeds);
    expect(bruno.senses).toEqual(OGRE.senses);
    expect(bruno.advantages.size).toBe(0);
    expect(bruno.battleBonus).toBe(0);
    expect(bruno.base).toBe(OGRE);
  });

  it('with no modifiers, is the base', () => {
    const stats = apply([]);
    expect(stats.skills).toEqual(OGRE.skills);
    expect(stats.saves).toEqual(OGRE.saves);
    expect(stats.speeds).toEqual(OGRE.speeds);
    expect(stats.senses).toEqual(OGRE.senses);
    expect(stats.advantages.size).toBe(0);
    expect(stats.battleBonus).toBe(0);
  });

  it('abilityMods come from the base ability scores', () => {
    expect(apply([{ kind: 'save_bonus', ability: 'str', value: 2 }]).abilityMods).toEqual({
      str: 4,
      dex: -1,
      con: 3,
      int: -3,
      wis: -2,
      cha: -2,
    });
  });

  it('skill_bonus adds, and repeats stack', () => {
    const stats = apply([
      { kind: 'skill_bonus', skill: 'stealth', value: 1 },
      { kind: 'skill_bonus', skill: 'stealth', value: 2 },
    ]);
    expect(stats.skills.stealth).toBe(OGRE.skills.stealth + 3);
  });

  it('save_bonus adds, including through a trait', () => {
    const stats = apply([
      { kind: 'save_bonus', ability: 'con', value: 1 },
      { kind: 'trait', trait: 'thick-skull' },
    ]);
    expect(stats.saves.con).toBe(OGRE.saves.con + 2);
  });

  it('advantage records the check target key', () => {
    const stats = apply([
      { kind: 'advantage', on: { type: 'save', ability: 'dex' } },
      { kind: 'advantage', on: { type: 'ability', ability: 'str' } },
      { kind: 'trait', trait: 'keen-nose' },
    ]);
    expect([...stats.advantages].sort()).toEqual(['ability:str', 'save:dex', 'skill:perception']);
    // Advantage doesn't change the modifier itself.
    expect(stats.skills.perception).toBe(OGRE.skills.perception);
  });

  it('grant_speed adds a speed or raises one, never lowers it', () => {
    expect(apply([{ kind: 'trait', trait: 'amphibious' }]).speeds).toEqual({ walk: 40, swim: 30 });
    expect(apply([{ kind: 'grant_speed', speed: 'walk', feet: 30 }]).speeds).toEqual({ walk: 40 });
    expect(apply([{ kind: 'grant_speed', speed: 'walk', feet: 50 }]).speeds).toEqual({ walk: 50 });
    expect(apply([{ kind: 'grant_speed', speed: 'fly', feet: 30 }]).speeds).toEqual({ walk: 40, fly: 30 });
  });

  it('grant_sense adds a sense or raises one, never lowers it', () => {
    expect(apply([{ kind: 'grant_sense', sense: 'darkvision', feet: 30 }]).senses).toEqual({ darkvision: 60 });
    expect(apply([{ kind: 'grant_sense', sense: 'darkvision', feet: 120 }]).senses).toEqual({ darkvision: 120 });
    expect(apply([{ kind: 'grant_sense', sense: 'tremorsense', feet: 10 }]).senses).toEqual({ darkvision: 60, tremorsense: 10 });
  });

  it('battle_bonus sums', () => {
    expect(apply([{ kind: 'battle_bonus', value: 1 }]).battleBonus).toBe(1);
    expect(
      apply([
        { kind: 'battle_bonus', value: 1 },
        { kind: 'battle_bonus', value: 1 },
      ]).battleBonus,
    ).toBe(2);
  });

  it('never changes CR', () => {
    const everything: ReadonlyArray<Modifier> = [
      { kind: 'skill_bonus', skill: 'athletics', value: 3 },
      { kind: 'save_bonus', ability: 'wis', value: 2 },
      { kind: 'advantage', on: { type: 'skill', skill: 'stealth' } },
      { kind: 'grant_speed', speed: 'fly', feet: 60 },
      { kind: 'grant_sense', sense: 'truesight', feet: 30 },
      { kind: 'battle_bonus', value: 1 },
      { kind: 'trait', trait: 'amphibious' },
    ];
    expect(apply(everything).cr).toBe(OGRE.cr);
  });

  it('throws instead of dropping an unknown trait, kind or term', () => {
    expect(() => apply([{ kind: 'trait', trait: 'nope' }])).toThrow(/unknown trait "nope"/);
    expect(() => apply([{ kind: 'flight' } as unknown as Modifier])).toThrow(/unknown modifier kind "flight"/);
    expect(() => apply([{ kind: 'skill_bonus', skill: 'juggling', value: 1 } as unknown as Modifier])).toThrow(/unknown skill "juggling"/);
    expect(() => apply([{ kind: 'grant_speed', speed: 'teleport', feet: 30 } as unknown as Modifier])).toThrow(/unknown speed/);
    const nested = [{ id: 'nested', cost: 1, effects: [{ kind: 'trait', trait: 'thick-skull' }] }] as unknown as ReadonlyArray<TraitDefinition>;
    expect(() => apply([{ kind: 'trait', trait: 'nested' }], nested)).toThrow(/unknown modifier kind "trait"/);
  });

  it('throws when the base is for a different slug', () => {
    expect(() => effectiveStats(pooled([], 'frog'), OGRE, TRAITS)).toThrow(/base is "frog" but stats are for "ogre"/);
  });

  it('does not mutate its inputs or share mutable state with them', () => {
    const base = deepFreeze(structuredClone(OGRE));
    const modifiers: ReadonlyArray<Modifier> = deepFreeze([
      { kind: 'skill_bonus', skill: 'intimidation', value: 2 },
      { kind: 'save_bonus', ability: 'con', value: 1 },
      { kind: 'grant_speed', speed: 'walk', feet: 60 },
      { kind: 'grant_sense', sense: 'darkvision', feet: 120 },
      { kind: 'trait', trait: 'amphibious' },
    ]);
    const character = deepFreeze(pooled(modifiers));
    const traits = deepFreeze(structuredClone(TRAITS));
    const before = structuredClone({ base, character, traits });

    const stats = effectiveStats(character, base, traits);

    expect({ base, character, traits }).toEqual(before);
    expect(stats.skills).not.toBe(base.skills);
    expect(stats.saves).not.toBe(base.saves);
    expect(stats.speeds).not.toBe(base.speeds);
    expect(stats.senses).not.toBe(base.senses);
    expect(stats.skills.intimidation).toBe(0);
    expect(stats.speeds).toEqual({ walk: 60, swim: 30 });
    expect(stats.senses).toEqual({ darkvision: 120 });
  });
});
