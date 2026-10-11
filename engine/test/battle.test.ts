import { describe, expect, it } from 'vitest';
import { toBaseStats, type BaseStats } from '../src/adapters/open5e';
import { TRAITS, effectiveStats, type EffectiveStats } from '../src/characters';
import type { Party } from '../src/resolution';
import {
  BATTLE_MODELS,
  EV_TTK_V0_K,
  NONMAGICAL_EHP_FACTOR,
  P_WIN_RANGE,
  attackHitChance,
  evTtkBreakdown,
  evTtkV0,
} from '../src/resolution/battle';
import { FIXTURE_SLUGS, loadFixture } from './fixtures/open5e';

type Foes = Array<{ readonly stats: BaseStats; readonly count: number }>;

const BASE: ReadonlyMap<string, BaseStats> = new Map(FIXTURE_SLUGS.map((slug) => [slug, toBaseStats(loadFixture(slug)).stats]));

function base(slug: string): BaseStats {
  const stats = BASE.get(slug);
  if (stats === undefined) throw new Error(`no fixture "${slug}"`);
  return stats;
}

function member(slug: string, battleBonus = 0): EffectiveStats {
  const stats = effectiveStats({ ref: { id: `test-${slug}`, base: slug }, modifiers: [] }, base(slug), TRAITS);
  return { ...stats, battleBonus };
}

function party(...members: ReadonlyArray<EffectiveStats | string>): Party {
  const stats = members.map((m) => (typeof m === 'string' ? member(m) : m));
  return { captain: stats[0]?.characterId ?? '', members: stats };
}

function foes(...entries: ReadonlyArray<readonly [string, number]>): Foes {
  return entries.map(([slug, count]) => ({ stats: base(slug), count }));
}

/** Ogre captain with three allies averaging CR 1 (1/2 + 1/2 + 2). */
const BOG_PARTY = party('ogre', 'black-bear', 'lizardfolk', 'bandit-captain');
/** example-drowned-toll, node bog-ambush. */
const BOG_AMBUSH = foes(['crocodile', 3], ['giant-frog', 4]);

describe('attackHitChance', () => {
  it('needs 21 − (AC − bonus) on a d20', () => {
    expect(attackHitChance(5, 15)).toBeCloseTo(0.55, 12);
    expect(attackHitChance(4, 11)).toBeCloseTo(0.7, 12);
  });

  it('a natural 1 always misses and a natural 20 always hits', () => {
    expect(attackHitChance(0, 30)).toBe(0.05);
    expect(attackHitChance(30, 10)).toBe(0.95);
  });
});

