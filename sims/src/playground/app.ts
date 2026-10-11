/**
 * The playground page: runs the real engine and bots in the browser.
 *
 * Plain TypeScript and DOM. The build script (../build-playground.ts) inlines
 * the season as `__PLAYGROUND_DATA__` ahead of this bundle. Every number on
 * the page comes from the engine or from `runMockSeason`, the same code the
 * CLI runs, so a seed here gives exactly the CLI's season.
 *
 * Rendering is string templates into a few containers, with event delegation
 * on `data-action` attributes. Pure helpers live in ./view.ts.
 */
import {
  battleOdds,
  checkOdds,
  evTtkBreakdown,
  freeAgents,
  homeTavern,
  lineHash,
  projectMission,
  rngFor,
  runMission,
  seasonStandings,
  standings,
  weekResults,
  weekSeed,
  validateLineup,
} from '@league-of-taverns/engine';
import type {
  CrEighths,
  EvTtkBreakdown,
  LeagueEvent,
  Lineup,
  Mission,
  NodeRecord,
  Party,
  Projection,
  RunResult,
} from '@league-of-taverns/engine';
import { SeasonSession, aggregate, runMockSeason, runSeed, type MockSeasonResult, type RunSummary } from '../season-runner';
import { seasonInputFromData, type PlaygroundData } from './data';
import {
  actorLabel,
  aggregateRows,
  checkLabel,
  draftBoard,
  eventSummary,
  formatCr,
  formatModifier,
  layoutMission,
  partyFrom,
  pct,
  rostersAtLock,
  sampleMission,
  sameScore,
  scoreFraction,
  scoreHistogram,
  seedWords,
  signed,
  topSkills,
  type GraphLayout,
  type SampleResult,
} from './view';

declare const __PLAYGROUND_DATA__: PlaygroundData;

// ── season data ────────────────────────────────────────────────────────────

const data = __PLAYGROUND_DATA__;
const input = seasonInputFromData(data);
const { config } = input;
const SCALE = config.scoring.pointsScale;
const BUDGET = config.budget.partyCr;
const WEEKS = [...input.missions.keys()].sort((a, b) => a - b);
const poolIds = input.pool.map((p) => p.character.ref.id);
const crById = new Map(input.pool.map((p) => [p.character.ref.id, p.cr]));
const crOf = (id: string): CrEighths => {
  const cr = crById.get(id);
  if (cr === undefined) throw new Error(`"${id}" is not pooled`);
  return cr;
};
const tavernById = new Map(input.taverns.map((t) => [t.id, t]));
const tavernName = (id: string): string => tavernById.get(id)?.name ?? id;
const botOf = (id: string): string => run?.result.summary.taverns.find((t) => t.tavern === id)?.bot ?? tavernById.get(id)?.bot ?? '?';
const layouts = new Map<number, GraphLayout>(WEEKS.map((w) => [w, layoutMission(missionOf(w))]));

function missionOf(week: number): Mission {
  const m = input.missions.get(week);
  if (m === undefined) throw new Error(`no mission for week ${week}`);
  return m.mission;
}
function environmentOf(week: number): string {
  return input.schedule.find((s) => s.week === week)?.environment ?? '';
}

// ── page state ─────────────────────────────────────────────────────────────

type Tab = 'play' | 'standings' | 'weeks' | 'lab' | 'draft' | 'pool' | 'events' | 'batch';
const TABS: ReadonlyArray<Tab> = ['play', 'standings', 'weeks', 'lab', 'draft', 'pool', 'events', 'batch'];

interface Run {
  readonly seed: string;
  readonly result: MockSeasonResult;
  readonly ms: number;
  readonly sha256: string;
  /** True for a season played on the Play tab rather than run from a seed. */
  readonly played?: boolean;
}

let run: Run | null = null;
let tab: Tab = 'standings';
const weeksUi = { week: WEEKS[0] ?? 1, tavern: input.taverns[0]?.id ?? '' };
const lab = {
  week: WEEKS[0] ?? 1,
  roster: 'pool' as string,
  onlyRoster: false,
  filter: '',
  picks: [] as string[],
  captain: null as string | null,
  roll: null as { seed: string; result: RunResult } | null,
  sample: null as { seed: string; result: SampleResult; ms: number } | null,
  seeded: false,
};
const draftUi = { hot: null as string | null };
const poolUi = { filter: '', sort: 'pool' as 'pool' | 'cr' | 'owner' };
const eventsUi = { type: 'all', text: '', open: new Set<number>() };
const batchUi = {
  n: 50,
  running: false,
  done: 0,
  total: 0,
  seed: '',
  summaries: [] as RunSummary[],
  ms: 0,
  token: 0,
  error: null as string | null,
};

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is missing`);
  return el as T;
};
const panel = $('panel');

// ── small helpers ──────────────────────────────────────────────────────────

function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
const num = (v: string | number, cls = ''): string => `<span class="num ${cls}">${esc(v)}</span>`;

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage is a convenience only */
  }
}

/** A fresh random seed from the page's crypto, outside the engine. */
function cryptoSeed(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
function cryptoRand(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! / 2 ** 32;
}

function charLabel(id: string): string {
  const s = input.statsOf(id);
  return `${esc(id)} <span class="muted small">${esc(s.base.typeName)} · CR ${formatCr(crOf(id))}</span>`;
}

// ── mission graph ──────────────────────────────────────────────────────────

interface Overlay {
  readonly path?: ReadonlyArray<string>;
  readonly reach?: Readonly<Record<string, number>>;
  readonly outcomes?: ReadonlyMap<string, string>;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function graphSvg(layout: GraphLayout, overlay: Overlay = {}): string {
  const onPath = new Set(overlay.path ?? []);
  const pathEdges = new Set<string>();
  const path = overlay.path ?? [];
  for (let i = 1; i < path.length; i++) pathEdges.add(`${path[i - 1]}>${path[i]}`);
  const lost = path.length > 0 && overlay.outcomes?.get(path[path.length - 1]!) === 'lose' ? path[path.length - 1] : undefined;

  const edges = layout.edges
    .map((e) => {
      const on = pathEdges.has(`${e.from}>${e.to}`) ? ' on' : '';
      return `<path class="edge${on}" d="${e.d}"/>`;
    })
    .join('');
  const labels = layout.edges
    .filter((e) => e.on !== 'always')
    .map((e) => {
      const on = pathEdges.has(`${e.from}>${e.to}`) ? ' on' : '';
      return `<text class="elabel${on}" x="${e.lx}" y="${e.ly + 3}" text-anchor="middle">${esc(e.on)}</text>`;
    })
    .join('');
  const nodes = layout.nodes
    .map((n) => {
      const cls = [n.kind, onPath.has(n.id) ? 'on' : '', n.id === lost ? 'lost' : ''].filter(Boolean).join(' ');
      const reach = overlay.reach?.[n.id];
      const outcome = overlay.outcomes?.get(n.id);
      const reachText = reach === undefined ? '' : `<text class="reach" x="${n.x + n.w - 6}" y="${n.y + 14}" text-anchor="end">${reach >= 0.9995 ? '100' : (100 * reach).toFixed(reach < 0.1 ? 1 : 0)}%</text>`;
      const outText = outcome === undefined ? '' : `<text class="out ${outcome}" x="${n.x + n.w - 6}" y="${n.y + n.h - 7}" text-anchor="end">${esc(outcome)}</text>`;
      const rx = n.kind === 'start' || n.kind === 'end' ? 18 : 3;
      return (
        `<g class="node ${cls}"><title>${esc(n.id)}: ${esc(n.detail)}${reach === undefined ? '' : ` (reach ${pct(reach)})`}</title>` +
        `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}"/>` +
        `<text class="id" x="${n.x + 8}" y="${n.y + 18}">${esc(clip(n.id, reach === undefined ? 19 : 14))}</text>` +
        `<text class="detail" x="${n.x + 8}" y="${n.y + 35}">${esc(clip(n.detail, outcome === undefined ? 24 : 18))}</text>` +
        reachText +
        outText +
        `</g>`
      );
    })
    .join('');
  return (
    `<div class="graph"><svg width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" role="img" aria-label="Mission graph">` +
    `${edges}${labels}${nodes}</svg></div>`
  );
}

