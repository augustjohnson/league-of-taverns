import { describe, expect, it } from 'vitest';
import type { BaseStats } from '../src/adapters/open5e';
import type { CheckSpec, Encounter } from '../src/missions';
import { battleOdds, checkOdds, passChance, type BattleModel } from '../src/resolution';
import { baseOf, constantModel, member, partyOf } from './support/builders';

const stealth = (dc: number, extra: Partial<CheckSpec> = {}): CheckSpec => ({ type: 'skill', skill: 'stealth', dc, ...extra }) as CheckSpec;

// T6.1.
describe('checkOdds', () => {
  describe('pass chance across DC − mod from −20 to +20', () => {
    const mod = 4;
    for (let diff = -20; diff <= 20; diff++) {
      // p = (21 − diff) / 20, clamped: every diff ≤ 1 passes on any d20.
      const expected = diff <= 1 ? 1 : (21 - diff) / 20;
      it(`DC − mod = ${diff} → ${expected}`, () => {
        const odds = checkOdds(partyOf([member('a', { skills: { stealth: mod } })]), stealth(mod + diff));
        expect(odds.pPass).toBeCloseTo(expected, 12);
        expect(odds.modifier).toBe(mod);
        expect(odds.eligible).toBe(true);
        expect(odds.advantage).toBe(false);
      });
    }
  });

  it('clamps to 0 once DC − mod reaches 21, and to 1 well below 1', () => {
    expect(passChance(0, 21, false)).toBe(0);
    expect(passChance(0, 40, false)).toBe(0);
    expect(passChance(0, 40, true)).toBe(0);
    expect(passChance(0, 20, false)).toBeCloseTo(0.05, 12);
    expect(passChance(0, 2, false)).toBeCloseTo(0.95, 12);
    expect(passChance(0, 1, false)).toBe(1);
    expect(passChance(30, 5, false)).toBe(1);
    expect(passChance(30, 5, true)).toBe(1);
  });

  it('reads skills for a skill check, saves for a save, ability modifiers for an ability check', () => {
    const party = partyOf([member('a', { skills: { athletics: 5 }, saves: { str: 3 }, abilityMods: { str: 1 } })]);
    expect(checkOdds(party, { type: 'skill', skill: 'athletics', dc: 15 }).modifier).toBe(5);
    expect(checkOdds(party, { type: 'save', ability: 'str', dc: 15 }).modifier).toBe(3);
    expect(checkOdds(party, { type: 'ability', ability: 'str', dc: 15 }).modifier).toBe(1);
    expect(checkOdds(party, { type: 'ability', ability: 'str', dc: 15 }).pPass).toBeCloseTo(0.35, 12);
  });

  describe('advantage', () => {
    it('is 1 − (1 − p)²', () => {
      for (const [mod, dc, p] of [
        [0, 11, 0.5],
        [0, 20, 0.05],
        [3, 13, 0.55],
        [0, 2, 0.95],
      ] as const) {
        const withAdv = partyOf([member('a', { skills: { stealth: mod }, advantages: ['skill:stealth'] })]);
        const odds = checkOdds(withAdv, stealth(dc));
        expect(odds.advantage).toBe(true);
        expect(odds.pPass).toBeCloseTo(1 - (1 - p) ** 2, 12);
      }
      expect(passChance(0, 11, true)).toBe(0.75);
    });

    it('applies only to the matching check target', () => {
      const party = partyOf([member('a', { skills: { stealth: 2 }, saves: { dex: 2 }, advantages: ['save:dex'] })]);
      expect(checkOdds(party, stealth(12)).advantage).toBe(false);
      expect(checkOdds(party, { type: 'save', ability: 'dex', dc: 12 }).advantage).toBe(true);
      expect(checkOdds(party, { type: 'ability', ability: 'dex', dc: 12 }).advantage).toBe(false);
    });
  });

  describe('best fit and tiebreak (D-15)', () => {
    it('picks the highest pass chance, even over the captain', () => {
      const party = partyOf([member('cap', { skills: { stealth: 2 } }), member('b', { skills: { stealth: 5 } })], 'cap');
      expect(checkOdds(party, stealth(14))).toEqual({ actor: 'b', modifier: 5, advantage: false, eligible: true, pPass: 0.6 });
    });

    it('breaks a tie in favour of the captain, wherever it sits in the lineup', () => {
      const party = partyOf(
        [member('a', { skills: { stealth: 3 } }), member('b', { skills: { stealth: 3 } }), member('cap', { skills: { stealth: 3 } })],
        'cap',
      );
      expect(checkOdds(party, stealth(12)).actor).toBe('cap');
    });

    it('then breaks ties in lineup order', () => {
      const party = partyOf(
        [member('cap'), member('b', { skills: { stealth: 3 } }), member('c', { skills: { stealth: 3 } }), member('d', { skills: { stealth: 3 } })],
        'cap',
      );
      expect(checkOdds(party, stealth(12)).actor).toBe('b');
      const reordered = partyOf([party.members[0]!, party.members[3]!, party.members[2]!, party.members[1]!], 'cap');
      expect(checkOdds(reordered, stealth(12)).actor).toBe('d');
    });

    it('prefers advantage over an equal modifier, even over the captain', () => {
      const party = partyOf(
        [member('cap', { skills: { stealth: 3 } }), member('b', { skills: { stealth: 3 }, advantages: ['skill:stealth'] })],
        'cap',
      );
      const odds = checkOdds(party, stealth(13));
      expect(odds.actor).toBe('b');
      expect(odds.advantage).toBe(true);
      expect(odds.pPass).toBeCloseTo(1 - 0.45 ** 2, 12);
    });

    it('lets advantage beat a higher modifier when its pass chance is higher', () => {
      // +3 with advantage at DC 13: 1 − 0.45² = 0.7975 beats +5 at 0.65.
      const party = partyOf([member('cap', { skills: { stealth: 5 } }), member('b', { skills: { stealth: 3 }, advantages: ['skill:stealth'] })]);
      expect(checkOdds(party, stealth(13)).actor).toBe('b');
      // At DC 6 the +5 is certain (1) and beats advantage (0.99).
      expect(checkOdds(party, stealth(6)).actor).toBe('cap');
      // At DC 4 both are certain, so the tie goes to the captain.
      const swapped = partyOf([party.members[0]!, party.members[1]!], 'b');
      expect(checkOdds(swapped, stealth(4)).actor).toBe('b');
      expect(checkOdds(party, stealth(4)).actor).toBe('cap');
    });

    it('treats the captain like anyone else when there is no tie (D-12)', () => {
      const party = partyOf([member('a', { skills: { stealth: 1 } }), member('cap', { skills: { stealth: 0 } })], 'cap');
      const odds = checkOdds(party, stealth(10));
      expect(odds.actor).toBe('a');
      expect(odds.pPass).toBeCloseTo(0.6, 12);
    });

    it('throws on an empty party or a captain who is not a member', () => {
      expect(() => checkOdds(partyOf([], 'x'), stealth(10))).toThrow(/no members/);
      expect(() => checkOdds(partyOf([member('a')], 'x'), stealth(10))).toThrow(/captain "x"/);
    });
  });

  describe('requires gate (D-39)', () => {
    const party = partyOf(
      [
        member('cap', { skills: { stealth: 6 }, senses: { darkvision: 60 } }),
        member('flier', { skills: { stealth: 1 }, speeds: { fly: 40 } }),
        member('swimmer', { skills: { stealth: 4 }, speeds: { swim: 30, fly: 0 } }),
      ],
      'cap',
    );

    it('limits the actor to starters with the speed', () => {
      expect(checkOdds(party, stealth(12, { requires: { speed: 'fly' } }))).toEqual({
        actor: 'flier',
        modifier: 1,
        advantage: false,
        eligible: true,
        pPass: 0.5,
      });
    });

    it('limits the actor to starters with the sense', () => {
      const odds = checkOdds(party, stealth(12, { requires: { sense: 'darkvision' } }));
      expect(odds.actor).toBe('cap');
      expect(odds.eligible).toBe(true);
      expect(odds.pPass).toBeCloseTo(0.75, 12);
    });

    it('auto-fails when nobody qualifies, with a best-fit actor for the story', () => {
      expect(checkOdds(party, stealth(12, { requires: { speed: 'burrow' } }))).toEqual({
        actor: 'cap',
        modifier: 6,
        advantage: false,
        eligible: false,
        pPass: 0,
      });
      expect(checkOdds(party, stealth(12, { requires: { sense: 'tremorsense' } })).eligible).toBe(false);
    });

    it('does not count a speed of 0 feet', () => {
      const grounded = partyOf([member('a', { speeds: { fly: 0 } })]);
      expect(checkOdds(grounded, stealth(5, { requires: { speed: 'fly' } })).eligible).toBe(false);
    });

    it('is ignored when absent', () => {
      expect(checkOdds(party, stealth(12)).actor).toBe('cap');
    });
  });
});

