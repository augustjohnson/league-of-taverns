/**
 * The workshop: the playground's tools for checking the league by hand, out
 * of the game's way. A bot run (any seed, every seat a bot, audited against
 * the CLI), or your finished season, in Standings, Weeks, Draft board and
 * Reports; and the Lineup lab, the Pool, the Event log and a Batch of seasons.
 *
 * The bot run starts the first time the workshop opens, so the game loads
 * without it.
 */
import {
  battleOdds,
  checkOdds,
  evTtkBreakdown,
  hexOn,
  homeTavern,
  lineHash,
  projectMission,
  rngFor,
  runMission,
  weekResults,
  weekSeed,
  validateLineup,
} from '@league-of-taverns/engine';
import type { EvTtkBreakdown, LeagueEvent, Lineup, Party, Projection, RetreatOrder, RunResult } from '@league-of-taverns/engine';
import { aggregate, runMockSeason, runSeed, type MockSeasonResult, type RunSummary } from '../season-runner';
import {
  ReportContext,
  aggregateLuck,
  benchReport,
  luckReport,
  luckSeason,
  titleOdds,
  type BenchOption,
  type BenchRow,
  type LuckAggregate,
  type LuckRow,
  type LuckSeason,
  type TitleOddsPoint,
} from '../reports';
import {
  $,
  BUDGET,
  SCALE,
  WEEKS,
  bannerAttr,
  charChip,
  charLabel,
  charTitle,
  chromeOf,
  charList,
  charName,
  clip,
  config,
  crMeter,
  crOf,
  cryptoRand,
  cryptoSeed,
  draftPick,
  environmentOf,
  esc,
  graphLegend,
  graphSvg,
  input,
  keywordsLine,
  layouts,
  missionOf,
  num,
  ordinal,
  outcomesOf,
  poolIds,
  portrait,
  retreatSelect,
  retreatTable,
  rollLog,
  seriesVar,
  storageGet,
  storageSet,
  swatch,
  tavernName,
  violationList,
  type Overlay,
} from './shared';
import {
  actorLabel,
  aggregateRows,
  checkLabel,
  draftBoard,
  eventSummary,
  formatCr,
  formatCrTotal,
  formatModifier,
  parseRetreat,
  partyFrom,
  pct,
  retreatLabel,
  rostersAtLock,
  sampleMission,
  sameScore,
  scoreHistogram,
  seedWords,
  signed,
  topSkills,
  waiverReasonLabel,
  type SampleResult,
} from './view';

// ── page state ─────────────────────────────────────────────────────────────

type Tab = 'standings' | 'reports' | 'weeks' | 'lab' | 'draft' | 'pool' | 'events' | 'batch';
const TABS: ReadonlyArray<Tab> = ['standings', 'reports', 'weeks', 'lab', 'draft', 'pool', 'events', 'batch'];

interface Run {
  readonly seed: string;
  readonly result: MockSeasonResult;
  readonly ms: number;
  readonly sha256: string;
  /** True for a season you played in the game rather than run from a seed. */
  readonly played?: boolean;
}

let run: Run | null = null;
let tab: Tab = (TABS as ReadonlyArray<string>).includes(storageGet('lot-playground-tab') ?? '') ? (storageGet('lot-playground-tab') as Tab) : 'standings';
const weeksUi = { week: WEEKS[0] ?? 1, tavern: input.taverns[0]?.id ?? '' };
const lab = {
  week: WEEKS[0] ?? 1,
  roster: 'pool' as string,
  onlyRoster: false,
  filter: '',
  picks: [] as string[],
  retreat: 'never' as RetreatOrder,
  roll: null as { seed: string; result: RunResult } | null,
  sample: null as { seed: string; result: SampleResult; ms: number } | null,
  seeded: false,
};
const draftUi = { hot: null as string | null };
/** The bench detail's tavern, and the run it was picked in (a new run resets it to your tavern, else the top row). */
const reportsUi = { tavern: '', run: null as Run | null };
const poolUi = { filter: '', sort: 'pool' as 'pool' | 'cr' | 'owner' };
const eventsUi = { type: 'all', text: '', open: new Set<number>() };
const batchUi = {
  n: 50,
  running: false,
  done: 0,
  total: 0,
  seed: '',
  summaries: [] as RunSummary[],
  luck: [] as LuckSeason[],
  ms: 0,
  token: 0,
  error: null as string | null,
};


const botOf = (id: string): string => run?.result.summary.taverns.find((t) => t.tavern === id)?.bot ?? '?';

// ── run bar ────────────────────────────────────────────────────────────────

function renderStatus(error: string | null, ms: number): void {
  const status = $('status');
  const errBox = $('run-error');
  if (error !== null || run === null) {
    status.innerHTML = `<span class="chip fail"><span class="dot"></span>Run failed</span><span class="chip">${num(ms.toFixed(0))} ms</span>`;
    errBox.hidden = false;
    errBox.textContent = error ?? 'No run.';
    return;
  }
  errBox.hidden = true;
  const { result } = run;
  const { audit, summary } = result;
  const replayChip = audit.replayMatches
    ? `<span class="chip ok" title="replayLog(ndjson) deep-equals the state built event by event"><span class="dot"></span>Replay matches</span>`
    : `<span class="chip fail"><span class="dot"></span>Replay differs</span>`;
  const verifyChip =
    audit.mismatches.length === 0
      ? `<span class="chip ok" title="verifyResolutions found no mismatches"><span class="dot"></span>Verify: 0 mismatches</span>`
      : `<span class="chip fail"><span class="dot"></span>Verify: ${audit.mismatches.length} mismatches</span>`;
  status.innerHTML =
    (run.played === true ? `<span class="chip brass" title="Played on the Play tab: your moves plus seed ${esc(run.seed)}">Your season</span>` : '') +
    `<span class="chip">${num(summary.events)} events</span>${replayChip}${verifyChip}` +
    `<span class="chip">${num(run.ms.toFixed(0))} ms</span>` +
    `<span class="chip" title="sha256 of events.ndjson. Matches the CLI's events-1.ndjson for the same seed.">ndjson ${num(run.sha256.slice(0, 12))}</span>` +
    `<span class="chip brass">${summary.champions.length === 1 ? 'Champion' : 'Co-champions'}: ${summary.champions.map((c) => `<b>${esc(tavernName(c.tavern))}</b> <span class="muted">${esc(c.bot)}</span>`).join(', ')}</span>`;
}

function doRun(seed: string): void {
  const status = $('status');
  status.innerHTML = `<span class="chip">Running ${esc(seed)}…</span>`;
  const started = performance.now();
  let error: string | null = null;
  try {
    if (seed.length === 0 || seed.includes('/')) throw new Error('A seed must be non-empty and contain no "/".');
    const result = runMockSeason(input, { seed });
    const ms = performance.now() - started;
    run = { seed, result, ms, sha256: lineHash(result.ndjson) };
    lab.roll = null;
    lab.sample = null;
    eventsUi.open.clear();
    if (!lab.seeded) seedLab();
  } catch (e) {
    run = null;
    error = e instanceof Error ? e.message : String(e);
  }
  renderStatus(error, performance.now() - started);
  renderTab();
}

// ── tabs ───────────────────────────────────────────────────────────────────

function setTab(next: Tab, focus = false): void {
  tab = next;
  storageSet('lot-playground-tab', next);
  markTabs(focus);
  renderTab();
}

/** Selected state, roving tabindex and the panel's label follow `tab`. */
function markTabs(focus = false): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#ws-tabs button')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  panel.setAttribute('aria-labelledby', `tab-${tab}`);
}

function renderTab(): void {
  if (tab === 'batch') {
    panel.innerHTML = renderBatch();
    return;
  }
  if (run === null) {
    panel.innerHTML = '<p class="muted">No season loaded. Fix the seed and press Run.</p>';
    return;
  }
  switch (tab) {
    case 'standings':
      panel.innerHTML = renderStandings(run);
      break;
    case 'reports':
      panel.innerHTML = renderReports(run);
      break;
    case 'weeks':
      panel.innerHTML = renderWeeks(run);
      break;
    case 'lab':
      panel.innerHTML = renderLab(run);
      break;
    case 'draft':
      panel.innerHTML = renderDraft(run);
      break;
    case 'pool':
      panel.innerHTML = renderPool(run);
      break;
    case 'events':
      panel.innerHTML = renderEvents(run);
      break;
  }
}

// ── standings ──────────────────────────────────────────────────────────────

