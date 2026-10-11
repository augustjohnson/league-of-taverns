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
    matchups: { format: 'head_to_head', playoffs: { enabled: false, teams: 4, weeks: [] } },
    scoring: { pointsScale: 100, tiebreakers: ['projected', 'checks_passed', 'seeded_coin'] },
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

const legal: Lineup = { captain: 'bruno-the-bruiser', allies: ['moss-hag', 'tin-knight', 'pip-the-sly'] };

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
    const lineup: Lineup = { captain: 'moss-hag', allies: ['tin-knight', 'pip-the-sly', 'stranger'] };
    const violations = validateLineup(lineup, flagon.roster, crOf, config);
    expect(violations.map((v) => v.code)).toEqual(['not_owned']);
    expect(violations[0]!.message).toContain('stranger');
  });

  it('duplicate: the captain repeated as an ally', () => {
    const lineup: Lineup = { captain: 'wisp', allies: ['wisp', 'nib', 'old-gristle'] };
    const violations = validateLineup(lineup, flagon.roster, flagon.crOf, config);
    expect(violations.map((v) => v.code)).toEqual(['duplicate']);
    expect(violations[0]!.message).toContain('wisp');
    expect(violations[0]!.message).toContain('captain');
  });

  it('duplicate: the same ally twice', () => {
    expect(codes({ captain: 'wisp', allies: ['nib', 'nib', 'old-gristle'] })).toEqual(['duplicate']);
  });

  it('wrong_size: too few or too many allies, or no captain, at runtime', () => {
    const twoAllies = { captain: 'wisp', allies: ['nib', 'old-gristle'] } as unknown as Lineup;
    const fourAllies = { captain: 'wisp', allies: ['nib', 'old-gristle', 'pip-the-sly', 'moss-hag'] } as unknown as Lineup;
    const noCaptain = { allies: ['nib', 'old-gristle', 'pip-the-sly'] } as unknown as Lineup;
    const noAllies = { captain: 'wisp' } as unknown as Lineup;
    const junkAlly = { captain: 'wisp', allies: ['nib', 7, 'old-gristle'] } as unknown as Lineup;
    expect(codes(twoAllies)).toEqual(['wrong_size']);
    expect(codes(fourAllies)).toEqual(['wrong_size']);
    expect(codes(noCaptain)).toEqual(['wrong_size']);
    expect(codes(noAllies)).toEqual(['wrong_size']);
    expect(codes(junkAlly)).toEqual(['wrong_size']);
  });

  it('over_budget: shows both totals in human CR form', () => {
    const t = tavern([
      ['a', 32],
      ['b', 32],
      ['c', 32],
      ['d', 4],
    ]);
    const violations = validateLineup({ captain: 'a', allies: ['b', 'c', 'd'] }, t.roster, t.crOf, config);
    expect(violations.map((v) => v.code)).toEqual(['over_budget']);
    expect(violations[0]!.message).toContain('12 1/2 > 12');
  });

  it('unknown_character: crOf throws or returns a non-integer', () => {
    const throws = (id: string): CrEighths => {
      if (id === 'nib') throw new Error('no stat block');
      return flagon.crOf(id);
    };
    const fractional = (id: string): CrEighths => (id === 'nib' ? (0.5 as CrEighths) : flagon.crOf(id));
    const lineup: Lineup = { captain: 'wisp', allies: ['nib', 'old-gristle', 'pip-the-sly'] };
    const fromThrow = validateLineup(lineup, flagon.roster, throws, config);
    expect(fromThrow.map((v) => v.code)).toEqual(['unknown_character']);
    expect(fromThrow[0]!.message).toContain('nib');
    expect(validateLineup(lineup, flagon.roster, fractional, config).map((v) => v.code)).toEqual(['unknown_character']);
  });

  it('reports every violation together', () => {
    // Duplicate captain, a non-owned ally, and over budget all at once.
    const t = tavern([
      ['big', 64],
      ['mid', 16],
      ['stranger', 8],
    ]);
    const roster: RosterView = { tavern: 'x', characters: ['big', 'mid'] };
    const lineup: Lineup = { captain: 'big', allies: ['big', 'mid', 'stranger'] };
    expect(validateLineup(lineup, roster, t.crOf, config).map((v) => v.code)).toEqual(['duplicate', 'not_owned', 'over_budget']);

    // Wrong size, not owned and unknown together.
    const short = { captain: 'ghost', allies: ['wisp', 'nib'] } as unknown as Lineup;
    expect(codes(short)).toEqual(['wrong_size', 'not_owned', 'unknown_character']);
  });

  it('sums fractional CRs exactly: four CR 1/8 total 4 eighths', () => {
    const t = tavern([
      ['rat-a', 1],
      ['rat-b', 1],
      ['rat-c', 1],
      ['rat-d', 1],
    ]);
    const rats: Lineup = { captain: 'rat-a', allies: ['rat-b', 'rat-c', 'rat-d'] };
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
    const lineup: Lineup = { captain: 'a', allies: ['b', 'c', 'd'] };
    expect(codes(lineup, t, configWithBudget(8))).toEqual([]);
    expect(codes(lineup, t, configWithBudget(7))).toEqual(['over_budget']);
  });
});

