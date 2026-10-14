import { describe, expect, it } from 'vitest';
import type { SeasonConfig } from '../src/league';
import { carriedLineup, validateLineup, type Lineup, type RosterView } from '../src/roster';
import type { CrEighths } from '../src/vocabulary';

/** Minimal season config; only `budget.partyCr` matters here. Shape as in events.test.ts. */
function configWithBudget(partyCr: number): SeasonConfig {
  return {
    id: 'season-01',
    snapshot: 'open5e-v1-2026-10',
    modifierRegistryVersion: 1,
    weeks: 6,
    budget: { partyCr: partyCr as CrEighths, modifierPointsPerCharacter: 3 },
    roster: { size: 7, starters: 4, ownership: 'exclusive' },
    draft: { format: 'snake', rounds: 7, order: { mode: 'seeded' }, pickWindowHours: 24, onTimeout: 'autopick' },
    scoring: { pointsScale: 100, homeBonus: 1.25 },
    waivers: { priority: 'rolling', initialOrder: 'reverse_draft' },
    trades: { vetoWindowHours: 24, vetoBy: 'commissioner', deadlineWeek: 4 },
    missedLineup: 'carry_over',
    schedules: { lineupLock: '0 18 * * 4', weeklyRun: '15 18 * * 4', waivers: '0 12 * * 5' },
    secrecy: 'encrypted',
    seedSalt: 'none',
    missions: {
      dcBand: { min: 8, max: 20 },
      maxNodes: 14,
      maxRank: 8,
      battlesPerPath: { min: 0, max: 3 },
      encounterCrRatio: 1,
      haul: 100,
      battleModel: 'ev-ttk-v0',
    },
    carryover: {
      mode: 'none',
      keepersPerTavern: 0,
      keeperCost: 'none',
      championBonusKeepers: 0,
      maxModifierChangePoints: 0,
    },
  };
}

/** B = 12, as in season 1. */
const config = configWithBudget(96);

/** A roster in draft order, with each character's CR in eighths. */
function tavern(entries: ReadonlyArray<readonly [string, number]>): {
  roster: RosterView;
  crOf: (id: string) => CrEighths;
} {
  const crs = new Map(entries);
  return {
    roster: { tavern: 'the-gilded-flagon', characters: entries.map(([id]) => id) },
    crOf: (id) => {
      const cr = crs.get(id);
      if (cr === undefined) throw new Error(`no such character: ${id}`);
      return cr as CrEighths;
    },
  };
}

// CR 4, 3, 3, 2, 1, 1/2, 1/4.
const flagon = tavern([
  ['bruno-the-bruiser', 32],
  ['moss-hag', 24],
  ['tin-knight', 24],
  ['pip-the-sly', 16],
  ['old-gristle', 8],
  ['wisp', 4],
  ['nib', 2],
]);

const legal: Lineup = { starters: ['bruno-the-bruiser', 'moss-hag', 'tin-knight', 'pip-the-sly'], retreat: 'never' };

function codes(lineup: Lineup, t = flagon, c = config): string[] {
  return validateLineup(lineup, t.roster, t.crOf, c).map((v) => v.code);
}