function renderStandings(r: Run): string {
  const { summary, state } = r.result;
  const weekly = (tavern: string): string =>
    summary.weeks
      .map((w) => {
        const x = w.results.find((y) => y.tavern === tavern);
        return `<td class="n ${x?.rank === 1 ? 'win' : 'muted'}" title="Week ${w.week}${x?.rank === 1 ? ': topped the week' : ''}">${x?.points ?? 0}</td>`;
      })
      .join('');
  const weekHeads = summary.weeks.map((w) => `<th class="n">W${w.week}</th>`).join('');
  const rows = summary.standings
    .map(
      (s) =>
        `<tr class="${s.rank === 1 ? 'champ' : ''}${s.bot === 'human' ? ' mine' : ''}"${s.bot === 'human' ? bannerAttr(s.tavern) : ''}><td class="n">${s.rank}</td><td><b>${esc(tavernName(s.tavern))}</b></td>` +
        `<td><span class="tag">${esc(s.bot)}</span></td><td class="n"><b>${s.points}</b></td>${weekly(s.tavern)}</tr>`,
    )
    .join('');
  const champs = summary.champions;
  const weeks = summary.weeks
    .map((w) => {
      const results = new Map(weekResults(state, w.week).map((x) => [x.tavern, x]));
      const top = Math.max(...w.results.map((x) => x.projectedPoints));
      const rankRows = [...w.results]
        .sort((x, y) => x.rank - y.rank || y.points - x.points)
        .map((x) => {
          const checks = results.get(x.tavern)?.checksPassed ?? 0;
          return (
            `<tr><td class="n">${x.rank}</td><td><span class="${x.rank === 1 ? 'win' : ''}">${esc(tavernName(x.tavern))}</span>${x.home ? ` <span class="tag brass" title="sponsor's week: loot × ${config.scoring.homeBonus}">home</span>` : ''}</td>` +
            `<td class="n">${x.points}</td><td class="n muted">${x.projectedPoints.toFixed(1)}${x.projectedPoints === top ? ' <span class="tag brass" title="The highest projection this week">top proj.</span>' : ''}</td><td class="n muted">${checks}</td></tr>`
          );
        })
        .join('');
      // Awarded claims first, then by tavern; a claim's add and drop sit side by side.
      const claims = [...w.waivers].sort((x, y) => Number(y.awarded) - Number(x.awarded) || tavernName(x.tavern).localeCompare(tavernName(y.tavern)));
      const waivers =
        claims.length === 0
          ? ''
          : `<details class="small"><summary>Waivers after week ${w.week}: ${claims.filter((x) => x.awarded).length} awarded of ${claims.length} claims</summary>` +
            `<div class="scroll"><table><thead><tr><th>tavern</th><th>add</th><th>drop</th><th>outcome</th></tr></thead><tbody>${claims
              .map(
                (x) =>
                  `<tr><td>${esc(tavernName(x.tavern))}</td><td>${charChip(x.add)}</td><td class="muted">${x.drop === null ? '–' : charChip(x.drop)}</td>` +
                  `<td class="${x.awarded ? 'pass' : 'fail'}">${esc(waiverReasonLabel(x.reason))}</td></tr>`,
              )
              .join('')}</tbody></table></div></details>`;
      return (
        `<div class="stack"><h3>Week ${w.week} <span class="muted small">${esc(w.mission)} · ${esc(environmentOf(w.week))}</span></h3>` +
        `<div class="scroll"><table><thead><tr><th class="n">#</th><th>tavern</th><th class="n">points</th><th class="n">projected</th><th class="n">checks</th></tr></thead><tbody>${rankRows}</tbody></table></div>${waivers}</div>`
      );
    })
    .join('');
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Standings</h2><span class="chip brass">${champs.length === 1 ? 'Champion' : 'Co-champions'}: ${champs.map((c) => `<b>${esc(tavernName(c.tavern))}</b> <span class="muted">${esc(c.bot)}</span>`).join(', ')}</span></div>` +
    `<div class="scroll"><table><thead><tr><th class="n">#</th><th>tavern</th><th>bot</th><th class="n">loot</th>${weekHeads}</tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="hint">Ranked by total loot. Equal totals share a rank; there are no tiebreakers. W1–W${summary.weeks.length} are each week's loot, bold where the tavern topped the week.</p></section>` +
    `<section class="card"><h2>Weekly tables</h2>${weeks}</section>`
  );
}

// ── reports ────────────────────────────────────────────────────────────────

interface Reports {
  readonly odds: ReadonlyArray<TitleOddsPoint>;
  readonly luck: ReadonlyArray<LuckRow>;
  readonly bench: ReadonlyArray<BenchRow>;
  readonly ms: number;
}
/** One report per run object, computed when the Reports tab first shows it. */
const reportCache = new WeakMap<Run, Reports>();

function reportsOf(r: Run): Reports {
  let rep = reportCache.get(r);
  if (rep === undefined) {
    const started = performance.now();
    const ctx = new ReportContext(input, r.result.summary.taverns, r.result.events, r.result.state);
    rep = { odds: titleOdds(ctx, { seed: r.seed }), luck: luckReport(ctx), bench: benchReport(ctx), ms: performance.now() - started };
    reportCache.set(r, rep);
  }
  return rep;
}


const signedFixed = (x: number, digits = 1): string => (Math.abs(x) < 0.5 * 10 ** -digits ? (0).toFixed(digits) : signed(Number(x.toFixed(digits))));

function renderReports(r: Run): string {
  const rep = reportsOf(r);
  return (
    `<p class="hint">${r.played === true ? 'Your played season' : `Seed ${esc(r.seed)}`}, ${config.weeks} weeks. Computed in ${num(rep.ms.toFixed(0))} ms.</p>` +
    renderTitleOdds(rep.odds) +
    renderLuck(rep.luck) +
    renderBench(rep.bench)
  );
}

