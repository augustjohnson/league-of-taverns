/**
 * Random legal missions and random parties for property tests, drawn from a
 * seeded `Rng` (never Math.random). Test-only.
 *
 * Missions are layered DAGs: one start at rank 0 with one `always` edge, then
 * 2–5 layers of checks and battles (plus the odd early end), then a layer of
 * ends. Checks get `pass` + `fail` edges, or one `always`; battles get one
 * `win`. Edges may skip layers. Unreachable nodes are pruned, and a candidate
 * is kept only if `validateMission` accepts it under `PROPERTY_RULES` (so
 * every path attempts a check and at most one check is gated).
 *
 * Check targets and advantages come from a small shared pool, so advantage
 * and `requires` gates actually come into play.
 */
import { TRAITS, effectiveStats, type CheckTarget, type EffectiveStats, type Modifier } from '../../src/characters';
import { validateMission, type CheckSpec, type Mission, type MissionEdge, type MissionNode, type MissionRules, type Requirement } from '../../src/missions';
import type { Party } from '../../src/resolution';
import type { Rng } from '../../src/rng';
import { SENSES, SPEEDS, type CrEighths } from '../../src/vocabulary';
import { FIXTURE_SLUGS } from '../fixtures/open5e';
import { baseOf } from './builders';

/** Wide limits: the generator explores shapes, not season balance. */
export const PROPERTY_RULES: MissionRules = {
  dcBand: { min: 1, max: 30 },
  maxNodes: 100,
  maxRank: 100,
  battlesPerPath: { min: 0, max: 100 },
  encounterCrRatio: 1000,
  partyCr: 96 as CrEighths,
};

const crOf = (slug: string): CrEighths | undefined => (FIXTURE_SLUGS.includes(slug) ? baseOf(slug).cr : undefined);

/** The check targets missions use and advantages are granted on. */
const TARGETS: ReadonlyArray<CheckTarget> = [
  { type: 'skill', skill: 'stealth' },
  { type: 'skill', skill: 'athletics' },
  { type: 'skill', skill: 'perception' },
  { type: 'skill', skill: 'survival' },
  { type: 'save', ability: 'dex' },
  { type: 'save', ability: 'con' },
  { type: 'save', ability: 'wis' },
  { type: 'ability', ability: 'str' },
  { type: 'ability', ability: 'int' },
];

const REQUIREMENTS: ReadonlyArray<Requirement> = [
  ...SPEEDS.filter((speed) => speed !== 'walk').map((speed) => ({ speed })),
  ...SENSES.map((sense) => ({ sense })),
];

/** Integer in [lo, hi]. */
export function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

export function pick<T>(rng: Rng, items: ReadonlyArray<T>): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick: empty list');
  return item;
}

/** A random mission that passes `validateMission` under `PROPERTY_RULES`. */
export function randomMission(rng: Rng, id: string): Mission {
  for (let attempt = 0; attempt < 200; attempt++) {
    const mission = candidate(rng, id);
    if (validateMission(mission, PROPERTY_RULES, crOf).length === 0) return mission;
  }
  throw new Error(`randomMission: no legal mission after 200 attempts (${id})`);
}