describe('battle model ev-ttk-v0', () => {
  it('is registered by id', () => {
    expect(evTtkV0.id).toBe('ev-ttk-v0');
    expect(BATTLE_MODELS['ev-ttk-v0']).toBe(evTtkV0);
  });

  it('equal mirrored sides give 0.5', () => {
    const slugs = ['ogre', 'black-bear', 'lizardfolk', 'bandit-captain'];
    expect(evTtkV0.pWin(party(...slugs), slugs.map((s) => ({ stats: base(s), count: 1 })))).toBeCloseTo(0.5, 12);
    expect(evTtkV0.pWin(party('ghost', 'ghost', 'werewolf', 'werewolf'), foes(['ghost', 2], ['werewolf', 2]))).toBeCloseTo(0.5, 12);
  });

  it('a stronger party has higher p', () => {
    const weak = evTtkV0.pWin(party('ogre', 'giant-badger', 'lizardfolk', 'bandit-captain'), BOG_AMBUSH);
    const mid = evTtkV0.pWin(BOG_PARTY, BOG_AMBUSH);
    const strong = evTtkV0.pWin(party('ogre', 'werewolf', 'lizardfolk', 'bandit-captain'), BOG_AMBUSH);
    expect(weak).toBeLessThan(mid);
    expect(mid).toBeLessThan(strong);
  });

  it('battleBonus raises party DPR by 5% per point, and p with it', () => {
    const plain = evTtkBreakdown(BOG_PARTY, BOG_AMBUSH);
    const bonus = evTtkBreakdown(party(member('ogre', 1), 'black-bear', member('lizardfolk', 1), 'bandit-captain'), BOG_AMBUSH);
    expect(bonus.partyDpr).toBeCloseTo(plain.partyDpr * 1.1, 9);
    expect(bonus.foeDpr).toBe(plain.foeDpr);
    expect(bonus.pWin).toBeGreaterThan(plain.pWin);
  });

  it('more foes give lower p', () => {
    let previous = 1;
    for (let crocodiles = 1; crocodiles <= 12; crocodiles++) {
      const p = evTtkV0.pWin(BOG_PARTY, foes(['crocodile', crocodiles], ['giant-frog', 4]));
      if (previous > P_WIN_RANGE.min) expect(p).toBeLessThan(previous);
      else expect(p).toBe(P_WIN_RANGE.min);
      previous = p;
    }
    expect(evTtkV0.pWin(BOG_PARTY, [...BOG_AMBUSH, ...foes(['grimlock', 1])])).toBeLessThan(evTtkV0.pWin(BOG_PARTY, BOG_AMBUSH));
  });

  describe('zero damage', () => {
    it('a party that deals no damage cannot win', () => {
      expect(evTtkV0.pWin(party('frog', 'frog', 'frog', 'frog'), BOG_AMBUSH)).toBe(P_WIN_RANGE.min);
      expect(evTtkV0.pWin(party(member('ogre', -20)), BOG_AMBUSH)).toBe(P_WIN_RANGE.min);
    });

    it('foes that deal no damage cannot win', () => {
      expect(evTtkV0.pWin(BOG_PARTY, foes(['frog', 6]))).toBe(P_WIN_RANGE.max);
    });

    it('when neither side deals damage, the party still has not won', () => {
      expect(evTtkV0.pWin(party('frog'), foes(['frog', 1]))).toBe(P_WIN_RANGE.min);
    });

    it('an empty encounter is a win and an empty party a loss', () => {
      expect(evTtkV0.pWin(BOG_PARTY, [])).toBe(P_WIN_RANGE.max);
      expect(evTtkV0.pWin(BOG_PARTY, foes(['crocodile', 0]))).toBe(P_WIN_RANGE.max);
      expect(evTtkV0.pWin(party(), BOG_AMBUSH)).toBe(P_WIN_RANGE.min);
    });

    it('every result is a finite number', () => {
      const breakdown = evTtkBreakdown(party('frog'), BOG_AMBUSH);
      expect(breakdown.ttkParty).toBe(Infinity);
      expect(breakdown.logit).toBe(-Infinity);
      expect(Number.isFinite(breakdown.pWin)).toBe(true);
    });
  });

  it('stays within [0.02, 0.98]', () => {
    expect(evTtkV0.pWin(BOG_PARTY, foes(['purple-worm', 6]))).toBe(0.02);
    expect(evTtkV0.pWin(party('young-red-dragon', 'hydra'), foes(['bat', 1]))).toBe(0.98);
    for (const a of FIXTURE_SLUGS) {
      for (const b of FIXTURE_SLUGS) {
        const p = evTtkV0.pWin(party(a, 'ogre'), foes([b, 2]));
        expect(p).toBeGreaterThanOrEqual(P_WIN_RANGE.min);
        expect(p).toBeLessThanOrEqual(P_WIN_RANGE.max);
      }
    }
  });

  it('is deterministic and does not mutate its input', () => {
    const encounter = Object.freeze(BOG_AMBUSH.map((f) => Object.freeze({ ...f })));
    const frozenParty = Object.freeze({ ...BOG_PARTY, members: Object.freeze([...BOG_PARTY.members]) });
    const first = evTtkV0.pWin(frozenParty, encounter);
    expect(evTtkV0.pWin(frozenParty, encounter)).toBe(first);
    expect(evTtkV0.pWin(party('ogre', 'black-bear', 'lizardfolk', 'bandit-captain'), foes(['crocodile', 3], ['giant-frog', 4]))).toBe(first);
  });

  it('targets the opposing side’s HP-weighted mean AC', () => {
    const b = evTtkBreakdown(party('ogre', 'lizardfolk'), foes(['bandit-captain', 1], ['bat', 3]));
    expect(b.partyTargetAc).toBeCloseTo((15 * 65 + 12 * 3) / 68, 12);
    expect(b.foeTargetAc).toBeCloseTo((11 * 59 + 15 * 22) / 81, 12);
  });

  it('scales the HP of creatures resistant or immune to nonmagical weapons', () => {
    expect(evTtkBreakdown(BOG_PARTY, foes(['ghost', 1])).foeEhp).toBeCloseTo(45 * NONMAGICAL_EHP_FACTOR.resist, 12);
    expect(evTtkBreakdown(BOG_PARTY, foes(['werewolf', 2])).foeEhp).toBeCloseTo(2 * 58 * NONMAGICAL_EHP_FACTOR.immune, 12);
    expect(evTtkBreakdown(party('werewolf'), BOG_AMBUSH).partyEhp).toBeCloseTo(58 * NONMAGICAL_EHP_FACTOR.immune, 12);
  });

  it('rejects a negative or fractional count', () => {
    expect(() => evTtkV0.pWin(BOG_PARTY, foes(['crocodile', -1]))).toThrow(RangeError);
    expect(() => evTtkV0.pWin(BOG_PARTY, foes(['crocodile', 1.5]))).toThrow(RangeError);
  });

  it('pins the bog-ambush: ogre, black bear, lizardfolk, bandit captain vs 3 crocodiles + 4 giant frogs', () => {
    const b = evTtkBreakdown(BOG_PARTY, BOG_AMBUSH);
    // Foes: 3 × 19 + 4 × 18 = 129 HP, all AC 12 or 11 → target AC (12 × 57 + 11 × 72) / 129.
    expect(b.foeEhp).toBe(129);
    expect(b.partyTargetAc).toBeCloseTo((12 * 57 + 11 * 72) / 129, 12);
    // Party: 59 + 19 + 22 + 65 = 165 HP.
    expect(b.partyEhp).toBe(165);
    expect(b.foeTargetAc).toBeCloseTo(2163 / 165, 12);
    // Party vs AC 11.44: ogre 13 × 0.778, bear 12 × 0.678, lizardfolk 10 × 0.678, captain 17 × 0.728.
    expect(b.partyDpr).toBeCloseTo(37.40116279, 6);
    // Foes vs AC 13.11: crocodiles 3 × 7 × 0.595, frogs 4 × 4 × 0.545.
    expect(b.foeDpr).toBeCloseTo(21.19818182, 6);
    // TTK 3.45 rounds for the party, 7.78 for the foes.
    expect(b.logit).toBeCloseTo(EV_TTK_V0_K * Math.log(b.ttkFoe / b.ttkParty), 12);
    expect(b.pWin).toBeCloseTo(0.734465707, 6);
  });
});