function graphLegend(overlay: Overlay): string {
  const parts = ['columns are ranks; dashed boxes are battles'];
  if (overlay.path !== undefined) parts.unshift('<span><i></i>path taken</span>');
  if (overlay.reach !== undefined) parts.push('% = projected chance to reach the node');
  return `<div class="legend">${parts.map((p) => `<span>${p}</span>`).join('')}</div>`;
}

// ── roll log ───────────────────────────────────────────────────────────────

function rollLog(mission: Mission, run: RunResult, extra = ''): string {
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));
  const rows = run.nodes.map((r: NodeRecord, i) => {
    const node = byId.get(r.node);
    if (r.kind === 'check') {
      const total = r.d20 + r.modifier;
      const meets = total >= r.dc;
      // A gated check nobody qualifies for fails whatever the die says (D-39).
      const gated = node?.kind === 'check' && node.check.requires !== undefined && meets && r.outcome === 'fail';
      const what = node?.kind === 'check' ? checkLabel(node.check) : '';
      return (
        `<tr><td class="n">${i + 1}</td><td>${esc(r.node)}<div class="muted small">${esc(what)}</div></td><td>${esc(r.actor)}</td>` +
        `<td><span class="die ${r.d20 === 20 ? 'hi' : r.d20 === 1 ? 'lo' : ''}">${r.d20}</span>${r.advantage ? ' <span class="tag brass">adv</span>' : ''}</td>` +
        `<td class="sum">${signed(r.modifier)} = <b>${total}</b> ${meets ? '≥' : '<'} DC ${r.dc}</td>` +
        `<td class="${r.outcome}">${r.outcome}${gated ? ' <span class="tag bad">gate</span>' : ''}</td></tr>`
      );
    }
    const what = node?.kind === 'battle' ? node.encounter.creatures.map((c) => `${c.count}× ${c.ref}`).join(', ') : '';
    const won = r.roll < r.pWin;
    return (
      `<tr><td class="n">${i + 1}</td><td>${esc(r.node)}<div class="muted small">${esc(what)}</div></td><td class="muted">party</td>` +
      `<td><span class="die">${r.roll.toFixed(3)}</span></td>` +
      `<td class="sum">roll ${won ? '<' : '≥'} pWin ${r.pWin.toFixed(3)}</td><td class="${r.outcome === 'win' ? 'pass' : 'fail'}">${r.outcome}</td></tr>`
    );
  });
  const score = run.dnf
    ? `DNF after ${run.checksPassed} of ${run.checksAttempted} checks passed: score 0`
    : `${run.checksPassed} of ${run.checksAttempted} checks passed: score ${scoreFraction(run.score)}`;
  return (
    `<div class="scroll"><table><thead><tr><th class="n">#</th><th>node</th><th>actor</th><th>die</th><th>sum</th><th>outcome</th></tr></thead>` +
    `<tbody>${rows.join('') || '<tr><td colspan="6" class="muted">No checks or battles.</td></tr>'}</tbody></table></div>` +
    `<p class="small"><b>${esc(score)}</b> → ${num(Math.round(run.score * SCALE))} points${extra}</p>` +
    `<p class="hint">Checks pass when d20 + modifier ≥ DC (no natural-20 rule; with advantage the higher of two d20s is shown). Battles are won when the roll is below pWin.</p>`
  );
}

function outcomesOf(run: RunResult): Map<string, string> {
  return new Map(run.nodes.map((n) => [n.node, n.outcome]));
}

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

function setTab(next: Tab): void {
  tab = next;
  storageSet('lot-playground-tab', next);
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === next));
  renderTab();
}

function renderTab(): void {
  if (tab === 'play') {
    panel.innerHTML = renderPlay();
    return;
  }
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
    summary.weeks.map((w) => w.results.find((x) => x.tavern === tavern)?.points ?? 0).join(' / ');
  const rows = summary.standings
    .map(
      (s) =>
        `<tr class="${s.rank === 1 ? 'champ' : ''}"><td class="n">${s.rank}</td><td><b>${esc(tavernName(s.tavern))}</b><div class="muted small">${esc(s.tavern)}</div></td>` +
        `<td><span class="tag">${esc(s.bot)}</span></td><td class="n">${s.points}</td><td class="n muted">${weekly(s.tavern)}</td></tr>`,
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
            `<td class="n">${x.points}</td><td class="n muted">${x.projectedPoints.toFixed(1)}${x.projectedPoints === top ? ' <span class="tag brass">best</span>' : ''}</td><td class="n muted">${checks}</td></tr>`
          );
        })
        .join('');
      const waivers =
        w.waivers.length === 0
          ? ''
          : `<p class="small muted">Waivers after week ${w.week}: ${w.waivers
              .map((x) => `${esc(tavernName(x.tavern))} +${esc(x.add)}${x.drop === null ? '' : ` −${esc(x.drop)}`} <span class="${x.awarded ? 'pass' : 'fail'}">${esc(x.reason)}</span>`)
              .join('; ')}</p>`;
      return (
        `<div class="stack"><h3>Week ${w.week} <span class="muted small">${esc(w.mission)} · ${esc(environmentOf(w.week))}</span></h3>` +
        `<div class="scroll"><table><thead><tr><th class="n">#</th><th>tavern</th><th class="n">points</th><th class="n">projected</th><th class="n">checks</th></tr></thead><tbody>${rankRows}</tbody></table></div>${waivers}</div>`
      );
    })
    .join('');
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Standings</h2><span class="chip brass">${champs.length === 1 ? 'Champion' : 'Co-champions'}: ${champs.map((c) => `<b>${esc(tavernName(c.tavern))}</b> <span class="muted">${esc(c.bot)}</span>`).join(', ')}</span></div>` +
    `<div class="scroll"><table><thead><tr><th class="n">#</th><th>tavern</th><th>bot</th><th class="n">loot</th><th class="n">weekly</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    `<p class="hint">Ranked by total loot. Equal totals share a rank; there are no tiebreakers.</p></section>` +
    `<section class="card"><h2>Weekly tables</h2>${weeks}</section>`
  );
}

