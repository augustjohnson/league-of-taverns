import { describe, expect, it } from 'vitest';
import type { BaseStats } from '../src/adapters/open5e';
import { TRAITS, effectiveStats } from '../src/characters';
import type { CheckSpec, Encounter } from '../src/missions';
import { battleOdds, checkOdds, injuredStarter, passChance, runMission, type BattleModel, type RunResult } from '../src/resolution';
import { rngFor, rollD20, weekSeed, type Rng } from '../src/rng';
// The engine has no YAML parser, so the example mission and Bruno's ref are
// read through the scripts loaders, as in missions.test.ts.
import { loadCharacterRef, loadMission } from '../../scripts/src/lib/repo';
import { baseOf, battle, check, constantModel, edge, end, member, missionOf, partyOf, skillCheck, start } from './support/builders';

const EXAMPLE_MISSION = 'seasons/season-01/missions/candidates/example-drowned-toll.yaml';

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
    it('picks the highest pass chance, even over an earlier starter', () => {
      const party = partyOf([member('cap', { skills: { stealth: 2 } }), member('b', { skills: { stealth: 5 } })]);
      expect(checkOdds(party, stealth(14))).toEqual({ actor: 'b', modifier: 5, advantage: false, eligible: true, pPass: 0.6 });
    });

    it('breaks ties in lineup order (there is no captain, D-12)', () => {
      const party = partyOf(
        [member('cap'), member('b', { skills: { stealth: 3 } }), member('c', { skills: { stealth: 3 } }), member('d', { skills: { stealth: 3 } })],
      );
      expect(checkOdds(party, stealth(12)).actor).toBe('b');
      const reordered = partyOf([party.members[0]!, party.members[3]!, party.members[2]!, party.members[1]!]);
      expect(checkOdds(reordered, stealth(12)).actor).toBe('d');
    });

    it('prefers advantage over an equal modifier, even over an earlier starter', () => {
      const party = partyOf([member('cap', { skills: { stealth: 3 } }), member('b', { skills: { stealth: 3 }, advantages: ['skill:stealth'] })]);
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
      // At DC 4 both are certain, so the tie goes to whoever is listed first.
      const swapped = partyOf([party.members[1]!, party.members[0]!]);
      expect(checkOdds(swapped, stealth(4)).actor).toBe('b');
      expect(checkOdds(party, stealth(4)).actor).toBe('cap');
    });

    it('throws on an empty party', () => {
      expect(() => checkOdds(partyOf([]), stealth(10))).toThrow(/no members/);
    });
  });

  describe('requires gate (D-39)', () => {
    const party = partyOf(
      [
        member('cap', { skills: { stealth: 6 }, senses: { darkvision: 60 } }),
        member('flier', { skills: { stealth: 1 }, speeds: { fly: 40 } }),
        member('swimmer', { skills: { stealth: 4 }, speeds: { swim: 30, fly: 0 } }),
      ],
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

// T6.3.
describe('runMission', () => {
  const SEED = 'season-01/week-1/tavern:test-tavern';
  const seeded = (seed: string) => (id: string) => rngFor(seed, 'roll:' + id);
  /** Each node's stream returns its listed values in order, then repeats the last. */
  const scripted =
    (values: Readonly<Record<string, ReadonlyArray<number>>>) =>
    (id: string): Rng => {
      const list = values[id] ?? [0];
      let i = 0;
      return () => list[Math.min(i++, list.length - 1)] ?? 0;
    };

  // start → a ─pass→ b ─pass/fail→ done
  //           └fail→ fight ─win→ b
  // a banks 40 and b banks 60, so the haul is 100.
  const branching = missionOf(
    [start(), skillCheck('a', 1, 'stealth', 12, 40), battle('fight', 2), skillCheck('b', 3, 'athletics', 10, 60), end('done', 4)],
    [
      edge('start', 'a', 'always'),
      edge('a', 'b', 'pass'),
      edge('a', 'fight', 'fail'),
      edge('fight', 'b', 'win'),
      edge('b', 'done', 'pass'),
      edge('b', 'done', 'fail'),
    ],
  );
  const party = partyOf([member('cap', { skills: { stealth: 2, athletics: 1 } }), member('ally', { skills: { athletics: 3 } })]);

  it('is deterministic for a seed, and each die depends only on its node id', () => {
    const first = runMission(party, branching, seeded(SEED), baseOf, constantModel(0.6));
    const again = runMission(party, branching, seeded(SEED), baseOf, constantModel(0.6));
    expect(again).toEqual(first);
    for (const record of first.nodes) {
      const rng = rngFor(SEED, 'roll:' + record.node);
      if (record.kind === 'check') expect(record.d20).toBe(rollD20(rng));
      else expect(record.roll).toBe(rng());
    }
    // Across seeds both routes to `b` occur, and b's die is the same either way.
    const routes = new Set<string>();
    for (let k = 0; k < 40; k++) {
      const seed = `${SEED}/k-${k}`;
      const run = runMission(party, branching, seeded(seed), baseOf, constantModel(1));
      routes.add(run.path.join(' '));
      const b = run.nodes.find((r) => r.node === 'b');
      expect(b?.kind === 'check' ? b.d20 : undefined).toBe(rollD20(rngFor(seed, 'roll:b')));
    }
    expect(routes).toEqual(new Set(['start a b done', 'start a fight b done']));
  });

  it('records each check, and scores loot banked / haul', () => {
    // a: d20 10 + 2 = 12 ≥ 12 passes. b: d20 6 + 3 = 9 < 10 fails.
    const run = runMission(party, branching, scripted({ a: [0.45], b: [0.25] }), baseOf, constantModel(0.6));
    expect(run).toEqual({
      path: ['start', 'a', 'b', 'done'],
      nodes: [
        { node: 'a', kind: 'check', actor: 'cap', d20: 10, modifier: 2, dc: 12, advantage: false, outcome: 'pass' },
        { node: 'b', kind: 'check', actor: 'ally', d20: 6, modifier: 3, dc: 10, advantage: false, outcome: 'fail' },
      ],
      dnf: false,
      retreatedBefore: null,
      checksPassed: 1,
      checksAttempted: 2,
      loot: 40,
      score: 0.4,
      injury: null,
    });
  });

  it('wins a battle iff roll < pWin', () => {
    const at = (roll: number): RunResult =>
      runMission(party, branching, scripted({ a: [0], fight: [roll], b: [0.99] }), baseOf, constantModel(0.5));
    const won = at(0.4999);
    expect(won.nodes[1]).toEqual({ node: 'fight', kind: 'battle', pWin: 0.5, roll: 0.4999, outcome: 'win' });
    expect(won.path).toEqual(['start', 'a', 'fight', 'b', 'done']);
    expect(won.loot).toBe(60);
    expect(won.score).toBe(0.6);
    expect(at(0.5).nodes[1]).toMatchObject({ outcome: 'lose' });
  });

  it('a lost battle is a DNF: the run stops there, here with nothing banked', () => {
    const run = runMission(party, branching, scripted({ a: [0], fight: [0.3], 'injury:fight': [0.7] }), baseOf, constantModel(0.2));
    expect(run).toEqual({
      path: ['start', 'a', 'fight'],
      nodes: [
        { node: 'a', kind: 'check', actor: 'cap', d20: 1, modifier: 2, dc: 12, advantage: false, outcome: 'fail' },
        { node: 'fight', kind: 'battle', pWin: 0.2, roll: 0.3, outcome: 'lose' },
      ],
      dnf: true,
      retreatedBefore: null,
      checksPassed: 0,
      checksAttempted: 1,
      loot: 0,
      score: 0,
      // floor(0.7 × 2 starters) = 1: the second starter is hurt (D-51).
      injury: { character: 'ally', roll: 0.7 },
    });
    // pWin 0 always loses, even on a roll of 0.
    expect(runMission(party, branching, scripted({ a: [0], fight: [0] }), baseOf, constantModel(0)).dnf).toBe(true);
  });

  it('a DNF injures one starter by its own roll, which a finished run never draws (D-51)', () => {
    const four = partyOf(['a', 'b', 'c', 'd'].map((id) => member(id)));
    const lost = (roll: number) => runMission(four, branching, scripted({ a: [0], fight: [0.9], 'injury:fight': [roll] }), baseOf, constantModel(0.5));
    expect([0, 0.25, 0.49, 0.5, 0.999].map((roll) => lost(roll).injury?.character)).toEqual(['a', 'b', 'b', 'c', 'd']);
    // The injury draw comes from its own stream, so the seeded run is unchanged by it.
    const failA = scripted({ a: [0] });
    const seeded = runMission(four, branching, (id) => (id === 'a' ? failA(id) : rngFor(SEED, 'roll:' + id)), baseOf, constantModel(0));
    expect(seeded.injury).toEqual({ character: injuredStarter(four.members, rngFor(SEED, 'roll:injury:fight')()).characterId, roll: rngFor(SEED, 'roll:injury:fight')() });
    // Off when a boon says so (D-52), and never on a finished run or a retreat.
    expect(runMission(four, branching, scripted({ a: [0], fight: [0.9] }), baseOf, constantModel(0.5), { injuries: false })).toMatchObject({ dnf: true, injury: null });
    expect(runMission(four, branching, scripted({ a: [0.99] }), baseOf, constantModel(0.5)).injury).toBeNull();
    expect(runMission(four, branching, scripted({ a: [0] }), baseOf, constantModel(0.5), { retreat: 'avoid_battles' }).injury).toBeNull();
  });

  it('a DNF keeps the loot banked before the lost battle (D-46)', () => {
    // start → a (30) → fight → b (70) → done: haul 100.
    const late = missionOf(
      [start(), skillCheck('a', 1, 'stealth', 12, 30), battle('fight', 2), skillCheck('b', 3, 'athletics', 10, 70), end('done', 4)],
      [edge('start', 'a', 'always'), edge('a', 'fight', 'always'), edge('fight', 'b', 'win'), edge('b', 'done', 'always')],
    );
    const run = runMission(party, late, scripted({ a: [0.45], fight: [0.9] }), baseOf, constantModel(0.5));
    expect(run).toMatchObject({ path: ['start', 'a', 'fight'], dnf: true, checksPassed: 1, loot: 30, score: 0.3 });
  });

  it('banks a battle\'s loot on a win, and nothing on a loss (D-50)', () => {
    // start → a (30) → fight (bounty 50) → b (20) → done: haul 100.
    const bounty = missionOf(
      [start(), skillCheck('a', 1, 'stealth', 12, 30), { ...battle('fight', 2), loot: 50 }, skillCheck('b', 3, 'athletics', 10, 20), end('done', 4)],
      [edge('start', 'a', 'always'), edge('a', 'fight', 'always'), edge('fight', 'b', 'win'), edge('b', 'done', 'always')],
    );
    const won = runMission(party, bounty, scripted({ a: [0.45], fight: [0.1], b: [0.9] }), baseOf, constantModel(0.5));
    expect(won).toMatchObject({ dnf: false, retreatedBefore: null, checksPassed: 2, loot: 100, score: 1 });
    const lost = runMission(party, bounty, scripted({ a: [0.45], fight: [0.9] }), baseOf, constantModel(0.5));
    expect(lost).toMatchObject({ dnf: true, loot: 30, score: 0.3 });
  });

  describe('retreat orders (D-49)', () => {
    // start → a (30) → fight (bounty 50) → b (20) → done, and a ─fail→ fight too.
    const late = missionOf(
      [start(), skillCheck('a', 1, 'stealth', 12, 30), { ...battle('fight', 2), loot: 50 }, skillCheck('b', 3, 'athletics', 10, 20), end('done', 4)],
      [edge('start', 'a', 'always'), edge('a', 'fight', 'always'), edge('fight', 'b', 'win'), edge('b', 'done', 'always')],
    );
    const dice = scripted({ a: [0.45], fight: [0.9], b: [0.9] });

    it('never: fights every battle (the default)', () => {
      expect(runMission(party, late, dice, baseOf, constantModel(0.5))).toEqual(
        runMission(party, late, dice, baseOf, constantModel(0.5), { retreat: 'never' }),
      );
      expect(runMission(party, late, dice, baseOf, constantModel(0.5)).dnf).toBe(true);
    });

    it('avoid_battles: turns back before the first battle, keeping its loot, with no DNF and no die drawn', () => {
      let drawn = false;
      const watch = (id: string): Rng => {
        if (id === 'fight') drawn = true;
        return dice(id);
      };
      const run = runMission(party, late, watch, baseOf, constantModel(0.5), { retreat: 'avoid_battles' });
      expect(run).toEqual({
        path: ['start', 'a'],
        nodes: [{ node: 'a', kind: 'check', actor: 'cap', d20: 10, modifier: 2, dc: 12, advantage: false, outcome: 'pass' }],
        dnf: false,
        retreatedBefore: 'fight',
        checksPassed: 1,
        checksAttempted: 1,
        loot: 30,
        score: 0.3,
        injury: null,
      });
      expect(drawn).toBe(false);
    });

    it('bank: N turns back only once N loot is banked', () => {
      // Passing a banks 30: bank 30 turns back, bank 31 fights.
      expect(runMission(party, late, dice, baseOf, constantModel(0.5), { retreat: { bank: 30 } }).retreatedBefore).toBe('fight');
      expect(runMission(party, late, dice, baseOf, constantModel(0.5), { retreat: { bank: 31 } })).toMatchObject({ retreatedBefore: null, dnf: true });
      // Failing a banks nothing, so even bank 1 fights; bank 0 is avoid_battles.
      const failA = scripted({ a: [0], fight: [0.1], b: [0.9] });
      expect(runMission(party, late, failA, baseOf, constantModel(0.5), { retreat: { bank: 1 } })).toMatchObject({ retreatedBefore: null, loot: 70 });
      expect(runMission(party, late, failA, baseOf, constantModel(0.5), { retreat: { bank: 0 } }).retreatedBefore).toBe('fight');
    });
  });

  it('with advantage, draws a second d20 from the same stream and keeps the higher', () => {
    const lucky = partyOf([member('a', { skills: { stealth: 2 }, advantages: ['skill:stealth'] })]);
    const one = missionOf([start(), skillCheck('c', 1, 'stealth', 16), end('done', 2)], [edge('start', 'c', 'always'), edge('c', 'done', 'always')]);
    // 3 and 15: keeps 15, and 15 + 2 ≥ 16. 13 and 2: keeps 13, and 13 + 2 < 16.
    const high = runMission(lucky, one, scripted({ c: [0.1, 0.7] }), baseOf, constantModel(1));
    expect(high.nodes[0]).toMatchObject({ d20: 15, advantage: true, outcome: 'pass' });
    const low = runMission(lucky, one, scripted({ c: [0.6, 0.05] }), baseOf, constantModel(1));
    expect(low.nodes[0]).toMatchObject({ d20: 13, advantage: true, outcome: 'fail' });
    // A check with one `always` edge still counts.
    expect(low).toMatchObject({ path: ['start', 'c', 'done'], checksAttempted: 1, checksPassed: 0, score: 0 });
  });

  it('has no natural-20 rule', () => {
    const weak = partyOf([member('a', { skills: { stealth: -5 } })]);
    const one = missionOf([start(), skillCheck('c', 1, 'stealth', 16), end('done', 2)], [edge('start', 'c', 'always'), edge('c', 'done', 'always')]);
    expect(runMission(weak, one, scripted({ c: [0.99] }), baseOf, constantModel(1)).nodes[0]).toMatchObject({ d20: 20, outcome: 'fail' });
  });

  it('auto-fails a gated check nobody qualifies for, but still records its die', () => {
    const gated = missionOf(
      [start(), check('c', 1, { type: 'skill', skill: 'stealth', dc: 2, requires: { speed: 'fly' } }), end('done', 2)],
      [edge('start', 'c', 'always'), edge('c', 'done', 'pass'), edge('c', 'done', 'fail')],
    );
    const run = runMission(party, gated, scripted({ c: [0.99] }), baseOf, constantModel(1));
    expect(run.nodes).toEqual([{ node: 'c', kind: 'check', actor: 'cap', d20: 20, modifier: 2, dc: 2, advantage: false, outcome: 'fail' }]);
    expect(run.score).toBe(0);
  });

  it('throws on a mission it cannot walk', () => {
    const noStart = missionOf([skillCheck('c', 1, 'stealth', 10), end('done', 2)], [edge('c', 'done', 'always')]);
    expect(() => runMission(party, noStart, seeded(SEED), baseOf, constantModel(1))).toThrow(/exactly one start/);
    const deadEnd = missionOf([start(), skillCheck('c', 1, 'stealth', 10), end('done', 2)], [edge('start', 'c', 'always'), edge('c', 'done', 'pass')]);
    expect(() => runMission(party, deadEnd, scripted({ c: [0] }), baseOf, constantModel(1))).toThrow(/no `fail` edge/);
    const flat = missionOf([start(), skillCheck('c', 1, 'stealth', 10), end('done', 1)], [edge('start', 'c', 'always'), edge('c', 'done', 'always')]);
    expect(() => runMission(party, flat, scripted({}), baseOf, constantModel(1))).toThrow(/higher rank/);
  });

  it('pinned regression: Bruno solo on the example mission', () => {
    // seasons/season-01/pool.yaml: ogre + intimidation +2 + thick-skull.
    const ref = loadCharacterRef('bruno-the-bruiser');
    const bruno = effectiveStats(
      {
        ref,
        modifiers: [
          { kind: 'skill_bonus', skill: 'intimidation', value: 2 },
          { kind: 'trait', trait: 'thick-skull' },
        ],
      },
      baseOf(ref.base),
      TRAITS,
    );
    const seed = weekSeed({ season: 'season-01', week: 1, tavern: 'bruno-solo' });
    const run = runMission(partyOf([bruno]), loadMission(EXAMPLE_MISSION), seeded(seed), baseOf, constantModel(0.5));
    // Survival −2 vs DC 12 fails on a 12, the bog ambush is won (0.347 < 0.5),
    // and Athletics +4 vs DC 13 passes on a 14, banking haul-chain's 50 of 100.
    expect(run).toEqual({
      path: ['start', 'find-path', 'bog-ambush', 'haul-chain', 'crossed-dry'],
      nodes: [
        { node: 'find-path', kind: 'check', actor: 'bruno-the-bruiser', d20: 12, modifier: -2, dc: 12, advantage: false, outcome: 'fail' },
        { node: 'bog-ambush', kind: 'battle', pWin: 0.5, roll: 0.34700014791451395, outcome: 'win' },
        { node: 'haul-chain', kind: 'check', actor: 'bruno-the-bruiser', d20: 14, modifier: 4, dc: 13, advantage: false, outcome: 'pass' },
      ],
      dnf: false,
      retreatedBefore: null,
      checksPassed: 1,
      checksAttempted: 2,
      loot: 50,
      score: 0.5,
      injury: null,
    });
  });
});
