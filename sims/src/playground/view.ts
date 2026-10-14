/**
 * Pure view-model helpers for the playground: mission graph layout, score
 * histograms, Monte Carlo sampling, the draft board, the banner stylesheet,
 * and the small formatters the page uses. No DOM, so tests run them in Node.
 */
import { SKILLS, replay, retreatOptions, runMission, rngFor } from '@league-of-taverns/engine';
import type {
  Ability,
  Actor,
  BaseStats,
  BattleModel,
  CheckSpec,
  EffectiveStats,
  LeagueEvent,
  Mission,
  MissionNode,
  Modifier,
  NodeRecord,
  Party,
  RetreatOrder,
  RunOptions,
  RunResult,
  Skill,
} from '@league-of-taverns/engine';
import type { GodChrome } from '@league-of-taverns/scripts/lib/god-schema';
import type { Aggregate } from '../season-runner';

// ── mission graph layout ───────────────────────────────────────────────────

export interface LaidOutNode {
  readonly id: string;
  readonly kind: MissionNode['kind'];
  readonly rank: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** One short line under the id: what the node tests. */
  readonly detail: string;
}

export interface LaidOutEdge {
  readonly from: string;
  readonly to: string;
  readonly on: string;
  /** SVG path data, a cubic from the source's right edge to the target's left edge. */
  readonly d: string;
  /** Label anchor: the curve's midpoint. */
  readonly lx: number;
  readonly ly: number;
}

export interface GraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<LaidOutNode>;
  readonly edges: ReadonlyArray<LaidOutEdge>;
}

export const GRAPH = { nodeW: 132, nodeH: 46, colGap: 32, rowGap: 22, pad: 14 } as const;

/**
 * Lay a mission out as columns by rank. Within a column, nodes sit in the
 * mean row of their predecessors (a single barycenter pass, left to right),
 * ties broken by file order, which keeps most edges short and uncrossed.
 * Columns are centred vertically on the tallest one.
 */
export function layoutMission(mission: Mission): GraphLayout {
  const { nodeW, nodeH, colGap, rowGap, pad } = GRAPH;
  const ranks = [...new Set(mission.nodes.map((n) => n.rank))].sort((a, b) => a - b);
  const column = new Map(ranks.map((rank, i) => [rank, i]));
  const fileIndex = new Map(mission.nodes.map((n, i) => [n.id, i]));
  const row = new Map<string, number>();
  const byRank = new Map<number, MissionNode[]>();
  for (const node of mission.nodes) byRank.set(node.rank, [...(byRank.get(node.rank) ?? []), node]);

  for (const rank of ranks) {
    const nodes = byRank.get(rank)!;
    const centre = (node: MissionNode): number => {
      const preds = mission.edges.filter((e) => e.to === node.id).map((e) => row.get(e.from));
      const known = preds.filter((r): r is number => r !== undefined);
      return known.length === 0 ? fileIndex.get(node.id)! : known.reduce((a, b) => a + b, 0) / known.length;
    };
    const keyed = nodes.map((node) => ({ node, key: centre(node) }));
    keyed.sort((a, b) => a.key - b.key || fileIndex.get(a.node.id)! - fileIndex.get(b.node.id)!);
    keyed.forEach(({ node }, i) => row.set(node.id, i));
  }

  const tallest = Math.max(1, ...ranks.map((r) => byRank.get(r)!.length));
  const height = pad * 2 + tallest * nodeH + (tallest - 1) * rowGap;
  const width = pad * 2 + ranks.length * nodeW + Math.max(0, ranks.length - 1) * colGap;
  const placed = new Map<string, LaidOutNode>();
  for (const node of mission.nodes) {
    if (placed.has(node.id)) continue;
    const count = byRank.get(node.rank)!.length;
    const offset = ((tallest - count) * (nodeH + rowGap)) / 2;
    placed.set(node.id, {
      id: node.id,
      kind: node.kind,
      rank: node.rank,
      x: pad + column.get(node.rank)! * (nodeW + colGap),
      y: pad + offset + row.get(node.id)! * (nodeH + rowGap),
      w: nodeW,
      h: nodeH,
      detail: nodeDetail(node),
    });
  }

  const edges: LaidOutEdge[] = [];
  for (const edge of mission.edges) {
    const a = placed.get(edge.from);
    const b = placed.get(edge.to);
    if (a === undefined || b === undefined) continue;
    const x0 = a.x + a.w;
    const y0 = a.y + a.h / 2;
    const x3 = b.x;
    const y3 = b.y + b.h / 2;
    const dx = Math.max(18, (x3 - x0) / 2);
    edges.push({
      from: edge.from,
      to: edge.to,
      on: edge.on,
      d: `M${r1(x0)},${r1(y0)} C${r1(x0 + dx)},${r1(y0)} ${r1(x3 - dx)},${r1(y3)} ${r1(x3)},${r1(y3)}`,
      lx: r1((x0 + x3) / 2),
      ly: r1((y0 + y3) / 2),
    });
  }
  return { width, height, nodes: [...placed.values()], edges };
}

