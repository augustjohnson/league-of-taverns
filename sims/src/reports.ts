/**
 * Season reports: luck, title odds and loot left on the bench. Drafts, for
 * the playground's Reports and Batch tabs; nothing here feeds back into a
 * season.
 *
 * The league is a table by total loot (rules §8): no matchups, so every
 * report is about a tavern's own loot against what it could have expected.
 *
 * - **Luck** (`luckReport`): loot above the projection, the mean percentile
 *   of each week's loot in its own exact distribution, checks and battles won
 *   above their chances, and the rank the tavern would hold had every tavern
 *   scored exactly its projection.
 * - **Title odds** (`titleOdds`): after the draft and after each finalized
 *   week, Monte Carlo the rest of the season. Each tavern plays the lineup its
 *   own strategy would pick from its roster at that point (a person's seat:
 *   the `projection` strategy), and each week's loot is drawn from that
 *   lineup's exact distribution, home bonus included.
 * - **Bench** (`benchReport`): for each tavern-week, what the roster at the
 *   lock could have scored instead. Two lenses, because a benched character
 *   never rolled: **projected** (exact expected loot, the call you could have
 *   made) and **same dice** (rerun with the week's seed: every node has its
 *   own fixed roll, so a different party meets the same d20s at the same
 *   nodes; hindsight, with the luck held fixed).
 * - **Batch** (`luckSeason`, `aggregateLuck`): luck over many seasons. A
 *   season's total loot is exactly its projected total (strength) plus its
 *   loot above projection (luck), so their spreads split the table cleanly.
 *
 * Pure: no I/O, no clock, no ambient randomness. Title odds draw from
 * `rngFor(seed, ...)`, so a seed gives the same report everywhere.
 */
import { botManager, legalSubsets, lineupFrom, projectionLineup } from '@league-of-taverns/bots';
import type { LineupStrategy, PublicView, Subset } from '@league-of-taverns/bots';
import {
  applyEvent,
  checkOdds,
  homeTavern,
  initialState,
  projectMission,
  projectedPoints,
  rngFor,
  runMission,
  runPoints,
  seasonStandings,
  weekResults,
} from '@league-of-taverns/engine';
import type { CheckNode, LeagueEvent, LeagueState, Lineup, Mission, Party, Projection, Rng, SeasonConfig } from '@league-of-taverns/engine';
import type { RunSummary, SeasonInput, Seat } from './season-runner';

// ── shared ─────────────────────────────────────────────────────────────────

/** Points as a distribution: [points, probability] pairs, ascending, summing to 1. */
export type PointsDistribution = ReadonlyArray<readonly [number, number]>;

/**
 * The expensive parts every report shares: one projection per (mission,
 * starters), and the season's states around each week's lock.
 */
export class ReportContext {
  private readonly projections = new Map<string, Projection>();
  /** State just before week w's `lineup.locked` (rosters after the previous waivers). */
  readonly beforeLock = new Map<number, LeagueState>();
  /** State just after week w's `lineup.locked`. */
  readonly atLock = new Map<number, LeagueState>();
  readonly config: SeasonConfig;
  private readonly seatOf: ReadonlyMap<string, Seat>;

  constructor(
    readonly input: SeasonInput,
    /** Who manages each tavern (`RunSummary.taverns`): its bot picks its future lineups in title odds; `human` uses `projection`. */
    taverns: ReadonlyArray<{ readonly tavern: string; readonly bot: Seat }>,
    /** The season's events so far. */
    readonly events: ReadonlyArray<LeagueEvent>,
    /** The state after `events`. */
    readonly state: LeagueState,
  ) {
    if (state.config === null) throw new Error('reports: the season has no config');
    this.config = state.config;
    this.seatOf = new Map(taverns.map((t) => [t.tavern, t.bot]));
    let folded = initialState();
    for (const e of events) {
      if (e.type === 'lineup.locked') this.beforeLock.set(e.payload.week, folded);
      folded = applyEvent(folded, e);
      if (e.type === 'lineup.locked') this.atLock.set(e.payload.week, folded);
    }
  }