function renderTitleOdds(odds: ReadonlyArray<TitleOddsPoint>): string {
  const head = '<h2>Title odds</h2>';
  if (odds.length === 0) return `<section class="card">${head}<p class="muted">After the draft.</p></section>`;
  const weeks = config.weeks;
  const taverns = input.taverns.map((t) => t.id);
  const last = odds.at(-1)!;
  const order = [...taverns].sort((a, b) => last.odds.get(b)! - last.odds.get(a)! || taverns.indexOf(a) - taverns.indexOf(b));
  const label = (k: number): string => (k === 0 ? 'draft' : `W${k}`);

  // Chart: x = after the draft, after each week; y = P(title).
  const W = 720;
  const H = 260;
  const m = { l: 40, r: 150, t: 12, b: 28 };
  const x = (k: number): number => m.l + ((W - m.l - m.r) * k) / Math.max(1, weeks);
  const y = (p: number): number => m.t + (H - m.t - m.b) * (1 - p);
  const grid = [0, 0.25, 0.5, 0.75, 1]
    .map((p) => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(p)}" y2="${y(p)}"/><text class="tick" x="${m.l - 6}" y="${y(p) + 4}" text-anchor="end">${p * 100}%</text>`)
    .join('');
  const xTicks = Array.from({ length: weeks + 1 }, (_, k) => `<text class="tick" x="${x(k)}" y="${H - 8}" text-anchor="middle">${label(k)}</text>`).join('');
  const lines = taverns
    .map((t) => {
      const pts = odds.map((p) => `${x(p.afterWeek).toFixed(1)},${y(p.odds.get(t)!).toFixed(1)}`).join(' ');
      const dots = odds.map((p) => `<circle cx="${x(p.afterWeek).toFixed(1)}" cy="${y(p.odds.get(t)!).toFixed(1)}" r="3.5"/>`).join('');
      return `<g class="series" style="--c:${seriesVar(t)}"><polyline points="${pts}"/>${dots}</g>`;
    })
    .join('');
  // Direct labels at the latest point, pushed apart and kept inside the plot.
  const ends = order.map((t) => ({ t, y: y(last.odds.get(t)!) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) ends[i]!.y = Math.max(ends[i]!.y, ends[i - 1]!.y + 13);
  for (let i = ends.length - 1; i >= 0; i--) ends[i]!.y = Math.min(ends[i]!.y, i === ends.length - 1 ? H - m.b : ends[i + 1]!.y - 13);
  const endLabels = ends
    .map(({ t, y: ly }) => `<text class="end" x="${x(last.afterWeek) + 8}" y="${(ly + 4).toFixed(1)}">${esc(clip(tavernName(t), 18))} ${pct(last.odds.get(t)!, 0)}</text>`)
    .join('');
  // Hover: one hit column per point, with every tavern's odds in its tooltip.
  const colW = (W - m.l - m.r) / Math.max(1, weeks);
  const hits = odds
    .map((p) => {
      const tip = `After ${p.afterWeek === 0 ? 'the draft' : `week ${p.afterWeek}`}\n${[...taverns]
        .sort((a, b) => p.odds.get(b)! - p.odds.get(a)!)
        .map((t) => `${tavernName(t)}: ${pct(p.odds.get(t)!)} · ${p.expectedPoints.get(t)!.toFixed(0)} loot expected`)
        .join('\n')}`;
      return `<rect class="hit" x="${x(p.afterWeek) - colW / 2}" y="${m.t}" width="${colW}" height="${H - m.t - m.b}"><title>${esc(tip)}</title></rect>`;
    })
    .join('');
  const svg = `<div class="scroll"><svg class="odds" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Title odds after the draft and each week">${grid}${xTicks}${lines}${endLabels}${hits}</svg></div>`;
  const legend = `<div class="legend">${taverns.map((t) => `<span>${swatch(t)}${esc(tavernName(t))}</span>`).join('')}</div>`;

  const cols = odds.map((p) => `<th class="n">${label(p.afterWeek)}</th>`).join('');
  const rows = order
    .map((t) => {
      const cells = odds
        .map((p, i) => {
          const v = p.odds.get(t)!;
          const prev = i === 0 ? null : odds[i - 1]!.odds.get(t)!;
          const move = prev === null || Math.abs(v - prev) < 0.005 ? '' : ` <span class="small ${v > prev ? 'pass' : 'fail'}">${v > prev ? '▲' : '▼'}</span>`;
          return `<td class="n" style="background:color-mix(in srgb, var(--brass-soft) ${(100 * v).toFixed(0)}%, transparent)">${pct(v, 0)}${move}</td>`;
        })
        .join('');
      return `<tr><td>${swatch(t)}<b>${esc(tavernName(t))}</b> <span class="tag">${esc(botOf(t))}</span></td>${cells}<td class="n">${last.expectedPoints.get(t)!.toFixed(0)}</td></tr>`;
    })
    .join('');
  return (
    `<section class="card">${head}${legend}${svg}` +
    `<div class="scroll"><table><thead><tr><th>tavern</th>${cols}<th class="n">final loot</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="hint">After the draft and after each week, 2,000 simulated finishes. Played weeks count as played. Each remaining week every tavern fields what its own lineup strategy would pick from its roster at that point (yours: the best projection) and draws its loot from that lineup's exact distribution, home bonus included. Future waivers aren't modeled. The top total wins; a tie shares the title. <b>Final loot</b> is the expected season total from the latest point.</p></section>`
  );
}

function renderLuck(luck: ReadonlyArray<LuckRow>): string {
  const head = '<h2>Luck index</h2>';
  if (luck.every((l) => l.weeks.length === 0)) return `<section class="card">${head}<p class="muted">After the first week.</p></section>`;
  const span = Math.max(1, ...luck.map((l) => Math.abs(l.pointsAbove)));
  const bar = (v: number): string => {
    const w = (50 * Math.abs(v)) / span;
    return `<div class="dbar" title="${signedFixed(v)} loot vs projection"><i class="${v >= 0 ? 'up' : 'down'}" style="${v >= 0 ? 'left:50%' : 'right:50%'};width:${w.toFixed(1)}%"></i></div>`;
  };
  const rows = luck
    .map((l) => {
      const weekly = l.weeks
        .map(
          (w) =>
            `<span title="Week ${w.week}: ${w.points} vs ${w.projected.toFixed(1)} projected${w.home ? ' (home)' : ''}${w.percentile === null ? '' : `, ${pct(w.percentile, 0)} percentile`}" class="${w.points >= w.projected ? 'pass' : 'fail'}">${signedFixed(w.points - w.projected, 0)}</span>`,
        )
        .join(' ');
      const moved = l.projectedRank - l.rank;
      return (
        `<tr><td>${swatch(l.tavern)}<b>${esc(tavernName(l.tavern))}</b></td>` +
        `<td class="n">${signedFixed(l.pointsAbove)}</td><td style="min-width:120px">${bar(l.pointsAbove)}</td>` +
        `<td class="n">${l.meanPercentile === null ? '–' : pct(l.meanPercentile, 0)}</td>` +
        `<td class="n">${signedFixed(l.checksAbove, 2)}</td><td class="n">${signedFixed(l.battlesAbove, 2)}</td>` +
        `<td class="n">${ordinal(l.rank)}</td><td class="n">${ordinal(l.projectedRank)}${moved === 0 ? '' : ` <span class="small ${moved > 0 ? 'pass' : 'fail'}">${moved > 0 ? '▲' : '▼'}${Math.abs(moved)}</span>`}</td>` +
        `<td class="num small">${weekly}</td></tr>`
      );
    })
    .join('');
  return (
    `<section class="card">${head}` +
    `<div class="scroll"><table><thead><tr><th>tavern</th><th class="n">loot vs proj.</th><th></th><th class="n">pctile</th><th class="n">checks ±</th><th class="n">battles ±</th><th class="n">rank</th><th class="n">proj. rank</th><th>by week</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="hint"><b>Loot vs proj.</b> is the luck index: loot banked minus the exact projection, summed. <b>Pctile</b> is where each week's loot fell in that lineup's own distribution, averaged (50% = average dice). <b>Checks ±</b> and <b>battles ±</b> are rolls won minus their chances, over the rolls actually made. <b>Proj. rank</b> is where the tavern would stand had every tavern banked exactly its projection; the arrow is how far luck moved it.</p></section>`
  );
}

function renderBench(bench: ReadonlyArray<BenchRow>): string {
  const head = '<h2>Loot on the bench</h2>';
  if (bench.every((b) => b.weeks.length === 0)) return `<section class="card">${head}<p class="muted">After the first week.</p></section>`;
  const human = run?.result.summary.taverns.find((t) => t.bot === 'human')?.tavern;
  if (reportsUi.run !== run || !bench.some((b) => b.tavern === reportsUi.tavern)) {
    reportsUi.tavern = human ?? bench[0]!.tavern;
    reportsUi.run = run;
  }
  const sameDice = bench.every((b) => b.weeks.every((w) => w.sameDice || w.played === null));
  const nothingLeft = bench.every((b) => b.projectedOnBench < 0.05 && b.swapOnBench === 0 && b.sameDiceOnBench === 0);
  const empty = !nothingLeft
    ? ''
    : `<p class="okline">No tavern left loot on the bench this season.</p>` +
      `<p class="hint">Every bot fields its best-projected lineup, and with the dice held fixed a stronger lineup meets the same d20s with modifiers at least as high, so no swap ${sameDice ? 'beat what was played' : 'beat the projection'}. ` +
      `Play a season on the Play vs bots tab to see your own calls here.</p>`;
  const rows = bench
    .map(
      (b) =>
        `<tr class="click ${b.tavern === reportsUi.tavern ? 'sel' : ''}" data-action="rep-tavern" data-tavern="${esc(b.tavern)}">` +
        `<td>${swatch(b.tavern)}<b>${esc(tavernName(b.tavern))}</b> <span class="tag">${esc(botOf(b.tavern))}</span></td>` +
        `<td class="n">${b.projectedOnBench.toFixed(1)}</td><td class="n">${b.swapOnBench}</td><td class="n">${b.sameDiceOnBench}</td>` +
        `<td class="n">${ordinal(b.rank)}${b.rankWithBest < b.rank ? ` <span class="pass">→ ${ordinal(b.rankWithBest)}</span>` : ''}</td></tr>`,
    )
    .join('');
  const sel = bench.find((b) => b.tavern === reportsUi.tavern)!;
  const ids = charList;
  const diff = (o: BenchOption, points: number, projected: number, showStarters = true): string => {
    const d = o.points === null ? null : o.points - points;
    const dp = o.projected - projected;
    return (
      `${o.points === null ? '' : `${num(o.points)} <span class="small ${d! > 0 ? 'pass' : 'muted'}">(${signed(d!)})</span>`} ` +
      `<span class="muted small">proj ${o.projected.toFixed(1)}${Math.abs(dp) >= 0.05 ? ` (${signedFixed(dp)})` : ''}</span>` +
      (showStarters ? `<div class="small muted">${ids(o.starters)}</div>` : '')
    );
  };
  const detail = sel.weeks
    .map((w) => {
      const same = (o: BenchOption): boolean => w.played !== null && o.starters.every((id) => w.played!.includes(id));
      const better = (o: BenchOption): boolean => (o.points === null ? o.projected > w.projected + 0.05 : o.points > w.points);
      const alt = (o: BenchOption | null): string =>
        o === null
          ? '<span class="muted">–</span>'
          : same(o)
            ? '<span class="muted">what was played</span>'
            : !better(o)
              ? '<span class="muted">none better</span>'
              : diff(o, w.points, w.projected);
      const swap =
        w.bestSwap === null
          ? '<span class="muted">no legal swap</span>'
          : !better(w.bestSwap)
            ? '<span class="muted">none better</span>'
            : `<span class="fail">−${esc(charName(w.bestSwap.out))}</span> <span class="pass">+${esc(charName(w.bestSwap.in))}</span><div>${diff(w.bestSwap, w.points, w.projected, false)}</div>`;
      const rank =
        `${ordinal(w.rank)}` +
        (w.rankWithBest !== null && w.rankWithBest < w.rank ? ` <span class="pass" title="With the best same-dice lineup, everyone else unchanged">→ ${ordinal(w.rankWithBest)}</span>` : '');
      return (
        `<tr><td class="n">${w.week}${w.home ? ' <span class="tag brass">home</span>' : ''}</td>` +
        `<td class="wrap-ok">${w.played === null ? '<span class="muted">nobody</span>' : ids(w.played)}<div class="small muted">bench: ${w.bench.length === 0 ? '–' : ids(w.bench)}</div></td>` +
        `<td class="n">${w.points}<div class="small muted">proj ${w.projected.toFixed(1)}</div></td>` +
        `<td>${swap}</td><td class="wrap-ok">${alt(w.bestSameDice)}</td><td class="wrap-ok">${alt(w.bestProjected && { ...w.bestProjected, points: null })}</td><td class="n">${rank}</td></tr>`
      );
    })
    .join('');
  return (
    `<section class="card">${head}${empty}` +
    `<div class="scroll"><table><thead><tr><th>tavern</th><th class="n" title="Σ projected loot the best projected lineup had over the one played">proj. left</th><th class="n" title="Σ same-dice loot the best single swap would have added">best swap</th><th class="n" title="Σ same-dice loot the best lineup would have added">hindsight</th><th class="n" title="Season rank, and with every week's best same-dice lineup">rank</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<h3>${swatch(sel.tavern)}${esc(tavernName(sel.tavern))} by week <span class="muted small">click a tavern above</span></h3>` +
    `<div class="scroll"><table><thead><tr><th class="n">wk</th><th>played</th><th class="n">loot</th><th>best swap</th><th>best lineup, same dice</th><th>best lineup, projected</th><th class="n">week rank</th></tr></thead><tbody>${detail}</tbody></table></div>` +
    `<p class="hint">A benched character never rolled, so there are two lenses. <b>Projected</b> compares exact expected loot: what the roster at the lock could have been expected to bank, the call you could have made before the dice. <b>Same dice</b> reruns the week's seed: every node of the mission has its own fixed roll, so another party meets the same d20s at the same nodes (it may take a different path and meet other nodes' rolls). That is hindsight with the luck held fixed. <b>Best swap</b> trades one starter for one bench character. The arrows show the rank the best same-dice lineup would have reached, everyone else unchanged. Bots already field the best projection, so their <b>proj. left</b> is 0.` +
    (sameDice ? '' : ' Some weeks could not be replayed from their seed, so they show projections only.') +
    `</p></section>`
  );
}

function renderBatchLuck(l: LuckAggregate): string {
  if (l.seasons === 0) return '';
  const par = 1 / Math.max(1, l.taverns);
  const top = Math.max(par, ...l.titlesByLuckRank, ...l.titlesBySkillRank);
  const w = (x: number): string => `${((100 * x) / top).toFixed(1)}%`;
  const bars = l.titlesByLuckRank
    .map(
      (luck, i) =>
        `<div class="bar" title="The ${ordinal(i + 1)} luckiest tavern won ${pct(luck)} of titles; the ${ordinal(i + 1)} strongest by projection won ${pct(l.titlesBySkillRank[i]!)}">` +
        `<span class="num">${ordinal(i + 1)}</span>` +
        `<div class="track two"><div class="fill" style="width:${w(luck)}"></div><div class="fill alt" style="width:${w(l.titlesBySkillRank[i]!)}"></div><i class="par" style="left:${w(par)}"></i></div>` +
        `<span class="num">${pct(luck, 0)} · ${pct(l.titlesBySkillRank[i]!, 0)}</span></div>`,
    )
    .join('');
  const v = l.variance;
  const botRows = Object.entries(l.byBot)
    .map(([bot, b]) => `<tr><td>${esc(bot)}</td><td class="n">${b.seats}</td><td class="n">${signedFixed(b.pointsAbove)}</td><td class="n">${pct(b.percentile, 0)}</td></tr>`)
    .join('');
  return (
    `<h3>Luck</h3>` +
    `<div class="kv"><div><span class="label">luck's share of the table</span><span class="v">${pct(v.luck, 0)}</span></div>` +
    `<div><span class="label">strength's share</span><span class="v">${pct(v.skill, 0)}</span></div>` +
    (Math.abs(v.cov) >= 0.005 ? `<div title="Twice the covariance of luck and strength: the part of the spread they share or cancel"><span class="label">overlap</span><span class="v muted">${signedFixed(200 * v.cov, 0)}%</span></div>` : '') +
    `<div><span class="label">champion vs projection</span><span class="v">${signedFixed(l.champion.pointsAbove)} loot</span></div>` +
    `<div><span class="label">champion's dice</span><span class="v">${pct(l.champion.percentile, 0)} pctile</span></div></div>` +
    `<p class="small muted">A season's total loot is exactly its projected loot (strength) plus its loot above projection (luck). The shares split the spread of totals within a season${Math.abs(v.cov) >= 0.005 ? `; with the overlap (twice their covariance) they add up to 100%` : ''}.</p>` +
    `<p class="small">Who won the title, by rank within the season. <span class="legend" style="display:inline-flex"><span><i></i>by luck (loot above projection)</span><span><i class="alt"></i>by strength (projected loot)</span><span><i class="par"></i>par ${pct(par, 0)}</span></span></p>` +
    `<div class="bars luck-ranks">${bars}</div>` +
    `<div class="scroll"><table><thead><tr><th>bot</th><th class="n">seats</th><th class="n">loot vs proj.</th><th class="n">pctile</th></tr></thead><tbody>${botRows}</tbody></table></div>` +
    `<p class="hint">Per tavern-season means. Luck should wash out by manager: loot vs proj. near 0 and pctile near 50% for every bot. A bot that stays lucky over many seasons points to a bias in the projection, not a skill. Shared titles split between co-champions.</p>`
  );
}

// ── weeks ──────────────────────────────────────────────────────────────────

function lineupCard(lineup: Lineup | null, source: string): string {
  if (lineup === null) return '<p class="muted">No lineup this week: the tavern scores 0.</p>';
  const ids = lineup.starters;
  const total = ids.reduce((s, id) => s + crOf(id), 0);
  const items = ids.map((id) => `<li>${charLabel(id)}</li>`).join('');
  return (
    `<ul class="stack" style="list-style:none;margin:0;padding:0">${items}</ul>` +
    `<p class="small">Retreat order: ${esc(retreatLabel(lineup.retreat))}</p>` +
    `<p class="small">CR total ${num(formatCrTotal(total))} of ${num(formatCrTotal(BUDGET))} <span class="tag" title="submitted: set this week; carried: last week's; fallback: the engine's legal default">${esc(source)}</span></p>` +
    crMeter(total)
  );
}


function renderWeeks(r: Run): string {
  const { state } = r.result;
  const week = weeksUi.week;
  const mission = missionOf(week);
  const locked = state.lockedLineups.get(week) ?? [];
  const resolved = state.results.get(week);
  const weekOptions = WEEKS.map((w) => `<option value="${w}" ${w === week ? 'selected' : ''}>Week ${w}: ${esc(missionOf(w).id)}</option>`).join('');
  const tavernOptions = input.taverns.map((t) => `<option value="${esc(t.id)}" ${t.id === weeksUi.tavern ? 'selected' : ''}>${esc(t.name)}</option>`).join('');

  const table = locked
    .map(({ tavern, lineup, source }) => {
      const res = resolved?.get(tavern);
      return (
        `<tr class="click ${tavern === weeksUi.tavern ? 'sel' : ''}" data-action="pick-tavern" data-tavern="${esc(tavern)}">` +
        `<td>${esc(tavernName(tavern))}</td><td><span class="tag">${esc(botOf(tavern))}</span></td><td class="muted">${esc(source)}</td>` +
        `<td class="wrap-ok small">${lineup === null ? '—' : charList(lineup.starters)}</td>` +
        `<td class="n">${res === undefined ? '—' : `${res.run.checksPassed}/${res.run.checksAttempted}`}</td>` +
        `<td class="n"><b>${res?.points ?? 0}</b></td><td class="n muted">${res === undefined ? '—' : res.projectedPoints.toFixed(1)}</td>` +
        `<td>${res?.run.dnf === true ? '<span class="fail">DNF</span>' : ''}</td></tr>`
      );
    })
    .join('');

  const entry = locked.find((l) => l.tavern === weeksUi.tavern);
  const res = resolved?.get(weeksUi.tavern);
  let detail = '<p class="muted">Pick a tavern.</p>';
  if (entry !== undefined) {
    let projection: Projection | null = null;
    if (entry.lineup !== null) {
      const party = partyFrom(entry.lineup.starters, input.statsOf, hexOn(r.result.state, weeksUi.tavern, week));
      projection = projectMission(party, mission, input.baseOf, input.battleModel, { retreat: entry.lineup.retreat });
    }
    const overlay: Overlay = {
      ...(res === undefined ? {} : { path: res.run.path, outcomes: outcomesOf(res.run) }),
      ...(projection === null ? {} : { reach: projection.reach }),
    };
    const seedCheck =
      res === undefined
        ? ''
        : weekSeed({ season: config.id, week, tavern: weeksUi.tavern, salt: r.seed }) === res.seed
          ? ' <span class="tag">= weekSeed(season, week, tavern, salt = sim seed)</span>'
          : ' <span class="tag bad">does not match weekSeed</span>';
    detail =
      `<div class="cols"><div class="stack"><span class="label">Locked lineup</span>${lineupCard(entry.lineup, entry.source)}</div>` +
      (res === undefined
        ? ''
        : `<div class="stack"><span class="label">Result</span><div class="kv">` +
          `<div><span class="label">points</span><span class="v">${res.points}</span></div>` +
          `<div><span class="label">projected</span><span class="v">${res.projectedPoints.toFixed(1)}</span></div>` +
          `<div><span class="label">chance of DNF</span><span class="v">${pct(res.projected.pDnf)}</span></div>` +
          `<div><span class="label">checks passed</span><span class="v">${res.run.dnf ? 'DNF' : `${res.run.checksPassed} of ${res.run.checksAttempted}`}</span></div></div>` +
          (homeTavern(r.result.state, week) === weeksUi.tavern ? `<p class="small">Home week: loot × ${config.scoring.homeBonus}.</p>` : '') +
          (() => {
            const hex = r.result.state.hexes.find((h) => h.target === weeksUi.tavern && h.week === week);
            return hex === undefined ? '' : `<p class="small">Hexed by ${esc(tavernName(hex.tavern))}: disadvantage on ${hex.ability} checks and saves.</p>`;
          })() +
          `<p class="small muted">Dice seed ${num(res.seed)}${seedCheck}</p></div>`) +
      `</div>` +
      graphSvg(layouts.get(week)!, overlay) +
      graphLegend(overlay) +
      (res === undefined ? '' : `<h3>Roll log</h3>${rollLog(mission, res.run, homeTavern(r.result.state, week) === weeksUi.tavern)}`);
  }

  return (
    `<section class="card"><div class="row"><h2>Week ${week}</h2><span class="muted">${esc(mission.id)} · ${esc(environmentOf(week))}</span></div>` +
    keywordsLine(week) +
    `<div class="row"><label class="label" for="wk-week">Week</label><select id="wk-week" data-action="wk-week">${weekOptions}</select>` +
    `<label class="label" for="wk-tavern">Tavern</label><select id="wk-tavern" data-action="wk-tavern">${tavernOptions}</select></div>` +
    `<div class="scroll"><table><thead><tr><th>tavern</th><th>bot</th><th>source</th><th>lineup</th><th class="n">checks</th><th class="n">pts</th><th class="n">proj</th><th></th></tr></thead><tbody>${table}</tbody></table></div></section>` +
    `<section class="card"><h2>${esc(tavernName(weeksUi.tavern))}</h2>${detail}</section>`
  );
}

// ── lineup lab ─────────────────────────────────────────────────────────────

/** Start the lab on week 1 with the champion's locked lineup, so it opens with real numbers. */
function seedLab(): void {
  if (run === null) return;
  lab.seeded = true;
  lab.roster = run.result.summary.champions[0]!.tavern;
  loadLocked();
}

function loadLocked(): void {
  if (run === null || lab.roster === 'pool') return;
  const entry = run.result.state.lockedLineups.get(lab.week)?.find((l) => l.tavern === lab.roster);
  if (entry?.lineup == null) return;
  lab.picks = [...entry.lineup.starters];
  lab.retreat = entry.lineup.retreat;
  lab.roll = null;
  lab.sample = null;
}

function labRosterIds(events: ReadonlyArray<LeagueEvent>): { ids: ReadonlyArray<string>; owner: ReadonlyMap<string, string> } {
  const rosters = rostersAtLock(events, lab.week);
  const owner = new Map<string, string>();
  for (const [tavern, ids] of rosters) for (const id of ids) owner.set(id, tavern);
  const ids = lab.roster === 'pool' ? poolIds : (rosters.get(lab.roster) ?? []);
  return { ids, owner };
}

function labParty(): Party | null {
  if (lab.picks.length === 0) return null;
  return partyFrom(lab.picks, input.statsOf);
}


function renderLab(r: Run): string {
  const weekOptions = WEEKS.map((w) => `<option value="${w}" ${w === lab.week ? 'selected' : ''}>Week ${w}: ${esc(missionOf(w).id)}</option>`).join('');
  const rosterOptions =
    `<option value="pool" ${lab.roster === 'pool' ? 'selected' : ''}>Whole pool (ownership ignored)</option>` +
    input.taverns.map((t) => `<option value="${esc(t.id)}" ${t.id === lab.roster ? 'selected' : ''}>${esc(t.name)} (roster at week ${lab.week} lock)</option>`).join('');
  return (
    `<section class="card"><div class="row"><h2>Lineup lab</h2><span class="muted small">Pick any four and a retreat order, and see the engine's odds live.</span></div>` +
    `<div class="row"><label class="label" for="lab-week">Mission</label><select id="lab-week" data-action="lab-week">${weekOptions}</select>` +
    `<label class="label" for="lab-roster">Validate against</label><select id="lab-roster" data-action="lab-roster">${rosterOptions}</select>` +
    `<label class="small"><input type="checkbox" id="lab-only" data-action="lab-only" ${lab.onlyRoster ? 'checked' : ''} ${lab.roster === 'pool' ? 'disabled' : ''}> list only this roster</label>` +
    `<button type="button" data-action="lab-load" ${lab.roster === 'pool' ? 'disabled' : ''}>Load its locked lineup</button>` +
    `<button type="button" data-action="lab-clear">Clear</button></div>` +
    `<div class="cols"><div class="stack"><span class="label">Party (lineup order)</span><div id="lab-party">${renderLabParty()}</div><div class="row">${retreatSelect('lab-retreat', 'lab-retreat', lab.retreat)}</div></div>` +
    `<div class="stack"><div class="row"><span class="label">Candidates</span><input type="text" id="lab-filter" placeholder="Filter by name or skill" value="${esc(lab.filter)}" data-action="lab-filter"></div>` +
    // A picker, so it scrolls on its own, but only up and down: rows are compact and skills wrap, so nothing hides off to the side.
    `<div id="lab-cands" style="max-height:440px;overflow-y:auto;overflow-x:hidden">${renderLabCandidates(r)}</div></div></div></section>` +
    `<div id="lab-analysis" class="panel">${renderLabAnalysis(r)}</div>`
  );
}

function renderLabParty(): string {
  const slots = [0, 1, 2, 3].map((i) => {
    const id = lab.picks[i];
    if (id === undefined) return `<div class="slot empty"><span>${i + 1}</span><span class="who">Empty: add from the list</span><span></span><span></span></div>`;
    return (
      `<div class="slot"><span>${i + 1}</span>` +
      `<span class="who">${charLabel(id)}</span>` +
      `<span>${i > 0 ? `<button type="button" class="small" data-action="lab-up" data-id="${esc(id)}" title="Move up the lineup order" aria-label="Move ${esc(charName(id))} up">↑</button>` : ''}</span>` +
      `<button type="button" class="small" data-action="lab-remove" data-id="${esc(id)}">Remove</button></div>`
    );
  });
  const total = lab.picks.reduce((s, id) => s + crOf(id), 0);
  return `<div class="pick-list">${slots.join('')}</div><p class="small">CR total ${num(formatCrTotal(total))} of ${num(formatCrTotal(BUDGET))}</p>${crMeter(total)}`;
}

function renderLabCandidates(r: Run): string {
  const { ids: rosterIds, owner } = labRosterIds(r.result.events);
  const ids = lab.roster !== 'pool' && lab.onlyRoster ? rosterIds : poolIds;
  const q = lab.filter.trim().toLowerCase();
  const rows = ids
    .filter((id) => {
      if (q === '') return true;
      const s = input.statsOf(id);
      return id.includes(q) || charName(id).toLowerCase().includes(q) || s.base.slug.includes(q) || s.base.typeName.toLowerCase().includes(q) || topSkills(s).some((t) => t.skill.includes(q));
    })
    .map((id) => {
      const s = input.statsOf(id);
      const chosen = lab.picks.includes(id);
      const full = lab.picks.length >= 4;
      const moves = Object.entries(s.speeds)
        .filter(([k]) => k !== 'walk')
        .map(([k, v]) => `${k} ${v}`)
        .join(', ');
      return (
        `<tr class="${chosen ? 'sel' : ''}"><td><button type="button" class="${chosen ? '' : 'primary'} small" data-action="${chosen ? 'lab-remove' : 'lab-add'}" data-id="${esc(id)}" ${!chosen && full ? 'disabled' : ''}>${chosen ? 'Remove' : 'Add'}</button></td>` +
        `<td class="flow">${charChip(id)}<div class="muted small">${[s.base.typeName, moves, owner.has(id) ? tavernName(owner.get(id)!) : 'free agent'].filter(Boolean).map(esc).join(' · ')}</div></td>` +
        `<td class="n">${formatCr(crOf(id))}</td>` +
        `<td class="small flow">${topSkills(s)
          .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
          .join(', ')}</td></tr>`
      );
    })
    .join('');
  return `<table><thead><tr><th></th><th title="Under each name: base, movement, owner at the week ${lab.week} lock">character</th><th class="n">CR</th><th>best skills</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="muted">No match.</td></tr>'}</tbody></table>`;
}

function breakdownTable(b: EvTtkBreakdown): string {
  const f = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : String(x));
  return (
    `<table class="small"><thead><tr><th></th><th class="n">party</th><th class="n">foes</th></tr></thead><tbody>` +
    `<tr><td>DPR</td><td class="n">${f(b.partyDpr)}</td><td class="n">${f(b.foeDpr)}</td></tr>` +
    `<tr><td>eHP</td><td class="n">${f(b.partyEhp)}</td><td class="n">${f(b.foeEhp)}</td></tr>` +
    `<tr><td>target AC</td><td class="n">${f(b.partyTargetAc)}</td><td class="n">${f(b.foeTargetAc)}</td></tr>` +
    `<tr><td>TTK (rounds to win)</td><td class="n">${f(b.ttkParty)}</td><td class="n">${f(b.ttkFoe)}</td></tr>` +
    `<tr><td>logit</td><td class="n" colspan="2">${f(b.logit)}</td></tr>` +
    `<tr><td>pWin</td><td class="n" colspan="2"><b>${b.pWin.toFixed(3)}</b></td></tr></tbody></table>`
  );
}

function distributionBars(projection: Projection, sample: SampleResult | null): string {
  const support = projection.distribution.map(([s]) => s);
  const hist = sample === null ? null : scoreHistogram(sample.scores, support);
  const max = Math.max(...projection.distribution.map(([, p]) => p), ...(hist === null || sample === null ? [] : hist.counts.map((c) => c / sample.n)), 1e-9);
  const rows = projection.distribution
    .map(([score, p], i) => {
      const sampled = hist === null || sample === null ? null : hist.counts[i]! / sample.n;
      const label = `${Math.round(score * SCALE)}${sameScore(score, 0) && projection.pDnf > 0 ? '*' : ''}`;
      return (
        `<div class="bar"><span class="num">${esc(label)}</span><div class="track ${sampled === null ? '' : 'two'}">` +
        `<div class="fill" style="width:${((100 * p) / max).toFixed(1)}%"></div>` +
        (sampled === null ? '' : `<div class="fill alt" style="width:${((100 * sampled) / max).toFixed(1)}%"></div>`) +
        `</div><span class="num small">${pct(p)}${sampled === null ? '' : `<br><span class="muted">${pct(sampled)}</span>`}</span></div>`
      );
    })
    .join('');
  const legend =
    hist === null
      ? '<p class="hint">Bars: projected chance of each points total.</p>'
      : `<p class="hint">Upper bar: projected. Lower grey bar: sampled share.${hist.other > 0 ? ` <span class="fail">${hist.other} samples hit no projected score.</span>` : ''}</p>`;
  return `<div class="bars">${rows}</div>${projection.pDnf > 0 ? '<p class="hint">* 0 points includes every DNF.</p>' : ''}${legend}`;
}

function renderLabAnalysis(r: Run): string {
  const mission = missionOf(lab.week);
  const layout = layouts.get(lab.week)!;
  const party = labParty();
  if (party === null) {
    return `<section class="card"><p class="muted">Add characters to see odds for ${esc(mission.id)}.</p>${graphSvg(layout)}${graphLegend({})}</section>`;
  }
  const lineup = { starters: lab.picks, retreat: lab.retreat } as unknown as Lineup;
  const { ids: rosterIds } = labRosterIds(r.result.events);
  const rosterView = { tavern: lab.roster === 'pool' ? 'the pool' : lab.roster, characters: rosterIds };
  const violations = validateLineup(lineup, rosterView, crOf, config);
  const projection = projectMission(party, mission, input.baseOf, input.battleModel, { retreat: lab.retreat });

  const nodes = [...mission.nodes].sort((a, b) => a.rank - b.rank);
  const checkRows = nodes
    .flatMap((n) => {
      if (n.kind !== 'check') return [];
      const o = checkOdds(party, n.check);
      const gate = n.check.requires === undefined ? '<span class="muted">—</span>' : o.eligible ? '<span class="pass">met</span>' : '<span class="fail">unmet: auto-fail</span>';
      return [
        `<tr><td>${esc(n.id)}</td><td class="small">${esc(checkLabel(n.check))}</td><td>${charChip(o.actor)}</td>` +
          `<td class="n">${signed(o.modifier)}</td><td>${o.advantage ? '<span class="tag brass">adv</span>' : ''}</td><td>${gate}</td><td class="n"><b>${pct(o.pPass)}</b></td><td class="n muted">${pct(projection.reach[n.id] ?? 0)}</td></tr>`,
      ];
    })
    .join('');
  const battleRows = nodes
    .flatMap((n) => {
      if (n.kind !== 'battle') return [];
      const { pWin } = battleOdds(party, n.encounter, input.baseOf, input.battleModel);
      const foes = n.encounter.creatures.map((c) => ({ stats: input.baseOf(c.ref), count: c.count }));
      const details =
        input.battleModel.id === 'ev-ttk-v0'
          ? `<details><summary>DPR, eHP and TTK for ${esc(n.id)}</summary>${breakdownTable(evTtkBreakdown(party, foes))}</details>`
          : '<span class="muted small">No breakdown for this battle model.</span>';
      return [
        `<tr><td>${esc(n.id)}</td><td class="small wrap-ok">${esc(n.encounter.creatures.map((c) => `${c.count}× ${c.ref}`).join(', '))}</td>` +
          `<td class="n"><b>${pct(pWin)}</b></td><td class="n muted">${pct(projection.reach[n.id] ?? 0)}</td></tr>` +
          `<tr><td colspan="4" style="white-space:normal">${details}</td></tr>`,
      ];
    })
    .join('');

  const rollOverlay: Overlay =
    lab.roll === null ? { reach: projection.reach } : { reach: projection.reach, path: lab.roll.result.path, outcomes: outcomesOf(lab.roll.result) };

  const sample = lab.sample;
  let sampleBlock = '';
  if (sample !== null) {
    const exp = projection.expectedScore;
    const variance = projection.distribution.reduce((s, [x, p]) => s + p * x * x, 0) - exp * exp;
    const se = Math.sqrt(Math.max(0, variance) / sample.result.n);
    const z = se === 0 ? 0 : (sample.result.mean - exp) / se;
    sampleBlock =
      `<div class="kv"><div><span class="label">sampled mean</span><span class="v">${(sample.result.mean * SCALE).toFixed(1)}</span></div>` +
      `<div><span class="label">projected mean</span><span class="v">${(exp * SCALE).toFixed(1)}</span></div>` +
      `<div><span class="label">sampled DNF</span><span class="v">${pct(sample.result.dnfs / sample.result.n)}</span></div>` +
      `<div><span class="label">gap</span><span class="v">${z.toFixed(2)} SE</span></div></div>` +
      `<p class="small">${Math.abs(z) <= 3 ? '<span class="chip ok"><span class="dot"></span>Within 3 standard errors</span>' : '<span class="chip fail"><span class="dot"></span>More than 3 standard errors apart</span>'} ` +
      `<span class="muted">${sample.result.n.toLocaleString()} runs in ${sample.ms.toFixed(0)} ms, seed ${num(sample.seed)}</span></p>`;
  }

  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>${esc(mission.id)}</h2><span class="muted small">lineup order breaks ties</span></div>` +
    (violations.length === 0
      ? `<p class="okline">Legal lineup${lab.roster === 'pool' ? ' (ownership not checked)' : ''}</p>`
      : violationList(violations)) +
    `<div class="kv"><div><span class="label">expected points</span><span class="v">${(projection.expectedScore * SCALE).toFixed(1)}</span></div>` +
    `<div><span class="label">chance of DNF</span><span class="v">${pct(projection.pDnf)}</span></div>` +
    `<div><span class="label">chance to turn back</span><span class="v">${pct(projection.pRetreat)}</span></div></div>` +
    `<p class="hint">Points before any home bonus.</p>` +
    retreatTable(party, mission, lab.retreat, false) +
    graphSvg(layout, rollOverlay) +
    graphLegend(rollOverlay) +
    `</section>` +
    `<div class="cols"><section class="card"><h3>Checks</h3><div class="scroll"><table><thead><tr><th>node</th><th>check</th><th>actor</th><th class="n">mod</th><th>adv</th><th>gate</th><th class="n">pass</th><th class="n">reach</th></tr></thead><tbody>${checkRows || '<tr><td colspan="8" class="muted">None.</td></tr>'}</tbody></table></div>` +
    `<h3>Battles</h3><div class="scroll"><table><thead><tr><th>node</th><th>encounter</th><th class="n">pWin</th><th class="n">reach</th></tr></thead><tbody>${battleRows || '<tr><td colspan="4" class="muted">None.</td></tr>'}</tbody></table></div></section>` +
    `<section class="card" id="lab-dist"><h3>Points distribution</h3>` +
    `<div class="row"><button type="button" class="primary" data-action="lab-roll">Roll once</button><button type="button" data-action="lab-sample">Roll 1,000</button></div>${sampleBlock}` +
    `${distributionBars(projection, sample?.result ?? null)}</section></div>` +
    (lab.roll === null ? '' : `<section class="card" id="lab-roll-result"><h3>One roll <span class="muted small">seed ${esc(lab.roll.seed)}</span></h3>${rollLog(mission, lab.roll.result)}</section>`)
  );
}

function refreshLab(parts: { party?: boolean; cands?: boolean; analysis?: boolean } = { party: true, cands: true, analysis: true }): void {
  if (run === null || tab !== 'lab') return;
  if (parts.party === true) $('lab-party').innerHTML = renderLabParty();
  if (parts.cands === true) $('lab-cands').innerHTML = renderLabCandidates(run);
  if (parts.analysis === true) $('lab-analysis').innerHTML = renderLabAnalysis(run);
}

function labRoll(): void {
  const party = labParty();
  if (party === null) return;
  const seed = cryptoSeed('lab');
  const result = runMission(party, missionOf(lab.week), (node) => rngFor(seed, `roll:${node}`), input.baseOf, input.battleModel, { retreat: lab.retreat });
  lab.roll = { seed, result };
  refreshLab({ analysis: true });
  reveal('lab-roll-result');
}

/** Bring a fresh result into view, so a click never seems to do nothing. */
function reveal(id: string): void {
  // Smooth scrolling runs on animation frames, which a hidden tab never gets.
  const smooth = !document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.getElementById(id)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'nearest' });
}

function labSample(): void {
  const party = labParty();
  if (party === null) return;
  const seed = cryptoSeed('lab');
  const started = performance.now();
  const result = sampleMission(party, missionOf(lab.week), input.baseOf, input.battleModel, 1000, seed, { retreat: lab.retreat });
  lab.sample = { seed, result, ms: performance.now() - started };
  refreshLab({ analysis: true });
  reveal('lab-dist');
}

// ── draft board ────────────────────────────────────────────────────────────

function renderDraft(r: Run): string {
  const { state, summary } = r.result;
  const order = state.draft.order;
  const rows = draftBoard(order, summary.draft);
  const head = order
    .map(
      (t, i) =>
        `<th class="${draftUi.hot === t ? 'hot' : ''}"><button type="button" class="link" data-action="draft-hot" data-tavern="${esc(t)}">Slot ${i + 1}</button><div style="text-transform:none;letter-spacing:0;font-size:12.5px;color:var(--ink)">${esc(tavernName(t))}</div><span class="tag">${esc(botOf(t))}</span></th>`,
    )
    .join('');
  const body = rows
    .map(
      (row) =>
        `<tr class="${row.direction}"><td class="rd">R${row.round} ${row.direction === 'ltr' ? '→' : '←'}</td>${row.cells
          .map((c) => {
            if (c === null) return '<td></td>';
            const s = input.statsOf(c.character);
            return `<td class="${draftUi.hot === c.tavern ? 'hot' : ''}">${draftPick(c.pick, c.character)}<div class="muted small">${esc(s.base.typeName)} · CR ${formatCr(crOf(c.character))}</div></td>`;
          })
          .join('')}</tr>`,
    )
    .join('');
  return (
    `<section class="card"><div class="row"><h2>Draft board</h2><span class="muted small">${summary.draft.length} picks, ${rows.length} rounds, snake order. Click a slot to highlight its picks.</span></div>` +
    `<div class="scroll"><table class="draft"><thead><tr><th>round</th>${head}</tr></thead><tbody>${body}</tbody></table></div>` +
    `<p class="hint">Odd rounds run left to right and even rounds right to left (shaded), so the end slots pick twice in a row at each turn. The order is the engine's seeded shuffle of the join order; this runner shuffles join order per sim seed.</p></section>`
  );
}

