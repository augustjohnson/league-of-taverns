import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dishonestKeywords, lootShape, missionHaul, missionKeywords, topologicalOrder, validateMission } from '../src/missions';
import type { BattleNode, CheckNode, Mission, MissionEdge, MissionIssue, MissionNode, MissionRules } from '../src/missions';
import type { CrEighths } from '../src/vocabulary';
// The engine has no YAML parser (it does no I/O), so the example file is read
// through the scripts loader, as in missions-schema.test.ts.
import { loadMission } from '../../scripts/src/lib/repo';

const EXAMPLE = 'seasons/season-01/missions/candidates/example-drowned-toll.yaml';
const SNAPSHOT = new URL('../../data/open5e/open5e-v1-2026-10/monsters.json', import.meta.url);

/** CR in eighths per slug, from the real pinned snapshot. */
const snapshotCr: ReadonlyMap<string, CrEighths> = new Map(
  (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as Array<{ slug: string; cr: number }>).map((record) => [
    record.slug,
    Math.round(record.cr * 8) as CrEighths,
  ]),
);
const crOf = (slug: string): CrEighths | undefined => snapshotCr.get(slug);

/** season-01/config.yaml `missions`, with B = CR 12. */
const RULES: MissionRules = {
  dcBand: { min: 8, max: 20 },
  maxNodes: 14,
  maxRank: 8,
  battlesPerPath: { min: 0, max: 3 },
  encounterCrRatio: 1.0,
  partyCr: 96 as CrEighths,
};

const start = (id = 'start', rank = 0): MissionNode => ({ id, rank, kind: 'start' });
const end = (id: string, rank: number): MissionNode => ({ id, rank, kind: 'end' });
const check = (id: string, rank: number, dc = 12, extra: Partial<CheckNode['check']> = {}, loot = 1): CheckNode => ({
  id,
  rank,
  kind: 'check',
  check: { type: 'skill', skill: 'perception', dc, ...extra } as CheckNode['check'],
  loot,
});
const battle = (id: string, rank: number, creatures: BattleNode['encounter']['creatures'] = [{ ref: 'goblin', count: 2 }]): BattleNode => ({
  id,
  rank,
  kind: 'battle',
  encounter: { creatures },
});
const edge = (from: string, to: string, on: MissionEdge['on']): MissionEdge => ({ from, to, on });

/** start → look ─pass→ fight ─win→ done; look ─fail→ done. Valid against RULES. */
function tiny(overrides: Partial<Pick<Mission, 'nodes' | 'edges' | 'environment'>> = {}): Mission {
  return {
    schemaVersion: 1,
    id: 'tiny',
    season: 'season-01',
    environment: 'swamp',
    nodes: [start(), check('look', 1), battle('fight', 2), end('done', 3)],
    edges: [edge('start', 'look', 'always'), edge('look', 'fight', 'pass'), edge('look', 'done', 'fail'), edge('fight', 'done', 'win')],
    ...overrides,
  };
}

function validate(mission: Mission, rules: MissionRules = RULES, options = {}): ReadonlyArray<MissionIssue> {
  return validateMission(mission, rules, crOf, options);
}

/** `code@nodeId` pairs, for compact assertions. */
function codes(issues: ReadonlyArray<MissionIssue>): ReadonlyArray<string> {
  return issues.map((issue) => (issue.nodeId === undefined ? issue.code : `${issue.code}@${issue.nodeId}`));
}