  /** The exact projection of these starters on `mission`. Cached by the set of starters, since lineup order never changes a pass chance. */
  project(mission: Mission, starters: ReadonlyArray<string>): Projection {
    const key = `${mission.id}\u0000${[...starters].sort().join('\u0000')}`;
    let p = this.projections.get(key);
    if (p === undefined) {
      p = projectMission(this.party(starters), mission, this.input.baseOf, this.input.battleModel);
      this.projections.set(key, p);
    }
    return p;
  }

  party(starters: ReadonlyArray<string>): Party {
    return { members: starters.map(this.input.statsOf) };
  }

  /** True when `week` is `tavern`'s sponsor's week, so its loot carries the home bonus. */
  home(tavern: string, week: number): boolean {
    return homeTavern(this.state, week) === tavern;
  }

  /** A projection's score distribution as points (`runPoints`, home bonus included), merged where rounding collides. */
  points(projection: Projection, home: boolean): PointsDistribution {
    const merged = new Map<number, number>();
    for (const [score, p] of projection.distribution) {
      const pts = runPoints(score, this.config.scoring, home);
      merged.set(pts, (merged.get(pts) ?? 0) + p);
    }
    return [...merged].sort((a, b) => a[0] - b[0]);
  }

  /** Exact expected points of a projection, home bonus included. */
  expected(projection: Projection, home: boolean): number {
    return projectedPoints(projection.expectedScore, this.config.scoring, home);
  }

  /** A bot-style view of `state` for `tavern`, for lineup strategies. */
  view(state: LeagueState, tavern: string): PublicView {
    return {
      state,
      tavern,
      statsOf: this.input.statsOf,
      schedule: this.input.schedule,
      missionFor: (week) => this.input.missions.get(week)?.mission ?? null,
      baseOf: this.input.baseOf,
      battleModel: this.input.battleModel,
      rng: rngFor('reports', `view:${tavern}`),
    };
  }

  /** The lineup strategy `tavern`'s manager plays: its bot's, or `projection` for a person. */
  strategy(tavern: string): LineupStrategy {
    const seat = this.seatOf.get(tavern);
    return seat === undefined || seat === 'human' ? projectionLineup : botManager(seat).lineup;
  }

  /** The mission week `week` was (or will be) played on. */
  mission(week: number): Mission {
    const m = this.state.revealed.get(week) ?? this.input.missions.get(week)?.mission;
    if (m === undefined) throw new Error(`reports: no mission for week ${week}`);
    return m;
  }

  taverns(): ReadonlyArray<string> {
    return [...this.state.taverns.keys()];
  }

  finalizedWeeks(): ReadonlyArray<number> {
    return [...this.state.finalizedWeeks].sort((a, b) => a - b);
  }
}

/** P(X < x) + ½·P(X = x): where `x` falls in `dist`, 0.5 being dead average. */
export function midPercentile(dist: PointsDistribution, x: number): number {
  let below = 0;
  let at = 0;
  for (const [v, p] of dist) {
    if (v < x) below += p;
    else if (v === x) at += p;
  }
  return below + at / 2;
}

/** 1-based rank of `points` among `others` (which exclude it): one more than the number strictly above, so ties share a rank. */
function rankAmong(points: number, others: ReadonlyArray<number>): number {
  return 1 + others.filter((p) => p > points).length;
}

// ── luck ───────────────────────────────────────────────────────────────────

export interface LuckWeek {
  readonly week: number;
  readonly points: number;
  readonly projected: number;
  readonly home: boolean;
  /** Where the loot fell in its own exact distribution (0.5 = average). Null with no lineup. */
  readonly percentile: number | null;
  /** Checks passed minus Σ pass chance, over the checks actually rolled. */
  readonly checksAbove: number;
  /** Battles won minus Σ P(win), over the battles actually fought. */
  readonly battlesAbove: number;
}