// ── pool ───────────────────────────────────────────────────────────────────

function renderPool(r: Run): string {
  return (
    `<section class="card"><div class="row"><h2>Pool</h2><span class="muted small">${poolIds.length} characters, base + modifiers as the engine sees them</span></div>` +
    `<div class="row"><input type="text" id="pool-filter" placeholder="Filter by name, base, owner or skill" aria-label="Filter by name, base, owner or skill" style="width:18em" value="${esc(poolUi.filter)}" data-action="pool-filter">` +
    `<label class="label" for="pool-sort">Sort</label><select id="pool-sort" data-action="pool-sort">` +
    ['pool', 'cr', 'owner'].map((k) => `<option value="${k}" ${poolUi.sort === k ? 'selected' : ''}>${k === 'pool' ? 'pool order' : k === 'cr' ? 'CR, high first' : 'owner'}</option>`).join('') +
    `</select></div><div id="pool-table" class="scroll">${renderPoolTable(r)}</div></section>`
  );
}

function renderPoolTable(r: Run): string {
  const { state, summary } = r.result;
  const draftedBy = new Map(summary.draft.map((d) => [d.character, d]));
  const q = poolUi.filter.trim().toLowerCase();
  const items = input.pool.map((p, i) => {
    const id = p.character.ref.id;
    const s = input.statsOf(id);
    const owner = state.owner.get(id) ?? null;
    return { id, i, s, p, owner, drafted: draftedBy.get(id) ?? null };
  });
  const filtered = items.filter(({ id, s, owner, drafted }) => {
    if (q === '') return true;
    const hay = [id, charName(id), chromeOf(id)?.epithet ?? '', s.base.slug, s.base.typeName, owner ?? 'free agent', owner === null ? '' : tavernName(owner), drafted?.tavern ?? '', ...topSkills(s).map((t) => t.skill)].join(' ').toLowerCase();
    return hay.includes(q);
  });
  if (poolUi.sort === 'cr') filtered.sort((a, b) => b.p.cr - a.p.cr || a.i - b.i);
  if (poolUi.sort === 'owner') filtered.sort((a, b) => (a.owner ?? '~').localeCompare(b.owner ?? '~') || a.i - b.i);
  const rows = filtered
    .map(({ id, s, p, owner, drafted }) => {
      const speeds = Object.entries(s.speeds).map(([k, v]) => `${k} ${v}`).join(', ');
      const senses = Object.entries(s.senses).map(([k, v]) => `${k} ${v}`).join(', ');
      const moved = drafted !== null && owner !== drafted.tavern;
      return (
        `<tr><td class="pt-cell">${portrait(id, 'md')}</td><td>${charTitle(id)}</td><td>${esc(s.base.typeName)}<div class="muted small">${esc(s.base.slug)}</div></td><td class="n">${formatCr(p.cr)}</td>` +
        `<td>${drafted === null ? '<span class="muted">undrafted</span>' : `${esc(tavernName(drafted.tavern))}<div class="muted small">pick #${drafted.pick + 1}</div>`}</td>` +
        `<td>${owner === null ? '<span class="muted">free agent</span>' : esc(tavernName(owner))}${moved ? ' <span class="tag brass">waivers</span>' : ''}</td>` +
        `<td class="small wrap-ok">${p.character.modifiers.length === 0 ? '<span class="muted">—</span>' : p.character.modifiers.map((m) => esc(formatModifier(m))).join('<br>')}</td>` +
        `<td class="small">${topSkills(s)
          .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
          .join('<br>')}</td>` +
        `<td class="n small">${s.base.ac} / ${s.base.hp}</td><td class="small muted">${esc(speeds)}${senses ? `<br>${esc(senses)}` : ''}</td>` +
        `<td class="n small">${s.battleBonus === 0 ? '' : signed(s.battleBonus)}</td></tr>`
      );
    })
    .join('');
  return `<table><thead><tr><th></th><th>character</th><th>base</th><th class="n">CR</th><th>drafted by</th><th>owner at end</th><th>modifiers</th><th>best 3 skills</th><th class="n">AC / HP</th><th>speeds, senses</th><th class="n">battle</th></tr></thead><tbody>${rows || '<tr><td colspan="11" class="muted">No match.</td></tr>'}</tbody></table>`;
}

