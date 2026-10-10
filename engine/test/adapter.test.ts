import { describe, expect, it } from 'vitest';
import {
  indexSnapshot,
  parseCr,
  parseDamageList,
  toBaseStats,
  warningKind,
  type AdaptResult,
  type AttackProfile,
  type Open5eMonster,
} from '../src/adapters/open5e';
import { ABILITIES, SKILLS } from '../src/vocabulary';
import { FIXTURE_SLUGS, loadFixture, loadSnapshot } from './fixtures/open5e';

function adapt(slug: string): AdaptResult {
  return toBaseStats(loadFixture(slug));
}

function kinds(result: AdaptResult): string[] {
  return result.warnings.map(warningKind);
}

/** The attacks a creature makes in one turn, as "N×Name". */
function routine(attacks: ReadonlyArray<AttackProfile>): string[] {
  return attacks.filter((a) => a.perTurn > 0).map((a) => `${a.perTurn}×${a.name}`);
}

describe('parseCr', () => {
  it('converts every 5e form to exact eighths', () => {
    expect(parseCr('0')).toBe(0);
    expect(parseCr(0)).toBe(0);
    expect(parseCr('1/8')).toBe(1);
    expect(parseCr(0.125)).toBe(1);
    expect(parseCr('1/4')).toBe(2);
    expect(parseCr(0.25)).toBe(2);
    expect(parseCr('1/2')).toBe(4);
    expect(parseCr(0.5)).toBe(4);
    expect(parseCr('1')).toBe(8);
    expect(parseCr(2)).toBe(16);
    expect(parseCr('10')).toBe(80);
    expect(parseCr(30)).toBe(240);
  });

  it.each([['3/8'], ['1/3'], ['abc'], [''], ['-1'], ['31'], ['2.5'], [0.3], [-1], [31], [1.5], [Number.NaN]])('throws on %j', (value) => {
    expect(() => parseCr(value)).toThrow(/malformed CR/);
  });
});

describe('parseDamageList', () => {
  it('splits plain damage types and keeps qualified groups whole', () => {
    expect(parseDamageList('')).toEqual([]);
    expect(parseDamageList('acid, cold, lightning, slashing')).toEqual(['acid', 'cold', 'lightning', 'slashing']);
    expect(parseDamageList('cold; bludgeoning, piercing, and slashing from nonmagical attacks not made with silvered weapons')).toEqual([
      'cold',
      'bludgeoning, piercing, and slashing from nonmagical attacks not made with silvered weapons',
    ]);
  });

  it('warns about qualified tokens without the standard nonmagical phrasing', () => {
    const warnings: string[] = [];
    const tokens = parseDamageList('damage from spells; bludgeoning', 'damage_resistances', (k, d) => warnings.push(`${k}: ${d}`));
    expect(tokens).toEqual(['damage from spells', 'bludgeoning']);
    expect(warnings.map(warningKind)).toEqual(['damage.qualified']);
  });
});

describe('indexSnapshot', () => {
  it('indexes by slug and rejects duplicates', () => {
    const ogre = loadFixture('ogre');
    const frog = loadFixture('frog');
    const index = indexSnapshot([ogre, frog]);
    expect(index.get('ogre')).toBe(ogre);
    expect(index.size).toBe(2);
    expect(() => indexSnapshot([ogre, ogre])).toThrow(/duplicate slug "ogre"/);
  });
});