export interface LuckRow {
  readonly tavern: string;
  readonly weeks: ReadonlyArray<LuckWeek>;
  /** Σ (points − projected): the headline luck index. */
  readonly pointsAbove: number;
  /** Σ projected: what the lineups were expected to bank (strength). */
  readonly projected: number;
  /** Σ points. Always `projected + pointsAbove`. */
  readonly points: number;
  /** Mean weekly percentile over the weeks with a lineup, or null with none. */
  readonly meanPercentile: number | null;
  readonly checksAbove: number;
  readonly battlesAbove: number;
  /** Rank by actual total loot (ties share). */
  readonly rank: number;
  /** Rank had every tavern banked exactly its projection: lower than `rank` means luck helped. */
  readonly projectedRank: number;
}

/** Luck per tavern over the finalized weeks, luckiest first. */
export function luckReport(ctx: ReportContext): ReadonlyArray<LuckRow> {
  const { state } = ctx;
  const rows = new Map<string, LuckWeek[]>(ctx.taverns().map((t) => [t, []]));
  for (const week of ctx.finalizedWeeks()) {
    const mission = ctx.mission(week);
    const nodes = new Map(mission.nodes.map((n) => [n.id, n]));
    const resolved = state.results.get(week);
    for (const r of weekResults(state, week)) {
      const res = resolved?.get(r.tavern);
      const home = ctx.home(r.tavern, week);
      let checksAbove = 0;
      let battlesAbove = 0;
      let percentile: number | null = null;
      if (res !== undefined) {
        const starters = startersOf(res.lineup);
        percentile = midPercentile(ctx.points(ctx.project(mission, starters), home), r.points);
        const party = ctx.party(starters);
        for (const rec of res.run.nodes) {
          if (rec.kind === 'check') checksAbove += (rec.outcome === 'pass' ? 1 : 0) - checkOdds(party, (nodes.get(rec.node) as CheckNode).check).pPass;
          else battlesAbove += (rec.outcome === 'win' ? 1 : 0) - rec.pWin;
        }
      }
      rows.get(r.tavern)!.push({ week, points: r.points, projected: r.projected, home, percentile, checksAbove, battlesAbove });
    }
  }
  const totals = [...rows].map(([tavern, weeks]) => {
    const sum = (f: (w: LuckWeek) => number): number => weeks.reduce((s, w) => s + f(w), 0);
    const pcts = weeks.flatMap((w) => (w.percentile === null ? [] : [w.percentile]));
    return {
      tavern,
      weeks,
      pointsAbove: sum((w) => w.points - w.projected),
      projected: sum((w) => w.projected),
      points: sum((w) => w.points),
      meanPercentile: pcts.length === 0 ? null : pcts.reduce((a, b) => a + b, 0) / pcts.length,
      checksAbove: sum((w) => w.checksAbove),
      battlesAbove: sum((w) => w.battlesAbove),
    };
  });
  return totals
    .map((t): LuckRow => {
      const others = totals.filter((o) => o.tavern !== t.tavern);
      return {
        ...t,
        rank: rankAmong(t.points, others.map((o) => o.points)),
        projectedRank: rankAmong(t.projected, others.map((o) => o.projected)),
      };
    })
    .sort((a, b) => b.pointsAbove - a.pointsAbove || cmp(a.tavern, b.tavern));
}

// ── title odds ─────────────────────────────────────────────────────────────

export interface TitleOddsPoint {
  /** 0 = right after the draft. */
  readonly afterWeek: number;
  /** tavern → P(champion). A shared title counts 1/k to each of the k co-champions. */
  readonly odds: ReadonlyMap<string, number>;
  /** tavern → mean final total loot. */
  readonly expectedPoints: ReadonlyMap<string, number>;
}

export interface TitleOddsOptions {
  /** Simulated seasons per point. Default 2000. */
  readonly sims?: number;
  /** Seeds the simulation. */
  readonly seed: string;
}