// ── event log ──────────────────────────────────────────────────────────────

function renderEvents(r: Run): string {
  const types = [...new Set(r.result.events.map((e) => e.type))];
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Event log</h2>` +
    `<div class="row"><button type="button" class="primary" data-action="copy-ndjson">Copy events.ndjson</button><span id="copy-msg" class="small muted" aria-live="polite"></span></div></div>` +
    `<p class="hint">Copies the NDJSON (${r.result.ndjson.length.toLocaleString()} bytes) to your clipboard, since downloads are blocked here. Paste it into a file to diff against the CLI's events-1.ndjson.</p>` +
    `<textarea id="ndjson-fallback" readonly hidden></textarea>` +
    `<div class="row"><label class="label" for="ev-type">Type</label><select id="ev-type" data-action="ev-type"><option value="all">all (${r.result.events.length})</option>${types
      .map((t) => `<option value="${esc(t)}" ${eventsUi.type === t ? 'selected' : ''}>${esc(t)} (${r.result.events.filter((e) => e.type === t).length})</option>`)
      .join('')}</select>` +
    `<input type="text" id="ev-text" placeholder="Filter text, e.g. a tavern or character" value="${esc(eventsUi.text)}" data-action="ev-text"></div>` +
    `<div id="ev-list" class="scroll">${renderEventList(r)}</div></section>`
  );
}