function r1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** "athletics DC 13", "save con DC 12 · fly", "ogre, 4 orc", "start". */
export function nodeDetail(node: MissionNode): string {
  switch (node.kind) {
    case 'check':
      return checkLabel(node.check);
    case 'battle':
      return node.encounter.creatures.map((c) => (c.count === 1 ? c.ref : `${c.count} ${c.ref}`)).join(', ');
    default:
      return node.kind;
  }
}

export function checkLabel(check: CheckSpec): string {
  const what = check.type === 'skill' ? check.skill.replaceAll('_', ' ') : `${check.type} ${check.ability}`;
  const gate = check.requires === undefined ? '' : ` · needs ${'speed' in check.requires ? check.requires.speed : check.requires.sense}`;
  return `${what} DC ${check.dc}${gate}`;
}

// ── scores and sampling ────────────────────────────────────────────────────

/** Same score within floating error (scores are small fractions). */
export function sameScore(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/**
 * Count `samples` against a known support (the projection's score values).
 * `other` counts samples that match no support value: with a correct engine
 * it is always 0, so the page shows it as a check.
 */
export function scoreHistogram(samples: ReadonlyArray<number>, support: ReadonlyArray<number>): { readonly counts: ReadonlyArray<number>; readonly other: number } {
  const counts = support.map(() => 0);
  let other = 0;
  for (const s of samples) {
    const i = support.findIndex((v) => sameScore(v, s));
    if (i < 0) other++;
    else counts[i]!++;
  }
  return { counts, other };
}

export interface SampleResult {
  readonly n: number;
  readonly scores: ReadonlyArray<number>;
  readonly dnfs: number;
  readonly mean: number;
}

/**
 * `n` independent runs of `party` on `mission`. Run i draws its dice from
 * `rngFor(seed, i + ':roll:' + node)`, so a seed reproduces the whole batch.
 */
export function sampleMission(
  party: Party,
  mission: Mission,
  baseOf: (slug: string) => BaseStats,
  model: BattleModel,
  n: number,
  seed: string,
  options: RunOptions = {},
): SampleResult {
  const scores: number[] = [];
  let dnfs = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const run = runMission(party, mission, (node) => rngFor(seed, `${i}:roll:${node}`), baseOf, model, options);
    scores.push(run.score);
    total += run.score;
    if (run.dnf) dnfs++;
  }
  return { n, scores, dnfs, mean: n === 0 ? 0 : total / n };
}

/** A party in lineup order, as the season runner builds it, under a rival's hex if any (D-52). */
export function partyFrom(starters: ReadonlyArray<string>, statsOf: (id: string) => EffectiveStats, hex?: Ability): Party {
  const members = starters.map(statsOf);
  return hex === undefined ? { members } : { members, hex };
}

// ── retreat orders (D-49) ──────────────────────────────────────────────────

/** A retreat order in words. */
export function retreatLabel(retreat: RetreatOrder): string {
  if (retreat === 'never') return 'never turn back';
  if (retreat === 'avoid_battles') return 'avoid every battle';
  return `turn back with ${retreat.bank}+ loot`;
}

/** A retreat order as a `<select>` value: `never`, `avoid_battles` or `bank:N`. */
export function retreatValue(retreat: RetreatOrder): string {
  return typeof retreat === 'string' ? retreat : `bank:${retreat.bank}`;
}

/** The inverse of `retreatValue`. Anything unreadable is `never`, the default. */
export function parseRetreat(value: string): RetreatOrder {
  if (value === 'avoid_battles') return 'avoid_battles';
  const bank = /^bank:(\d+)$/.exec(value);
  return bank === null ? 'never' : { bank: Number(bank[1]) };
}