/**
 * Title odds after the draft and after each finalized week. Weeks already
 * played count as played; each remaining week, every tavern plays what its
 * strategy would pick from its roster at that point (roster changes from
 * future waivers are not modeled), and its loot is drawn from that lineup's
 * exact distribution, with the home bonus on its sponsor's week. The
 * champion is the top total; a tie shares the title.
 */
export function titleOdds(ctx: ReportContext, options: TitleOddsOptions): ReadonlyArray<TitleOddsPoint> {
  const sims = options.sims ?? 2000;
  const { state, config } = ctx;
  if (!state.draft.complete) return [];
  const taverns = ctx.taverns();
  const finalized = ctx.finalizedWeeks();
  const out: TitleOddsPoint[] = [];
  for (let k = 0; k <= finalized.length; k++) {
    const after = k === 0 ? 0 : finalized[k - 1]!;
    // Rosters as they stood going into the next week.
    const at = ctx.beforeLock.get(after + 1) ?? state;
    const base = new Map(seasonStandings(stateThrough(ctx, after)).map((r) => [r.tavern, r.points]));

    // Each tavern's remaining weeks, as one CDF per week.
    const future: Array<Map<string, { pts: number[]; cdf: number[] }>> = [];
    const mean = new Map(taverns.map((t) => [t, base.get(t) ?? 0]));
    for (let week = after + 1; week <= config.weeks; week++) {
      const mission = ctx.mission(week);
      const byTavern = new Map<string, { pts: number[]; cdf: number[] }>();
      for (const t of taverns) {
        const best = ctx.strategy(t).best(ctx.view(at, t), at.taverns.get(t)?.roster ?? [], week);
        const home = ctx.home(t, week);
        const projection = best === null ? null : ctx.project(mission, startersOf(best.lineup));
        const dist: PointsDistribution = projection === null ? [[0, 1]] : ctx.points(projection, home);
        if (projection !== null) mean.set(t, mean.get(t)! + ctx.expected(projection, home));
        let c = 0;
        byTavern.set(t, { pts: dist.map(([p]) => p), cdf: dist.map(([, p]) => (c += p)) });
      }
      future.push(byTavern);
    }

    const titles = new Map(taverns.map((t) => [t, 0]));
    const rng = rngFor(options.seed, `title-odds:${after}`);
    for (let s = 0; s < sims; s++) {
      let top = -Infinity;
      let leaders: string[] = [];
      for (const t of taverns) {
        let total = base.get(t) ?? 0;
        for (const byTavern of future) total += sample(byTavern.get(t)!, rng);
        if (total > top) {
          top = total;
          leaders = [t];
        } else if (total === top) leaders.push(t);
      }
      for (const t of leaders) titles.set(t, titles.get(t)! + 1 / leaders.length);
    }
    out.push({
      afterWeek: after,
      odds: new Map(taverns.map((t) => [t, titles.get(t)! / sims])),
      expectedPoints: mean,
    });
  }
  return out;
}

/** The current state with only weeks 1..week finalized: enough for `seasonStandings` to count those weeks alone. */
function stateThrough(ctx: ReportContext, week: number): LeagueState {
  return { ...ctx.state, finalizedWeeks: new Set([...ctx.state.finalizedWeeks].filter((w) => w <= week)) };
}

function sample(d: { pts: number[]; cdf: number[] }, rng: Rng): number {
  const u = rng();
  for (let i = 0; i < d.cdf.length; i++) if (u < d.cdf[i]!) return d.pts[i]!;
  return d.pts.at(-1)!;
}

// ── bench ──────────────────────────────────────────────────────────────────

export interface BenchOption {
  readonly starters: ReadonlyArray<string>;
  readonly projected: number;
  /** Same-dice points, or null when the week's dice cannot be replayed. */
  readonly points: number | null;
}