function renderEventList(r: Run): string {
  const q = eventsUi.text.trim().toLowerCase();
  const rows = r.result.events
    .filter((e) => eventsUi.type === 'all' || e.type === eventsUi.type)
    .map((e) => ({ e, summary: eventSummary(e), actor: actorLabel(e.actor) }))
    .filter(({ e, summary, actor }) => q === '' || `${e.type} ${actor} ${summary}`.toLowerCase().includes(q) || JSON.stringify(e.payload).toLowerCase().includes(q))
    .map(({ e, summary, actor }) => {
      const open = eventsUi.open.has(e.seq);
      return (
        `<tr class="click ${open ? 'sel' : ''}" data-action="ev-toggle" data-seq="${e.seq}"><td class="n">${e.seq}</td><td class="mono small">${esc(e.type)}</td><td class="small muted">${esc(actor)}</td><td class="small wrap-ok">${esc(summary)}</td><td class="small muted mono">${esc(e.at)}</td></tr>` +
        (open ? `<tr><td colspan="5"><pre class="json">${esc(JSON.stringify(e, null, 2))}</pre></td></tr>` : '')
      );
    })
    .join('');
  return `<table><thead><tr><th class="n">seq</th><th>type</th><th>actor</th><th>summary</th><th>at</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No events match.</td></tr>'}</tbody></table>`;
}