// ── weeks ──────────────────────────────────────────────────────────────────

function lineupCard(lineup: Lineup | null, source: string): string {
  if (lineup === null) return '<p class="muted">No lineup this week: the tavern scores 0.</p>';
  const ids = [lineup.captain, ...lineup.allies];
  const total = ids.reduce((s, id) => s + crOf(id), 0);
  const items = ids
    .map((id, i) => `<li>${i === 0 ? '<span class="cap" title="captain">C</span>' : ''}${charLabel(id)}</li>`)
    .join('');
  return (
    `<ul class="stack" style="list-style:none;margin:0;padding:0">${items}</ul>` +
    `<p class="small">CR total ${num(formatCr(total))} of B = ${num(formatCr(BUDGET))} <span class="tag">${esc(source)}</span></p>` +
    crMeter(total)
  );
}

function crMeter(total: number): string {
  const over = total > BUDGET;
  return `<div class="meter ${over ? 'over' : ''}" title="CR ${formatCr(total)} / ${formatCr(BUDGET)}"><div style="width:${Math.min(100, (100 * total) / BUDGET).toFixed(1)}%"></div></div>`;
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
        `<td class="wrap-ok small">${lineup === null ? '—' : `<span class="cap">C</span>${esc(lineup.captain)}, ${lineup.allies.map(esc).join(', ')}`}</td>` +
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
      const party = partyFrom(entry.lineup.captain, entry.lineup.allies, input.statsOf);
      projection = projectMission(party, mission, input.baseOf, input.battleModel);
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
          `<div><span class="label">P(DNF)</span><span class="v">${pct(res.projected.pDnf)}</span></div>` +
          `<div><span class="label">score</span><span class="v">${res.run.dnf ? 'DNF' : scoreFraction(res.run.score)}</span></div></div>` +
          `<p class="small muted">Dice seed ${num(res.seed)}${seedCheck}</p></div>`) +
      `</div>` +
      graphSvg(layouts.get(week)!, overlay) +
      graphLegend(overlay) +
      (res === undefined ? '' : `<h3>Roll log</h3>${rollLog(mission, res.run)}`);
  }

  return (
    `<section class="card"><div class="row"><h2>Week ${week}</h2><span class="muted">${esc(mission.id)} · ${esc(environmentOf(week))}</span></div>` +
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
  lab.picks = [entry.lineup.captain, ...entry.lineup.allies];
  lab.captain = entry.lineup.captain;
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
  const captain = lab.captain !== null && lab.picks.includes(lab.captain) ? lab.captain : lab.picks[0]!;
  return partyFrom(
    captain,
    lab.picks.filter((p) => p !== captain),
    input.statsOf,
  );
}

function renderLab(r: Run): string {
  const weekOptions = WEEKS.map((w) => `<option value="${w}" ${w === lab.week ? 'selected' : ''}>Week ${w}: ${esc(missionOf(w).id)}</option>`).join('');
  const rosterOptions =
    `<option value="pool" ${lab.roster === 'pool' ? 'selected' : ''}>Whole pool (ownership ignored)</option>` +
    input.taverns.map((t) => `<option value="${esc(t.id)}" ${t.id === lab.roster ? 'selected' : ''}>${esc(t.name)} (roster at week ${lab.week} lock)</option>`).join('');
  return (
    `<section class="card"><div class="row"><h2>Lineup lab</h2><span class="muted small">Pick any four, mark a captain, and see the engine's odds live.</span></div>` +
    `<div class="row"><label class="label" for="lab-week">Mission</label><select id="lab-week" data-action="lab-week">${weekOptions}</select>` +
    `<label class="label" for="lab-roster">Validate against</label><select id="lab-roster" data-action="lab-roster">${rosterOptions}</select>` +
    `<label class="small"><input type="checkbox" id="lab-only" data-action="lab-only" ${lab.onlyRoster ? 'checked' : ''} ${lab.roster === 'pool' ? 'disabled' : ''}> list only this roster</label>` +
    `<button type="button" data-action="lab-load" ${lab.roster === 'pool' ? 'disabled' : ''}>Load its locked lineup</button>` +
    `<button type="button" data-action="lab-clear">Clear</button></div>` +
    `<div class="cols"><div class="stack"><span class="label">Party (lineup order)</span><div id="lab-party">${renderLabParty()}</div></div>` +
    `<div class="stack"><div class="row"><span class="label">Candidates</span><input type="text" id="lab-filter" placeholder="Filter by id, base or skill" value="${esc(lab.filter)}" data-action="lab-filter"></div>` +
    `<div id="lab-cands" class="scroll" style="max-height:340px;overflow-y:auto">${renderLabCandidates(r)}</div></div></div></section>` +
    `<div id="lab-analysis" class="panel">${renderLabAnalysis(r)}</div>`
  );
}

function renderLabParty(): string {
  const captain = labParty()?.captain ?? null;
  const slots = [0, 1, 2, 3].map((i) => {
    const id = lab.picks[i];
    if (id === undefined) return `<div class="slot empty"><span>${i === 0 ? 'C' : '·'}</span><span class="who">Empty: add from the list</span><span></span><span></span></div>`;
    const isCap = id === captain;
    return (
      `<div class="slot"><span>${isCap ? '<span class="cap">C</span>' : `<button type="button" class="link small" data-action="lab-captain" data-id="${esc(id)}" title="Make captain">make C</button>`}</span>` +
      `<span class="who">${charLabel(id)}</span>` +
      `<span>${i > 0 ? `<button type="button" class="link small" data-action="lab-up" data-id="${esc(id)}" title="Move up">up</button>` : ''}</span>` +
      `<button type="button" class="link small" data-action="lab-remove" data-id="${esc(id)}">remove</button></div>`
    );
  });
  const total = lab.picks.reduce((s, id) => s + crOf(id), 0);
  return `<div class="pick-list">${slots.join('')}</div><p class="small">CR total ${num(formatCr(total))} of B = ${num(formatCr(BUDGET))}</p>${crMeter(total)}`;
}