describe('toBaseStats on fixtures', () => {
  it('ogre', () => {
    const { stats, warnings } = adapt('ogre');
    expect(warnings).toEqual([]);
    expect(stats.slug).toBe('ogre');
    expect(stats.typeName).toBe('Ogre');
    expect(stats.cr).toBe(16);
    expect(stats.ac).toBe(11);
    expect(stats.hp).toBe(59);
    expect(stats.size).toBe('large');
    expect(stats.creatureType).toBe('giant');
    expect(stats.attacks).toEqual([
      { name: 'Greatclub', attackBonus: 6, averageDamage: 13, perTurn: 1 },
      { name: 'Javelin', attackBonus: 6, averageDamage: 11, perTurn: 0 },
    ]);
    expect(stats.senses).toEqual({ darkvision: 60 });
    expect(stats.speeds).toEqual({ walk: 40 });
    // Not proficient: every skill and save is the ability modifier.
    expect(stats.skills.athletics).toBe(4);
    expect(stats.skills.intimidation).toBe(-2);
    expect(stats.skills.perception).toBe(-2);
    expect(stats.saves).toEqual({ str: 4, dex: -1, con: 3, int: -3, wis: -2, cha: -2 });
    expect(stats.damage).toEqual({ resist: [], immune: [], vulnerable: [] });
  });

  it('crocodile: proficient skill over the ability fallback, swim speed', () => {
    const { stats, warnings } = adapt('crocodile');
    expect(warnings).toEqual([]);
    expect(stats.cr).toBe(4);
    expect(stats.skills.stealth).toBe(2);
    expect(stats.skills.athletics).toBe(2);
    expect(stats.speeds).toEqual({ walk: 20, swim: 20 });
    expect(stats.senses).toEqual({});
    expect(stats.attacks).toEqual([{ name: 'Bite', attackBonus: 4, averageDamage: 7, perTurn: 1 }]);
  });

  it('giant-frog: CR 1/4, skips non-attack actions', () => {
    const { stats } = adapt('giant-frog');
    expect(stats.cr).toBe(2);
    expect(stats.attacks.map((a) => a.name)).toEqual(['Bite']);
    expect(stats.senses).toEqual({ darkvision: 30 });
  });

  it('giant-crocodile: named Multiattack', () => {
    const { stats, warnings } = adapt('giant-crocodile');
    expect(warnings).toEqual([]);
    expect(stats.cr).toBe(40);
    expect(stats.attacks).toEqual([
      { name: 'Bite', attackBonus: 8, averageDamage: 21, perTurn: 1 },
      { name: 'Tail', attackBonus: 8, averageDamage: 14, perTurn: 1 },
    ]);
  });

  it('lizardfolk: "each one with a different weapon" picks two different attacks', () => {
    const { stats, warnings } = adapt('lizardfolk');
    expect(warnings).toEqual([]);
    expect(routine(stats.attacks)).toEqual(['1×Bite', '1×Heavy Club']);
    expect(stats.skills.survival).toBe(5);
  });

  it('frog: CR 0 with null actions', () => {
    const result = adapt('frog');
    expect(result.stats.cr).toBe(0);
    expect(result.stats.attacks).toEqual([]);
    expect(kinds(result)).toEqual(['attack.none']);
  });

  it('flying-snake: CR 1/8, fly and swim, blindsight', () => {
    const { stats, warnings } = adapt('flying-snake');
    expect(warnings).toEqual([]);
    expect(stats.cr).toBe(1);
    expect(stats.speeds).toEqual({ walk: 30, fly: 60, swim: 30 });
    expect(stats.senses).toEqual({ blindsight: 10 });
  });

  it('bat: uses the desc when attack_bonus is missing', () => {
    const record = loadFixture('bat');
    expect(record.actions?.[0]?.attack_bonus).toBeUndefined();
    const { stats, warnings } = toBaseStats(record);
    expect(warnings).toEqual([]);
    expect(stats.attacks).toEqual([{ name: 'Bite', attackBonus: 0, averageDamage: 1, perTurn: 1 }]);
  });

  it('giant-badger: burrow speed', () => {
    expect(adapt('giant-badger').stats.speeds).toEqual({ walk: 30, burrow: 10 });
  });

  it('hunter-shark: swim-only', () => {
    expect(adapt('hunter-shark').stats.speeds).toEqual({ swim: 40 });
  });

  it('ghost: hover ignored, walk 0 dropped, resistances with nonmagical phrasing', () => {
    const { stats, warnings } = adapt('ghost');
    expect(warnings).toEqual([]);
    expect(stats.speeds).toEqual({ fly: 40 });
    expect(stats.damage).toEqual({
      resist: ['acid', 'fire', 'lightning', 'thunder', 'bludgeoning, piercing, and slashing from nonmagical attacks'],
      immune: ['cold', 'necrotic', 'poison'],
      vulnerable: [],
    });
  });

  it('earth-elemental: tremorsense, vulnerability', () => {
    const { stats } = adapt('earth-elemental');
    expect(stats.senses).toEqual({ darkvision: 60, tremorsense: 60 });
    expect(stats.speeds).toEqual({ walk: 30, burrow: 30 });
    expect(stats.damage.vulnerable).toEqual(['thunder']);
    expect(stats.damage.immune).toEqual(['poison']);
  });

  it('werewolf: speed notes are ignored with a warning', () => {
    const result = adapt('werewolf');
    expect(result.stats.speeds).toEqual({ walk: 30 });
    expect(result.warnings).toEqual(['speed.notes: ignored notes "40 ft. in wolf form"']);
    expect(result.stats.damage.immune).toEqual(['bludgeoning, piercing, and slashing from nonmagical attacks not made with silvered weapons']);
    // "two with its spear (humanoid form) or one with its bite and one with its claws (hybrid form)": the stronger option.
    expect(routine(result.stats.attacks)).toEqual(['1×Bite (Wolf or Hybrid Form Only)', '1×Claws (Hybrid Form Only)']);
  });

  it('grimlock: takes the first blindsight radius and warns about the rest', () => {
    const result = adapt('grimlock');
    expect(result.stats.senses).toEqual({ blindsight: 30 });
    expect(kinds(result)).toEqual(['senses.qualifier']);
  });

  it('purple-worm: warns when the desc and attack_bonus disagree, and uses the desc', () => {
    const result = adapt('purple-worm');
    expect(result.stats.cr).toBe(120);
    expect(result.stats.senses).toEqual({ blindsight: 30, tremorsense: 60 });
    expect(result.stats.attacks.map((a) => a.attackBonus)).toEqual([14, 14]);
    expect(result.warnings).toContain('attack.bonus_mismatch: Bite: desc says +14 to hit, attack_bonus is 9; using the desc');
    expect(routine(result.stats.attacks)).toEqual(['1×Bite', '1×Tail Stinger']);
  });

  it('black-bear: CR 1/2, bonus disagreement, two-attack Multiattack', () => {
    const result = adapt('black-bear');
    expect(result.stats.cr).toBe(4);
    expect(result.stats.speeds).toEqual({ walk: 40, climb: 30 });
    expect(result.stats.attacks.map((a) => a.attackBonus)).toEqual([4, 4]);
    expect(kinds(result)).toEqual(['attack.bonus_mismatch', 'attack.bonus_mismatch']);
    expect(routine(result.stats.attacks)).toEqual(['1×Bite', '1×Claws']);
  });

  it('young-red-dragon: CR 10, sums "plus" damage clauses, saves from the record', () => {
    const { stats, warnings } = adapt('young-red-dragon');
    expect(warnings).toEqual([]);
    expect(stats.cr).toBe(80);
    expect(stats.senses).toEqual({ blindsight: 30, darkvision: 120 });
    expect(stats.damage.immune).toEqual(['fire']);
    // Bite: 17 (2d10 + 6) piercing plus 3 (1d6) fire. damage_dice is the compound "2d10+1d6".
    expect(stats.attacks).toEqual([
      { name: 'Bite', attackBonus: 10, averageDamage: 20, perTurn: 1 },
      { name: 'Claw', attackBonus: 10, averageDamage: 13, perTurn: 2 },
    ]);
    expect(stats.saves).toEqual({ str: 6, dex: 4, con: 9, int: 2, wis: 4, cha: 8 });
    expect(stats.skills.perception).toBe(8);
  });

  it('vampire-spawn: "only one of which can be a bite"', () => {
    const result = adapt('vampire-spawn');
    expect(result.stats.attacks).toEqual([
      { name: 'Bite', attackBonus: 6, averageDamage: 13, perTurn: 1 },
      { name: 'Claws', attackBonus: 6, averageDamage: 8, perTurn: 1 },
    ]);
    expect(kinds(result)).toEqual(['attack.bonus_mismatch']);
    expect(result.stats.damage.resist).toEqual(['necrotic', 'bludgeoning, piercing, and slashing from nonmagical attacks']);
  });

  it('bandit-captain: reads the first Multiattack sentence', () => {
    expect(routine(adapt('bandit-captain').stats.attacks)).toEqual(['2×Scimitar', '1×Dagger']);
  });

  it('hydra: an unreadable Multiattack falls back to one best attack, with a warning', () => {
    const result = adapt('hydra');
    expect(routine(result.stats.attacks)).toEqual(['1×Bite']);
    expect(kinds(result)).toEqual(['multiattack.unparsed']);
  });

  it('rug-of-smothering: desc bonus over attack_bonus 0, damage from the fields when the hit text has none', () => {
    const result = adapt('rug-of-smothering');
    expect(result.stats.attacks).toEqual([{ name: 'Smother', attackBonus: 5, averageDamage: 10, perTurn: 1 }]);
    expect(kinds(result)).toEqual(['senses.qualifier', 'attack.bonus_mismatch', 'attack.damage_from_fields']);
  });

  it('every fixture adapts', () => {
    for (const slug of FIXTURE_SLUGS) expect(() => adapt(slug)).not.toThrow();
  });
});