function copyNdjson(): void {
  if (run === null) return;
  const text = run.result.ndjson;
  const msg = $('copy-msg');
  const fallback = (): void => {
    const area = $<HTMLTextAreaElement>('ndjson-fallback');
    area.hidden = false;
    area.value = text;
    area.focus();
    area.select();
    msg.textContent = 'Clipboard unavailable: the log is selected below, press Ctrl+C or Cmd+C.';
  };
  try {
    navigator.clipboard.writeText(text).then(
      () => {
        msg.textContent = `Copied ${run?.result.events.length ?? 0} events to your clipboard.`;
      },
      fallback,
    );
  } catch {
    fallback();
  }
}

// ── batch ──────────────────────────────────────────────────────────────────

function renderBatch(): string {
  const b = batchUi;
  const seed = run?.seed ?? (($('seed') as HTMLInputElement).value || 'sim-1');
  let results = '';
  if (b.error !== null) results = `<div class="error">${esc(b.error)}</div>`;
  else if (b.summaries.length > 0 && !b.running) {
    const totals = aggregate(b.summaries);
    const { header, rows } = aggregateRows(totals);
    const bp = totals.bestProjectedTops;
    results =
      `<div class="scroll"><table><thead><tr>${header.map((h, i) => `<th class="${i === 0 ? '' : 'n'}">${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
      rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? '' : 'n'}">${esc(c)}</td>`).join('')}</tr>`).join('') +
      `</tbody></table></div>` +
      `<p>Best-projected tavern topped its week ${num(`${bp.tops}/${bp.weeks}`)} times (${num(pct(bp.share))}).</p>` +
      `<p>DNF rate: ${num(pct(totals.dnfRate))} of mission runs; tavern-weeks with no lineup: ${num(totals.noLineupWeeks)}.</p>` +
      `<p>Titles by tavern: ${Object.entries(totals.titlesByTavern)
        .map(([t, n]) => `${esc(tavernName(t))} ${num(Number.isInteger(n) ? n : n.toFixed(1))}`)
        .join(', ')}</p>` +
      `<p class="hint">${totals.runs} seasons from seed ${esc(b.seed)} in ${(b.ms / 1000).toFixed(2)} s (${(b.ms / totals.runs).toFixed(1)} ms/season, luck included). Same as <span class="mono">mock-season -- --runs ${totals.runs} --seed ${esc(b.seed)}</span>.</p>` +
      renderBatchLuck(aggregateLuck(b.luck));
  }
  const progress = b.total === 0 ? 0 : (100 * b.done) / b.total;
  return (
    `<section class="card"><div class="row"><h2>Batch</h2><span class="muted small">Many seasons with the CLI's aggregate table</span></div>` +
    `<div class="row"><label class="label" for="batch-n">Seasons</label><input type="number" id="batch-n" min="10" max="200" step="10" value="${b.n}" style="width:6em" data-action="batch-n">` +
    `<span class="small muted">seeds ${esc(seed)}, ${esc(runSeed(seed, 2))}, …</span>` +
    `<button type="button" class="primary" data-action="batch-run" ${b.running ? 'disabled' : ''}>Run batch</button>` +
    `<button type="button" data-action="batch-cancel" ${b.running ? '' : 'disabled'}>Cancel</button></div>` +
    `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${b.total}" aria-valuenow="${b.done}"><div id="batch-bar" style="width:${progress.toFixed(1)}%"></div></div>` +
    `<p class="small muted" id="batch-msg">${b.running ? `${b.done} of ${b.total} seasons…` : b.total === 0 ? 'Not run yet.' : `${b.done} of ${b.total} seasons.`}</p>` +
    `<div id="batch-results" class="stack">${results}</div></section>`
  );
}