/** The retreat orders a picker offers: the engine's `retreatOptions` (D-49). */
export function retreatChoices(haul: number): ReadonlyArray<RetreatOrder> {
  return retreatOptions(haul);
}

// ── draft board ────────────────────────────────────────────────────────────

export interface DraftCell {
  readonly pick: number;
  readonly tavern: string;
  readonly character: string;
}

export interface DraftRow {
  readonly round: number;
  /** Snake direction across the slots: left to right on even rounds (0-based). */
  readonly direction: 'ltr' | 'rtl';
  /** One cell per slot of `order`, null where no pick was made. */
  readonly cells: ReadonlyArray<DraftCell | null>;
}

/** Rounds × draft slots. Slot s is `order[s]`; pick p is round ⌊p/n⌋, slot p mod n, reversed on odd rounds. */
export function draftBoard(order: ReadonlyArray<string>, picks: ReadonlyArray<DraftCell>): ReadonlyArray<DraftRow> {
  const n = order.length;
  if (n === 0) return [];
  const rounds = Math.ceil(picks.length / n);
  const rows: Array<{ round: number; direction: 'ltr' | 'rtl'; cells: Array<DraftCell | null> }> = [];
  for (let r = 0; r < rounds; r++) rows.push({ round: r + 1, direction: r % 2 === 0 ? 'ltr' : 'rtl', cells: order.map(() => null) });
  for (const p of picks) {
    const round = Math.floor(p.pick / n);
    const i = p.pick % n;
    const slot = round % 2 === 0 ? i : n - 1 - i;
    rows[round]!.cells[slot] = p;
  }
  return rows;
}

// ── rosters over time ──────────────────────────────────────────────────────

/** Each tavern's roster at week `week`'s lineup lock, by replaying the log up to that `lineup.locked`. Final rosters if the week has no lock. */
export function rostersAtLock(events: ReadonlyArray<LeagueEvent>, week: number): ReadonlyMap<string, ReadonlyArray<string>> {
  const at = events.findIndex((e) => e.type === 'lineup.locked' && e.payload.week === week);
  const state = replay(at < 0 ? events : events.slice(0, at + 1));
  return new Map([...state.taverns.values()].map((t) => [t.id, t.roster]));
}

// ── formatting ─────────────────────────────────────────────────────────────

/** Human CR from eighths: 4 → "1/2", 100 → "12 1/2". */
export function formatCr(eighths: number): string {
  const whole = Math.floor(eighths / 8);
  let num = eighths % 8;
  if (num === 0) return String(whole);
  let den = 8;
  while (num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  return whole === 0 ? `${num}/${den}` : `${whole} ${num}/${den}`;
}

/**
 * A CR total from eighths as a decimal: 58 → "7.25", 96 → "12". Totals are
 * compared with the budget, and "7 1/4 of 12" reads like a ratio.
 */
export function formatCrTotal(eighths: number): string {
  return String(Math.round((eighths / 8) * 1000) / 1000);
}

/** A waiver outcome reason in words. */
export function waiverReasonLabel(reason: string): string {
  switch (reason) {
    case 'awarded':
      return 'awarded';
    case 'add_unavailable':
      return 'already taken';
    case 'drop_not_owned':
      return 'drop no longer on roster';
    case 'roster_full':
      return 'roster full';
    default:
      return reason.replaceAll('_', ' ');
  }
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}

export function pct(x: number, digits = 1): string {
  return `${(100 * x).toFixed(digits)}%`;
}

/** A score in [0, 1] as its smallest fraction with denominator ≤ 24 ("2/3"), else 3 decimals. */
export function scoreFraction(x: number): string {
  if (sameScore(x, 0)) return '0';
  if (sameScore(x, 1)) return '1';
  for (let d = 2; d <= 24; d++) {
    const n = Math.round(x * d);
    if (sameScore(n / d, x)) return `${n}/${d}`;
  }
  return x.toFixed(3);
}

export function formatModifier(m: Modifier): string {
  switch (m.kind) {
    case 'trait':
      return `trait ${m.trait}`;
    case 'skill_bonus':
      return `${m.skill.replaceAll('_', ' ')} ${signed(m.value)}`;
    case 'save_bonus':
      return `${m.ability} save ${signed(m.value)}`;
    case 'advantage':
      return `adv. ${m.on.type === 'skill' ? m.on.skill.replaceAll('_', ' ') : `${m.on.type} ${m.on.ability}`}`;
    case 'grant_speed':
      return `${m.speed} ${m.feet} ft`;
    case 'grant_sense':
      return `${m.sense} ${m.feet} ft`;
    case 'battle_bonus':
      return `battle ${signed(m.value)}`;
  }
}

/** The `n` highest effective skill modifiers, ties in vocabulary order. */
export function topSkills(stats: EffectiveStats, n = 3): ReadonlyArray<{ readonly skill: Skill; readonly modifier: number }> {
  return SKILLS.map((skill, i) => ({ skill, modifier: stats.skills[skill], i }))
    .sort((a, b) => b.modifier - a.modifier || a.i - b.i)
    .slice(0, n)
    .map(({ skill, modifier }) => ({ skill, modifier }));
}

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'bot':
      return `bot:${actor.strategy}`;
    case 'system':
      return `system:${actor.workflow}`;
    default:
      return `${actor.kind}:${actor.login}`;
  }
}