describe('validateLineup', () => {
  it('returns no violations for a legal lineup', () => {
    expect(validateLineup(legal, flagon.roster, flagon.crOf, config)).toEqual([]);
  });

  it('a lineup exactly at the budget is legal (4 + 3 + 3 + 2 = 12)', () => {
    expect(codes(legal)).toEqual([]);
    expect(codes(legal, flagon, configWithBudget(95))).toEqual(['over_budget']);
  });

  it('not_owned: a starter is not on the roster', () => {
    // `stranger` has a known CR (it exists in the pool) but belongs to someone else.
    const crOf = (id: string): CrEighths => (id === 'stranger' ? (8 as CrEighths) : flagon.crOf(id));
    const lineup: Lineup = { starters: ['moss-hag', 'tin-knight', 'pip-the-sly', 'stranger'], retreat: 'never' };
    const violations = validateLineup(lineup, flagon.roster, crOf, config);
    expect(violations.map((v) => v.code)).toEqual(['not_owned']);
    expect(violations[0]!.message).toContain('stranger');
  });

  it('duplicate: the same starter twice', () => {
    const violations = validateLineup({ starters: ['wisp', 'nib', 'nib', 'old-gristle'], retreat: 'never' }, flagon.roster, flagon.crOf, config);
    expect(violations.map((v) => v.code)).toEqual(['duplicate']);
    expect(violations[0]!.message).toContain('"nib" appears 2 times');
  });

  it('wrong_size: too few or too many starters, or junk, at runtime', () => {
    const three = { starters: ['wisp', 'nib', 'old-gristle'], retreat: 'never' } as unknown as Lineup;
    const five = { starters: ['wisp', 'nib', 'old-gristle', 'pip-the-sly', 'moss-hag'], retreat: 'never' } as unknown as Lineup;
    const none = { retreat: 'never' } as unknown as Lineup;
    const junk = { starters: ['wisp', 'nib', 7, 'old-gristle'], retreat: 'never' } as unknown as Lineup;
    const oldShape = { captain: 'wisp', allies: ['nib', 'old-gristle', 'pip-the-sly'], retreat: 'never' } as unknown as Lineup;
    expect(codes(three)).toEqual(['wrong_size']);
    expect(codes(five)).toEqual(['wrong_size']);
    expect(codes(none)).toEqual(['wrong_size']);
    expect(codes(junk)).toEqual(['wrong_size']);
    expect(codes(oldShape)).toEqual(['wrong_size']);
  });

  it('bad_retreat: anything but never, avoid_battles or { bank: N } with N a whole number ≥ 0 (D-49)', () => {
    const starters = legal.starters;
    for (const retreat of ['never', 'avoid_battles', { bank: 0 }, { bank: 70 }]) {
      expect(codes({ starters, retreat } as Lineup)).toEqual([]);
    }
    for (const retreat of [undefined, 'always', { bank: -1 }, { bank: 2.5 }, { bank: '40' }, { bank: 40, extra: 1 }, null]) {
      expect(codes({ starters, retreat } as unknown as Lineup)).toEqual(['bad_retreat']);
    }
  });

  it('injured: a starter hurt in last week\'s DNF can\'t start (D-51)', () => {
    const violations = validateLineup(legal, flagon.roster, flagon.crOf, config, { unavailable: new Set(['moss-hag', 'wisp']) });
    expect(violations.map((v) => v.code)).toEqual(['injured']);
    expect(violations[0]!.message).toContain('"moss-hag" was injured');
    expect(codes(legal)).toEqual([]);
  });

  it('over_budget: shows both totals in human CR form', () => {
    const t = tavern([
      ['a', 32],
      ['b', 32],
      ['c', 32],
      ['d', 4],
    ]);
    const violations = validateLineup({ starters: ['a', 'b', 'c', 'd'], retreat: 'never' }, t.roster, t.crOf, config);
    expect(violations.map((v) => v.code)).toEqual(['over_budget']);
    expect(violations[0]!.message).toContain('12 1/2 > 12');
  });

  it('unknown_character: crOf throws or returns a non-integer', () => {
    const throws = (id: string): CrEighths => {
      if (id === 'nib') throw new Error('no stat block');
      return flagon.crOf(id);
    };
    const fractional = (id: string): CrEighths => (id === 'nib' ? (0.5 as CrEighths) : flagon.crOf(id));
    const lineup: Lineup = { starters: ['wisp', 'nib', 'old-gristle', 'pip-the-sly'], retreat: 'never' };
    const fromThrow = validateLineup(lineup, flagon.roster, throws, config);
    expect(fromThrow.map((v) => v.code)).toEqual(['unknown_character']);
    expect(fromThrow[0]!.message).toContain('nib');
    expect(validateLineup(lineup, flagon.roster, fractional, config).map((v) => v.code)).toEqual(['unknown_character']);
  });

  it('reports every violation together', () => {
    // A duplicate starter, a non-owned starter, and over budget all at once.
    const t = tavern([
      ['big', 64],
      ['mid', 16],
      ['stranger', 8],
    ]);
    const roster: RosterView = { tavern: 'x', characters: ['big', 'mid'] };
    const lineup: Lineup = { starters: ['big', 'big', 'mid', 'stranger'], retreat: 'never' };
    expect(validateLineup(lineup, roster, t.crOf, config).map((v) => v.code)).toEqual(['duplicate', 'not_owned', 'over_budget']);

    // Wrong size, not owned and unknown together.
    const short = { starters: ['ghost', 'wisp', 'nib'], retreat: 'never' } as unknown as Lineup;
    expect(codes(short)).toEqual(['wrong_size', 'not_owned', 'unknown_character']);
  });

  it('sums fractional CRs exactly: four CR 1/8 total 4 eighths', () => {
    const t = tavern([
      ['rat-a', 1],
      ['rat-b', 1],
      ['rat-c', 1],
      ['rat-d', 1],
    ]);
    const rats: Lineup = { starters: ['rat-a', 'rat-b', 'rat-c', 'rat-d'], retreat: 'never' };
    expect(codes(rats, t, configWithBudget(4))).toEqual([]);
    const over = validateLineup(rats, t.roster, t.crOf, configWithBudget(3));
    expect(over.map((v) => v.code)).toEqual(['over_budget']);
    expect(over[0]!.message).toContain('1/2 > 3/8');
  });

  it('sums mixed fractions exactly at the budget: 1/8 + 1/8 + 1/4 + 1/2 = 1', () => {
    const t = tavern([
      ['a', 1],
      ['b', 1],
      ['c', 2],
      ['d', 4],
    ]);
    const lineup: Lineup = { starters: ['a', 'b', 'c', 'd'], retreat: 'never' };
    expect(codes(lineup, t, configWithBudget(8))).toEqual([]);
    expect(codes(lineup, t, configWithBudget(7))).toEqual(['over_budget']);
  });
});

