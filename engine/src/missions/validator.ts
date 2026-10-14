/**
 * Mission validator (T5.2): the graph and content rules from docs/schema.md §
 * Mission, applied to a mission that already passed `parseMission`.
 *
 * Issue codes (the docs table, plus `gated`):
 *
 * | Code               | Rule |
 * |--------------------|------|
 * | `start`            | exactly one `start` node, at rank 0 |
 * | `end`              | at least one `end` node, and end nodes have no outgoing edges |
 * | `ids`              | node ids unique, edge endpoints exist |
 * | `rank`             | every edge has `rank(to) > rank(from)` |
 * | `reachable`        | every node is reachable from start |
 * | `edges.check`      | a check has exactly `pass` + `fail`, or exactly one `always` |
 * | `edges.battle`     | a battle has exactly one `win` |
 * | `edges.start`      | start has exactly one `always` |
 * | `scored`           | every start→end path attempts ≥ 1 check |
 * | `haul`             | the most loot any start→end path can bank equals the season's fixed `haul` (D-45). Check loot counts on `pass`/`always`, battle loot on `win` (D-50) |
 * | `gates`            | a party with no special speeds or senses can bank as much as any party: a `requires` gate only opens a better or safer route (D-39) |
 * | `dc`               | `dcBand.min ≤ dc ≤ dcBand.max` |
 * | `encounter.ref`    | every creature ref exists in the pinned snapshot |
 * | `encounter.budget` | Σ count × CR ≤ `floor(encounterCrRatio × B)` per battle, in eighths |
 * | `size`             | node count ≤ `maxNodes`, every rank ≤ `maxRank`, battles on every start→end path within `battlesPerPath` |
 * | `gated`            | at most one check per mission has `requires` (docs/decisions.md D-39) |
 * | `environment`      | when an expected environment is given, the mission's matches it |
 *
 * A dead end (a non-end node with no outgoing edges) is reported under the
 * `edges.*` code for its kind.
 *
 * Every violation is returned, not just the first, because LLM drafting feeds
 * the whole list back into its retry prompt. Messages are written for the GM
 * (or model) fixing the file. Structural failures only switch off the checks
 * they make meaningless: without exactly one start there is no reachability or
 * path analysis, and with a rank violation (a possible cycle) there is no path
 * analysis, but DC, encounter and size checks always run.
 *
 * Path rules (`scored`, `haul`, `gates`, battles per path) are computed by dynamic programming
 * over the layered DAG, not by enumerating paths, so they stay linear in the
 * number of edges. Each issue names one offending end node and an example path.
 */
import type { CrEighths } from '../vocabulary';
import type { BattleNode, CheckNode, Mission, MissionEdge, MissionNode } from './types';

export interface MissionRules {
  readonly dcBand: { readonly min: number; readonly max: number };
  readonly maxNodes: number;
  readonly maxRank: number;
  readonly battlesPerPath: { readonly min: number; readonly max: number };
  /** Encounter difficulty cap: total encounter CR ≤ ratio × B, floored to whole eighths. */
  readonly encounterCrRatio: number;
  readonly partyCr: CrEighths;
  /**
   * The fixed haul (D-45): the loot every mission's best path must pay. Omit
   * to skip the `haul` rule (candidate drafting, tests).
   */
  readonly haul?: number;
}

export interface MissionIssue {
  readonly missionId: string;
  readonly nodeId?: string;
  readonly code: MissionIssueCode;
  readonly message: string;
}

export type MissionIssueCode =
  | 'start'
  | 'end'
  | 'ids'
  | 'rank'
  | 'reachable'
  | 'edges.check'
  | 'edges.battle'
  | 'edges.start'
  | 'scored'
  | 'haul'
  | 'gates'
  | 'dc'
  | 'encounter.ref'
  | 'encounter.budget'
  | 'size'
  | 'gated'
  | 'environment';

export interface ValidateMissionOptions {
  /** The environment of the schedule entry the mission is selected for. Omit for candidates. */
  readonly expectedEnvironment?: string;
}

/** Node ids in rank order, ties broken by id. Shared by resolution, projection and coverage checks. */
export function topologicalOrder(mission: Mission): ReadonlyArray<string> {
  return sortByRankThenId(mission.nodes).map((node) => node.id);
}

