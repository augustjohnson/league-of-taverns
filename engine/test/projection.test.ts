import { describe, expect, it } from 'vitest';
import { projectMission, type Projection } from '../src/projection';
import { checkOdds, runMission } from '../src/resolution';
import { rngFor } from '../src/rng';
import { randomMission, randomParty, randomRetreat } from './support/generators';
// The engine has no YAML parser, so the example mission is read through the
// scripts loader, as in missions.test.ts.
import { loadMission } from '../../scripts/src/lib/repo';
import { baseOf, battle, check, constantModel, crModel, edge, end, member, missionOf, partyOf, skillCheck, start } from './support/builders';

const EXAMPLE_MISSION = 'seasons/season-01/missions/candidates/example-drowned-toll.yaml';

/** Σ probability over the distribution. */
const total = (projection: Projection): number => projection.distribution.reduce((sum, [, p]) => sum + p, 0);

function expectDistribution(projection: Projection, expected: ReadonlyArray<readonly [number, number]>): void {
  expect(projection.distribution.map(([score]) => score)).toEqual(expected.map(([score]) => score));
  projection.distribution.forEach(([, p], i) => expect(p).toBeCloseTo(expected[i]?.[1] ?? Number.NaN, 12));
}

// T6.4.
describe('projection', () => {
  const zero = partyOf([member('a')]);

  it('a single check with p = 0.55 projects 0.55', () => {
    // +2 vs DC 12: (21 − 10) / 20.
    const party = partyOf([member('a', { skills: { stealth: 2 } })]);
    const mission = missionOf(
      [start(), skillCheck('c', 1, 'stealth', 12), end('done', 2)],
      [edge('start', 'c', 'always'), edge('c', 'done', 'pass'), edge('c', 'done', 'fail')],
    );
    const projection = projectMission(party, mission, baseOf, constantModel(1));
    expect(projection.expectedScore).toBeCloseTo(0.55, 12);
    expect(projection.pDnf).toBe(0);
    expect(projection.reach).toEqual({ start: 1, c: 1, done: 1 });
    expectDistribution(projection, [
      [0, 0.45],
      [1, 0.55],
    ]);
  });

  it('expected score is E[loot] / haul, and a failed check banks nothing', () => {
    // start → a (2) ─pass→ done
    //               └fail→ b (1) → c (1) → done      every check at p = 0.5 (+0 vs DC 11)
    // Both routes can bank 2, so the haul is 2.
    const mission = missionOf(
      [start(), skillCheck('a', 1, 'stealth', 11, 2), skillCheck('b', 2, 'stealth', 11), skillCheck('c', 3, 'stealth', 11), end('done', 4)],
      [
        edge('start', 'a', 'always'),
        edge('a', 'done', 'pass'),
        edge('a', 'b', 'fail'),
        edge('b', 'c', 'always'),
        edge('c', 'done', 'pass'),
        edge('c', 'done', 'fail'),
      ],
    );
    const projection = projectMission(zero, mission, baseOf, constantModel(1));
    // Pass a: 2 of 2 at 0.5. Fail a: b + c ~ Bin(2, 0.5) loot.
    // E = 0.5 × 1 + 0.5 × (0.25 × 0 + 0.5 × 1/2 + 0.25 × 1) = 3/4.
    expect(projection.expectedScore).toBeCloseTo(3 / 4, 12);
    expect(projection.reach).toEqual({ start: 1, a: 1, b: 0.5, c: 0.5, done: 1 });
    expectDistribution(projection, [
      [0, 0.125],
      [0.5, 0.25],
      [1, 0.625],
    ]);
  });

  it('a lost battle keeps the loot banked before it (D-46)', () => {
    // A certain check (1), a battle at p(win) = 0.3, then a certain check (3). Haul 4.
    const mission = missionOf(
      [start(), skillCheck('c', 1, 'stealth', 1), battle('fight', 2), skillCheck('d', 3, 'stealth', 1, 3), end('done', 4)],
      [edge('start', 'c', 'always'), edge('c', 'fight', 'always'), edge('fight', 'd', 'win'), edge('d', 'done', 'always')],
    );
    const projection = projectMission(zero, mission, baseOf, constantModel(0.3));
    expect(projection.expectedScore).toBeCloseTo(0.7 * 0.25 + 0.3 * 1, 12);
    expect(projection.pDnf).toBeCloseTo(0.7, 12);
    expect(projection.reach).toEqual({ start: 1, c: 1, fight: 1, d: 0.3, done: 0.3 });
    expectDistribution(projection, [
      [0.25, 0.7],
      [1, 0.3],
    ]);
  });

  it('matches a hand computation on the example mission', () => {
    // All modifiers 0: survival DC 12 → 0.45, stealth DC 14 → 0.35,
    // athletics DC 13 → 0.4, Con save DC 12 → 0.45. Every battle at 0.5.
    const projection = projectMission(zero, loadMission(EXAMPLE_MISSION), baseOf, constantModel(0.5));
    // Loot: find-path 20, slip-past 30, haul-chain 50, wade-across 10; haul 100.
    // Find the path (0.45, +20): slip past (0.35, +30) then haul the chain (+50) or
    // wade (+10), or fail into the toll fight, which keeps the 20 win or lose.
    const viaPath = 20 + 0.35 * (30 + 0.4 * 50 + 0.6 * 0.45 * 10);
    // Miss it (0.55): lose the bog ambush with nothing (0.5), or haul the chain or wade.
    const viaBog = 0.5 * (0.4 * 50 + 0.6 * 0.45 * 10);
    expect(projection.expectedScore).toBeCloseTo((0.45 * viaPath + 0.55 * viaBog) / 100, 12);
    expect(projection.pDnf).toBeCloseTo(0.45 * 0.65 * 0.5 + 0.55 * 0.5, 12);
    expect(projection.reach['toll-seized']).toBeCloseTo(0.45 * 0.65 * 0.5, 12);
    expect(projection.reach['haul-chain']).toBeCloseTo(0.45 * 0.35 + 0.55 * 0.5, 12);
    expect(projection.reach['wade-across']).toBeCloseTo((0.45 * 0.35 + 0.55 * 0.5) * 0.6, 12);
  });

  it('reach probabilities at end nodes plus P(DNF) sum to 1', () => {
    const party = partyOf([member('a', { skills: { survival: 3 } }), member('b', { skills: { athletics: 5 }, saves: { con: 2 } })]);
    for (const model of [constantModel(0.5), constantModel(0), constantModel(1), crModel]) {
      const projection = projectMission(party, loadMission(EXAMPLE_MISSION), baseOf, model);
      const endReach = ['crossed-dry', 'crossed-wet', 'toll-seized'].reduce((sum, id) => sum + (projection.reach[id] ?? 0), 0);
      expect(endReach + projection.pDnf).toBeCloseTo(1, 12);
      expect(total(projection)).toBeCloseTo(1, 12);
      expect(projection.reach.start).toBe(1);
    }
  });

  it('merges runs that bank the same loot and sorts by score', () => {
    // a ─pass→ b → done: 1 or 2 loot.   a ─fail→ c → d → e → done: 0 to 3. Haul 3.
    // Both routes can bank 1 or 2, so those share entries.
    const mission = missionOf(
      [
        start(),
        skillCheck('a', 1, 'stealth', 11),
        skillCheck('b', 2, 'stealth', 11),
        skillCheck('c', 2, 'stealth', 11),
        skillCheck('d', 3, 'stealth', 11),
        skillCheck('e', 4, 'stealth', 11),
        end('done', 5),
      ],
      [
        edge('start', 'a', 'always'),
        edge('a', 'b', 'pass'),
        edge('a', 'c', 'fail'),
        edge('b', 'done', 'always'),
        edge('c', 'd', 'always'),
        edge('d', 'e', 'always'),
        edge('e', 'done', 'always'),
      ],
    );
    const projection = projectMission(zero, mission, baseOf, constantModel(1));
    // Fail a (0.5), then c, d, e ~ Bin(3, 0.5): 0, 1, 2, 3 at 1/8, 3/8, 3/8, 1/8.
    // Pass a (0.5), then b: 1 or 2 at 1/2 each.
    expectDistribution(projection, [
      [0, 0.0625],
      [1 / 3, 0.1875 + 0.25],
      [2 / 3, 0.1875 + 0.25],
      [1, 0.0625],
    ]);
  });

  it('projects a gated check nobody qualifies for as a certain fail', () => {
    const mission = missionOf(
      [start(), check('c', 1, { type: 'skill', skill: 'stealth', dc: 2, requires: { sense: 'truesight' } }, 2), skillCheck('x', 2, 'stealth', 1), end('done', 3)],
      [edge('start', 'c', 'always'), edge('c', 'done', 'pass'), edge('c', 'x', 'fail'), edge('x', 'done', 'always')],
    );
    const projection = projectMission(zero, mission, baseOf, constantModel(1));
    expect(projection.reach).toEqual({ start: 1, c: 1, x: 1, done: 1 });
    expect(projection.expectedScore).toBe(0.5);
    expect(projection.distribution).toEqual([[0.5, 1]]);
  });

  it('banks a battle\'s loot on a win, and turns back by the retreat order (D-49, D-50)', () => {
    // A certain check (1), a battle at p(win) = 0.4 with bounty 2, then a certain check (1). Haul 4.
    const mission = missionOf(
      [start(), skillCheck('c', 1, 'stealth', 1), { ...battle('fight', 2), loot: 2 }, skillCheck('d', 3, 'stealth', 1), end('done', 4)],
      [edge('start', 'c', 'always'), edge('c', 'fight', 'always'), edge('fight', 'd', 'win'), edge('d', 'done', 'always')],
    );
    const fight = projectMission(zero, mission, baseOf, constantModel(0.4));
    expect(fight.expectedScore).toBeCloseTo(0.6 * 0.25 + 0.4 * 1, 12);
    expect([fight.pDnf, fight.pRetreat]).toEqual([0.6, 0]);
    expect(fight.reach).toEqual({ start: 1, c: 1, fight: 1, d: 0.4, done: 0.4 });

    // Turning back keeps the 1 banked, with no DNF, and the party never visits the battle.
    for (const retreat of ['avoid_battles', { bank: 1 }] as const) {
      const back = projectMission(zero, mission, baseOf, constantModel(0.4), { retreat });
      expect(back.expectedScore).toBeCloseTo(0.25, 12);
      expect([back.pDnf, back.pRetreat]).toEqual([0, 1]);
      expect(back.reach).toEqual({ start: 1, c: 1, fight: 0, d: 0, done: 0 });
      expect(back.distribution).toEqual([[0.25, 1]]);
    }
    expect(projectMission(zero, mission, baseOf, constantModel(0.4), { retreat: { bank: 2 } })).toEqual(fight);
  });

  it('applies a bank threshold per loot state, so one battle can split', () => {
    // a (p 0.5, loot 1) then a battle at p 0.5: bank 1 turns back only the parties that passed a.
    const mission = missionOf(
      [start(), skillCheck('a', 1, 'stealth', 11), battle('fight', 2), skillCheck('d', 3, 'stealth', 1, 2), end('done', 4)],
      [edge('start', 'a', 'always'), edge('a', 'fight', 'always'), edge('fight', 'd', 'win'), edge('d', 'done', 'always')],
    );
    const p = projectMission(zero, mission, baseOf, constantModel(0.5), { retreat: { bank: 1 } });
    expect(p.pRetreat).toBeCloseTo(0.5, 12);
    expect(p.pDnf).toBeCloseTo(0.25, 12);
    expect(p.reach.fight).toBeCloseTo(0.5, 12);
    // Retreat with 1 (0.5), lose with 0 (0.25), win and bank d's 2 (0.25). Haul 3.
    expect(p.expectedScore).toBeCloseTo((0.5 * 1 + 0.25 * 2) / 3, 12);
  });

  it('lists unreachable branches with reach 0', () => {
    const mission = missionOf(
      [start(), skillCheck('c', 1, 'stealth', 1), battle('fight', 2), end('done', 3)],
      [edge('start', 'c', 'always'), edge('c', 'done', 'pass'), edge('c', 'fight', 'fail'), edge('fight', 'done', 'win')],
    );
    const projection = projectMission(zero, mission, baseOf, constantModel(0));
    expect(projection.reach).toEqual({ start: 1, c: 1, fight: 0, done: 1 });
    expect(projection.pDnf).toBe(0);
    expect(projection.distribution).toEqual([[1, 1]]);
  });

});