/** One line per event for the log list. */
export function eventSummary(event: LeagueEvent): string {
  switch (event.type) {
    case 'season.created':
      return `${event.payload.config.id}: ${event.payload.config.weeks} weeks, B = ${formatCr(event.payload.config.budget.partyCr)}`;
    case 'character.pooled':
      return `${event.payload.character} (${event.payload.base}, CR ${formatCr(event.payload.cr)})${event.payload.modifiers.length > 0 ? ` +${event.payload.modifiers.length} mod` : ''}`;
    case 'manager.joined':
      return `${event.payload.manager} (${'bot' in event.payload.account ? event.payload.account.bot : event.payload.account.login})`;
    case 'tavern.chosen':
      return `${event.payload.manager} chooses ${event.payload.tavern}`;
    case 'draft.pick':
      return `#${event.payload.pick + 1} ${event.payload.tavern} takes ${event.payload.character}`;
    case 'lineup.set':
      return `wk ${event.payload.week} ${event.payload.tavern}: ${event.payload.lineup.starters.join(', ')} (${retreatLabel(event.payload.lineup.retreat)})`;
    case 'lineup.locked':
      return `wk ${event.payload.week}: ${event.payload.lineups.length} lineups (${event.payload.lineups.map((l) => l.source).join(', ')})`;
    case 'mission.revealed':
      return `wk ${event.payload.week}: ${event.payload.mission.id}`;
    case 'mission.resolved': {
      const p = event.payload;
      return `wk ${p.week} ${p.tavern}: ${p.points} pts (proj ${p.projectedPoints.toFixed(1)})${p.run.dnf ? ' DNF' : ''}`;
    }
    case 'week.finalized':
      return `wk ${event.payload.week} final`;
    case 'waiver.claimed':
      return `${event.payload.tavern}: +${event.payload.add}${event.payload.drop === null ? '' : ` −${event.payload.drop}`}`;
    case 'waiver.resolved':
      return `wk ${event.payload.week}: ${event.payload.outcomes.filter((o) => o.awarded).length}/${event.payload.outcomes.length} awarded`;
    default:
      return '';
  }
}

/** The CLI's aggregate table (mock-season.ts `print`), as rows of cells. */
export function aggregateRows(totals: Aggregate): { readonly header: ReadonlyArray<string>; readonly rows: ReadonlyArray<ReadonlyArray<string>> } {
  const header = ['bot', 'seats', 'titles', 'titles/seat', 'week top%', 'mean pts', 'mean proj', 'DNF%'];
  const rows = Object.entries(totals.byBot).map(([bot, a]) => [
    bot,
    String(a.seats),
    Number.isInteger(a.titles) ? String(a.titles) : a.titles.toFixed(1),
    a.titlesPerSeat.toFixed(3),
    pct(a.weekTopRate),
    a.meanPoints.toFixed(1),
    a.meanProjected.toFixed(1),
    pct(a.dnfRate),
  ]);
  return { header, rows };
}

// ── seeds ──────────────────────────────────────────────────────────────────

const SEED_ADJECTIVES = ['amber', 'brassy', 'crooked', 'drowsy', 'gilded', 'hollow', 'mossy', 'rusty', 'salty', 'smoky', 'sodden', 'tarnished', 'thorny', 'wobbly'];
const SEED_NOUNS = ['ale', 'anvil', 'barrel', 'candle', 'flagon', 'goblet', 'hearth', 'kettle', 'lantern', 'mug', 'stool', 'tankard', 'trencher', 'wick'];