/**
 * The haul: the most loot any start→end path can bank (D-45). A check banks
 * its loot when the path leaves it by `pass` or `always`, and nothing when it
 * leaves by `fail`. A battle banks its loot, if any, when the path leaves it
 * by `win` (D-50). Only nodes reached from the start through edges that go
 * up in rank count, so it never throws; it is 0 when no end is reached.
 * Scores are loot ÷ haul, so a mission that passed the `haul` rule scores
 * loot ÷ the season's fixed haul.
 */
export function missionHaul(mission: Mission): number {
  let haul = haulCache.get(mission);
  if (haul === undefined) {
    haul = computeHaul(mission);
    haulCache.set(mission, haul);
  }
  return haul;
}

/** The D-45 loot shape of a mission: how late its loot and its battles come. */
export interface LootShape {
  /** One best path, start to end: a path that banks the haul. Empty when no end is reached. */
  readonly bestPath: ReadonlyArray<string>;
  /** The loot each node on `bestPath` banks on the way, in path order. */
  readonly lootByNode: ReadonlyArray<readonly [string, number]>;
  /** The highest rank of any end node, the mission's length. */
  readonly length: number;
  /** Share of the best path's loot banked by nodes in the last third of the ranks (rank > ⅔ × length). */
  readonly lateShare: number;
  /** The highest rank of any battle reached from start, or null with no battles. */
  readonly lastBattleRank: number | null;
  /**
   * The default D-45 check (docs/decisions.md): at least half the best path's
   * loot in the last third, and the last battle (if any) in the last third.
   * An authoring guide for the difficulty report, not a validator rule.
   */
  readonly ok: boolean;
}

/**
 * The loot shape of `mission` (D-45: rising loot, a late climax). Never
 * throws; a mission with no reachable end has an empty best path.
 */