describe('mission validator', () => {
  it('accepts seasons/season-01/missions/candidates/example-drowned-toll.yaml', () => {
    expect(validate(loadMission(EXAMPLE), RULES, { expectedEnvironment: 'swamp' })).toEqual([]);
  });

  it('accepts the tiny fixture, and every issue names the mission', () => {
    expect(validate(tiny())).toEqual([]);
    const issues = validate(tiny({ environment: 'desert' }), RULES, { expectedEnvironment: 'swamp' });
    expect(issues.every((issue) => issue.missionId === 'tiny')).toBe(true);
  });

  describe('start', () => {
    it('rejects a mission with no start node, but still checks DC and encounters', () => {
      const mission = tiny({
        nodes: [check('look', 1, 30), battle('fight', 2, [{ ref: 'not-a-monster', count: 1 }]), end('done', 3)],
        edges: tiny().edges.slice(1),
      });
      expect(codes(validate(mission))).toEqual(['start', 'dc@look', 'encounter.ref@fight']);
    });

    it('rejects a second start node', () => {
      const mission = tiny({
        nodes: [...tiny().nodes, start('start-b', 0)],
        edges: [...tiny().edges, edge('start-b', 'look', 'always')],
      });
      expect(codes(validate(mission))).toEqual(['start@start-b']);
    });

    it('rejects a start node above rank 0', () => {
      const mission = tiny({ nodes: [start('start', 1), check('look', 2), battle('fight', 3), end('done', 4)] });
      expect(codes(validate(mission))).toEqual(['start@start']);
    });
  });

  describe('end', () => {
    it('rejects a mission with no end node', () => {
      const mission = tiny({
        nodes: [start(), check('look', 1), battle('fight', 2)],
        edges: [edge('start', 'look', 'always'), edge('look', 'fight', 'always')],
      });
      expect(codes(validate(mission))).toEqual(['end', 'edges.battle@fight']);
    });

    it('rejects an end node with an outgoing edge', () => {
      const mission = tiny({
        nodes: [...tiny().nodes, end('after', 4)],
        edges: [...tiny().edges, edge('done', 'after', 'always')],
      });
      expect(codes(validate(mission))).toEqual(['end@done']);
    });
  });

  describe('ids', () => {
    it('rejects a duplicate node id', () => {
      const mission = tiny({ nodes: [...tiny().nodes, end('done', 4)] });
      expect(codes(validate(mission))).toEqual(['ids@done']);
    });

    it('rejects an edge to a node that does not exist', () => {
      const mission = tiny({ edges: [...tiny().edges.slice(0, 3), edge('fight', 'nowhere', 'win')] });
      const issues = validate(mission);
      expect(codes(issues)).toEqual(['ids@fight']);
      expect(issues[0]?.message).toContain('"nowhere"');
    });
  });

  it('rejects an edge that does not increase rank (rank)', () => {
    const mission = tiny({ nodes: [start(), check('look', 1), battle('fight', 3), end('done', 3)] });
    expect(codes(validate(mission))).toEqual(['rank@fight']);
  });

  it('survives a cycle once rank is broken', () => {
    const mission = tiny({
      nodes: [start(), check('look', 2), battle('fight', 1), end('done', 3)],
      edges: [edge('start', 'look', 'always'), edge('look', 'fight', 'pass'), edge('look', 'done', 'fail'), edge('fight', 'look', 'win')],
    });
    // look → fight → look is a cycle; only the backward edge breaks rank, and path checks are skipped.
    expect(codes(validate(mission))).toEqual(['rank@look']);
  });

  it('rejects a node unreachable from start (reachable)', () => {
    const mission = tiny({
      nodes: [...tiny().nodes, check('side', 1)],
      edges: [...tiny().edges, edge('side', 'done', 'always')],
    });
    expect(codes(validate(mission))).toEqual(['reachable@side']);
  });

  describe('edges', () => {
    it('rejects a check node without both pass and fail (or always) edges (edges.check)', () => {
      const missingFail = tiny({ edges: tiny().edges.filter((e) => e.on !== 'fail') });
      expect(codes(validate(missingFail))).toEqual(['edges.check@look']);
      const mixed = tiny({ edges: [...tiny().edges, edge('look', 'done', 'always')] });
      expect(codes(validate(mixed))).toEqual(['edges.check@look']);
    });

    it('accepts a pass-through check with a single always edge', () => {
      const mission = tiny({
        edges: [edge('start', 'look', 'always'), edge('look', 'fight', 'always'), edge('fight', 'done', 'win')],
      });
      expect(validate(mission)).toEqual([]);
    });

    it('rejects a battle without exactly one win edge (edges.battle)', () => {
      const mission = tiny({ edges: [...tiny().edges.slice(0, 3), edge('fight', 'done', 'always')] });
      expect(codes(validate(mission))).toEqual(['edges.battle@fight']);
    });

    it('rejects a start without exactly one always edge (edges.start)', () => {
      const mission = tiny({ edges: [edge('start', 'look', 'pass'), ...tiny().edges.slice(1)] });
      expect(codes(validate(mission))).toEqual(['edges.start@start']);
    });

    it('reports a dead end under its kind', () => {
      const mission = tiny({ edges: tiny().edges.slice(0, 3) });
      const issues = validate(mission);
      expect(codes(issues)).toEqual(['edges.battle@fight']);
      expect(issues[0]?.message).toContain('dead end');
    });
  });

  it('rejects a path from start to an end with zero checks (scored)', () => {
    const mission = tiny({
      nodes: [start(), battle('fight', 1), end('done', 2)],
      edges: [edge('start', 'fight', 'always'), edge('fight', 'done', 'win')],
    });
    const issues = validate(mission);
    expect(codes(issues)).toEqual(['scored@done']);
    expect(issues[0]?.message).toContain('start → fight → done');
  });

  it('counts a check that comes after a battle (scored)', () => {
    const mission = tiny({
      nodes: [start(), battle('fight', 1), check('look', 2), end('done-a', 3), end('done-b', 3)],
      edges: [
        edge('start', 'fight', 'always'),
        edge('fight', 'look', 'win'),
        edge('look', 'done-a', 'pass'),
        edge('look', 'done-b', 'fail'),
      ],
    });
    expect(validate(mission)).toEqual([]);
  });

  it('checks the fixed haul only when the rules set one (haul)', () => {
    // start → a (30) ─pass→ b (70) → done      best path banks 100
    //                └fail→ c (90) → done      a fail banks nothing, so 90
    const mission = tiny({
      nodes: [start(), check('a', 1, 12, {}, 30), check('b', 2, 12, {}, 70), check('c', 2, 12, {}, 90), end('done', 3)],
      edges: [
        edge('start', 'a', 'always'),
        edge('a', 'b', 'pass'),
        edge('a', 'c', 'fail'),
        edge('b', 'done', 'always'),
        edge('c', 'done', 'always'),
      ],
    });
    expect(missionHaul(mission)).toBe(100);
    expect(validate(mission)).toEqual([]);
    expect(validate(mission, { ...RULES, haul: 100 })).toEqual([]);
    const issues = validate(mission, { ...RULES, haul: 120 });
    expect(codes(issues)).toEqual(['haul@done']);
    expect(issues[0]?.message).toContain('start → a → b → done banks 100');
    expect(issues[0]?.message).toContain('fixed haul of 120');
  });

  it('accepts the example mission under the season-01 fixed haul of 100 (haul)', () => {
    expect(validate(loadMission(EXAMPLE), { ...RULES, haul: 100 })).toEqual([]);
  });

  it('rejects a DC outside the season band (dc)', () => {
    const mission = tiny({ nodes: [start(), check('look', 1, 7), battle('fight', 2), end('done', 3)] });
    expect(codes(validate(mission))).toEqual(['dc@look']);
    const high = tiny({ nodes: [start(), check('look', 1, 21), battle('fight', 2), end('done', 3)] });
    expect(codes(validate(high))).toEqual(['dc@look']);
    const edgeOfBand = tiny({ nodes: [start(), check('look', 1, 20), battle('fight', 2), end('done', 3)] });
    expect(validate(edgeOfBand)).toEqual([]);
  });

  it('rejects an encounter ref missing from the pinned snapshot (encounter.ref)', () => {
    const mission = tiny({ nodes: [start(), check('look', 1), battle('fight', 2, [{ ref: 'swamp-dragon', count: 1 }]), end('done', 3)] });
    const issues = validate(mission);
    expect(codes(issues)).toEqual(['encounter.ref@fight']);
    expect(issues[0]?.message).toContain('"swamp-dragon"');
  });

  describe('encounter.budget', () => {
    // ogre is CR 2 (16 eighths), goblin CR 1/4 (2 eighths). The cap is 96 eighths.
    it('accepts an encounter exactly at the cap', () => {
      const mission = tiny({ nodes: [start(), check('look', 1), battle('fight', 2, [{ ref: 'ogre', count: 6 }]), end('done', 3)] });
      expect(validate(mission)).toEqual([]);
    });

    it('rejects an encounter one eighth over the cap', () => {
      const mission = tiny({
        nodes: [
          start(),
          check('look', 1),
          battle('fight', 2, [
            { ref: 'ogre', count: 6 },
            { ref: 'goblin', count: 1 },
          ]),
          end('done', 3),
        ],
      });
      const issues = validate(mission);
      expect(codes(issues)).toEqual(['encounter.budget@fight']);
      expect(issues[0]?.message).toContain('CR 12 1/4');
    });

    it('floors a fractional cap', () => {
      // 0.99 × 96 = 95.04 eighths → cap 95, so 96 eighths is over.
      const mission = tiny({ nodes: [start(), check('look', 1), battle('fight', 2, [{ ref: 'ogre', count: 6 }]), end('done', 3)] });
      expect(codes(validate(mission, { ...RULES, encounterCrRatio: 0.99 }))).toEqual(['encounter.budget@fight']);
    });

    it('still reports an overrun proven by the known refs alone', () => {
      const mission = tiny({
        nodes: [
          start(),
          check('look', 1),
          battle('fight', 2, [
            { ref: 'ogre', count: 7 },
            { ref: 'mystery', count: 1 },
          ]),
          end('done', 3),
        ],
      });
      const issues = validate(mission);
      expect(codes(issues)).toEqual(['encounter.ref@fight', 'encounter.budget@fight']);
      expect(issues[1]?.message).toContain('at least');
    });
  });

  describe('size', () => {
    it('rejects too many nodes', () => {
      expect(codes(validate(tiny(), { ...RULES, maxNodes: 3 }))).toEqual(['size']);
    });

    it('rejects a rank above maxRank', () => {
      expect(codes(validate(tiny(), { ...RULES, maxRank: 2 }))).toEqual(['size@done']);
    });

    it('rejects a path with too many battles', () => {
      const mission = tiny({
        nodes: [start(), check('look', 1), battle('b1', 2), battle('b2', 3), end('done', 4)],
        edges: [
          edge('start', 'look', 'always'),
          edge('look', 'b1', 'pass'),
          edge('look', 'done', 'fail'),
          edge('b1', 'b2', 'win'),
          edge('b2', 'done', 'win'),
        ],
      });
      const issues = validate(mission, { ...RULES, battlesPerPath: { min: 0, max: 1 } });
      expect(codes(issues)).toEqual(['size@done']);
      expect(issues[0]?.message).toContain('start → look → b1 → b2 → done');
    });

    it('rejects a path with too few battles', () => {
      // The fail branch skips the only battle.
      const issues = validate(tiny(), { ...RULES, battlesPerPath: { min: 1, max: 3 } });
      expect(codes(issues)).toEqual(['size@done']);
      expect(issues[0]?.message).toContain('start → look → done');
    });
  });

  it('rejects more than one gated check (gated)', () => {
    // Loot-free gated checks, so the gates rule has nothing to say.
    const mission = tiny({
      nodes: [
        start(),
        check('warm-up', 1),
        check('look', 2, 12, { requires: { sense: 'darkvision' } }, 0),
        check('climb', 3, 12, { requires: { speed: 'climb' } }, 0),
        end('done', 4),
      ],
      edges: [edge('start', 'warm-up', 'always'), edge('warm-up', 'look', 'always'), edge('look', 'climb', 'always'), edge('climb', 'done', 'always')],
    });
    expect(codes(validate(mission))).toEqual(['gated@climb']);
  });

  it('counts a battle\'s loot on a win toward the haul (haul, D-50)', () => {
    // start → a (30) ─pass→ fight (bounty 70) ─win→ done; a ─fail→ done
    const mission = tiny({
      nodes: [start(), check('a', 1, 12, {}, 30), { ...battle('fight', 2), loot: 70 }, end('done', 3)],
      edges: [edge('start', 'a', 'always'), edge('a', 'fight', 'pass'), edge('a', 'done', 'fail'), edge('fight', 'done', 'win')],
    });
    expect(missionHaul(mission)).toBe(100);
    expect(validate(mission, { ...RULES, haul: 100 })).toEqual([]);
    expect(missionHaul(tiny())).toBe(1);
  });

  it('keeps the full haul open to a party that meets no gate (gates, D-39)', () => {
    // start → look (fly gate, 60) ─pass→ done; look ─fail→ climb (40) → done.
    // Without a flyer, look always fails: the best ungated path banks 40, not 100.
    const wall = tiny({
      nodes: [start(), check('look', 1, 12, { requires: { speed: 'fly' } }, 60), check('climb', 2, 12, {}, 40), end('done', 3)],
      edges: [edge('start', 'look', 'always'), edge('look', 'done', 'pass'), edge('look', 'climb', 'fail'), edge('climb', 'done', 'always')],
    });
    const issues = validate(wall);
    expect(codes(issues)).toEqual(['gates@done']);
    expect(issues[0]?.message).toContain('at most 40 loot, on start → look → climb → done, but the best path banks 60');

    // A shortcut: the gated route pays 60 at once, the long way 30 + 30 with a fight. Both reach 60.
    const shortcut = tiny({
      nodes: [
        start(),
        check('look', 1, 12, { requires: { speed: 'fly' } }, 60),
        check('climb', 2, 12, {}, 30),
        { ...battle('fight', 3), loot: 30 },
        end('done', 4),
      ],
      edges: [
        edge('start', 'look', 'always'),
        edge('look', 'done', 'pass'),
        edge('look', 'climb', 'fail'),
        edge('climb', 'fight', 'always'),
        edge('fight', 'done', 'win'),
      ],
    });
    expect(validate(shortcut)).toEqual([]);

    // An `always` edge out of a gated check banks nothing for a party that fails the gate.
    const alwaysEdge = tiny({
      nodes: [start(), check('look', 1, 12, { requires: { speed: 'fly' } }, 10), end('done', 2)],
      edges: [edge('start', 'look', 'always'), edge('look', 'done', 'always')],
    });
    expect(codes(validate(alwaysEdge))).toEqual(['gates@done']);
  });

  it('lootShape reports the D-45 shape: late loot and a late last battle', () => {
    // start → a (10) → b (20) → fight (bounty 30) → c (40) → done. Length 5; the last third is ranks 4 and 5.
    const rising = tiny({
      nodes: [start(), check('a', 1, 12, {}, 10), check('b', 2, 12, {}, 20), { ...battle('fight', 3), loot: 30 }, check('c', 4, 12, {}, 40), end('done', 5)],
      edges: [edge('start', 'a', 'always'), edge('a', 'b', 'always'), edge('b', 'fight', 'always'), edge('fight', 'c', 'win'), edge('c', 'done', 'always')],
    });
    const shape = lootShape(rising);
    expect(shape.bestPath).toEqual(['start', 'a', 'b', 'fight', 'c', 'done']);
    expect(shape.lootByNode).toEqual([['start', 0], ['a', 10], ['b', 20], ['fight', 30], ['c', 40]]);
    expect([shape.length, shape.lateShare, shape.lastBattleRank]).toEqual([5, 0.4, 3]);
    expect(shape.ok).toBe(false); // 40% late, and the battle at rank 3 is not past ⅔ × 5
    const late = tiny({
      nodes: [start(), check('a', 1, 12, {}, 10), check('b', 2, 12, {}, 20), check('c', 3, 12, {}, 30), { ...battle('fight', 4), loot: 40 }, end('done', 5)],
      edges: [edge('start', 'a', 'always'), edge('a', 'b', 'always'), edge('b', 'c', 'always'), edge('c', 'fight', 'always'), edge('fight', 'done', 'win')],
    });
    expect(lootShape(late)).toMatchObject({ lateShare: 0.4, lastBattleRank: 4, ok: false });
    expect(lootShape({ ...late, nodes: late.nodes.map((n) => (n.id === 'fight' ? { ...n, loot: 60 } : n)) })).toMatchObject({ lateShare: 0.5, ok: true });
  });

  it('lists the D-42 keywords a mission supports, and flags keywords that name nothing', () => {
    const mission = tiny({
      nodes: [
        start(),
        check('look', 1, 12, { requires: { sense: 'darkvision' } }, 0),
        { id: 'swim', rank: 2, kind: 'check', check: { type: 'save', ability: 'con', dc: 12 }, loot: 1 },
        { id: 'grip', rank: 3, kind: 'check', check: { type: 'ability', ability: 'str', dc: 12 }, loot: 1 },
        { id: 'pick', rank: 4, kind: 'check', check: { type: 'skill', skill: 'sleight_of_hand', dc: 12 }, loot: 1 },
        battle('fight', 5, [{ ref: 'giant-frog', count: 2 }, { ref: 'goblin', count: 1 }]),
        end('done', 6),
      ],
      edges: [
        edge('start', 'look', 'always'),
        edge('look', 'swim', 'always'),
        edge('swim', 'grip', 'always'),
        edge('grip', 'pick', 'always'),
        edge('pick', 'fight', 'always'),
        edge('fight', 'done', 'win'),
      ],
    });
    expect(missionKeywords(mission)).toEqual(['perception', 'darkvision', 'con save', 'str check', 'sleight of hand', 'giant frog fight']);
    expect(dishonestKeywords(mission, ['perception', 'con save', 'giant frog fight'])).toEqual([]);
    // The second creature is not the lead, and nothing here swims.
    expect(dishonestKeywords(mission, ['goblin fight', 'swim', 'perception'])).toEqual(['goblin fight', 'swim']);
  });

  it('checks environment only when an expected one is given (environment)', () => {
    const mission = tiny({ environment: 'desert' });
    expect(validate(mission)).toEqual([]);
    expect(codes(validate(mission, RULES, { expectedEnvironment: 'swamp' }))).toEqual(['environment']);
    expect(validate(mission, RULES, { expectedEnvironment: 'desert' })).toEqual([]);
  });

  it('reports every violation, not just the first', () => {
    const mission: Mission = {
      schemaVersion: 1,
      id: 'broken',
      season: 'season-01',
      environment: 'swamp',
      nodes: [
        start(),
        battle('ambush', 1, [{ ref: 'ogre', count: 7 }]),
        check('look', 2, 25),
        battle('lair', 3, [{ ref: 'not-real', count: 1 }]),
        end('done', 9),
        check('stray', 4),
      ],
      edges: [
        edge('start', 'ambush', 'always'),
        edge('ambush', 'done', 'win'),
        edge('look', 'lair', 'pass'),
        edge('lair', 'ghost', 'win'),
      ],
    };
    const issues = validate(mission, { ...RULES, maxNodes: 5 });
    expect(codes(issues)).toEqual([
      'ids@lair',
      'reachable@look',
      'reachable@lair',
      'reachable@stray',
      'edges.check@look',
      'edges.check@stray',
      'scored@done',
      'dc@look',
      'encounter.budget@ambush',
      'encounter.ref@lair',
      'size',
      'size@done',
    ]);
    for (const issue of issues) expect(issue.message.length).toBeGreaterThan(20);
  });
});

describe('topologicalOrder', () => {
  it('sorts node ids by rank, breaking ties by id', () => {
    const mission = tiny({
      nodes: [end('z-end', 3), check('b', 1), start(), battle('a', 1), end('a-end', 3), check('c', 2)],
    });
    expect(topologicalOrder(mission)).toEqual(['start', 'a', 'b', 'c', 'a-end', 'z-end']);
  });

  it('orders the example mission', () => {
    expect(topologicalOrder(loadMission(EXAMPLE))).toEqual([
      'start',
      'find-path',
      'bog-ambush',
      'slip-past',
      'haul-chain',
      'toll-fight',
      'wade-across',
      'crossed-dry',
      'crossed-wet',
      'toll-seized',
    ]);
  });
});