describe('toBaseStats on edited records', () => {
  const ogre = loadFixture('ogre');
  const edit = (patch: Partial<Record<keyof Open5eMonster, unknown>>): Open5eMonster => ({ ...ogre, ...patch }) as Open5eMonster;

  it('normalizes skill key spellings and warns on unknown keys', () => {
    const result = toBaseStats(
      edit({ skills: { animalhandling: 3, 'Sleight of Hand': 4, Athletics: 7, 'basket-weaving': 9 } }),
    );
    expect(result.stats.skills.animal_handling).toBe(3);
    expect(result.stats.skills.sleight_of_hand).toBe(4);
    expect(result.stats.skills.athletics).toBe(7);
    expect(result.warnings).toEqual(['skills.unknown_key: ignored skill "basket-weaving"']);
    expect(toBaseStats(edit({ skills: { animal_handling: 5, sleight_of_hand: 6 } })).stats.skills).toMatchObject({
      animal_handling: 5,
      sleight_of_hand: 6,
    });
  });

  it('throws on a malformed CR and nothing else', () => {
    expect(() => toBaseStats(edit({ challenge_rating: '3/8' }))).toThrow(/malformed CR/);
    expect(() => toBaseStats(edit({ senses: 'x-ray vision 5 miles', speed: { teleport: 30 }, damage_resistances: 'feelings' }))).not.toThrow();
  });

  it('averages compound damage_dice when the hit text has no number', () => {
    const result = toBaseStats(
      edit({
        actions: [{ name: 'Bite', desc: 'Melee Weapon Attack: +5 to hit, reach 5 ft., one target. Hit: piercing damage.', damage_dice: '2d10+1d8', damage_bonus: 6 }],
      }),
    );
    expect(result.stats.attacks[0]?.averageDamage).toBe(11 + 4.5 + 6);
    expect(kinds(result)).toEqual(['attack.damage_from_fields']);
  });
});