export function lootShape(mission: Mission): LootShape {
  const start = mission.nodes.find((node) => node.kind === 'start');
  const byId = new Map<string, MissionNode>();
  for (const node of mission.nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const ordered = sortByRankThenId([...byId.values()]);
  const edges = mission.edges.filter((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from !== undefined && to !== undefined && to.rank > from.rank;
  });
  const length = Math.max(0, ...ordered.filter((node) => node.kind === 'end').map((node) => node.rank));
  const late = (rank: number): boolean => rank > (2 * length) / 3;
  const loot = start === undefined ? new Map<string, PathStat>() : maxLoot(start, ordered, edges);
  const best = bestEnd(ordered, loot);
  const bestPath = best === undefined ? [] : tracePath(loot, best.id).split(' → ');
  const lootByNode = bestPath.slice(0, -1).map((id, i): readonly [string, number] => {
    const next = bestPath[i + 1];
    const banked = edges.filter((edge) => edge.from === id && edge.to === next).map((edge) => edgeLoot(byId.get(id), edge));
    return [id, Math.max(0, ...banked)];
  });
  const total = lootByNode.reduce((sum, [, n]) => sum + n, 0);
  const lateLoot = lootByNode.reduce((sum, [id, n]) => sum + (late(byId.get(id)?.rank ?? 0) ? n : 0), 0);
  const lateShare = total === 0 ? 0 : lateLoot / total;
  const battles = ordered.filter((node) => node.kind === 'battle' && loot.has(node.id)).map((node) => node.rank);
  const lastBattleRank = battles.length === 0 ? null : Math.max(...battles);
  return {
    bestPath,
    lootByNode,
    length,
    lateShare,
    lastBattleRank,
    ok: lateShare >= 0.5 && (lastBattleRank === null || late(lastBattleRank)),
  };
}

/** Missions are immutable values, so a mission object's haul never changes. Runs and replays call `missionHaul` per run. */
const haulCache = new WeakMap<Mission, number>();

function computeHaul(mission: Mission): number {
  const start = mission.nodes.find((node) => node.kind === 'start');
  if (start === undefined) return 0;
  const byId = new Map<string, MissionNode>();
  for (const node of mission.nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const ordered = sortByRankThenId([...byId.values()]);
  const edges = mission.edges.filter((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return from !== undefined && to !== undefined && to.rank > from.rank;
  });
  const best = maxLoot(start, ordered, edges);
  let haul = 0;
  for (const node of ordered) {
    const stat = node.kind === 'end' ? best.get(node.id) : undefined;
    if (stat !== undefined && stat.value > haul) haul = stat.value;
  }
  return haul;
}

/**
 * Every violation in `mission`, in rule order. `crOf` returns undefined for
 * slugs missing from the snapshot. Never throws on a mission that passed
 * `parseMission`.
 */
export function validateMission(
  mission: Mission,
  rules: MissionRules,
  crOf: (slug: string) => CrEighths | undefined,
  options: ValidateMissionOptions = {},
): ReadonlyArray<MissionIssue> {
  const issues: MissionIssue[] = [];
  const report = (code: MissionIssueCode, message: string, nodeId?: string): void => {
    issues.push(nodeId === undefined ? { missionId: mission.id, code, message } : { missionId: mission.id, nodeId, code, message });
  };

  // First occurrence wins for duplicate ids; the duplicates are reported under `ids`.
  const byId = new Map<string, MissionNode>();
  for (const node of mission.nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const outgoing = new Map<string, MissionEdge[]>();
  for (const edge of mission.edges) {
    const list = outgoing.get(edge.from);
    if (list) list.push(edge);
    else outgoing.set(edge.from, [edge]);
  }
  /** Edges whose endpoints both exist: the graph every later rule walks. */
  const liveEdges = mission.edges.filter((edge) => byId.has(edge.from) && byId.has(edge.to));
  const ordered = sortByRankThenId([...byId.values()]);

  // start
  const starts = mission.nodes.filter((node) => node.kind === 'start');
  if (starts.length === 0) {
    report('start', 'The mission has no start node. Add exactly one node with `kind: start` at rank 0.');
  } else if (starts.length > 1) {
    for (const extra of starts.slice(1)) {
      report(
        'start',
        `"${extra.id}" is a second start node (the first is "${starts[0]?.id ?? ''}"). A mission has exactly one start; ` +
          'make this a check or battle, or remove it.',
        extra.id,
      );
    }
  }
  for (const start of starts) {
    if (start.rank !== 0) {
      report('start', `Start node "${start.id}" is at rank ${start.rank}. The start node must be at rank 0.`, start.id);
    }
  }
  const start = starts.length === 1 ? starts[0] : undefined;

  // end
  const ends = mission.nodes.filter((node) => node.kind === 'end');
  if (ends.length === 0) {
    report('end', 'The mission has no end node. Add at least one node with `kind: end`.');
  }
  for (const end of ends) {
    const out = outgoing.get(end.id) ?? [];
    if (out.length > 0) {
      report(
        'end',
        `End node "${end.id}" has outgoing edges (${out.map(describeEdge).join(', ')}). The mission stops at an end node; ` +
          'remove these edges or make the node a check or battle.',
        end.id,
      );
    }
  }

  // ids
  const seen = new Set<string>();
  for (const node of mission.nodes) {
    if (seen.has(node.id)) {
      report('ids', `Node id "${node.id}" is used by more than one node. Node ids must be unique.`, node.id);
    }
    seen.add(node.id);
  }
  for (const edge of mission.edges) {
    const missing = [edge.from, edge.to].filter((id, i, all) => !byId.has(id) && all.indexOf(id) === i);
    if (missing.length > 0) {
      report(
        'ids',
        `Edge ${describeEdge(edge)} refers to ${missing.map((id) => `"${id}"`).join(' and ')}, which ` +
          `${missing.length === 1 ? 'is not a node' : 'are not nodes'}. Fix the id or add the node.`,
        byId.has(edge.from) ? edge.from : undefined,
      );
    }
  }

  // rank
  let rankBroken = false;
  for (const edge of liveEdges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (from && to && to.rank <= from.rank) {
      rankBroken = true;
      report(
        'rank',
        `Edge ${describeEdge(edge)} goes from rank ${from.rank} to rank ${to.rank}. Edges must point to a strictly higher ` +
          `rank; raise "${to.id}" above ${from.rank} or point the edge elsewhere.`,
        from.id,
      );
    }
  }

  // reachable
  if (start) {
    const reached = new Set<string>([start.id]);
    const queue: string[] = [start.id];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of outgoing.get(queue[i] ?? '') ?? []) {
        if (byId.has(edge.to) && !reached.has(edge.to)) {
          reached.add(edge.to);
          queue.push(edge.to);
        }
      }
    }
    for (const node of ordered) {
      if (!reached.has(node.id)) {
        report(
          'reachable',
          `Node "${node.id}" (${node.kind}, rank ${node.rank}) cannot be reached from start "${start.id}". ` +
            'Add an edge into it or remove it.',
          node.id,
        );
      }
    }
  }

  // edges.check, edges.battle, edges.start
  for (const node of ordered) {
    if (node.kind === 'end') continue;
    const out = outgoing.get(node.id) ?? [];
    const count = (on: MissionEdge['on']): number => out.filter((edge) => edge.on === on).length;
    const has = out.length === 0 ? 'none (a dead end)' : out.map(describeEdge).join(', ');
    if (node.kind === 'start') {
      if (!(out.length === 1 && count('always') === 1)) {
        report('edges.start', `Start node "${node.id}" needs exactly one \`always\` edge and nothing else; it has ${has}.`, node.id);
      }
    } else if (node.kind === 'check') {
      const passFail = out.length === 2 && count('pass') === 1 && count('fail') === 1;
      const always = out.length === 1 && count('always') === 1;
      if (!passFail && !always) {
        report(
          'edges.check',
          `Check "${node.id}" needs exactly one \`pass\` and one \`fail\` edge, or exactly one \`always\` edge; it has ${has}.`,
          node.id,
        );
      }
    } else if (!(out.length === 1 && count('win') === 1)) {
      report(
        'edges.battle',
        `Battle "${node.id}" needs exactly one \`win\` edge and nothing else (losing is a DNF, so there is no \`lose\` edge); ` +
          `it has ${has}.`,
        node.id,
      );
    }
  }

  // scored, haul, gates and size (battles per path): only on a DAG with a single start.
  if (start && !rankBroken) {
    for (const issue of pathIssues(start, ordered, liveEdges, rules)) report(issue.code, issue.message, issue.nodeId);
  }

  // dc
  const checks = ordered.filter((node): node is CheckNode => node.kind === 'check');
  for (const check of checks) {
    const { dc } = check.check;
    if (dc < rules.dcBand.min || dc > rules.dcBand.max) {
      report(
        'dc',
        `Check "${check.id}" has DC ${dc}, outside this season's band of ${rules.dcBand.min}–${rules.dcBand.max}.`,
        check.id,
      );
    }
  }

  // encounter.ref and encounter.budget
  // The cap is floored to whole eighths when the ratio makes it fractional. The
  // tiny epsilon absorbs float error in decimal ratios (0.29 × 100 is
  // 28.999…996 in binary), so a cap that is exact on paper is not lost.
  const cap = Math.floor(rules.encounterCrRatio * rules.partyCr + 1e-9);
  for (const battle of ordered.filter((node): node is BattleNode => node.kind === 'battle')) {
    let total = 0;
    let unknown = 0;
    const parts: string[] = [];
    for (const creature of battle.encounter.creatures) {
      const cr = crOf(creature.ref);
      if (cr === undefined) {
        unknown++;
        report(
          'encounter.ref',
          `Battle "${battle.id}" uses creature "${creature.ref}", which is not in the season's pinned snapshot. ` +
            'Use an Open5e slug from the snapshot.',
          battle.id,
        );
      } else {
        total += creature.count * cr;
        parts.push(`${creature.count} × ${creature.ref} (CR ${formatCr(cr)})`);
      }
    }
    // With unknown refs the known total is a lower bound, so it can still prove an overrun.
    if (total > cap) {
      report(
        'encounter.budget',
        `Battle "${battle.id}" totals CR ${unknown > 0 ? 'at least ' : ''}${formatCr(total)} (${parts.join(' + ')}), over the ` +
          `encounter cap of CR ${formatCr(cap)} (${rules.encounterCrRatio} × party budget CR ${formatCr(rules.partyCr)}). ` +
          'Use fewer or weaker creatures.',
        battle.id,
      );
    }
  }

  // size (node count and rank)
  if (mission.nodes.length > rules.maxNodes) {
    report('size', `The mission has ${mission.nodes.length} nodes; the season allows at most ${rules.maxNodes}.`);
  }
  for (const node of ordered) {
    if (node.rank > rules.maxRank) {
      report('size', `Node "${node.id}" is at rank ${node.rank}; the season allows ranks up to ${rules.maxRank}.`, node.id);
    }
  }

  // gated (D-39): the first gated check in topological order is allowed.
  const gated = checks.filter((check) => check.check.requires !== undefined);
  const firstGated = gated[0];
  if (firstGated) {
    for (const extra of gated.slice(1)) {
      report(
        'gated',
        `Check "${extra.id}" has a \`requires\` gate, but "${firstGated.id}" already does. A mission may gate at most one ` +
          `check (${gated.map((check) => `"${check.id}"`).join(', ')} are gated); remove the extra gates.`,
        extra.id,
      );
    }
  }

  // environment
  if (options.expectedEnvironment !== undefined && mission.environment !== options.expectedEnvironment) {
    report(
      'environment',
      `The mission's environment is "${mission.environment}", but the schedule entry it is selected for is ` +
        `"${options.expectedEnvironment}".`,
    );
  }

  return issues;
}

/** Best path so far to a node, with the predecessor that produced it, for example paths in messages. */
interface PathStat {
  readonly value: number;
  readonly prev: string | undefined;
}

/**
 * For each node reached from start, the most loot banked on any path from
 * start up to it, with the predecessor that achieved it. Loot is added on the
 * edge out of a check that passed (`pass` or `always`) and out of a battle
 * that was won (`win`). `edges` must all go up in rank, so (rank, id) order is
 * topological.
 *
 * With `ungated`, the party meets no `requires` gate: a gated check always
 * fails, so its `pass` edge is never taken and it banks nothing (D-39).
 */
function maxLoot(
  start: MissionNode,
  ordered: ReadonlyArray<MissionNode>,
  edges: ReadonlyArray<MissionEdge>,
  ungated = false,
): ReadonlyMap<string, PathStat> {
  const byId = new Map(ordered.map((node) => [node.id, node] as const));
  const incoming = new Map<string, MissionEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge);
    else incoming.set(edge.to, [edge]);
  }
  const best = new Map<string, PathStat>();
  for (const node of ordered) {
    if (node.id === start.id) {
      best.set(node.id, { value: 0, prev: undefined });
      continue;
    }
    for (const edge of incoming.get(node.id) ?? []) {
      const from = byId.get(edge.from);
      const gated = ungated && from?.kind === 'check' && from.check.requires !== undefined;
      if (gated && edge.on === 'pass') continue;
      relax(best, node.id, edge.from, gated ? 0 : edgeLoot(from, edge), (a, b) => a > b);
    }
  }
  return best;
}