export interface BenchWeek {
  readonly week: number;
  readonly tavern: string;
  /** Captain first; null when the tavern played nobody. */
  readonly played: ReadonlyArray<string> | null;
  readonly bench: ReadonlyArray<string>;
  readonly points: number;
  readonly projected: number;
  readonly home: boolean;
  /** Rerunning the played lineup with the week's seed reproduces the recorded run, so same-dice points mean something. */
  readonly sameDice: boolean;
  /** The best one-for-one swap of a starter for a bench character (by same dice, else projected); null if none is legal. */
  readonly bestSwap: (BenchOption & { readonly out: string; readonly in: string }) | null;
  /** The best legal lineup by projection: the call you could have made before the dice. */
  readonly bestProjected: BenchOption | null;
  /** The best legal lineup with the same dice: full hindsight. Null without same dice. */
  readonly bestSameDice: BenchOption | null;
  /** This week's rank by loot (ties share). */
  readonly rank: number;
  /** The week's rank with the best same-dice lineup, everyone else unchanged. Null without same dice. */
  readonly rankWithBest: number | null;
}

export interface BenchRow {
  readonly tavern: string;
  readonly weeks: ReadonlyArray<BenchWeek>;
  /** Σ projected loot the best projected lineup had over the one played: decision cost. */
  readonly projectedOnBench: number;
  /** Σ same-dice loot the best single swap would have added (never negative). */
  readonly swapOnBench: number;
  /** Σ same-dice loot the best lineup would have added (never negative). */
  readonly sameDiceOnBench: number;
  /** Season rank (ties share) as it stands. */
  readonly rank: number;
  /** Season rank with every week's best same-dice lineup, everyone else unchanged. */
  readonly rankWithBest: number;
}