function startBatch(): void {
  const b = batchUi;
  const n = Math.max(10, Math.min(200, Math.round(b.n) || 50));
  b.n = n;
  b.seed = run?.seed ?? ($('seed') as HTMLInputElement).value;
  b.total = n;
  b.done = 0;
  b.summaries = [];
  b.luck = [];
  b.error = null;
  b.running = true;
  b.ms = 0;
  const token = ++b.token;
  renderTab();
  const step = (): void => {
    if (token !== b.token) return;
    const sliceStart = performance.now();
    try {
      while (b.done < b.total && performance.now() - sliceStart < 40) {
        const res = runMockSeason(input, { seed: runSeed(b.seed, b.done + 1) });
        b.summaries.push(res.summary);
        b.luck.push(luckSeason(res.summary, luckReport(new ReportContext(input, res.summary.taverns, res.events, res.state))));
        b.done++;
      }
    } catch (e) {
      b.error = `Season ${b.done + 1} (seed ${runSeed(b.seed, b.done + 1)}) failed: ${e instanceof Error ? e.message : String(e)}`;
      b.running = false;
    }
    b.ms += performance.now() - sliceStart;
    if (b.done >= b.total) b.running = false;
    if (tab === 'batch') {
      if (b.running) {
        $('batch-bar').style.width = `${((100 * b.done) / b.total).toFixed(1)}%`;
        $('batch-msg').textContent = `${b.done} of ${b.total} seasons…`;
      } else {
        renderTab();
      }
    }
    if (b.running) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

// ── entry points ───────────────────────────────────────────────────────────

const panel = $('ws-panel');
let opened = false;
/** A season you played to the end, waiting for the workshop to open: loading it audits the whole log, so it waits until it's wanted. */
let played: { readonly seed: string; readonly finish: () => MockSeasonResult } | null = null;

/** Show the workshop. The first time, run the seed in the run bar (sim-1 unless your season is already loaded). */
export function openWorkshop(): void {
  markTabs();
  if (played !== null) {
    loadPlayed(played.seed, played.finish);
    played = null;
    opened = true;
    renderTab();
    return;
  }
  if (opened) {
    renderTab();
    return;
  }
  opened = true;
  if (run !== null) {
    renderStatus(null, run.ms);
    renderTab();
    return;
  }
  $('status').innerHTML = '<span class="chip">Running…</span>';
  // After a paint, so "Running…" shows.
  requestAnimationFrame(() => setTimeout(() => doRun(($('seed') as HTMLInputElement).value.trim() || 'sim-1'), 0));
}

/** Load a season you played to the end into the workshop's tabs, like a seed run, the next time the workshop opens. */
export function loadPlayedSeason(seed: string, finish: () => MockSeasonResult): void {
  played = { seed, finish };
}

function loadPlayed(seed: string, finish: () => MockSeasonResult): void {
  const started = performance.now();
  let error: string | null = null;
  try {
    const result = finish();
    run = { seed, result, ms: performance.now() - started, sha256: lineHash(result.ndjson), played: true };
    lab.roll = null;
    lab.sample = null;
    lab.seeded = false;
    eventsUi.open.clear();
    seedLab();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  renderStatus(error, performance.now() - started);
}

// ── events wiring ──────────────────────────────────────────────────────────

panel.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (target === null) return;
  const { action, id, tavern } = target.dataset;
  switch (action) {
    case 'pick-tavern':
      if (tavern !== undefined) {
        weeksUi.tavern = tavern;
        renderTab();
      }
      break;
    case 'lab-add':
      if (id !== undefined && lab.picks.length < 4 && !lab.picks.includes(id)) {
        lab.picks.push(id);
        lab.roll = null;
        lab.sample = null;
        refreshLab();
      }
      break;
    case 'lab-remove':
      if (id !== undefined) {
        lab.picks = lab.picks.filter((p) => p !== id);
        lab.roll = null;
        lab.sample = null;
        refreshLab();
      }
      break;
    case 'lab-up':
      if (id !== undefined) {
        const i = lab.picks.indexOf(id);
        if (i > 0) {
          [lab.picks[i - 1], lab.picks[i]] = [lab.picks[i]!, lab.picks[i - 1]!];
          lab.roll = null;
          lab.sample = null;
          refreshLab({ party: true, analysis: true });
        }
      }
      break;
    case 'lab-load':
      loadLocked();
      renderTab();
      break;
    case 'lab-clear':
      lab.picks = [];
      lab.retreat = 'never';
      lab.roll = null;
      lab.sample = null;
      refreshLab();
      break;
    case 'lab-roll':
      labRoll();
      break;
    case 'lab-sample':
      labSample();
      break;
    case 'rep-tavern':
      if (tavern !== undefined) {
        reportsUi.tavern = tavern;
        renderTab();
      }
      break;
    case 'draft-hot':
      if (tavern !== undefined) {
        draftUi.hot = draftUi.hot === tavern ? null : tavern;
        renderTab();
      }
      break;
    case 'ev-toggle': {
      const seq = Number(target.dataset.seq);
      if (eventsUi.open.has(seq)) eventsUi.open.delete(seq);
      else eventsUi.open.add(seq);
      if (run !== null) $('ev-list').innerHTML = renderEventList(run);
      break;
    }
    case 'copy-ndjson':
      copyNdjson();
      break;
    case 'batch-run':
      startBatch();
      break;
    case 'batch-cancel':
      batchUi.token++;
      batchUi.running = false;
      renderTab();
      break;
  }
});

panel.addEventListener('change', (ev) => {
  const target = ev.target as HTMLInputElement | HTMLSelectElement;
  switch (target.dataset.action) {
    case 'lab-retreat':
      lab.retreat = parseRetreat(target.value);
      lab.roll = null;
      lab.sample = null;
      refreshLab({ analysis: true });
      break;
    case 'wk-week':
      weeksUi.week = Number(target.value);
      renderTab();
      break;
    case 'wk-tavern':
      weeksUi.tavern = target.value;
      renderTab();
      break;
    case 'lab-week':
      lab.week = Number(target.value);
      lab.roll = null;
      lab.sample = null;
      renderTab();
      break;
    case 'lab-roster':
      lab.roster = target.value;
      if (lab.roster === 'pool') lab.onlyRoster = false;
      renderTab();
      break;
    case 'lab-only':
      lab.onlyRoster = (target as HTMLInputElement).checked;
      refreshLab({ cands: true });
      break;
    case 'pool-sort':
      poolUi.sort = target.value as typeof poolUi.sort;
      if (run !== null) $('pool-table').innerHTML = renderPoolTable(run);
      break;
    case 'ev-type':
      eventsUi.type = target.value;
      if (run !== null) $('ev-list').innerHTML = renderEventList(run);
      break;
    case 'batch-n':
      batchUi.n = Number(target.value);
      break;
  }
});

panel.addEventListener('input', (ev) => {
  const target = ev.target as HTMLInputElement;
  switch (target.dataset.action) {
    case 'lab-filter':
      lab.filter = target.value;
      refreshLab({ cands: true });
      break;
    case 'pool-filter':
      poolUi.filter = target.value;
      if (run !== null) $('pool-table').innerHTML = renderPoolTable(run);
      break;
    case 'ev-text':
      eventsUi.text = target.value;
      if (run !== null) $('ev-list').innerHTML = renderEventList(run);
      break;
  }
});

$('ws-tabs').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (b?.dataset.tab !== undefined && (TABS as ReadonlyArray<string>).includes(b.dataset.tab)) setTab(b.dataset.tab as Tab);
});

// Arrow keys, Home and End move between tabs, as in any tab list.
$('ws-tabs').addEventListener('keydown', (ev) => {
  const order = [...document.querySelectorAll<HTMLButtonElement>('#ws-tabs button[data-tab]')].map((b) => b.dataset.tab as Tab);
  const i = order.indexOf(tab);
  const next =
    ev.key === 'ArrowRight' ? order[(i + 1) % order.length] : ev.key === 'ArrowLeft' ? order[(i - 1 + order.length) % order.length] : ev.key === 'Home' ? order[0] : ev.key === 'End' ? order.at(-1) : undefined;
  if (next === undefined) return;
  ev.preventDefault();
  setTab(next, true);
});

$('run-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  doRun(($('seed') as HTMLInputElement).value.trim());
});

$('new-seed').addEventListener('click', () => {
  const seed = seedWords(cryptoRand);
  ($('seed') as HTMLInputElement).value = seed;
  doRun(seed);
});