function candidate(rng: Rng, id: string): Mission {
  const layers = int(rng, 2, 5);
  const byRank: MissionNode[][] = [[{ id: 'start', rank: 0, kind: 'start' }]];
  let serial = 0;
  for (let rank = 1; rank <= layers; rank++) {
    // Only start feeds rank 1, and start has one edge, so rank 1 has one node.
    const count = rank === 1 ? 1 : int(rng, 1, 3);
    const layer: MissionNode[] = [];
    for (let i = 0; i < count; i++) {
      const nodeId = `n${serial++}`;
      const roll = rng();
      if (rank > 1 && roll < 0.08) layer.push({ id: nodeId, rank, kind: 'end' });
      else if (roll < 0.68) layer.push({ id: nodeId, rank, kind: 'check', check: randomCheck(rng), loot: int(rng, 0, 5) });
      else layer.push({ id: nodeId, rank, kind: 'battle', encounter: { creatures: randomEncounter(rng) } });
    }
    byRank.push(layer);
  }
  byRank.push(Array.from({ length: int(rng, 1, 2) }, (_, i) => ({ id: `end${i}`, rank: layers + 1, kind: 'end' }) as MissionNode));

  const edges: MissionEdge[] = [];
  /** Mostly the next layer, sometimes any higher one. */
  const target = (rank: number): string => {
    const next = byRank[rank + 1] ?? [];
    const higher = byRank.slice(rank + 1).flat();
    return pick(rng, rng() < 0.7 && next.length > 0 ? next : higher).id;
  };
  for (const node of byRank.flat()) {
    switch (node.kind) {
      case 'start':
        edges.push({ from: node.id, to: target(0), on: 'always' });
        break;
      case 'check':
        if (rng() < 0.8) {
          edges.push({ from: node.id, to: target(node.rank), on: 'pass' });
          edges.push({ from: node.id, to: target(node.rank), on: 'fail' });
        } else {
          edges.push({ from: node.id, to: target(node.rank), on: 'always' });
        }
        break;
      case 'battle':
        edges.push({ from: node.id, to: target(node.rank), on: 'win' });
        break;
      case 'end':
        break;
    }
  }

  // Prune what start cannot reach.
  const reached = new Set(['start']);
  for (const node of byRank.flat()) {
    if (!reached.has(node.id)) continue;
    for (const edge of edges) if (edge.from === node.id) reached.add(edge.to);
  }
  let nodes = byRank.flat().filter((node) => reached.has(node.id));

  // Gate at most one reachable check, sometimes.
  const checks = nodes.filter((node) => node.kind === 'check');
  if (checks.length > 0 && rng() < 0.35) {
    const gated = pick(rng, checks);
    const requires = pick(rng, REQUIREMENTS);
    nodes = nodes.map((node) => (node === gated && node.kind === 'check' ? { ...node, check: { ...node.check, requires } } : node));
  }

  return {
    schemaVersion: 1,
    id,
    season: 'season-01',
    environment: 'swamp',
    nodes,
    edges: edges.filter((edge) => reached.has(edge.from)),
  };
}

function randomCheck(rng: Rng): CheckSpec {
  return { ...pick(rng, TARGETS), dc: int(rng, 3, 26) };
}

function randomEncounter(rng: Rng): Array<{ readonly ref: string; readonly count: number }> {
  return Array.from({ length: int(rng, 1, 2) }, () => ({ ref: pick(rng, FIXTURE_SLUGS), count: int(rng, 1, 4) }));
}

/** Four starters on random fixture bases with a few random modifiers each, and a random captain. */
export function randomParty(rng: Rng): Party {
  const members: EffectiveStats[] = [];
  for (let i = 0; i < 4; i++) {
    const slug = pick(rng, FIXTURE_SLUGS);
    members.push(effectiveStats({ ref: { id: `m${i}`, base: slug }, modifiers: randomModifiers(rng) }, baseOf(slug), TRAITS));
  }
  return { captain: pick(rng, members).characterId, members };
}

function randomModifiers(rng: Rng): Modifier[] {
  const modifiers: Modifier[] = [];
  if (rng() < 0.35) modifiers.push({ kind: 'advantage', on: pick(rng, TARGETS) });
  if (rng() < 0.3) {
    const target = pick(rng, TARGETS);
    if (target.type === 'skill') modifiers.push({ kind: 'skill_bonus', skill: target.skill, value: int(rng, 1, 3) });
    else modifiers.push({ kind: 'save_bonus', ability: target.ability, value: int(rng, 1, 2) });
  }
  if (rng() < 0.15) modifiers.push({ kind: 'grant_speed', speed: pick(rng, SPEEDS), feet: 30 });
  if (rng() < 0.15) modifiers.push({ kind: 'grant_sense', sense: pick(rng, SENSES), feet: 60 });
  if (rng() < 0.1) modifiers.push({ kind: 'battle_bonus', value: 1 });
  if (rng() < 0.1) modifiers.push({ kind: 'trait', trait: pick(rng, TRAITS).id });
  return modifiers;
}