describe('battleOdds', () => {
  const encounter: Encounter = {
    creatures: [
      { ref: 'crocodile', count: 3 },
      { ref: 'giant-frog', count: 4 },
    ],
  };

  it('passes the party and each creature as { stats: baseOf(ref), count } to the model', () => {
    const party = partyOf([member('a')]);
    const seen: Array<{ readonly slug: string; readonly count: number }> = [];
    const model: BattleModel = {
      id: 'spy',
      pWin(p, foes) {
        expect(p).toBe(party);
        for (const foe of foes) seen.push({ slug: foe.stats.slug, count: foe.count });
        return 0.4;
      },
    };
    expect(battleOdds(party, encounter, baseOf, model)).toEqual({ pWin: 0.4 });
    expect(seen).toEqual([
      { slug: 'crocodile', count: 3 },
      { slug: 'giant-frog', count: 4 },
    ]);
  });

  it('clamps the model to [0, 1] and rejects NaN', () => {
    const party = partyOf([member('a')]);
    const stub = (_slug: string): BaseStats => baseOf('bat');
    expect(battleOdds(party, encounter, stub, constantModel(1.7)).pWin).toBe(1);
    expect(battleOdds(party, encounter, stub, constantModel(-0.2)).pWin).toBe(0);
    expect(() => battleOdds(party, encounter, stub, constantModel(Number.NaN))).toThrow(/NaN/);
  });
});