/** Loot banked by leaving `from` along `edge`: a check's on `pass` or `always`, a battle's on `win`. */
function edgeLoot(from: MissionNode | undefined, edge: MissionEdge): number {
  if (from?.kind === 'check') return edge.on === 'fail' ? 0 : from.loot;
  if (from?.kind === 'battle') return edge.on === 'win' ? (from.loot ?? 0) : 0;
  return 0;
}

/** The end node with the most loot in `loot`, ties to the first in (rank, id) order. */
function bestEnd(ordered: ReadonlyArray<MissionNode>, loot: ReadonlyMap<string, PathStat>): { readonly id: string; readonly value: number } | undefined {
  let best: { readonly id: string; readonly value: number } | undefined;
  for (const end of ordered) {
    const stat = end.kind === 'end' ? loot.get(end.id) : undefined;
    if (stat !== undefined && (best === undefined || stat.value > best.value)) best = { id: end.id, value: stat.value };
  }
  return best;
}

/**
 * `scored`, `haul` and battles-per-path, by DP in (rank, id) order. Requires every live
 * edge to increase rank, so that order is topological.
 */
function pathIssues(
  start: MissionNode,
  ordered: ReadonlyArray<MissionNode>,
  liveEdges: ReadonlyArray<MissionEdge>,
  rules: MissionRules,
): ReadonlyArray<{ readonly code: MissionIssueCode; readonly nodeId: string; readonly message: string }> {
  const incoming = new Map<string, string[]>();
  for (const edge of liveEdges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge.from);
    else incoming.set(edge.to, [edge.from]);
  }

  // For each node reached from start: the fewest checks and the fewest/most
  // battles on any path from start up to and including it.
  const minChecks = new Map<string, PathStat>();
  const minBattles = new Map<string, PathStat>();
  const maxBattles = new Map<string, PathStat>();
  for (const node of ordered) {
    const isCheck = node.kind === 'check' ? 1 : 0;
    const isBattle = node.kind === 'battle' ? 1 : 0;
    if (node.id === start.id) {
      minChecks.set(node.id, { value: isCheck, prev: undefined });
      minBattles.set(node.id, { value: isBattle, prev: undefined });
      maxBattles.set(node.id, { value: isBattle, prev: undefined });
      continue;
    }
    for (const from of incoming.get(node.id) ?? []) {
      relax(minChecks, node.id, from, isCheck, (a, b) => a < b);
      relax(minBattles, node.id, from, isBattle, (a, b) => a < b);
      relax(maxBattles, node.id, from, isBattle, (a, b) => a > b);
    }
  }

  const issues: Array<{ code: MissionIssueCode; nodeId: string; message: string }> = [];
  const { min, max } = rules.battlesPerPath;

  const loot = maxLoot(start, ordered, liveEdges);
  const best = bestEnd(ordered, loot);
  if (rules.haul !== undefined && best !== undefined && best.value !== rules.haul) {
    issues.push({
      code: 'haul',
      nodeId: best.id,
      message:
        `The best path ${tracePath(loot, best.id)} banks ${best.value} loot, but every mission this season must pay a ` +
        `fixed haul of ${rules.haul} on its best path. Adjust the checks' and battles' \`loot\` so the best path sums to ${rules.haul}.`,
    });
  }
  const gates = ordered.filter((node) => node.kind === 'check' && node.check.requires !== undefined).map((node) => node.id);
  if (gates.length > 0 && best !== undefined) {
    const plainLoot = maxLoot(start, ordered, liveEdges, true);
    const plain = bestEnd(ordered, plainLoot);
    if (plain === undefined || plain.value < best.value) {
      issues.push({
        code: 'gates',
        nodeId: plain?.id ?? best.id,
        message:
          `A party that meets no gate (${gates.map((id) => `"${id}"`).join(', ')}) can bank at most ${plain?.value ?? 0} loot` +
          `${plain === undefined ? '' : `, on ${tracePath(plainLoot, plain.id)}`}, but the best path banks ${best.value}. ` +
          'A gate may only open a better or safer route (D-39): give the ungated route the full haul too.',
      });
    }
  }
  for (const end of ordered) {
    if (end.kind !== 'end') continue;
    const checks = minChecks.get(end.id);
    if (checks === undefined) continue; // unreachable, already reported
    if (checks.value === 0) {
      issues.push({
        code: 'scored',
        nodeId: end.id,
        message:
          `The path ${tracePath(minChecks, end.id)} reaches end "${end.id}" without attempting a check, so it has no ` +
          'score. Put at least one check on every path to an end.',
      });
    }
    const most = maxBattles.get(end.id);
    if (most !== undefined && most.value > max) {
      issues.push({
        code: 'size',
        nodeId: end.id,
        message:
          `The path ${tracePath(maxBattles, end.id)} has ${most.value} battles; the season allows at most ${max} ` +
          'battles on any path.',
      });
    }
    const fewest = minBattles.get(end.id);
    if (fewest !== undefined && fewest.value < min) {
      issues.push({
        code: 'size',
        nodeId: end.id,
        message:
          `The path ${tracePath(minBattles, end.id)} has ${fewest.value} battle${fewest.value === 1 ? '' : 's'}; the season ` +
          `requires at least ${min} on every path.`,
      });
    }
  }
  return issues;
}