/** "mossy-flagon-37": two words and a number from `rand` (any [0, 1) source). Never contains "/". */
export function seedWords(rand: () => number): string {
  const pick = <T>(list: ReadonlyArray<T>): T => list[Math.floor(rand() * list.length)]!;
  return `${pick(SEED_ADJECTIVES)}-${pick(SEED_NOUNS)}-${Math.floor(rand() * 100)}`;
}

// ── the week reveal ────────────────────────────────────────────────────────

/** One node of a run, in path order, as the week reveal plays it. */
export interface TaleStep {
  readonly node: string;
  /** The node before it on the path, null for the first. */
  readonly from: string | null;
  /** The check or battle rolled here, null for a node with no roll (start, end). */
  readonly record: NodeRecord | null;
  /** Loot this node banked: a passed check's `loot`, a won battle's bounty, else 0. */
  readonly bank: number;
  /** Loot banked so far, this node included. A DNF loses it all afterwards (D-54). */
  readonly total: number;
}

/**
 * The steps of a run in path order, with the loot banked along the way. The
 * last step's `total` is `run.loot` unless the run ended in a DNF, which
 * carries nothing home.
 */
export function taleSteps(mission: Mission, run: RunResult): ReadonlyArray<TaleStep> {
  const nodes = new Map(mission.nodes.map((n) => [n.id, n]));
  const records = new Map(run.nodes.map((r) => [r.node, r]));
  let total = 0;
  return run.path.map((id, i) => {
    const node = nodes.get(id);
    const record = records.get(id) ?? null;
    const bank =
      record === null || node === undefined
        ? 0
        : record.kind === 'check' && node.kind === 'check' && record.outcome === 'pass'
          ? node.loot
          : record.kind === 'battle' && node.kind === 'battle' && record.outcome === 'win'
            ? (node.loot ?? 0)
            : 0;
    total += bank;
    return { node: id, from: i === 0 ? null : run.path[i - 1]!, record, bank, total };
  });
}

/**
 * How a week went for one tavern, which sets the size of its moment (fx.ts
 * weekMoment). One per week, the first that holds: a DNF (loss), topping the
 * week (triumph), turning back (relief), beating the scrying ball's own
 * projection (satisfaction), else quiet, which gets no effect at all so the
 * others keep meaning something.
 */
export type WeekOutcome = 'dnf' | 'top' | 'retreat' | 'good' | 'quiet';

export function weekOutcome(week: {
  readonly rank: number;
  readonly points: number;
  readonly projected: number;
  readonly dnf: boolean;
  readonly retreated: boolean;
}): WeekOutcome {
  if (week.dnf) return 'dnf';
  if (week.rank === 1 && week.points > 0) return 'top';
  if (week.retreated) return 'retreat';
  if (week.points > week.projected) return 'good';
  return 'quiet';
}

// ── banners ────────────────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-f]{6}$/;

/**
 * The gods that get a banner: those whose id, colours and texture name are
 * well formed. The build validates every god file; this keeps a bad value
 * out of a selector or a style attribute all the same.
 */
export function bannerGods(gods: Readonly<Record<string, GodChrome>>): ReadonlySet<string> {
  return new Set(
    Object.entries(gods)
      .filter(([god, { banner: b }]) => KEBAB.test(god) && HEX.test(b.field) && HEX.test(b.charge) && HEX.test(b.mark) && KEBAB.test(b.texture))
      .map(([god]) => god),
  );
}

/**
 * The banner stylesheet: per god, its mark as `--mark-<god>` on :root (for
 * swatches and chart lines anywhere) and, on `[data-banner="<god>"]`, its
 * colours and texture as custom properties. page.html § Banners turns those
 * into every banner surface, so no god has CSS of its own. Only `bannerGods`.
 */
export function bannerCss(gods: Readonly<Record<string, GodChrome>>): string {
  return [...bannerGods(gods)]
    .map((god) => {
      const b = gods[god]!.banner;
      return (
        `:root{--mark-${god}:${b.mark}}\n` +
        `[data-banner="${god}"]{--banner-field:${b.field};--banner-charge:${b.charge};--banner-mark:${b.mark};--banner-pattern:var(--tex-${b.texture})}`
      );
    })
    .join('\n');
}