// T6.5.
describe('projection property', () => {
  const CASES = 200;
  const N = 5000;

  it(`propagated mean equals the sampled mean of ${N} seeded runs within 4 standard errors, over ${CASES} random legal missions and parties`, () => {
    const failures: string[] = [];
    let gated = 0;
    let withAdvantage = 0;
    let withDnf = 0;
    let partRetreat = 0;
    let withBounty = 0;
    for (let c = 0; c < CASES; c++) {
      const gen = rngFor('projection-property', 'case:' + c);
      const mission = randomMission(gen, `prop-${c}`);
      const party = randomParty(gen);
      const orders = { retreat: randomRetreat(gen) };
      const projection = projectMission(party, mission, baseOf, crModel, orders);

      // Internal consistency.
      const ends = mission.nodes.filter((n) => n.kind === 'end').reduce((sum, n) => sum + (projection.reach[n.id] ?? 0), 0);
      const fromDistribution = projection.distribution.reduce((sum, [score, p]) => sum + score * p, 0);
      const exits = ends + projection.pDnf + projection.pRetreat;
      if (Math.abs(exits - 1) > 1e-9) failures.push(`case ${c}: end reach + pDnf + pRetreat = ${exits}`);
      if (Math.abs(total(projection) - 1) > 1e-9) failures.push(`case ${c}: distribution sums to ${total(projection)}`);
      if (Math.abs(fromDistribution - projection.expectedScore) > 1e-9) failures.push(`case ${c}: distribution mean ${fromDistribution}`);

      // Sampled mean vs the exact mean, with the standard error from the exact distribution.
      let sum = 0;
      let dnfs = 0;
      let retreats = 0;
      for (let k = 0; k < N; k++) {
        const run = runMission(party, mission, (id) => rngFor(`prop-${c}-${k}`, 'roll:' + id), baseOf, crModel, orders);
        sum += run.score;
        if (run.dnf) dnfs++;
        if (run.retreatedBefore !== null) retreats++;
      }
      const mean = sum / N;
      const variance = projection.distribution.reduce((v, [score, p]) => v + p * (score - projection.expectedScore) ** 2, 0);
      const se = Math.sqrt(variance / N);
      if (Math.abs(mean - projection.expectedScore) > 4 * se + 1e-12) {
        failures.push(`case ${c}: sampled ${mean} vs projected ${projection.expectedScore} (4 SE = ${4 * se})`);
      }
      const dnfSe = Math.sqrt((projection.pDnf * (1 - projection.pDnf)) / N);
      if (Math.abs(dnfs / N - projection.pDnf) > 4 * dnfSe + 1e-12) {
        failures.push(`case ${c}: sampled DNF ${dnfs / N} vs projected ${projection.pDnf} (4 SE = ${4 * dnfSe})`);
      }
      const retreatSe = Math.sqrt((projection.pRetreat * (1 - projection.pRetreat)) / N);
      if (Math.abs(retreats / N - projection.pRetreat) > 4 * retreatSe + 1e-12) {
        failures.push(`case ${c}: sampled retreat ${retreats / N} vs projected ${projection.pRetreat} (4 SE = ${4 * retreatSe})`);
      }

      if (mission.nodes.some((n) => n.kind === 'check' && n.check.requires !== undefined)) gated++;
      if (mission.nodes.some((n) => n.kind === 'check' && checkOdds(party, n.check).advantage)) withAdvantage++;
      if (projection.pDnf > 0) withDnf++;
      if (projection.pRetreat > 0 && projection.pRetreat < 1) partRetreat++;
      if (mission.nodes.some((n) => n.kind === 'battle' && (n.loot ?? 0) > 0)) withBounty++;
    }
    expect(failures).toEqual([]);
    // The generator covers the interesting cases.
    expect(gated).toBeGreaterThan(CASES / 10);
    expect(withAdvantage).toBeGreaterThan(CASES / 10);
    expect(withDnf).toBeGreaterThan(CASES / 4);
    expect(partRetreat).toBeGreaterThan(CASES / 10);
    expect(withBounty).toBeGreaterThan(CASES / 4);
  }, 30_000); // about 3 s alone; the 5 s default is too tight when the whole suite runs in parallel
});