describe('carriedLineup', () => {
  it('returns a still-legal previous lineup as is', () => {
    const previous: Lineup = { starters: ['nib', 'wisp', 'old-gristle', 'pip-the-sly'], retreat: 'never' };
    expect(carriedLineup(previous, flagon.roster, flagon.crOf, config)).toBe(previous);
  });

  it('falls back when a starter was traded away', () => {
    const previous: Lineup = { starters: ['nib', 'wisp', 'old-gristle', 'traded-away'], retreat: 'never' };
    // Highest total ≤ 12: 4 + 3 + 3 + 2 = 12, the first four drafted.
    expect(carriedLineup(previous, flagon.roster, flagon.crOf, config)).toEqual(legal);
  });

  it('keeps a carried lineup\'s retreat order, and the fallback uses never (D-49)', () => {
    const previous: Lineup = { ...legal, retreat: { bank: 50 } };
    expect(carriedLineup(previous, flagon.roster, flagon.crOf, config)?.retreat).toEqual({ bank: 50 });
    const gone: Lineup = { starters: ['nib', 'wisp', 'old-gristle', 'traded-away'], retreat: 'avoid_battles' };
    expect(carriedLineup(gone, flagon.roster, flagon.crOf, config)?.retreat).toBe('never');
  });

  it('falls back past an injured starter, and never picks one (D-51)', () => {
    const unavailable = new Set(['bruno-the-bruiser']);
    const fallback = carriedLineup(legal, flagon.roster, flagon.crOf, config, { unavailable });
    expect(fallback?.starters).not.toContain('bruno-the-bruiser');
    // Without bruno: 3 + 3 + 2 + 1 = 9.
    expect(fallback?.starters).toEqual(['moss-hag', 'tin-knight', 'pip-the-sly', 'old-gristle']);
    expect(carriedLineup(legal, flagon.roster, flagon.crOf, config, { unavailable: new Set(['nib']) })).toBe(legal);
  });

  it('falls back when there is no previous lineup', () => {
    expect(carriedLineup(null, flagon.roster, flagon.crOf, config)).toEqual(legal);
  });

  it('falls back when the previous lineup is now over budget', () => {
    const tight = configWithBudget(48);
    // Best ≤ 6 is 5 3/4, reached by 4 + 1 + 1/2 + 1/4 (indices 0,4,5,6) and by
    // 3 + 2 + 1/2 + 1/4 (1,3,5,6 and 2,3,5,6). Index 0 comes first.
    expect(carriedLineup(legal, flagon.roster, flagon.crOf, tight)).toEqual({ starters: ['bruno-the-bruiser', 'old-gristle', 'wisp', 'nib'], retreat: 'never' });
  });

  it('returns null when every 4-subset is over budget', () => {
    const t = tavern([
      ['a', 32],
      ['b', 32],
      ['c', 32],
      ['d', 32],
      ['e', 32],
      ['f', 32],
      ['g', 32],
    ]);
    expect(carriedLineup(null, t.roster, t.crOf, config)).toBeNull();
  });

  it('returns null when the roster has fewer than four characters with a known CR', () => {
    const t = tavern([
      ['a', 8],
      ['b', 8],
      ['c', 8],
    ]);
    expect(carriedLineup(null, t.roster, t.crOf, config)).toBeNull();
    expect(carriedLineup(null, { ...t.roster, characters: ['a', 'b', 'c', 'ghost'] }, t.crOf, config)).toBeNull();
  });

  it('breaks ties by draft order, not by name', () => {
    // Every subset totals 12. Names run reverse-alphabetically, so a name sort would differ.
    const t = tavern([
      ['zed', 24],
      ['yew', 24],
      ['xan', 24],
      ['wren', 24],
      ['vale', 24],
      ['ulm', 24],
      ['tor', 24],
    ]);
    expect(carriedLineup(null, t.roster, t.crOf, config)).toEqual({ starters: ['zed', 'yew', 'xan', 'wren'], retreat: 'never' });
  });

  it('prefers the lexicographically earliest subset by roster index among ties', () => {
    // Totals of exactly 12 (96): {0,4,5,6}, {1,2,4,6}, {1,3,4,6}, {2,3,4,6}.
    // {0,4,5,6} wins because index 0 comes first, even though its indices are later overall.
    const t = tavern([
      ['r0', 48],
      ['r1', 40],
      ['r2', 40],
      ['r3', 40],
      ['r4', 0],
      ['r5', 32],
      ['r6', 16],
    ]);
    expect(carriedLineup(null, t.roster, t.crOf, config)).toEqual({ starters: ['r0', 'r4', 'r5', 'r6'], retreat: 'never' });
  });

  it('lists the starters in roster order, even when the first is not the strongest', () => {
    // r0 (CR 8) cannot fit, so the best party is r1..r4 (all CR 3).
    const t = tavern([
      ['r0', 64],
      ['r1', 24],
      ['r2', 24],
      ['r3', 24],
      ['r4', 24],
      ['r5', 8],
      ['r6', 8],
    ]);
    const result = carriedLineup(null, t.roster, t.crOf, config);
    expect(result).toEqual({ starters: ['r1', 'r2', 'r3', 'r4'], retreat: 'never' });

    // A weak first pick still leads the list when it is in the best party.
    const u = tavern([
      ['weak', 2],
      ['s1', 30],
      ['s2', 32],
      ['s3', 32],
      ['s4', 40],
    ]);
    expect(carriedLineup(null, u.roster, u.crOf, config)).toEqual({ starters: ['weak', 's1', 's2', 's3'], retreat: 'never' });
  });

  it('skips characters whose CR is unknown', () => {
    const crOf = (id: string): CrEighths => {
      if (id === 'bruno-the-bruiser') throw new Error('missing');
      return flagon.crOf(id);
    };
    // Without bruno: 3 + 3 + 2 + 1 = 9.
    expect(carriedLineup(null, flagon.roster, crOf, config)).toEqual({ starters: ['moss-hag', 'tin-knight', 'pip-the-sly', 'old-gristle'], retreat: 'never' });
  });

  it('is deterministic and does not mutate its inputs', () => {
    const characters = Object.freeze([...flagon.roster.characters]);
    const roster = Object.freeze({ tavern: flagon.roster.tavern, characters });
    const starters = Object.freeze(['nib', 'wisp', 'old-gristle', 'gone'] as const);
    const previous = Object.freeze({ starters, retreat: 'never' }) as Lineup;
    const frozenConfig = Object.freeze(config);
    const first = carriedLineup(previous, roster, flagon.crOf, frozenConfig);
    const second = carriedLineup(previous, roster, flagon.crOf, frozenConfig);
    expect(second).toEqual(first);
    expect(first).toEqual(legal);
    expect(characters).toEqual(flagon.roster.characters);
    expect(previous).toEqual({ starters: ['nib', 'wisp', 'old-gristle', 'gone'], retreat: 'never' });
  });
});