/** Loot left on the bench per tavern over the finalized weeks, most left first. */
export function benchReport(ctx: ReportContext): ReadonlyArray<BenchRow> {
  const { state, config } = ctx;
  const rows = new Map<string, BenchWeek[]>(ctx.taverns().map((t) => [t, []]));
  for (const week of ctx.finalizedWeeks()) {
    const mission = ctx.mission(week);
    const lockState = ctx.atLock.get(week) ?? state;
    const resolved = state.results.get(week);
    const results = weekResults(state, week);
    for (const { tavern, lineup } of state.lockedLineups.get(week) ?? []) {
      const res = resolved?.get(tavern);
      const home = ctx.home(tavern, week);
      const roster = lockState.taverns.get(tavern)?.roster ?? [];
      const played = lineup === null ? null : startersOf(lineup);
      const view = ctx.view(lockState, tavern);
      const seed = res?.seed ?? null;
      const rerun = (ids: ReadonlyArray<string>) =>
        runMission(ctx.party(ids), mission, (node) => rngFor(seed!, `roll:${node}`), ctx.input.baseOf, ctx.input.battleModel);
      // Same dice only if the seed reproduces what was recorded (a live week's real dice would not).
      const sameDice = res !== undefined && seed !== null && JSON.stringify(rerun(startersOf(res.lineup)).nodes) === JSON.stringify(res.run.nodes);
      const option = (ids: ReadonlyArray<string>): BenchOption => ({
        starters: ids,
        projected: ctx.expected(ctx.project(mission, ids), home),
        points: sameDice ? runPoints(rerun(ids).score, config.scoring, home) : null,
      });
      const subsets: ReadonlyArray<Subset> = legalSubsets(view, roster);
      const options = subsets.map((s) => option(startersOf(lineupFrom(s))));
      const best = (key: (o: BenchOption) => number | null): BenchOption | null => {
        let top: BenchOption | null = null;
        for (const o of options) {
          const v = key(o);
          if (v === null) continue;
          const t = top === null ? null : key(top);
          if (t === null || v > t + 1e-9 || (Math.abs(v - t) <= 1e-9 && o.projected > top!.projected + 1e-9)) top = o;
        }
        return top;
      };
      const bestProjected = best((o) => o.projected);
      const bestSameDice = sameDice ? best((o) => o.points) : null;

      let bestSwap: BenchWeek['bestSwap'] = null;
      if (played !== null) {
        const legal = new Set(subsets.map((s) => [...s.ids].sort().join('\u0000')));
        const score = (x: BenchOption): number => (sameDice ? x.points! : x.projected);
        for (const out of played) {
          for (const inn of roster.filter((id) => !played.includes(id))) {
            const ids = played.map((id) => (id === out ? inn : id));
            if (!legal.has([...ids].sort().join('\u0000'))) continue;
            const o = { ...option(ids), out, in: inn };
            if (bestSwap === null || score(o) > score(bestSwap) + 1e-9) bestSwap = o;
          }
        }
      }

      const mine = results.find((r) => r.tavern === tavern);
      const points = mine?.points ?? 0;
      const others = results.filter((r) => r.tavern !== tavern).map((r) => r.points);
      rows.get(tavern)!.push({
        week,
        tavern,
        played,
        bench: roster.filter((id) => played === null || !played.includes(id)),
        points,
        projected: mine?.projected ?? 0,
        home,
        sameDice,
        bestSwap,
        bestProjected,
        bestSameDice,
        rank: rankAmong(points, others),
        rankWithBest: bestSameDice?.points == null ? null : rankAmong(Math.max(points, bestSameDice.points), others),
      });
    }
  }
  const table = new Map(seasonStandings(state).map((r) => [r.tavern, r.points]));
  return [...rows]
    .map(([tavern, weeks]): BenchRow => {
      let projectedOnBench = 0;
      let swapOnBench = 0;
      let sameDiceOnBench = 0;
      for (const w of weeks) {
        if (w.bestProjected !== null) projectedOnBench += Math.max(0, w.bestProjected.projected - w.projected);
        if (w.bestSwap?.points != null) swapOnBench += Math.max(0, w.bestSwap.points - w.points);
        if (w.bestSameDice?.points != null) sameDiceOnBench += Math.max(0, w.bestSameDice.points - w.points);
      }
      const others = [...table].filter(([t]) => t !== tavern).map(([, p]) => p);
      const total = table.get(tavern) ?? 0;
      return {
        tavern,
        weeks,
        projectedOnBench,
        swapOnBench,
        sameDiceOnBench,
        rank: rankAmong(total, others),
        rankWithBest: rankAmong(total + sameDiceOnBench, others),
      };
    })
    .sort((a, b) => b.sameDiceOnBench - a.sameDiceOnBench || b.projectedOnBench - a.projectedOnBench || cmp(a.tavern, b.tavern));
}

// ── luck over many seasons ─────────────────────────────────────────────────

/** One season's luck, reduced to what `aggregateLuck` needs. */
export interface LuckSeason {
  readonly champions: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<{
    readonly tavern: string;
    readonly bot: Seat;
    readonly pointsAbove: number;
    readonly projected: number;
    readonly meanPercentile: number | null;
  }>;
}

export function luckSeason(summary: RunSummary, luck: ReadonlyArray<LuckRow>): LuckSeason {
  const botOf = new Map(summary.taverns.map((t) => [t.tavern, t.bot]));
  return {
    champions: summary.champions.map((c) => c.tavern),
    rows: luck.map((l) => ({ tavern: l.tavern, bot: botOf.get(l.tavern)!, pointsAbove: l.pointsAbove, projected: l.projected, meanPercentile: l.meanPercentile })),
  };
}

export interface LuckAggregate {
  readonly seasons: number;
  /** Taverns per season (the most seen), so par for a rank is 1 / taverns. */
  readonly taverns: number;
  /** Share of titles won by the tavern ranked r + 1 by loot above projection (index 0 = luckiest). Shared titles split. */
  readonly titlesByLuckRank: ReadonlyArray<number>;
  /** Share of titles won by the tavern ranked r + 1 by projected loot (index 0 = strongest lineups). */
  readonly titlesBySkillRank: ReadonlyArray<number>;
  /** Means over champions (a shared title weighs each co-champion 1/k). */
  readonly champion: { readonly pointsAbove: number; readonly percentile: number };
  /**
   * Within-season spread of final totals, split. Total = strength + luck
   * exactly, so `luck + skill + 2·cov = 1` as shares of the total's variance.
   */
  readonly variance: { readonly luck: number; readonly skill: number; readonly cov: number };
  /** Means per tavern-season by manager. Near 0 / 50% for everyone if the projection is unbiased. */
  readonly byBot: Readonly<Record<string, { readonly seats: number; readonly pointsAbove: number; readonly percentile: number }>>;
}