describe('carriedLineup', () => {
  it('returns a still-legal previous lineup as is', () => {
    const previous: Lineup = { captain: 'nib', allies: ['wisp', 'old-gristle', 'pip-the-sly'] };
    expect(carriedLineup(previous, flagon.roster, flagon.crOf, config)).toBe(previous);
  });

  it('falls back when a starter was traded away', () => {
    const previous: Lineup = { captain: 'nib', allies: ['wisp', 'old-gristle', 'traded-away'] };
    // Highest total ≤ 12: 4 + 3 + 3 + 2 = 12, the first four drafted.
    expect(carriedLineup(previous, flagon.roster, flagon.crOf, config)).toEqual(legal);
  });

  it('falls back when there is no previous lineup', () => {
    expect(carriedLineup(null, flagon.roster, flagon.crOf, config)).toEqual(legal);
  });

  it('falls back when the previous lineup is now over budget', () => {
    const tight = configWithBudget(48);
    // Best ≤ 6 is 5 3/4, reached by 4 + 1 + 1/2 + 1/4 (indices 0,4,5,6) and by
    // 3 + 2 + 1/2 + 1/4 (1,3,5,6 and 2,3,5,6). Index 0 comes first.
    expect(carriedLineup(legal, flagon.roster, flagon.crOf, tight)).toEqual({
      captain: 'bruno-the-bruiser',
      allies: ['old-gristle', 'wisp', 'nib'],
    });
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
    expect(carriedLineup(null, t.roster, t.crOf, config)).toEqual({ captain: 'zed', allies: ['yew', 'xan', 'wren'] });
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
    expect(carriedLineup(null, t.roster, t.crOf, config)).toEqual({ captain: 'r0', allies: ['r4', 'r5', 'r6'] });
  });

  it('makes the earliest-drafted member captain, even when it is not the strongest', () => {
    // r0 (CR 8) cannot fit, so the best party is r1..r4 (all CR 3).
    // The captain is r1, the earliest drafted of the four, although r2..r4 are equal and r1 is no stronger.
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
    expect(result).toEqual({ captain: 'r1', allies: ['r2', 'r3', 'r4'] });

    // A weak first pick still captains when it is in the best party.
    const u = tavern([
      ['weak', 2],
      ['s1', 30],
      ['s2', 32],
      ['s3', 32],
      ['s4', 40],
    ]);
    expect(carriedLineup(null, u.roster, u.crOf, config)).toEqual({ captain: 'weak', allies: ['s1', 's2', 's3'] });
  });

  it('skips characters whose CR is unknown', () => {
    const crOf = (id: string): CrEighths => {
      if (id === 'bruno-the-bruiser') throw new Error('missing');
      return flagon.crOf(id);
    };
    // Without bruno: 3 + 3 + 2 + 1 = 9.
    expect(carriedLineup(null, flagon.roster, crOf, config)).toEqual({
      captain: 'moss-hag',
      allies: ['tin-knight', 'pip-the-sly', 'old-gristle'],
    });
  });

  it('is deterministic and does not mutate its inputs', () => {
    const characters = Object.freeze([...flagon.roster.characters]);
    const roster = Object.freeze({ tavern: flagon.roster.tavern, characters });
    const allies = Object.freeze(['wisp', 'old-gristle', 'gone'] as const);
    const previous = Object.freeze({ captain: 'nib', allies }) as Lineup;
    const frozenConfig = Object.freeze(config);
    const first = carriedLineup(previous, roster, flagon.crOf, frozenConfig);
    const second = carriedLineup(previous, roster, flagon.crOf, frozenConfig);
    expect(second).toEqual(first);
    expect(first).toEqual(legal);
    expect(characters).toEqual(flagon.roster.characters);
    expect(previous).toEqual({ captain: 'nib', allies: ['wisp', 'old-gristle', 'gone'] });
  });
});