function renderLabCandidates(r: Run): string {
  const { ids: rosterIds, owner } = labRosterIds(r.result.events);
  const ids = lab.roster !== 'pool' && lab.onlyRoster ? rosterIds : poolIds;
  const q = lab.filter.trim().toLowerCase();
  const rows = ids
    .filter((id) => {
      if (q === '') return true;
      const s = input.statsOf(id);
      return id.includes(q) || s.base.slug.includes(q) || s.base.typeName.toLowerCase().includes(q) || topSkills(s).some((t) => t.skill.includes(q));
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
        `<tr class="${chosen ? 'sel' : ''}"><td><button type="button" class="${chosen ? '' : 'primary'} small" data-action="${chosen ? 'lab-remove' : 'lab-add'}" data-id="${esc(id)}" ${!chosen && full ? 'disabled' : ''}>${chosen ? 'remove' : 'add'}</button></td>` +
        `<td>${esc(id)}<div class="muted small">${esc(s.base.typeName)}</div></td><td class="n">${formatCr(crOf(id))}</td>` +
        `<td class="small">${topSkills(s)
          .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
          .join(', ')}</td><td class="small muted">${esc(moves || '—')}</td><td class="small">${esc(owner.has(id) ? tavernName(owner.get(id)!) : 'free agent')}</td></tr>`
      );
    })
    .join('');
  return `<table><thead><tr><th></th><th>character</th><th class="n">CR</th><th>best skills</th><th>moves</th><th>owner (wk ${lab.week} lock)</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No match.</td></tr>'}</tbody></table>`;
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
      const label = `${scoreFraction(score)}${sameScore(score, 0) && projection.pDnf > 0 ? '*' : ''}`;
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
      ? '<p class="hint">Bars: projected probability of each final score.</p>'
      : `<p class="hint">Upper bar: projected. Lower grey bar: sampled share.${hist.other > 0 ? ` <span class="fail">${hist.other} samples hit no projected score.</span>` : ''}</p>`;
  return `<div class="bars">${rows}</div>${projection.pDnf > 0 ? '<p class="hint">* score 0 includes every DNF.</p>' : ''}${legend}`;
}