describe('toBaseStats over the whole snapshot', () => {
  const snapshot = loadSnapshot();
  const results = snapshot.map((record) => ({ record, result: toBaseStats(record) }));

  it('adapts all 322 records without throwing', () => {
    expect(results).toHaveLength(322);
  });

  it('gets CR exact in eighths from both forms', () => {
    for (const { record, result } of results) {
      expect(result.stats.cr).toBe(record.cr * 8);
      expect(parseCr(record.cr)).toBe(result.stats.cr);
    }
    expect(results.filter(({ result }) => result.stats.cr === 0)).toHaveLength(29);
  });

  it('populates every skill and save', () => {
    for (const { result } of results) {
      for (const skill of SKILLS) expect(Number.isInteger(result.stats.skills[skill])).toBe(true);
      for (const ability of ABILITIES) expect(Number.isInteger(result.stats.saves[ability])).toBe(true);
    }
  });

  it('gives every creature with attacks a turn of at least one attack', () => {
    for (const { result } of results) {
      const { attacks } = result.stats;
      if (attacks.length > 0) expect(attacks.reduce((n, a) => n + a.perTurn, 0)).toBeGreaterThanOrEqual(1);
      for (const a of attacks) {
        expect(Number.isFinite(a.attackBonus) && Number.isFinite(a.averageDamage) && a.averageDamage >= 0).toBe(true);
      }
    }
  });

  it('parses nearly every Multiattack and reports warnings by kind', () => {
    const withMultiattack = results.filter(({ record }) => (record.actions ?? []).some((a) => /^multiattack\b/i.test(a.name)));
    const unparsed = withMultiattack.filter(({ result }) => kinds(result).includes('multiattack.unparsed'));
    // 137 actions named exactly "Multiattack", plus 5 form-qualified ones
    // ("Multiattack (Humanoid or Hybrid Form Only)" on lycanthropes, the vampire's).
    expect(withMultiattack).toHaveLength(142);
    expect(unparsed.map(({ record }) => record.slug)).toEqual(['hydra', 'violet-fungus']);

    const byKind = new Map<string, number>();
    for (const { result } of results) for (const k of kinds(result)) byKind.set(k, (byKind.get(k) ?? 0) + 1);
    const summary = [...byKind].sort(([a], [b]) => a.localeCompare(b));
    console.log(
      [
        `Open5e adapter: ${results.length} records, ${results.filter(({ result }) => result.warnings.length > 0).length} with warnings`,
        `Multiattack parsed: ${withMultiattack.length - unparsed.length}/${withMultiattack.length}`,
        ...summary.map(([k, n]) => `  ${k}: ${n}`),
      ].join('\n'),
    );
    expect(summary.length).toBeGreaterThan(0);
  });
});
