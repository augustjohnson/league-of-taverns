import { describe, expect, it } from 'vitest';
import { parseMission } from '../src/missions/schema';
import type { SchemaIssue } from '../src/missions/schema';
// The engine has no YAML parser (it does no I/O), so the example file is read
// through the scripts loader, which is also under test here (T5.1).
import { loadMission } from '../../scripts/src/lib/repo';

const EXAMPLE = 'seasons/season-01/missions/candidates/example-drowned-toll.yaml';

/** A small valid mission, cloned per test so each can break one field. */
function validMission(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'tiny',
    season: 'season-01',
    environment: 'swamp',
    nodes: [
      { id: 'start', rank: 0, kind: 'start' },
      { id: 'look', rank: 1, kind: 'check', check: { type: 'skill', skill: 'perception', dc: 12 }, loot: 100 },
      { id: 'fight', rank: 2, kind: 'battle', encounter: { creatures: [{ ref: 'crocodile', count: 2 }] } },
      { id: 'done', rank: 3, kind: 'end' },
    ],
    edges: [
      { from: 'start', to: 'look', on: 'always' },
      { from: 'look', to: 'fight', on: 'pass' },
      { from: 'look', to: 'done', on: 'fail' },
      { from: 'fight', to: 'done', on: 'win' },
    ],
  };
}

function issuesOf(input: unknown): ReadonlyArray<SchemaIssue> {
  const result = parseMission(input);
  if (result.ok) throw new Error('expected parseMission to fail');
  return result.issues;
}

function paths(input: unknown): ReadonlyArray<string> {
  return issuesOf(input).map((issue) => issue.path);
}

function nodes(mission: Record<string, unknown>): Array<Record<string, unknown>> {
  return mission['nodes'] as Array<Record<string, unknown>>;
}

describe('mission schema', () => {
  it('parses the example mission YAML', () => {
    const mission = loadMission(EXAMPLE);
    expect(mission.id).toBe('example-drowned-toll');
    expect(mission.nodes).toHaveLength(10);
    expect(mission.edges).toHaveLength(11);
    const wade = mission.nodes.find((node) => node.id === 'wade-across');
    expect(wade).toEqual({ id: 'wade-across', rank: 4, kind: 'check', check: { type: 'save', ability: 'con', dc: 12 }, loot: 10 });
  });

  it('accepts a check with a requires gate', () => {
    const mission = validMission();
    nodes(mission)[1] = { id: 'look', rank: 1, kind: 'check', check: { type: 'ability', ability: 'str', dc: 10, requires: { speed: 'fly' } }, loot: 5 };
    expect(parseMission(mission).ok).toBe(true);
  });

  it('reports an unknown node kind at its path', () => {
    const mission = validMission();
    nodes(mission)[2] = { id: 'fight', rank: 2, kind: 'ambush' };
    expect(paths(mission)).toEqual(['nodes[2].kind']);
  });

  it('reports a skill check missing `skill` at its path', () => {
    const mission = validMission();
    nodes(mission)[1] = { id: 'look', rank: 1, kind: 'check', check: { type: 'skill', dc: 12 }, loot: 5 };
    expect(paths(mission)).toEqual(['nodes[1].check.skill']);
  });

  it('reports a bad edge condition at its path', () => {
    const mission = validMission();
    (mission['edges'] as Array<Record<string, unknown>>)[3] = { from: 'fight', to: 'done', on: 'lose' };
    const issues = issuesOf(mission);
    expect(issues.map((issue) => issue.path)).toEqual(['edges[3].on']);
    expect(issues[0]?.message).toMatch(/always/);
  });

  it('rejects vocabulary outside the closed lists and unknown keys', () => {
    const mission = validMission();
    nodes(mission)[1] = { id: 'look', rank: 1, kind: 'check', check: { type: 'skill', skill: 'juggling', dc: 12, requires: { sense: 'smell' } }, loot: 5 };
    nodes(mission)[3] = { id: 'done', rank: 3, kind: 'end', title: 'prose belongs in chrome' };
    expect(paths(mission)).toEqual(['nodes[1].check.skill', 'nodes[1].check.requires', 'nodes[3]']);
  });

  it('requires a whole, non-negative loot on every check (D-45)', () => {
    const mission = validMission();
    const { loot: _loot, ...noLoot } = nodes(mission)[1]!;
    nodes(mission)[1] = noLoot;
    expect(paths(mission)).toEqual(['nodes[1].loot']);
    nodes(mission)[1] = { ...noLoot, loot: -5 };
    expect(paths(mission)).toEqual(['nodes[1].loot']);
    nodes(mission)[1] = { ...noLoot, loot: 2.5 };
    expect(paths(mission)).toEqual(['nodes[1].loot']);
  });

  it('reports every malformed field, not just the first', () => {
    const mission = validMission();
    mission['schemaVersion'] = 2;
    nodes(mission)[0] = { id: 'Start Node', rank: -1, kind: 'start' };
    expect(paths(mission)).toEqual(['schemaVersion', 'nodes[0].id', 'nodes[0].rank']);
  });

  it('names the file when the loader cannot read it', () => {
    expect(() => loadMission('seasons/season-01/missions/candidates/does-not-exist.yaml')).toThrow(
      'seasons/season-01/missions/candidates/does-not-exist.yaml: file not found',
    );
  });
});
