import { describe, expect, it } from 'vitest';
import type { SeasonConfig } from '../src/league';
import { resolveWaivers, validateTrade, type RosterView, type TradeTerms, type WaiverClaim } from '../src/roster';
import type { CrEighths } from '../src/vocabulary';

/** Minimal season config; only `roster.size` and `trades.deadlineWeek` matter here. Shape as in lineup.test.ts. */
function seasonConfig(opts: { size?: number; deadlineWeek?: number | null } = {}): SeasonConfig {
  return {
    id: 'season-01',
    snapshot: 'open5e-v1-2026-10',
    modifierRegistryVersion: 1,
    weeks: 6,
    budget: { partyCr: 96 as CrEighths, modifierPointsPerCharacter: 3 },
    roster: { size: opts.size ?? 7, starters: 4, ownership: 'exclusive' },
    draft: { format: 'snake', rounds: 7, order: { mode: 'seeded' }, pickWindowHours: 24, onTimeout: 'autopick' },
    scoring: { pointsScale: 100 },
    waivers: { priority: 'rolling', initialOrder: 'reverse_draft' },
    trades: { vetoWindowHours: 24, vetoBy: 'commissioner', deadlineWeek: opts.deadlineWeek === undefined ? 4 : opts.deadlineWeek },
    missedLineup: 'carry_over',
    schedules: { lineupLock: '0 18 * * 4', weeklyRun: '15 18 * * 4', waivers: '0 12 * * 5' },
    secrecy: 'open',
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
    carryover: { mode: 'none', keepersPerTavern: 0, keeperCost: 'none', championBonusKeepers: 0, maxModifierChangePoints: 0 },
  };
}

/** Season 1: rosters of 7, trade deadline after week 4. */
const config = seasonConfig();