/** Roll up many seasons' luck: how often the luckiest and the strongest won, how much of the table luck explains, and whether any manager is systematically lucky. */
export function aggregateLuck(seasons: ReadonlyArray<LuckSeason>): LuckAggregate {
  const n = Math.max(0, ...seasons.map((s) => s.rows.length));
  const byLuck = new Array<number>(n).fill(0);
  const bySkill = new Array<number>(n).fill(0);
  const champ = { pointsAbove: 0, percentile: 0, weight: 0, pctWeight: 0 };
  let vLuck = 0;
  let vSkill = 0;
  let vCov = 0;
  const bots = new Map<string, { seats: number; pointsAbove: number; percentile: number; pctN: number }>();
  for (const season of seasons) {
    const k = season.champions.length;
    const rankBy = (key: (r: LuckSeason['rows'][number]) => number): ReadonlyArray<string> =>
      [...season.rows].sort((a, b) => key(b) - key(a) || cmp(a.tavern, b.tavern)).map((r) => r.tavern);
    const luckOrder = rankBy((r) => r.pointsAbove);
    const skillOrder = rankBy((r) => r.projected);
    for (const c of season.champions) {
      byLuck[luckOrder.indexOf(c)]! += 1 / k;
      bySkill[skillOrder.indexOf(c)]! += 1 / k;
    }
    // Within-season deviations, so a hard or easy run of missions doesn't count as spread.
    const m = season.rows.length;
    const ml = season.rows.reduce((s, r) => s + r.pointsAbove, 0) / m;
    const ms = season.rows.reduce((s, r) => s + r.projected, 0) / m;
    for (const r of season.rows) {
      vLuck += (r.pointsAbove - ml) ** 2;
      vSkill += (r.projected - ms) ** 2;
      vCov += (r.pointsAbove - ml) * (r.projected - ms);
      let b = bots.get(r.bot);
      if (b === undefined) bots.set(r.bot, (b = { seats: 0, pointsAbove: 0, percentile: 0, pctN: 0 }));
      b.seats++;
      b.pointsAbove += r.pointsAbove;
      if (r.meanPercentile !== null) {
        b.percentile += r.meanPercentile;
        b.pctN++;
      }
      if (season.champions.includes(r.tavern)) {
        champ.pointsAbove += r.pointsAbove / k;
        champ.weight += 1 / k;
        if (r.meanPercentile !== null) {
          champ.percentile += r.meanPercentile / k;
          champ.pctWeight += 1 / k;
        }
      }
    }
  }
  const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);
  const s = seasons.length;
  const vTotal = vLuck + vSkill + 2 * vCov;
  return {
    seasons: s,
    taverns: n,
    titlesByLuckRank: byLuck.map((c) => ratio(c, s)),
    titlesBySkillRank: bySkill.map((c) => ratio(c, s)),
    champion: { pointsAbove: ratio(champ.pointsAbove, champ.weight), percentile: ratio(champ.percentile, champ.pctWeight) },
    variance: { luck: ratio(vLuck, vTotal), skill: ratio(vSkill, vTotal), cov: ratio(vCov, vTotal) },
    byBot: Object.fromEntries(
      [...bots].map(([bot, b]) => [bot, { seats: b.seats, pointsAbove: ratio(b.pointsAbove, b.seats), percentile: ratio(b.percentile, b.pctN) }]),
    ),
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function startersOf(lineup: Lineup): ReadonlyArray<string> {
  return lineup.starters;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