/** Extend `to` with a path through `from` when that beats what `to` has. Ties keep the first, which is (rank, id) order. */
function relax(
  stats: Map<string, PathStat>,
  to: string,
  from: string,
  add: number,
  better: (a: number, b: number) => boolean,
): void {
  const via = stats.get(from);
  if (via === undefined) return; // `from` is not reached from start
  const candidate = via.value + add;
  const current = stats.get(to);
  if (current === undefined || better(candidate, current.value)) stats.set(to, { value: candidate, prev: from });
}

/** `start → a → b`, following predecessors back from `id`. */
function tracePath(stats: ReadonlyMap<string, PathStat>, id: string): string {
  const path: string[] = [];
  const visited = new Set<string>();
  for (let at: string | undefined = id; at !== undefined && !visited.has(at); at = stats.get(at)?.prev) {
    visited.add(at);
    path.push(at);
  }
  return path.reverse().join(' → ');
}

function sortByRankThenId<T extends MissionNode>(nodes: ReadonlyArray<T>): T[] {
  return [...nodes].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function describeEdge(edge: MissionEdge): string {
  return `${edge.from} → ${edge.to} (${edge.on})`;
}

/** Eighths as a readable CR: 1 → "1/8", 4 → "1/2", 100 → "12 1/2". */
function formatCr(eighths: number): string {
  if (!Number.isInteger(eighths)) return String(eighths / 8);
  const whole = Math.floor(eighths / 8);
  const rest = eighths - whole * 8;
  if (rest === 0) return String(whole);
  const divisor = gcd(rest, 8);
  const fraction = `${rest / divisor}/${8 / divisor}`;
  return whole === 0 ? fraction : `${whole} ${fraction}`;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