/** A roster of `count` characters named `<prefix>-1` … `<prefix>-<count>`. */
function roster(tavern: string, prefix: string, count = 7): RosterView {
  return { tavern, characters: Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`) };
}

const claim = (tavern: string, seq: number, add: string, drop: string | null = null): WaiverClaim => ({ tavern, add, drop, seq });

/** Award outcomes as compact tuples: [tavern, seq, reason]. */
function outcomes(result: ReturnType<typeof resolveWaivers>): Array<[string, number, string]> {
  return result.awards.map((a) => [a.claim.tavern, a.claim.seq, a.reason]);
}

const flagon = roster('flagon', 'f');
const boar = roster('boar', 'b');
const wyvern = roster('wyvern', 'w');
const rosters = [flagon, boar, wyvern];
const freeAgents: ReadonlySet<string> = new Set(['gnoll', 'harpy', 'kobold', 'ogre']);

describe('resolveWaivers: rolling priority (rules §9)', () => {
  it('gives a contested player to the higher priority, then moves the winner to the back', () => {
    // Priority boar > flagon > wyvern. Boar and flagon both want the gnoll.
    const result = resolveWaivers(
      [claim('flagon', 1, 'gnoll', 'f-7'), claim('boar', 2, 'gnoll', 'b-7')],
      ['boar', 'flagon', 'wyvern'],
      rosters,
      freeAgents,
      config,
    );
    expect(outcomes(result)).toEqual([
      ['boar', 2, 'awarded'],
      ['flagon', 1, 'add_unavailable'],
    ]);
    expect(result.awards.map((a) => a.awarded)).toEqual([true, false]);
    expect(result.priority).toEqual(['flagon', 'wyvern', 'boar']);
  });

  it('tries one claim per tavern per round, so a winner waits for everyone else before its next claim', () => {
    // Flagon (priority 1) wants the gnoll, then the harpy. Boar (priority 2) wants the harpy.
    // Round 1: flagon gets the gnoll and goes to the back; boar gets the harpy.
    // Round 2: flagon's harpy claim fails.
    const result = resolveWaivers(
      [claim('flagon', 1, 'gnoll', 'f-7'), claim('flagon', 2, 'harpy', 'f-6'), claim('boar', 3, 'harpy', 'b-7')],
      ['flagon', 'boar', 'wyvern'],
      rosters,
      freeAgents,
      config,
    );
    expect(outcomes(result)).toEqual([
      ['flagon', 1, 'awarded'],
      ['boar', 3, 'awarded'],
      ['flagon', 2, 'add_unavailable'],
    ]);
    expect(result.priority).toEqual(['wyvern', 'flagon', 'boar']);
  });

  it("tries a tavern's own claims in seq order, not input order", () => {
    // Both claims drop f-7, so only the first one tried can succeed.
    const result = resolveWaivers(
      [claim('flagon', 9, 'harpy', 'f-7'), claim('flagon', 4, 'gnoll', 'f-7')],
      ['flagon', 'boar', 'wyvern'],
      rosters,
      freeAgents,
      config,
    );
    expect(outcomes(result)).toEqual([
      ['flagon', 4, 'awarded'],
      ['flagon', 9, 'drop_not_owned'],
    ]);
  });

  it('still awards a later claim when an earlier one fails, and a loser keeps its place', () => {
    // Boar takes the gnoll first. Flagon's gnoll claim fails in round 1, its kobold claim wins in round 2.
    const result = resolveWaivers(
      [claim('boar', 1, 'gnoll', 'b-7'), claim('flagon', 2, 'gnoll', 'f-7'), claim('flagon', 3, 'kobold', 'f-7')],
      ['boar', 'flagon', 'wyvern'],
      rosters,
      freeAgents,
      config,
    );
    expect(outcomes(result)).toEqual([
      ['boar', 1, 'awarded'],
      ['flagon', 2, 'add_unavailable'],
      ['flagon', 3, 'awarded'],
    ]);
    // After round 1: flagon, wyvern, boar. Flagon wins in round 2 and goes to the back.
    expect(result.priority).toEqual(['wyvern', 'boar', 'flagon']);
  });

  it('leaves the priority unchanged when nobody wins', () => {
    const result = resolveWaivers([claim('wyvern', 1, 'dragon', 'w-1')], ['flagon', 'boar', 'wyvern'], rosters, freeAgents, config);
    expect(outcomes(result)).toEqual([['wyvern', 1, 'add_unavailable']]);
    expect(result.priority).toEqual(['flagon', 'boar', 'wyvern']);
    expect(resolveWaivers([], ['flagon', 'boar'], rosters, freeAgents, config)).toEqual({ awards: [], priority: ['flagon', 'boar'] });
  });
});

describe('resolveWaivers: drops and roster size', () => {
  it('does not let anyone claim a player dropped in the same run (rules §9: next window)', () => {
    // Flagon drops f-7 for the gnoll. Boar, later in the same round, claims f-7.
    const result = resolveWaivers(
      [claim('flagon', 1, 'gnoll', 'f-7'), claim('boar', 2, 'f-7', 'b-7')],
      ['flagon', 'boar', 'wyvern'],
      rosters,
      freeAgents,
      config,
    );
    expect(outcomes(result)).toEqual([
      ['flagon', 1, 'awarded'],
      ['boar', 2, 'add_unavailable'],
    ]);
  });

  it('rejects a claim without a drop on a full roster, and accepts one with an open slot', () => {
    const sixMan = roster('boar', 'b', 6);
    const result = resolveWaivers(
      [claim('flagon', 1, 'gnoll'), claim('boar', 2, 'harpy')],
      ['flagon', 'boar'],
      [flagon, sixMan],
      freeAgents,
      config,
    );
    expect(outcomes(result)).toEqual([
      ['flagon', 1, 'roster_full'],
      ['boar', 2, 'awarded'],
    ]);
    expect(result.priority).toEqual(['flagon', 'boar']);
  });

  it('sees roster changes from earlier awards in the same run', () => {
    // Boar has one open slot. Its first claim fills it, so its second (no drop) is now full.
    const result = resolveWaivers(
      [claim('boar', 1, 'gnoll'), claim('boar', 2, 'harpy')],
      ['boar'],
      [roster('boar', 'b', 6)],
      freeAgents,
      config,
    );
    expect(outcomes(result)).toEqual([
      ['boar', 1, 'awarded'],
      ['boar', 2, 'roster_full'],
    ]);
  });

  it('rejects a drop the tavern does not own', () => {
    const result = resolveWaivers([claim('flagon', 1, 'gnoll', 'b-1')], ['flagon', 'boar'], rosters, freeAgents, config);
    expect(outcomes(result)).toEqual([['flagon', 1, 'drop_not_owned']]);
    expect(result.priority).toEqual(['flagon', 'boar']);
  });

  it('reports add_unavailable before drop_not_owned before roster_full', () => {
    const result = resolveWaivers(
      [claim('flagon', 1, 'dragon', 'b-1'), claim('boar', 2, 'gnoll', 'f-1'), claim('wyvern', 3, 'harpy')],
      ['flagon', 'boar', 'wyvern'],
      rosters,
      freeAgents,
      config,
    );
    expect(outcomes(result).map(([, , reason]) => reason)).toEqual(['add_unavailable', 'drop_not_owned', 'roster_full']);
  });
});

describe('resolveWaivers: determinism and purity', () => {
  const claims = [
    claim('wyvern', 7, 'ogre', 'w-1'),
    claim('flagon', 3, 'gnoll', 'f-7'),
    claim('boar', 1, 'gnoll', 'b-7'),
    claim('boar', 5, 'harpy', 'b-6'),
    claim('flagon', 4, 'harpy', 'f-6'),
    claim('wyvern', 2, 'kobold'),
  ];
  const priority = ['wyvern', 'boar', 'flagon'];

  it('returns an award for every claim, the same way every time and for any input order', () => {
    const first = resolveWaivers(claims, priority, rosters, freeAgents, config);
    expect(first.awards).toHaveLength(claims.length);
    expect(resolveWaivers(claims, priority, rosters, freeAgents, config)).toEqual(first);
    expect(resolveWaivers([...claims].reverse(), priority, rosters, freeAgents, config)).toEqual(first);
    // Round 1: wyvern's kobold (seq 2) fails on a full roster, boar wins the gnoll, flagon loses it.
    // Round 2 (wyvern, flagon, boar): wyvern wins the ogre, flagon the harpy, boar's harpy fails.
    expect(outcomes(first)).toEqual([
      ['wyvern', 2, 'roster_full'],
      ['boar', 1, 'awarded'],
      ['flagon', 3, 'add_unavailable'],
      ['wyvern', 7, 'awarded'],
      ['flagon', 4, 'awarded'],
      ['boar', 5, 'add_unavailable'],
    ]);
    expect(first.priority).toEqual(['boar', 'wyvern', 'flagon']);
  });

  it('never mutates its inputs', () => {
    const claimsCopy = structuredClone(claims);
    const priorityCopy = [...priority];
    const rostersCopy = structuredClone(rosters);
    const fa = new Set(freeAgents);
    resolveWaivers(claims, priority, rosters, fa, config);
    expect(claims).toEqual(claimsCopy);
    expect(priority).toEqual(priorityCopy);
    expect(rosters).toEqual(rostersCopy);
    expect([...fa]).toEqual([...freeAgents]);
  });

  it('throws on a claim by a tavern outside the priority order, or a duplicated priority', () => {
    expect(() => resolveWaivers([claim('stranger', 1, 'gnoll')], priority, rosters, freeAgents, config)).toThrow(/not in the priority/);
    expect(() => resolveWaivers([], ['boar', 'boar'], rosters, freeAgents, config)).toThrow(/duplicates/);
  });
});

describe('validateTrade (rules §10)', () => {
  const trade = (give: ReadonlyArray<string>, receive: ReadonlyArray<string>, from = 'flagon', to = 'boar'): TradeTerms => ({
    from,
    to,
    give,
    receive,
  });
  const codes = (terms: TradeTerms, rs: ReadonlyArray<RosterView> = rosters, cfg = config, week?: number): string[] =>
    validateTrade(terms, rs, cfg, week === undefined ? undefined : { week }).map((v) => v.code);

  it('accepts a 1-for-1 and a 2-for-2 between full rosters', () => {
    expect(validateTrade(trade(['f-1'], ['b-1']), rosters, config)).toEqual([]);
    expect(validateTrade(trade(['f-1', 'f-2'], ['b-1', 'b-2']), rosters, config)).toEqual([]);
  });

  it('same_tavern', () => {
    expect(codes(trade(['f-1'], ['f-2'], 'flagon', 'flagon'))).toEqual(['same_tavern']);
  });

  it('empty_side, once per empty side', () => {
    expect(codes(trade([], ['b-1']), [flagon, roster('boar', 'b', 7)], seasonConfig({ size: 8 }))).toEqual(['empty_side']);
    expect(codes(trade([], []))).toEqual(['empty_side', 'empty_side']);
  });

  it('duplicate, once per repeated id across both sides', () => {
    const v = validateTrade(trade(['f-1', 'f-1', 'f-1'], ['b-1']), rosters, config);
    expect(v.filter((x) => x.code === 'duplicate')).toEqual([{ code: 'duplicate', message: '"f-1" appears 3 times in the trade' }]);
    // A piece on both sides is a duplicate, and also not owned by one of them.
    expect(codes(trade(['f-1'], ['f-1']))).toEqual(['duplicate', 'receive_not_owned']);
  });

  it("give_not_owned: a piece not on the giver's roster", () => {
    expect(codes(trade(['w-1'], ['b-1']))).toEqual(['give_not_owned']);
  });

  it("receive_not_owned: a piece not on the receiver's roster", () => {
    expect(codes(trade(['f-1'], ['w-1']))).toEqual(['receive_not_owned']);
  });

  it('roster_size: a 2-for-1 between full rosters overflows the side taking two', () => {
    const v = validateTrade(trade(['f-1', 'f-2'], ['b-1']), rosters, config);
    expect(v).toEqual([
      { code: 'roster_size', message: "boar's roster would go from 7 to 8; an uneven trade must leave it between 1 and 7" },
    ]);
  });

  it('roster_size: an uneven trade is allowed into open slots, but never empties a roster', () => {
    const sixMan = roster('boar', 'b', 6);
    // Flagon goes 7 → 6 and boar 6 → 7.
    expect(codes(trade(['f-1', 'f-2'], ['b-1']), [flagon, sixMan])).toEqual([]);
    // Boar would go 6 → 8.
    expect(codes(trade(['f-1', 'f-2', 'f-3'], ['b-1']), [flagon, sixMan])).toEqual(['roster_size']);
    // A one-character roster can trade its only piece for two (1 → 2), and flagon goes 7 → 6.
    const oneMan = roster('boar', 'b', 1);
    expect(codes(trade(['f-1', 'f-2'], ['b-1']), [flagon, oneMan])).toEqual([]);
    const tiny = roster('flagon', 'f', 2);
    // Flagon 2 → 0 is illegal even though boar has room (1 → 3).
    expect(codes(trade(['f-1', 'f-2'], []), [tiny, oneMan])).toEqual(['empty_side', 'roster_size']);
  });

  it('past_deadline only when a week is given and it is after the deadline', () => {
    const ok = trade(['f-1'], ['b-1']);
    expect(codes(ok, rosters, config)).toEqual([]);
    expect(codes(ok, rosters, config, 4)).toEqual([]);
    expect(codes(ok, rosters, config, 5)).toEqual(['past_deadline']);
    expect(codes(ok, rosters, seasonConfig({ deadlineWeek: null }), 99)).toEqual([]);
  });

  it('re-checks at completion: a piece lost to waivers since the proposal invalidates the trade', () => {
    const terms = trade(['f-7'], ['b-1']);
    expect(codes(terms)).toEqual([]);
    const { awards } = resolveWaivers([claim('flagon', 1, 'gnoll', 'f-7')], ['flagon', 'boar'], rosters, freeAgents, config);
    expect(awards[0]!.awarded).toBe(true);
    const flagonAfter: RosterView = { tavern: 'flagon', characters: [...flagon.characters.filter((c) => c !== 'f-7'), 'gnoll'] };
    expect(codes(terms, [flagonAfter, boar])).toEqual(['give_not_owned']);
  });

  it('reports every violation together, in code order', () => {
    const v = validateTrade(trade(['w-1', 'f-1', 'f-1', 'f-2'], ['x-9']), rosters, config, { week: 6 });
    expect(v.map((x) => x.code)).toEqual(['duplicate', 'give_not_owned', 'receive_not_owned', 'roster_size', 'past_deadline']);
    expect(codes(trade([], [], 'flagon', 'flagon'), rosters, config, 5)).toEqual(['same_tavern', 'empty_side', 'empty_side', 'past_deadline']);
  });

  it('never mutates its inputs', () => {
    const terms = trade(['f-1', 'f-1'], ['b-1']);
    const termsCopy = structuredClone(terms);
    const rostersCopy = structuredClone(rosters);
    validateTrade(terms, rosters, config, { week: 5 });
    expect(terms).toEqual(termsCopy);
    expect(rosters).toEqual(rostersCopy);
  });
});