function renderLabAnalysis(r: Run): string {
  const mission = missionOf(lab.week);
  const layout = layouts.get(lab.week)!;
  const party = labParty();
  if (party === null) {
    return `<section class="card"><p class="muted">Add characters to see odds for ${esc(mission.id)}.</p>${graphSvg(layout)}${graphLegend({})}</section>`;
  }
  const captain = party.captain;
  const allies = lab.picks.filter((p) => p !== captain);
  const lineup = { captain, allies } as unknown as Lineup;
  const { ids: rosterIds } = labRosterIds(r.result.events);
  const rosterView = { tavern: lab.roster === 'pool' ? 'the pool' : lab.roster, characters: rosterIds };
  const violations = validateLineup(lineup, rosterView, crOf, config);
  const projection = projectMission(party, mission, input.baseOf, input.battleModel);

  const nodes = [...mission.nodes].sort((a, b) => a.rank - b.rank);
  const checkRows = nodes
    .flatMap((n) => {
      if (n.kind !== 'check') return [];
      const o = checkOdds(party, n.check);
      const gate = n.check.requires === undefined ? '<span class="muted">—</span>' : o.eligible ? '<span class="pass">met</span>' : '<span class="fail">unmet: auto-fail</span>';
      return [
        `<tr><td>${esc(n.id)}</td><td class="small">${esc(checkLabel(n.check))}</td><td>${esc(o.actor)}${o.actor === captain ? ' <span class="cap">C</span>' : ''}</td>` +
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
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>${esc(mission.id)}</h2><span class="muted small">captain breaks ties, then lineup order</span></div>` +
    (violations.length === 0
      ? `<p class="okline">validateLineup: legal${lab.roster === 'pool' ? ' (ownership not checked)' : ''}</p>`
      : `<div><span class="label">validateLineup</span><ul class="violations">${violations.map((v) => `<li><span class="mono">${esc(v.code)}</span>: ${esc(v.message)}</li>`).join('')}</ul></div>`) +
    `<div class="kv"><div><span class="label">expected points</span><span class="v">${(projection.expectedScore * SCALE).toFixed(1)}</span></div>` +
    `<div><span class="label">P(DNF)</span><span class="v">${pct(projection.pDnf)}</span></div>` +
    `<div><span class="label">expected score</span><span class="v">${projection.expectedScore.toFixed(4)}</span></div></div>` +
    graphSvg(layout, rollOverlay) +
    graphLegend(rollOverlay) +
    `</section>` +
    `<div class="cols"><section class="card"><h3>Checks</h3><div class="scroll"><table><thead><tr><th>node</th><th>check</th><th>actor</th><th class="n">mod</th><th>adv</th><th>gate</th><th class="n">pass</th><th class="n">reach</th></tr></thead><tbody>${checkRows || '<tr><td colspan="8" class="muted">None.</td></tr>'}</tbody></table></div>` +
    `<h3>Battles</h3><div class="scroll"><table><thead><tr><th>node</th><th>encounter</th><th class="n">pWin</th><th class="n">reach</th></tr></thead><tbody>${battleRows || '<tr><td colspan="4" class="muted">None.</td></tr>'}</tbody></table></div></section>` +
    `<section class="card"><h3>Score distribution</h3>${distributionBars(projection, sample?.result ?? null)}` +
    `<div class="row"><button type="button" class="primary" data-action="lab-roll">Roll once</button><button type="button" data-action="lab-sample">Roll 1,000</button></div>${sampleBlock}</section></div>` +
    (lab.roll === null ? '' : `<section class="card"><h3>One roll <span class="muted small">seed ${esc(lab.roll.seed)}</span></h3>${rollLog(mission, lab.roll.result)}</section>`)
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
  const result = runMission(party, missionOf(lab.week), (node) => rngFor(seed, `roll:${node}`), input.baseOf, input.battleModel);
  lab.roll = { seed, result };
  refreshLab({ analysis: true });
}

function labSample(): void {
  const party = labParty();
  if (party === null) return;
  const seed = cryptoSeed('lab');
  const started = performance.now();
  const result = sampleMission(party, missionOf(lab.week), input.baseOf, input.battleModel, 1000, seed);
  lab.sample = { seed, result, ms: performance.now() - started };
  refreshLab({ analysis: true });
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
            return `<td class="${draftUi.hot === c.tavern ? 'hot' : ''}"><span class="pk">#${c.pick + 1}</span> <span class="ch">${esc(c.character)}</span><div class="muted small">${esc(s.base.typeName)} · CR ${formatCr(crOf(c.character))}</div></td>`;
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
    `<div class="row"><input type="text" id="pool-filter" placeholder="Filter by id, base, owner or skill" value="${esc(poolUi.filter)}" data-action="pool-filter">` +
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
    const hay = [id, s.base.slug, s.base.typeName, owner ?? 'free agent', drafted?.tavern ?? '', ...topSkills(s).map((t) => t.skill)].join(' ').toLowerCase();
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
        `<tr><td><b>${esc(id)}</b></td><td>${esc(s.base.typeName)}<div class="muted small">${esc(s.base.slug)}</div></td><td class="n">${formatCr(p.cr)}</td>` +
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
  return `<table><thead><tr><th>character</th><th>base</th><th class="n">CR</th><th>drafted by</th><th>owner at end</th><th>modifiers</th><th>best 3 skills</th><th class="n">AC / HP</th><th>speeds, senses</th><th class="n">battle</th></tr></thead><tbody>${rows || '<tr><td colspan="10" class="muted">No match.</td></tr>'}</tbody></table>`;
}

// ── event log ──────────────────────────────────────────────────────────────

function renderEvents(r: Run): string {
  const types = [...new Set(r.result.events.map((e) => e.type))];
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Event log</h2>` +
    `<div class="row"><button type="button" class="primary" data-action="copy-ndjson">Download events.ndjson</button><span id="copy-msg" class="small muted" aria-live="polite"></span></div></div>` +
    `<p class="hint">Downloads are blocked here, so the button copies the NDJSON (${r.result.ndjson.length.toLocaleString()} bytes) to your clipboard. Paste it into a file to diff against the CLI's events-1.ndjson.</p>` +
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
      `<p>Titles by seat: ${Object.entries(totals.titlesByTavern)
        .map(([t, n]) => `${esc(tavernName(t))} ${num(Number.isInteger(n) ? n : n.toFixed(1))}`)
        .join(', ')}</p>` +
      `<p class="hint">${totals.runs} seasons from seed ${esc(b.seed)} in ${(b.ms / 1000).toFixed(2)} s (${(b.ms / totals.runs).toFixed(1)} ms/season). Same as <span class="mono">mock-season -- --runs ${totals.runs} --seed ${esc(b.seed)}</span>.</p>`;
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
        b.summaries.push(runMockSeason(input, { seed: runSeed(b.seed, b.done + 1) }).summary);
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

// ── play vs bots ───────────────────────────────────────────────────────────

const play = {
  session: null as SeasonSession | null,
  tavern: input.taverns[0]?.id ?? '',
  seed: '',
  error: null as string | null,
  filter: '',
  /** The lineup builder, captain first once submitted. */
  picks: [] as string[],
  captain: null as string | null,
  /** The week the builder was loaded for. */
  builderWeek: 0,
  add: '',
  drop: '',
  /** The week just played, to show its result. */
  played: null as number | null,
};

function startPlay(): void {
  const seed = play.seed.trim() || seedWords(cryptoRand);
  play.error = null;
  try {
    const session = new SeasonSession(input, { seed, human: { tavern: play.tavern, login: 'you', githubId: 1 } });
    session.advanceDraft();
    Object.assign(play, { session, seed, filter: '', picks: [], captain: null, builderWeek: 0, add: '', drop: '', played: null });
  } catch (e) {
    play.error = e instanceof Error ? e.message : String(e);
  }
  renderTab();
}

/** Run a move against the session; an engine refusal shows as an error and changes nothing. */
function playAct(move: (s: SeasonSession) => void): void {
  const s = play.session;
  if (s === null) return;
  play.error = null;
  try {
    move(s);
  } catch (e) {
    play.error = e instanceof Error ? e.message : String(e);
  }
  if (s.stage.kind === 'complete' && run?.result.state !== s.state) openPlayed(s);
  renderTab();
}

/** Load the finished season into the other tabs, like a seed run. */
function openPlayed(s: SeasonSession): void {
  const started = performance.now();
  let error: string | null = null;
  try {
    const result = s.finish();
    run = { seed: s.seed, result, ms: performance.now() - started, sha256: lineHash(result.ndjson), played: true };
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

function myRoster(s: SeasonSession): ReadonlyArray<string> {
  return s.state.taverns.get(s.human!.tavern)?.roster ?? [];
}

/** Point the builder at the next week: the submitted lineup, else last week's, else the advisor's. Drops anyone no longer on the roster. */
function syncBuilder(s: SeasonSession, week: number): void {
  const roster = new Set(myRoster(s));
  if (play.builderWeek !== week) {
    play.builderWeek = week;
    const me = s.human!.tavern;
    const lineup = s.pendingLineup() ?? s.state.lockedLineups.get(week - 1)?.find((l) => l.tavern === me)?.lineup ?? s.suggestLineup();
    play.picks = lineup === null ? [] : [lineup.captain, ...lineup.allies];
    play.captain = lineup?.captain ?? null;
  }
  play.picks = play.picks.filter((id) => roster.has(id));
  if (play.captain === null || !play.picks.includes(play.captain)) play.captain = play.picks[0] ?? null;
  if (!roster.has(play.drop)) play.drop = '';
  if (!freeAgents(s.state).includes(play.add)) play.add = '';
}

function builderLineup(): Lineup | null {
  if (play.captain === null) return null;
  return { captain: play.captain, allies: play.picks.filter((p) => p !== play.captain) } as unknown as Lineup;
}

function charRow(id: string, action: string, extra = ''): string {
  const s = input.statsOf(id);
  const moves = Object.entries(s.speeds)
    .filter(([k]) => k !== 'walk')
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return (
    `<tr><td>${action}</td><td><b>${esc(id)}</b><div class="muted small">${esc(s.base.typeName)}</div></td><td class="n">${formatCr(crOf(id))}</td>` +
    `<td class="small">${topSkills(s)
      .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
      .join(', ')}</td><td class="small muted">${esc(moves || '-')}</td><td class="n small">${s.base.ac} / ${s.base.hp}</td>${extra}</tr>`
  );
}
const CHAR_HEAD = '<th></th><th>character</th><th class="n">CR</th><th>best skills</th><th>moves</th><th class="n">AC / HP</th>';

function matchesFilter(id: string, q: string): boolean {
  if (q === '') return true;
  const s = input.statsOf(id);
  return id.includes(q) || s.base.slug.includes(q) || s.base.typeName.toLowerCase().includes(q) || topSkills(s).some((t) => t.skill.includes(q));
}

function renderPlay(): string {
  const s = play.session;
  const err = play.error === null ? '' : `<div class="error">${esc(play.error)}</div>`;
  if (s === null) return renderPlaySetup() + err;
  const stage = s.stage;
  if (stage.kind === 'draft') return playHeader(s) + err + renderPlayDraft(s, stage.pick);
  if (stage.kind === 'week') syncBuilder(s, stage.week);
  return (
    playHeader(s) +
    err +
    (play.played === null ? '' : renderPlayResult(s, play.played)) +
    (stage.kind === 'week' ? renderPlayWeek(s, stage.week) : '') +
    renderPlayStandings(s)
  );
}

function renderPlaySetup(): string {
  const options = input.taverns.map((t) => `<option value="${esc(t.id)}" ${t.id === play.tavern ? 'selected' : ''}>${esc(t.name)} (advisor: ${esc(t.bot)})</option>`).join('');
  return (
    `<section class="card"><h2>Play vs bots</h2>` +
    `<p>Manage one tavern yourself against ${input.taverns.length - 1} bot taverns. Draft when you are on the clock, then before each week set a lineup and make waiver claims, and play the week. ` +
    `Every move goes through the engine's reducers, so an illegal one is refused with the engine's reason.</p>` +
    `<div class="row"><label class="label" for="play-tavern">Your tavern</label><select id="play-tavern" data-action="play-tavern">${options}</select>` +
    `<label class="label" for="play-seed">Seed</label><input type="text" id="play-seed" data-action="play-seed" placeholder="random" value="${esc(play.seed)}" spellcheck="false" autocomplete="off">` +
    `<button type="button" class="primary" data-action="play-start">Start season</button></div>` +
    `<p class="hint">Your tavern's bot stays on as your advisor and can suggest a pick, a lineup or waiver claims. The seed drives the draft order, the bots and the dice, so the same seed and the same moves give the same season. ` +
    `When the season ends it loads into the other tabs.</p></section>`
  );
}

function playHeader(s: SeasonSession): string {
  const me = s.human!.tavern;
  const stage = s.stage;
  const total = config.draft.rounds * input.taverns.length;
  const where =
    stage.kind === 'draft' ? `Draft, pick ${stage.pick + 1} of ${total}` : stage.kind === 'week' ? `Week ${stage.week} of ${config.weeks}` : 'Season complete';
  const rows = seasonStandings(s.state);
  const row = rows.find((r) => r.tavern === me);
  const rec = row === undefined || s.state.finalizedWeeks.size === 0 ? '' : `<span class="chip">${ordinal(row.rank)} of ${rows.length} · ${row.points} loot</span>`;
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><div class="row"><h2>${esc(tavernName(me))}</h2><span class="tag brass">you</span>` +
    `<span class="muted small">${esc(where)} · seed ${esc(s.seed)}</span></div><div class="row">${rec}<button type="button" data-action="play-reset">New season</button></div></div></section>`
  );
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${tail}`;
}

function renderPlayDraft(s: SeasonSession, pick: number): string {
  const me = s.human!.tavern;
  const n = input.taverns.length;
  const picks = s.events.flatMap((e) => (e.type === 'draft.pick' ? [e.payload] : []));
  const mine = myRoster(s);
  const since = picks.slice(picks.map((p) => p.tavern).lastIndexOf(me) + 1);
  const advice = s.suggestPick();
  const q = play.filter.trim().toLowerCase();
  const rows = freeAgents(s.state)
    .filter((id) => matchesFilter(id, q))
    .map((id) => charRow(id, `<button type="button" class="primary small" data-action="play-draft" data-id="${esc(id)}">draft</button>`))
    .join('');
  const board = draftBoard(
    s.state.draft.order,
    picks.map((p) => ({ ...p, bot: p.tavern === me ? 'human' : botOf(p.tavern) })),
  );
  const boardRows = board
    .map(
      (row) =>
        `<tr class="${row.direction}"><td class="rd">R${row.round}</td>${row.cells
          .map((c) => (c === null ? '<td></td>' : `<td class="${c.tavern === me ? 'hot' : ''}"><span class="pk">#${c.pick + 1}</span> <span class="ch">${esc(c.character)}</span></td>`))
          .join('')}</tr>`,
    )
    .join('');
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>You are on the clock</h2><span class="muted small">pick #${pick + 1}, round ${Math.floor(pick / n) + 1} of ${config.draft.rounds}</span></div>` +
    (since.length === 0 ? '' : `<p class="small">Since your last pick: ${since.map((p) => `${esc(tavernName(p.tavern))} took <b>${esc(p.character)}</b>`).join('; ')}.</p>`) +
    `<p class="small">Advisor (${esc(tavernById.get(me)?.bot ?? '?')}) suggests <b>${esc(advice)}</b> <span class="muted">CR ${formatCr(crOf(advice))}</span> ` +
    `<button type="button" class="small" data-action="play-draft" data-id="${esc(advice)}">Take it</button></p>` +
    `<div class="cols"><div class="stack"><span class="label">Your roster (${mine.length} of ${config.roster.size})</span>` +
    (mine.length === 0 ? '<p class="muted small">Nobody yet.</p>' : `<ul class="stack" style="list-style:none;margin:0;padding:0">${mine.map((id) => `<li>${charLabel(id)}</li>`).join('')}</ul>`) +
    `<p class="hint">Each week you start ${config.roster.starters} with total CR at most ${formatCr(BUDGET)}.</p></div>` +
    `<div class="stack"><div class="row"><span class="label">Free agents</span><input type="text" id="play-filter" placeholder="Filter by id, base or skill" value="${esc(play.filter)}" data-action="play-filter"></div>` +
    `<div id="play-fa" class="scroll" style="max-height:420px;overflow-y:auto"><table><thead><tr>${CHAR_HEAD}</tr></thead><tbody>${rows || '<tr><td colspan="6" class="muted">No match.</td></tr>'}</tbody></table></div></div></div></section>` +
    `<section class="card"><h3>Draft board</h3><div class="scroll"><table class="draft"><thead><tr><th>round</th>${s.state.draft.order
      .map((t) => `<th class="${t === me ? 'hot' : ''}">${esc(tavernName(t))}</th>`)
      .join('')}</tr></thead><tbody>${boardRows || `<tr><td colspan="${n + 1}" class="muted">No picks yet.</td></tr>`}</tbody></table></div></section>`
  );
}

function renderPlayWeek(s: SeasonSession, week: number): string {
  const me = s.human!.tavern;
  const mission = missionOf(week);
  const roster = myRoster(s);
  const lineup = builderLineup();
  const pending = s.pendingLineup();
  const violations = lineup === null ? [] : validateLineup(lineup, { tavern: me, characters: roster }, crOf, config);
  const projection = lineup === null || play.picks.length === 0 ? null : projectMission(partyFrom(lineup.captain, lineup.allies, input.statsOf), mission, input.baseOf, input.battleModel);
  const same = pending !== null && lineup !== null && pending.captain === lineup.captain && pending.allies.join() === lineup.allies.join();
  const total = play.picks.reduce((t, id) => t + crOf(id), 0);

  const rosterRows = roster
    .map((id) => {
      const on = play.picks.includes(id);
      const isCap = id === play.captain;
      const btn = on
        ? `<button type="button" class="small" data-action="play-lu-remove" data-id="${esc(id)}">bench</button>`
        : `<button type="button" class="primary small" data-action="play-lu-add" data-id="${esc(id)}" ${play.picks.length >= config.roster.starters ? 'disabled' : ''}>start</button>`;
      const cap = isCap ? '<span class="cap" title="captain">C</span>' : on ? `<button type="button" class="link small" data-action="play-lu-captain" data-id="${esc(id)}">make C</button>` : '';
      return charRow(id, btn, `<td>${cap}</td>`).replace('<tr>', `<tr class="${on ? 'sel' : ''}">`);
    })
    .join('');

  const status =
    pending === null
      ? '<span class="muted">No lineup submitted: at the lock your last lineup carries over (or a legal fallback).</span>'
      : same
        ? '<span class="pass">Submitted.</span>'
        : `<span class="fail">Changed since you submitted</span> <span class="muted">(submitted: C ${esc(pending.captain)}, ${pending.allies.map(esc).join(', ')})</span>`;

  const lineupCardHtml =
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Week ${week}: ${esc(mission.id)}</h2><span class="muted small">${esc(environmentOf(week))} · ${homeLine(s, week)}</span></div>` +
    `<div class="scroll"><table><thead><tr>${CHAR_HEAD}<th></th></tr></thead><tbody>${rosterRows}</tbody></table></div>` +
    `<p class="small">Starting ${play.picks.length} of ${config.roster.starters} · CR ${num(formatCr(total))} of ${num(formatCr(BUDGET))}</p>${crMeter(total)}` +
    (lineup === null
      ? ''
      : violations.length === 0
        ? '<p class="okline">validateLineup: legal</p>'
        : `<ul class="violations">${violations.map((v) => `<li><span class="mono">${esc(v.code)}</span>: ${esc(v.message)}</li>`).join('')}</ul>`) +
    (projection === null
      ? ''
      : `<div class="kv"><div><span class="label">expected points</span><span class="v">${(projection.expectedScore * SCALE).toFixed(1)}</span></div>` +
        `<div><span class="label">P(DNF)</span><span class="v">${pct(projection.pDnf)}</span></div></div>`) +
    `<div class="row"><button type="button" class="primary" data-action="play-lu-submit" ${lineup === null || violations.length > 0 || same ? 'disabled' : ''}>Submit lineup</button>` +
    `<button type="button" data-action="play-lu-advice">Advisor's lineup</button><span class="small">${status}</span></div>` +
    (projection === null ? '' : graphSvg(layouts.get(week)!, { reach: projection.reach }) + graphLegend({ reach: projection.reach })) +
    `</section>`;

  let waivers = '';
  if (week < config.weeks) {
    const fa = freeAgents(s.state);
    const claims = s.pendingClaims().filter((c) => c.tavern === me);
    const advice = s.suggestClaims();
    waivers =
      `<section class="card"><h2>Waivers</h2>` +
      `<p class="small muted">Claims resolve after week ${week}'s run, in waiver priority order (yours: ${s.state.waivers.priority.indexOf(me) + 1} of ${s.state.waivers.priority.length}). A claim cannot be withdrawn.</p>` +
      `<div class="row"><label class="label" for="play-add">Add</label><select id="play-add" data-action="play-add"><option value="">choose a free agent</option>${fa
        .map((id) => `<option value="${esc(id)}" ${id === play.add ? 'selected' : ''}>${esc(id)} (CR ${formatCr(crOf(id))})</option>`)
        .join('')}</select>` +
      `<label class="label" for="play-drop">Drop</label><select id="play-drop" data-action="play-drop"><option value="">nobody${roster.length >= config.roster.size ? ' (roster is full)' : ''}</option>${roster
        .map((id) => `<option value="${esc(id)}" ${id === play.drop ? 'selected' : ''}>${esc(id)} (CR ${formatCr(crOf(id))})</option>`)
        .join('')}</select>` +
      `<button type="button" data-action="play-claim" ${play.add === '' ? 'disabled' : ''}>Claim</button></div>` +
      `<p class="small">Advisor: ${
        advice.length === 0
          ? '<span class="muted">no claims</span>'
          : advice.map((c) => `+${esc(c.add)}${c.drop === null ? '' : ` -${esc(c.drop)}`}`).join(', ') +
            ` <button type="button" class="small" data-action="play-claim-advice">Make these claims</button>`
      }</p>` +
      (claims.length === 0 ? '' : `<p class="small">Your pending claims: ${claims.map((c) => `+<b>${esc(c.add)}</b>${c.drop === null ? '' : ` -${esc(c.drop)}`}`).join('; ')}</p>`) +
      `</section>`;
  }

  return (
    lineupCardHtml +
    waivers +
    `<section class="card"><div class="row" style="justify-content:space-between"><span class="muted small">The bots set their lineups and claims when you play the week.</span>` +
    `<button type="button" class="primary" data-action="play-week">Play week ${week}</button></div></section>`
  );
}

/** Whose home week it is, from the sponsors in the season package. */
function homeLine(s: SeasonSession, week: number): string {
  const home = homeTavern(s.state, week);
  if (home === null) return 'no sponsor this week';
  if (home === s.human!.tavern) return `<b>your home week</b>: loot × ${config.scoring.homeBonus}`;
  return `home week for <b>${esc(tavernName(home))}</b> (× ${config.scoring.homeBonus})`;
}

function renderPlayResult(s: SeasonSession, week: number): string {
  const me = s.human!.tavern;
  const results = new Map(weekResults(s.state, week).map((r) => [r.tavern, r]));
  const table = standings([], [...results.values()]);
  const res = s.state.results.get(week)?.get(me);
  const mission = missionOf(week);
  const mine = table.find((r) => r.tavern === me);
  const headline =
    mine === undefined
      ? ''
      : `<b>${mine.rank === 1 ? '<span class="pass">Topped the week</span>' : `${ordinal(mine.rank)} of ${table.length}`}</b> with ${num(mine.points)} loot`;
  const others = table
    .map(
      (r) =>
        `<tr class="${r.tavern === me ? 'sel' : ''}"><td class="n">${r.rank}</td><td><span class="${r.rank === 1 ? 'win' : ''}">${esc(tavernName(r.tavern))}</span></td><td class="n">${r.points}</td></tr>`,
    )
    .join('');
  const waivers = s.events
    .flatMap((e) => (e.type === 'waiver.resolved' && e.payload.week === week ? e.payload.outcomes : []))
    .filter((o) => o.claim.includes(`-${me}-`));
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Week ${week} result</h2><span class="small">${headline}</span></div>` +
    (res === undefined
      ? '<p class="muted">You fielded no lineup and scored 0.</p>'
      : graphSvg(layouts.get(week)!, { path: res.run.path, outcomes: outcomesOf(res.run) }) + `<details><summary>Your roll log</summary>${rollLog(mission, res.run)}</details>`) +
    (others === '' ? '' : `<h3>This week's table</h3><div class="scroll"><table><tbody>${others}</tbody></table></div>`) +
    (waivers.length === 0 ? '' : `<p class="small">Your claims: ${waivers.map((o) => `<span class="${o.awarded ? 'pass' : 'fail'}">${esc(o.reason)}</span>`).join(', ')}</p>`) +
    `</section>`
  );
}

function renderPlayStandings(s: SeasonSession): string {
  const me = s.human!.tavern;
  const rows = seasonStandings(s.state);
  if (s.state.finalizedWeeks.size === 0) return '';
  const done = s.stage.kind === 'complete';
  const body = rows
    .map(
      (r) =>
        `<tr class="${r.tavern === me ? 'sel' : ''} ${done && r.rank === 1 ? 'champ' : ''}"><td class="n">${r.rank}</td><td><b>${esc(tavernName(r.tavern))}</b></td>` +
        `<td><span class="tag ${r.tavern === me ? 'brass' : ''}">${r.tavern === me ? 'you' : esc(botOf(r.tavern))}</span></td><td class="n">${r.points}</td></tr>`,
    )
    .join('');
  const champs = rows.filter((r) => r.rank === 1).map((r) => r.tavern);
  const mine = rows.find((r) => r.tavern === me);
  const banner = !done
    ? ''
    : mine?.rank === 1
      ? `<p><span class="chip ok"><span class="dot"></span>Champions!</span> ${esc(tavernName(me))} ${champs.length === 1 ? 'wins the season' : 'shares the title'}.</p>`
      : `<p>${champs.map((t) => esc(tavernName(t))).join(' and ')} ${champs.length === 1 ? 'wins' : 'share'} the season. You finish ${ordinal(mine?.rank ?? rows.length)}.</p>`;
  return (
    `<section class="card"><h2>${done ? 'Final standings' : 'Standings'}</h2>${banner}` +
    `<div class="scroll"><table><thead><tr><th class="n">#</th><th>tavern</th><th>manager</th><th class="n">loot</th></tr></thead><tbody>${body}</tbody></table></div>` +
    (done ? '<p class="hint">The season is loaded into the other tabs: Standings, Weeks, Draft board, Pool and Event log.</p>' : '') +
    `</section>`
  );
}

function playClick(action: string, id: string | undefined): boolean {
  switch (action) {
    case 'play-start':
      startPlay();
      return true;
    case 'play-reset':
      play.session = null;
      play.error = null;
      play.seed = '';
      renderTab();
      return true;
    case 'play-draft':
      if (id !== undefined) {
        playAct((s) => {
          s.draftPick(id);
          s.advanceDraft();
        });
      }
      return true;
    case 'play-lu-add':
      if (id !== undefined && play.picks.length < config.roster.starters && !play.picks.includes(id)) {
        play.picks.push(id);
        renderTab();
      }
      return true;
    case 'play-lu-remove':
      if (id !== undefined) {
        play.picks = play.picks.filter((p) => p !== id);
        renderTab();
      }
      return true;
    case 'play-lu-captain':
      if (id !== undefined) {
        play.captain = id;
        play.picks = [id, ...play.picks.filter((p) => p !== id)];
        renderTab();
      }
      return true;
    case 'play-lu-advice':
      playAct((s) => {
        const lineup = s.suggestLineup();
        if (lineup === null) throw new Error('The advisor finds no legal lineup on this roster.');
        play.picks = [lineup.captain, ...lineup.allies];
        play.captain = lineup.captain;
      });
      return true;
    case 'play-lu-submit':
      playAct((s) => {
        const lineup = builderLineup();
        if (lineup !== null) s.setLineup(lineup);
      });
      return true;
    case 'play-claim':
      playAct((s) => {
        s.claimWaiver(play.add, play.drop === '' ? null : play.drop);
        play.add = '';
        play.drop = '';
      });
      return true;
    case 'play-claim-advice':
      playAct((s) => {
        for (const { add, drop } of s.suggestClaims()) s.claimWaiver(add, drop);
      });
      return true;
    case 'play-week':
      playAct((s) => {
        const stage = s.stage;
        if (stage.kind !== 'week') return;
        s.playWeek();
        play.played = stage.week;
      });
      return true;
  }
  return false;
}

// ── events wiring ──────────────────────────────────────────────────────────

panel.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (target === null) return;
  const { action, id, tavern } = target.dataset;
  if (action !== undefined && playClick(action, id)) return;
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
        if (lab.picks.length === 1) lab.captain = id;
        lab.roll = null;
        lab.sample = null;
        refreshLab();
      }
      break;
    case 'lab-remove':
      if (id !== undefined) {
        lab.picks = lab.picks.filter((p) => p !== id);
        if (lab.captain === id) lab.captain = lab.picks[0] ?? null;
        lab.roll = null;
        lab.sample = null;
        refreshLab();
      }
      break;
    case 'lab-captain':
      if (id !== undefined) {
        lab.captain = id;
        lab.roll = null;
        lab.sample = null;
        refreshLab({ party: true, analysis: true });
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
      lab.captain = null;
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
    case 'play-tavern':
      play.tavern = target.value;
      break;
    case 'play-add':
      play.add = target.value;
      renderTab();
      break;
    case 'play-drop':
      play.drop = target.value;
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
    case 'play-seed':
      play.seed = target.value;
      break;
    case 'play-filter': {
      play.filter = target.value;
      const at = target.selectionStart;
      renderTab();
      const box = document.getElementById('play-filter') as HTMLInputElement | null;
      box?.focus();
      if (at !== null) box?.setSelectionRange(at, at);
      break;
    }
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

$('tabs').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (b?.dataset.tab !== undefined && (TABS as ReadonlyArray<string>).includes(b.dataset.tab)) setTab(b.dataset.tab as Tab);
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

// Theme: auto → light → dark.
const THEMES = ['auto', 'light', 'dark'] as const;
function applyTheme(theme: (typeof THEMES)[number]): void {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('theme').textContent = `Theme: ${theme}`;
}
let theme: (typeof THEMES)[number] = (THEMES as ReadonlyArray<string>).includes(storageGet('lot-playground-theme') ?? '')
  ? (storageGet('lot-playground-theme') as (typeof THEMES)[number])
  : 'auto';
applyTheme(theme);
$('theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
  storageSet('lot-playground-theme', theme);
  applyTheme(theme);
});

// ── boot ───────────────────────────────────────────────────────────────────

$('subtitle').innerHTML =
  `Playground · <b>${esc(config.id)}</b> · ${config.weeks} weeks · ${input.taverns.length} bot taverns · ${poolIds.length} pooled · ` +
  `B = CR ${formatCr(BUDGET)} · engine ${esc(input.engineVersion)} · ${esc(input.battleModel.id)}`;
const savedTab = storageGet('lot-playground-tab');
if (savedTab !== null && (TABS as ReadonlyArray<string>).includes(savedTab)) {
  tab = savedTab as Tab;
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
}
requestAnimationFrame(() => setTimeout(() => doRun(($('seed') as HTMLInputElement).value.trim() || 'sim-1'), 0));
