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
  ABILITIES,
  battleOdds,
  checkOdds,
  evTtkBreakdown,
  freeAgents,
  hexOn,
  homeTavern,
  injuredFor,
  lineHash,
  projectMission,
  projectedPoints,
  rngFor,
  runMission,
  runPoints,
  seasonStandings,
  waiverPriority,
  standings,
  weekResults,
  weekSeed,
  validateLineup,
} from '@league-of-taverns/engine';
import type {
  Ability,
  CrEighths,
  EvTtkBreakdown,
  LeagueEvent,
  Lineup,
  Mission,
  NodeRecord,
  Party,
  Projection,
  RetreatOrder,
  RunResult,
} from '@league-of-taverns/engine';
import { SeasonSession, aggregate, runMockSeason, runSeed, type MockSeasonResult, type RunSummary } from '../season-runner';
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
import type { Banner } from '@league-of-taverns/scripts/lib/god-schema';
import { seasonInputFromData, type PlaygroundChrome, type PlaygroundData } from './data';
import { clockBack, crownChampion, hailChampion, layCurse, nodMeter, raiseBanner, revealWeek, slideStandings, turnCard, weekMoment } from './fx';
import {
  actorLabel,
  aggregateRows,
  artCss,
  bannerCss,
  bannerGods,
  checkLabel,
  draftBoard,
  eventSummary,
  formatCr,
  formatCrTotal,
  formatModifier,
  layoutMission,
  parseRetreat,
  partyFrom,
  pct,
  retreatChoices,
  retreatLabel,
  retreatValue,
  rostersAtLock,
  sampleMission,
  sameScore,
  scoreFraction,
  scoreHistogram,
  seedWords,
  signed,
  bestWeek,
  tableMoves,
  taleSteps,
  weekOutcome,
  topSkills,
  waiverReasonLabel,
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
/** A character's display name (chrome, carried by the build for the page only), else its id. */
const tavernById = new Map(input.taverns.map((t) => [t.id, t]));
const tavernName = (id: string): string => tavernById.get(id)?.name ?? id;
const botOf = (id: string): string => run?.result.summary.taverns.find((t) => t.tavern === id)?.bot ?? '?';
const managerBot = (id: string): string => input.managers.find((m) => m.id === id)?.bot ?? '?';
const layouts = new Map<number, GraphLayout>(WEEKS.map((w) => [w, layoutMission(missionOf(w))]));

// Banners: each tavern fights under its god's colours (chrome from gods/<id>/god.yaml). One generated rule per god sets
// its colours as custom properties; page.html § Banners does the rest.
const godOf = new Map(input.sponsors.map((s) => [s.tavern, s.id]));
const BANNERED = bannerGods(data.gods);
const bannerStyle = document.createElement('style');
bannerStyle.textContent = bannerCss(data.gods);
document.head.append(bannerStyle);
// Card art: each character's face crop and thumbnail as custom properties, once, out of the card markup.
const artStyle = document.createElement('style');
artStyle.textContent = artCss(data.chrome);
document.head.append(artStyle);
/** The god whose banner a tavern fights under, if its god has one. */
const bannerOf = (tavern: string): string | null => {
  const god = godOf.get(tavern);
  return god !== undefined && BANNERED.has(god) ? god : null;
};
/** ` data-banner="<god>"` for a tavern with a banner, else nothing. */
const bannerAttr = (tavern: string): string => {
  const god = bannerOf(tavern);
  return god === null ? '' : ` data-banner="${esc(god)}"`;
};
/** A god's display name (chrome), else its id. */
const godName = (god: string): string => data.gods[god]?.name ?? god;

function missionOf(week: number): Mission {
  const m = input.missions.get(week);
  if (m === undefined) throw new Error(`no mission for week ${week}`);
  return m.mission;
}
function environmentOf(week: number): string {
  return input.schedule.find((s) => s.week === week)?.environment ?? '';
}

/** The week's public keywords (D-42) as a line, or nothing when the GM listed none. */
function keywordsLine(week: number): string {
  const keywords = input.schedule.find((s) => s.week === week)?.keywords ?? [];
  return keywords.length === 0 ? '' : `<p class="small"><span class="label">Tests</span> ${keywords.map((k) => `<span class="tag">${esc(k)}</span>`).join(' ')}</p>`;
}

// ── page state ─────────────────────────────────────────────────────────────

type Tab = 'play' | 'standings' | 'reports' | 'weeks' | 'lab' | 'draft' | 'pool' | 'events' | 'batch';
const TABS: ReadonlyArray<Tab> = ['play', 'standings', 'reports', 'weeks', 'lab', 'draft', 'pool', 'events', 'batch'];

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
function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
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


// ── character chrome ───────────────────────────────────────────────────────

const chromeOf = (id: string): PlaygroundChrome | undefined => data.chrome[id];
/** The chrome name, or the id when the season has no chrome for the character. */
const charName = (id: string): string => chromeOf(id)?.name ?? id;

/** Name in bold, then the epithet, muted. */
function charTitle(id: string): string {
  const epithet = chromeOf(id)?.epithet;
  return `<b>${esc(charName(id))}</b>${epithet === undefined ? '' : ` <span class="muted">${esc(epithet)}</span>`}`;
}

/** The portrait in a square frame (sm 28 px, md 44, lg 80), feet on the frame's floor; the name's initial when there is none. */
function portrait(id: string, size: 'sm' | 'md' | 'lg'): string {
  const src = chromeOf(id)?.portrait;
  return src === undefined
    ? `<span class="pt ${size} none" aria-hidden="true">${esc(charName(id).charAt(0).toUpperCase())}</span>`
    : `<img class="pt ${size}" src="${esc(src)}" alt="" title="${esc(charName(id))}">`;
}

/** Portrait, name and base on one line, for lists. */
function charLabel(id: string): string {
  const s = input.statsOf(id);
  return `<span class="face">${portrait(id, 'sm')}<span>${charTitle(id)} <span class="muted small">${esc(s.base.typeName)} · CR ${formatCr(crOf(id))}</span></span></span>`;
}

/** Portrait and name, compact, for inline mentions. */
function charChip(id: string): string {
  return `<span class="face">${portrait(id, 'sm')}<span>${esc(charName(id))}</span></span>`;
}

/** Several characters as chips that wrap. */
function charList(ids: ReadonlyArray<string>): string {
  return `<span class="faces">${ids.map(charChip).join('')}</span>`;
}

/** A draft board cell's contents: pick number, portrait and name. */
function draftPick(pick: number, id: string): string {
  return `<span class="face">${portrait(id, 'sm')}<span><span class="pk">#${pick + 1}</span> <span class="ch">${esc(charName(id))}</span></span></span>`;
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
      return `<path class="edge${on}" data-edge="${esc(`${e.from}>${e.to}`)}" d="${e.d}"/>`;
    })
    .join('');
  const labels = layout.edges
    .filter((e) => e.on !== 'always')
    .map((e) => {
      const on = pathEdges.has(`${e.from}>${e.to}`) ? ' on' : '';
      return `<text class="elabel${on}" data-edge="${esc(`${e.from}>${e.to}`)}" x="${e.lx}" y="${e.ly + 3}" text-anchor="middle">${esc(e.on)}</text>`;
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
        `<g class="node ${cls}" data-node="${esc(n.id)}"><title>${esc(n.id)}: ${esc(n.detail)}${reach === undefined ? '' : ` (reach ${pct(reach)})`}</title>` +
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
    // Fit the card's width, shrinking to at most 80% before the frame scrolls, so the end nodes usually stay in view.
    `<div class="graph"><svg width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" style="width:100%;max-width:${layout.width}px;min-width:${Math.round(0.8 * layout.width)}px" role="img" aria-label="Mission graph">` +
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

function rollLog(mission: Mission, run: RunResult, home = false): string {
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
        `<tr><td class="n">${i + 1}</td><td>${esc(r.node)}<div class="muted small">${esc(what)}</div></td><td>${charChip(r.actor)}</td>` +
        `<td><span class="die ${r.d20 === 20 ? 'hi' : r.d20 === 1 ? 'lo' : ''}">${r.d20}</span>${r.advantage ? ' <span class="tag brass">adv</span>' : ''}${r.disadvantage ? ' <span class="tag bad" title="Hexed: the lower of two d20s">dis</span>' : ''}</td>` +
        `<td class="sum">${signed(r.modifier)} = <b>${total}</b> ${meets ? '≥' : '<'} DC ${r.dc}</td>` +
        `<td class="${r.outcome}">${r.outcome}${gated ? ' <span class="tag bad">gate</span>' : ''}</td></tr>`
      );
    }
    const what = node?.kind === 'battle' ? node.encounter.creatures.map((c) => `${c.count}× ${c.ref}`).join(', ') : '';
    const won = r.roll < r.pWin;
    const bounty = node?.kind === 'battle' && won && (node.loot ?? 0) > 0 ? ` <span class="tag brass">+${node.loot} loot</span>` : '';
    return (
      `<tr><td class="n">${i + 1}</td><td>${esc(r.node)}<div class="muted small">${esc(what)}</div></td><td class="muted">party</td>` +
      `<td><span class="die">${r.roll.toFixed(3)}</span></td>` +
      `<td class="sum">roll ${won ? '<' : '≥'} win chance ${r.pWin.toFixed(3)}</td><td class="${r.outcome === 'win' ? 'pass' : 'fail'}">${r.outcome}${bounty}</td></tr>`
    );
  });
  if (run.injury !== null) {
    rows.push(
      `<tr><td class="n">${rows.length + 1}</td><td>injury</td><td>${esc(charName(run.injury.character))}</td><td><span class="die">${run.injury.roll.toFixed(3)}</span></td>` +
        `<td class="sum">the roll picks one of the four starters</td><td class="fail">hurt: sits out next week</td></tr>`,
    );
  }
  if (run.retreatedBefore !== null) {
    rows.push(
      `<tr><td class="n">${rows.length + 1}</td><td>${esc(run.retreatedBefore)}</td><td class="muted">party</td><td></td>` +
        `<td class="sum">the retreat order says turn back with ${run.loot} loot banked</td><td class="muted">turned back</td></tr>`,
    );
  }
  const checks = `${run.checksPassed} of ${run.checksAttempted} checks passed`;
  const score = run.dnf
    ? `DNF after ${checks}: everything banked is lost, score ${scoreFraction(run.score)}`
    : run.retreatedBefore !== null
      ? `Turned back before ${run.retreatedBefore} after ${checks}, keeping ${run.loot} loot: score ${scoreFraction(run.score)}`
      : `${checks}: score ${scoreFraction(run.score)}`;
  return (
    `<div class="scroll"><table><thead><tr><th class="n">#</th><th>node</th><th>actor</th><th>die</th><th>sum</th><th>outcome</th></tr></thead>` +
    `<tbody>${rows.join('') || '<tr><td colspan="6" class="muted">No checks or battles.</td></tr>'}</tbody></table></div>` +
    `<p class="small"><b>${esc(score)}</b> → ${num(Math.round(run.score * SCALE))} points` +
    (home ? ` × ${config.scoring.homeBonus} home bonus = <b>${num(runPoints(run.score, config.scoring, true))}</b> points` : '') +
    `</p>` +
    `<p class="hint">Checks pass when d20 + modifier ≥ DC (no natural-20 rule; with advantage the higher of two d20s is shown). Battles are won when the roll is below the party's win chance, and a win banks the battle's bounty. Just before a battle, the retreat order may turn the party back with what it has: not a DNF.</p>`
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

function setTab(next: Tab, focus = false): void {
  tab = next;
  storageSet('lot-playground-tab', next);
  markTabs(focus);
  renderTab();
}

/** Selected state, roving tabindex and the panel's label follow `tab`; the bot run's bar hides on the Play tab, where your own season is the one that counts. */
function markTabs(focus = false): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#tabs button')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  panel.setAttribute('aria-labelledby', `tab-${tab}`);
  $('runbar').hidden = tab === 'play';
  $('run-error').classList.toggle('off-tab', tab === 'play');
}

/** A moment (fx.ts) to play once the next render is on screen; set by the move that earns it. */
let pendingFx: (() => void) | null = null;

function renderTab(): void {
  const fx = pendingFx;
  pendingFx = null;
  if (tab === 'play') {
    panel.innerHTML = renderPlay();
    fx?.();
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

/**
 * Each tavern's series colour: its god's banner mark, lightened in the dark theme as banner lines are, so a tavern is
 * the same colour in every table and chart. A tavern without a banner falls back to `--s1`…`--s8` by package order.
 * Never follows rank.
 */
function seriesVar(tavern: string): string {
  const god = bannerOf(tavern);
  if (god !== null) return `oklch(from var(--mark-${god}) clamp(var(--bn-line-lo), l, 1) c h)`;
  const i = input.taverns.findIndex((t) => t.id === tavern);
  return `var(--s${(i < 0 ? 0 : i % 8) + 1})`;
}

function swatch(tavern: string): string {
  return `<i class="swatch" style="background:${seriesVar(tavern)}"></i>`;
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

/** Lineup violations in words; the engine's code stays as a tooltip. */
function violationList(violations: ReadonlyArray<{ readonly code: string; readonly message: string }>): string {
  return `<ul class="violations">${violations.map((v) => `<li title="${esc(v.code)}">${esc(v.message)}</li>`).join('')}</ul>`;
}

function crMeter(total: number): string {
  const over = total > BUDGET;
  return `<div class="meter ${over ? 'over' : ''}" title="CR ${formatCrTotal(total)} of ${formatCrTotal(BUDGET)}"><div style="width:${Math.min(100, (100 * total) / BUDGET).toFixed(1)}%"></div></div>`;
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

/**
 * Expected points, chance of DNF and chance of turning back for every retreat
 * order on offer, the current one marked: the projection informs the choice
 * without making it (D-49).
 */
function retreatTable(party: Party, mission: Mission, current: RetreatOrder, home: boolean): string {
  const rows = retreatChoices(config.missions.haul).map((order) => {
    const p = projectMission(party, mission, input.baseOf, input.battleModel, { retreat: order });
    const on = retreatValue(order) === retreatValue(current);
    return (
      `<tr class="${on ? 'sel' : ''}"><td>${esc(retreatLabel(order))}${on ? ' <span class="tag">yours</span>' : ''}</td>` +
      `<td class="n">${projectedPoints(p.expectedScore, config.scoring, home).toFixed(1)}</td><td class="n">${pct(p.pDnf)}</td><td class="n">${pct(p.pRetreat)}</td></tr>`
    );
  });
  return (
    `<details><summary>Expected points by retreat order</summary><div class="scroll"><table class="small"><thead><tr><th>retreat order</th><th class="n">exp. pts</th><th class="n">DNF</th><th class="n">turn back</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` +
    `<p class="hint">The highest expected points is not always the right call: a tavern that is behind may need the big fight.</p></details>`
  );
}

/** A `<select>` of retreat orders (D-49). */
function retreatSelect(id: string, action: string, retreat: RetreatOrder): string {
  const current = retreatValue(retreat);
  const options = retreatChoices(config.missions.haul)
    .map((r) => `<option value="${esc(retreatValue(r))}" ${retreatValue(r) === current ? 'selected' : ''}>${esc(retreatLabel(r))}</option>`)
    .join('');
  return `<label class="label" for="${id}">Retreat order</label><select id="${id}" data-action="${action}" title="Checked just before each battle: turn back with the loot banked instead of fighting. Turning back is not a DNF.">${options}</select>`;
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

// ── play vs bots ───────────────────────────────────────────────────────────

/** One of the person's moves. A season is its seed, its tavern and these, replayed in order, so it can be saved and restored. */
type PlayMove =
  | { readonly t: 'tavern'; readonly id: string }
  | { readonly t: 'draft'; readonly id: string }
  | { readonly t: 'lineup'; readonly starters: ReadonlyArray<string>; readonly retreat: RetreatOrder }
  | { readonly t: 'claim'; readonly add: string; readonly drop: string | null }
  | { readonly t: 'hex'; readonly target: string; readonly ability: Ability; readonly week: number }
  | { readonly t: 'week' };

interface SavedPlay {
  readonly v: 1;
  /** The season package and engine the moves were made against; anything else would replay differently. */
  readonly fingerprint: string;
  readonly manager: string;
  readonly seed: string;
  readonly moves: ReadonlyArray<PlayMove>;
}

const PLAY_KEY = 'lot-playground-play';
const PLAY_FINGERPRINT = `${data.version}:${config.id}:${data.configSha256}:${input.engineVersion}:${[...input.missions.values()].map((m) => m.sha256).join(',')}`;

const play = {
  session: null as SeasonSession | null,
  /** The manager seat the person takes; its bot stays on as the advisor. */
  manager: input.managers[0]?.id ?? '',
  seed: '',
  error: null as string | null,
  /** A note about the saved season (restored, or could not be). */
  notice: null as string | null,
  /** The moves so far, saved after each one. */
  moves: [] as PlayMove[],
  /** True while "New season" waits for a second, confirming click. */
  confirmReset: false,
  /** The hex form is asking "are you sure?" (a hex is public and final). */
  confirmHex: false,
  draftSort: 'value' as 'value' | 'cr',
  /** Free agents as character cards or the dense table; remembered in this browser. */
  faView: (storageGet('lot-playground-fa-view') === 'table' ? 'table' : 'cards') as 'cards' | 'table',
  filter: '',
  /** The lineup builder: starters in lineup order, and the retreat order. */
  picks: [] as string[],
  retreat: 'never' as RetreatOrder,
  /** The week the builder was loaded for. */
  builderWeek: 0,
  add: '',
  drop: '',
  /** The hex form (D-52). */
  hexTarget: '',
  hexAbility: 'wis' as Ability,
  hexWeek: 1,
  /** The week just played, to show its result. */
  played: null as number | null,
};

function newSession(manager: string, seed: string): SeasonSession {
  const session = new SeasonSession(input, { seed, human: { manager, login: 'you', githubId: 1 } });
  session.advanceDraft();
  return session;
}

function startPlay(): void {
  const seed = play.seed.trim() || seedWords(cryptoRand);
  play.error = null;
  play.notice = null;
  try {
    const session = newSession(play.manager, seed);
    Object.assign(play, { session, seed, moves: [], filter: '', picks: [], retreat: 'never', builderWeek: 0, add: '', drop: '', played: null, confirmReset: false, confirmHex: false });
    savePlay();
  } catch (e) {
    play.error = e instanceof Error ? e.message : String(e);
  }
  renderTab();
}

function applyMove(s: SeasonSession, m: PlayMove): void {
  switch (m.t) {
    case 'tavern':
      s.chooseTavern(m.id);
      s.advanceDraft();
      break;
    case 'draft':
      s.draftPick(m.id);
      s.advanceDraft();
      break;
    case 'lineup': {
      // Seasons saved before D-12 recorded a captain and three allies, with no retreat order.
      const old = m as unknown as { readonly captain?: string; readonly allies?: ReadonlyArray<string> };
      const starters = old.captain !== undefined ? [old.captain, ...(old.allies ?? [])] : m.starters;
      s.setLineup({ starters, retreat: m.retreat ?? 'never' } as unknown as Lineup);
      break;
    }
    case 'hex':
      s.declareHex(m.target, m.ability, m.week);
      break;
    case 'claim':
      s.claimWaiver(m.add, m.drop);
      break;
    case 'week':
      s.playWeek();
      break;
  }
}

function savePlay(): void {
  const s = play.session;
  if (s === null) return;
  const saved: SavedPlay = { v: 1, fingerprint: PLAY_FINGERPRINT, manager: s.human!.manager, seed: s.seed, moves: play.moves };
  storageSet(PLAY_KEY, JSON.stringify(saved));
}

/** Rebuild a saved season by replaying its moves, so a reload or a closed tab loses nothing. */
function restorePlay(): void {
  const raw = storageGet(PLAY_KEY);
  if (raw === null) return;
  try {
    const saved = JSON.parse(raw) as SavedPlay;
    if (saved.v !== 1 || saved.fingerprint !== PLAY_FINGERPRINT) throw new Error('it was played against another version of the season or engine');
    const session = newSession(saved.manager, saved.seed);
    for (const m of saved.moves) applyMove(session, m);
    const weeks = saved.moves.filter((m) => m.t === 'week').length;
    Object.assign(play, { session, manager: saved.manager, seed: saved.seed, moves: [...saved.moves], played: weeks === 0 ? null : weeks });
    play.notice = session.stage.kind === 'complete' ? null : 'Picked up your season where you left it.';
  } catch (e) {
    storageRemove(PLAY_KEY);
    play.notice = `Your saved season could not be restored: ${e instanceof Error ? e.message : String(e)}.`;
  }
}

/** Make moves against the session, keeping each one that the engine accepts; a refusal shows as an error and stops there. */
function playMoves(moves: ReadonlyArray<PlayMove>, after?: () => void): void {
  playAct((s) => {
    for (const m of moves) {
      applyMove(s, m);
      play.moves.push(m);
    }
    after?.();
  });
}

/** Run a step against the session; an engine refusal shows as an error and changes nothing. */
function playAct(move: (s: SeasonSession) => void): void {
  const s = play.session;
  if (s === null) return;
  play.error = null;
  play.notice = null;
  try {
    move(s);
  } catch (e) {
    play.error = e instanceof Error ? e.message : String(e);
  }
  savePlay();
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
  return s.state.taverns.get(s.humanTavern!)?.roster ?? [];
}

/** Point the builder at the next week: the submitted lineup, else last week's, else the advisor's. Drops anyone no longer on the roster. */
function syncBuilder(s: SeasonSession, week: number): void {
  const roster = new Set(myRoster(s));
  if (play.builderWeek !== week) {
    play.builderWeek = week;
    const me = s.humanTavern!;
    const lineup = s.pendingLineup() ?? s.state.lockedLineups.get(week - 1)?.find((l) => l.tavern === me)?.lineup ?? s.suggestLineup();
    play.picks = lineup === null ? [] : [...lineup.starters];
    play.retreat = lineup?.retreat ?? 'never';
  }
  const hurt = injuredFor(s.state, week);
  play.picks = play.picks.filter((id) => roster.has(id) && !hurt.has(id));
  if (!roster.has(play.drop)) play.drop = '';
  if (!freeAgents(s.state).includes(play.add)) play.add = '';
}

function builderLineup(): Lineup | null {
  if (play.picks.length === 0) return null;
  return { starters: play.picks, retreat: play.retreat } as unknown as Lineup;
}

function charRow(id: string, action: string, extra = ''): string {
  const s = input.statsOf(id);
  const moves = Object.entries(s.speeds)
    .filter(([k]) => k !== 'walk')
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return (
    `<tr><td>${action}</td><td class="pt-cell">${portrait(id, 'md')}</td><td>${charTitle(id)}<div class="muted small">${esc(s.base.typeName)}</div></td><td class="n">${formatCr(crOf(id))}</td>` +
    `<td class="small skills">${topSkills(s)
      .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
      .join(', ')}</td><td class="small muted">${esc(moves || '-')}</td><td class="n small">${s.base.ac} / ${s.base.hp}</td>${extra}</tr>`
  );
}
const CHAR_HEAD = '<th></th><th></th><th>character</th><th class="n">CR</th><th>best skills</th><th>moves</th><th class="n">AC / HP</th>';

/** A head-and-shoulders outline: the card's art until the character has a portrait. */
const SILHOUETTE =
  '<svg class="silhouette" viewBox="0 0 100 80" aria-hidden="true"><circle cx="50" cy="30" r="17"/><path d="M14 80c2-20 17-30 36-30s34 10 36 30z"/></svg>';

/**
 * A character card: name, epithet and CR across the top, the art (the portrait's face crop over a blurred copy of the
 * portrait, or a silhouette for a character without one), the monster
 * line with its size in words ("Ape · Medium beast"), AC, HP and speed, and the best skills. Neutral until a tavern
 * owns the character; then it wears that tavern's banner. `foot` is the card's action or note.
 */
function charCard(id: string, { owner = null, foot = '', advised = false }: { owner?: string | null; foot?: string; advised?: boolean } = {}): string {
  const st = input.statsOf(id);
  const themed = owner !== null && bannerOf(owner) !== null;
  const speeds = Object.entries(st.speeds).filter(([k]) => k !== 'walk');
  const speed = speeds.length > 0 ? speeds.map(([k, v]) => `${k} ${v}`).join(' · ') : `walk ${st.speeds.walk ?? 0}`;
  const size = st.base.size.charAt(0).toUpperCase() + st.base.size.slice(1);
  const epithet = chromeOf(id)?.epithet;
  const face = chromeOf(id)?.face !== undefined;
  return (
    `<article class="lcard ${themed ? 'themed' : 'neutral'}${advised ? ' advised' : ''}" data-card="${esc(id)}"${themed ? bannerAttr(owner) : ''}>` +
    `<header><div class="who"><b>${esc(charName(id))}</b>${epithet === undefined ? '' : `<span>${esc(epithet)}</span>`}</div><span class="cr" title="Challenge rating">${formatCr(crOf(id))}</span></header>` +
    (face
      ? `<div class="art has-face" data-art="${esc(id)}"><span class="face" role="img" aria-label="${esc(charName(id))}"></span></div>`
      : `<div class="art">${SILHOUETTE}</div>`) +
    `<div class="typeline"><b>${esc(st.base.typeName)}</b><span class="sizeword">${esc(size)} ${esc(st.base.creatureType)}</span></div>` +
    `<div class="stats"><span>AC <b>${st.base.ac}</b></span><span>HP <b>${st.base.hp}</b></span><span>${esc(speed)}</span></div>` +
    `<div class="skills">${topSkills(st, 2)
      .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
      .join(' · ')}</div>` +
    (foot === '' ? '' : `<div class="card-foot">${foot}</div>`) +
    `</article>`
  );
}

function matchesFilter(id: string, q: string): boolean {
  if (q === '') return true;
  const s = input.statsOf(id);
  const c = chromeOf(id);
  const named = c !== undefined && `${c.name} ${c.epithet ?? ''}`.toLowerCase().includes(q);
  return named || id.includes(q) || s.base.slug.includes(q) || s.base.typeName.toLowerCase().includes(q) || topSkills(s).some((t) => t.skill.includes(q));
}

function renderPlay(): string {
  const s = play.session;
  const err =
    (play.error === null ? '' : `<div class="error">${esc(play.error)}</div>`) +
    (play.notice === null ? '' : `<p class="hint" role="status">${esc(play.notice)}</p>`);
  if (s === null) return err + renderPlaySetup();
  const stage = s.stage;
  if (stage.kind === 'tavern') return playHeader(s) + err + renderPlayTavernPick(s);
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
  const options = input.managers.map((m) => `<option value="${esc(m.id)}" ${m.id === play.manager ? 'selected' : ''}>${esc(m.id)} (advisor: ${esc(m.bot)})</option>`).join('');
  return (
    `<section class="card"><h2>Play vs bots</h2>` +
    `<p>Manage one tavern yourself against ${input.managers.length - 1} bots. Before the draft, everyone chooses a tavern in reverse draft order. Then draft when you are on the clock, and before each week set a lineup and make waiver claims, and play the week. ` +
    `Every move goes through the engine's reducers, so an illegal one is refused with the engine's reason.</p>` +
    `<div class="row"><label class="label" for="play-tavern">Your seat</label><select id="play-tavern" data-action="play-tavern">${options}</select>` +
    `<label class="label" for="play-seed">Seed</label><input type="text" id="play-seed" data-action="play-seed" placeholder="random" value="${esc(play.seed)}" spellcheck="false" autocomplete="off">` +
    `<button type="button" class="primary" data-action="play-start">Start season</button></div>` +
    `<p class="hint">Your seat's bot stays on as your advisor and can suggest a pick, a lineup or waiver claims. The seed drives the draft order, the bots and the dice, so the same seed and the same moves give the same season. ` +
    `Your season is saved in this browser as you play, and when it ends it loads into the other tabs.</p></section>`
  );
}

function playHeader(s: SeasonSession): string {
  const me = s.humanTavern;
  const stage = s.stage;
  const total = config.draft.rounds * s.state.managers.size;
  const where =
    stage.kind === 'tavern'
      ? `Tavern pick, ${s.state.taverns.size + 1} of ${s.state.managers.size}`
      : stage.kind === 'draft'
        ? `Draft, pick ${stage.pick + 1} of ${total}`
        : stage.kind === 'week'
          ? `Week ${stage.week} of ${config.weeks}`
          : 'Season complete';
  const rows = seasonStandings(s.state);
  const row = rows.find((r) => r.tavern === me);
  const rec = row === undefined || s.state.finalizedWeeks.size === 0 ? '' : `<span class="chip" data-spoiler>${ordinal(row.rank)} of ${rows.length} · ${row.points} loot</span>`;
  // Abandoning a season takes a second click: one stray press must not throw away a draft and weeks of results.
  const reset = play.confirmReset
    ? `<span class="small" role="alert">Abandon this season? Your draft and results will be lost.</span>` +
      `<button type="button" class="small" data-action="play-reset-confirm">Abandon season</button><button type="button" class="primary small" data-action="play-reset-cancel">Keep playing</button>`
    : `<button type="button" data-action="play-reset">New season</button>`;
  // Once you hold a tavern, the card flies its god's banner and carries the god's call.
  const god = me === null ? null : bannerOf(me);
  const chrome = god === null ? undefined : data.gods[god];
  const call =
    chrome === undefined
      ? ''
      : `<p class="banner-call"><span class="label">${esc(chrome.name)}</span> ${esc(chrome.call ?? `You fight under the banner of ${chrome.name}.`)}</p>`;
  return (
    `<section class="card${chrome === undefined ? '' : ' banner-card'}"${me === null ? '' : bannerAttr(me)}>${chrome === undefined ? '' : '<div class="pennant" aria-hidden="true"></div>'}` +
    `<div class="row" style="justify-content:space-between"><div class="row"><h2>${chrome === undefined ? '' : '<i class="flag" aria-hidden="true"></i> '}${me === null ? 'No tavern yet' : esc(tavernName(me))}</h2><span class="tag ${chrome === undefined ? 'brass' : 'banner'}">you</span>` +
    `<span class="muted small">${esc(where)} · seed ${esc(s.seed)}</span></div><div class="row">${rec}${reset}</div></div>${call}</section>`
  );
}

/** The tavern-pick moment: your banner goes up over the Play header. */
function raiseMyBanner(): void {
  const me = play.session?.humanTavern;
  const god = me === undefined || me === null ? null : bannerOf(me);
  if (god !== null) raiseBanner(panel.querySelector<HTMLElement>('.banner-card'), data.gods[god]!.banner);
}

function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${tail}`;
}

/** The tavern pick (D-52): every tavern is already blessed by its god; you choose a tavern, not a god. */
function renderPlayTavernPick(s: SeasonSession): string {
  const open = new Set(s.openTaverns());
  const advice = s.suggestTavern();
  const weekOf = (tavern: string): number | null => {
    const god = s.state.sponsors.find((sp) => sp.tavern === tavern)?.id;
    return s.state.schedule.find((w) => w.sponsor === god)?.week ?? null;
  };
  const rows = input.taverns
    .map((t) => {
      const owner = s.state.taverns.get(t.id)?.managerId;
      const god = s.state.sponsors.find((sp) => sp.tavern === t.id)?.id;
      const week = weekOf(t.id);
      const action = open.has(t.id)
        ? `<button type="button" class="${t.id === advice ? 'primary ' : ''}small" data-action="play-tavern-pick" data-id="${esc(t.id)}">Choose</button>`
        : `<span class="muted small">${esc(owner ?? '')}</span>`;
      const banner = bannerOf(t.id);
      const flag = banner === null ? '' : `<i class="flag" aria-hidden="true"></i> `;
      return (
        `<tr class="${open.has(t.id) ? '' : 'muted'}"${bannerAttr(t.id)}><td>${action}</td><td>${flag}<b>${esc(t.name)}</b></td>` +
        `<td class="small"><span class="${banner === null ? '' : 'god-name'}">${god === undefined ? '—' : esc(godName(god))}</span></td><td class="n small">${week ?? '—'}</td></tr>`
      );
    })
    .join('');
  const order = [...s.state.draft.managerOrder];
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Choose your tavern</h2><span class="muted small">reverse draft order: whoever drafts last chooses first</span></div>` +
    `<p class="small">Every tavern is already blessed by one god, who sets one week's mission, and fights under that god's banner. Boons and hexes come later (D-52); for now the taverns differ only in their god's week.</p>` +
    `<div class="scroll"><table><thead><tr><th></th><th>tavern</th><th>god</th><th class="n">god's week</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    (order.length === 0 ? '' : `<p class="hint">Draft order: ${order.map((m) => esc(m === s.human?.manager ? 'you' : m)).join(' → ')}.</p>`) +
    `</section>`
  );
}

function renderPlayDraft(s: SeasonSession, pick: number): string {
  const me = s.humanTavern!;
  const n = s.state.managers.size;
  const picks = s.events.flatMap((e) => (e.type === 'draft.pick' ? [e.payload] : []));
  const mine = myRoster(s);
  const since = picks.slice(picks.map((p) => p.tavern).lastIndexOf(me) + 1);
  const advice = s.suggestPick();
  const q = play.filter.trim().toLowerCase();
  const available = freeAgents(s.state);
  const values = s.draftValues(available);
  const shown = available
    .filter((id) => matchesFilter(id, q))
    .sort((a, b) => (play.draftSort === 'value' ? values.get(b)! - values.get(a)! : crOf(b) - crOf(a)) || charName(a).localeCompare(charName(b)));
  const draftButton = (id: string): string =>
    `<button type="button" class="${id === advice ? 'primary ' : ''}small" data-action="play-draft" data-id="${esc(id)}">Draft</button>`;
  const rows = shown
    .map((id) => {
      const advised = id === advice;
      const extra = `<td class="n small">${values.get(id)!.toFixed(2)}</td><td>${advised ? '<span class="tag brass">advisor</span>' : ''}</td>`;
      return charRow(id, draftButton(id), extra).replace('<tr>', advised ? '<tr class="advised">' : '<tr>');
    })
    .join('');
  const cards = shown
    .map((id) =>
      charCard(id, {
        advised: id === advice,
        foot: `${draftButton(id)}<span class="small muted" title="The bots' rating">value ${values.get(id)!.toFixed(2)}</span>${id === advice ? '<span class="tag brass">advisor</span>' : ''}`,
      }),
    )
    .join('');
  const board = draftBoard(
    s.state.draft.order,
    picks.map((p) => ({ ...p, bot: p.tavern === me ? 'human' : botOf(p.tavern) })),
  );
  const boardRows = board
    .map(
      (row) =>
        `<tr class="${row.direction}"><td class="rd">R${row.round}</td>${row.cells
          .map((c) => (c === null ? '<td></td>' : `<td class="${c.tavern === me ? 'hot' : ''}">${draftPick(c.pick, c.character)}</td>`))
          .join('')}</tr>`,
    )
    .join('');
  return (
    `<section class="card" id="play-clock"><div class="row" style="justify-content:space-between"><h2>You are on the clock</h2><span class="muted small">pick #${pick + 1}, round ${Math.floor(pick / n) + 1} of ${config.draft.rounds}</span></div>` +
    (since.length === 0 ? '' : `<p class="small">Since your last pick: ${since.map((p) => `${esc(tavernName(p.tavern))} took <b>${esc(charName(p.character))}</b>`).join('; ')}.</p>`) +
    `<p class="small">Advisor (${esc(managerBot(s.human!.manager))}) suggests ${charChip(advice)} <span class="muted">CR ${formatCr(crOf(advice))}</span> ` +
    `<button type="button" class="primary small" data-action="play-draft" data-id="${esc(advice)}">Take it</button></p>` +
    `<div class="stack"><span class="label">Your roster (${mine.length} of ${config.roster.size})</span>` +
    (mine.length === 0 ? '<p class="muted small">Nobody yet.</p>' : `<div class="deck" id="play-roster">${mine.map((id) => charCard(id, { owner: me })).join('')}</div>`) +
    `<p class="hint">Each week you start ${config.roster.starters} with total CR at most ${formatCr(BUDGET)}.</p></div></section>` +
    `<section class="card"><div class="row"><h3>Free agents</h3><input type="text" id="play-filter" placeholder="Filter by name, base or skill" value="${esc(play.filter)}" data-action="play-filter">` +
    `<label class="label" for="play-sort">Sort</label><select id="play-sort" data-action="play-sort"><option value="value" ${play.draftSort === 'value' ? 'selected' : ''}>value, best first</option><option value="cr" ${play.draftSort === 'cr' ? 'selected' : ''}>CR, high first</option></select>` +
    `<label class="label" for="play-fa-view">Show</label><select id="play-fa-view" data-action="play-fa-view"><option value="cards" ${play.faView === 'cards' ? 'selected' : ''}>cards</option><option value="table" ${play.faView === 'table' ? 'selected' : ''}>table</option></select></div>` +
    (play.faView === 'cards'
      ? `<div id="play-fa" class="deck">${cards || '<p class="muted">No match.</p>'}</div>`
      : `<div id="play-fa" class="scroll"><table><thead><tr>${CHAR_HEAD}<th class="n" title="The bots' rating: battle strength plus skill breadth, per CR">value</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="9" class="muted">No match.</td></tr>'}</tbody></table></div>`) +
    `<p class="hint">Value is the bots' rating: battle strength plus skill breadth, per CR, with the cheapest picks rated as if they cost more, since unspent budget is worth nothing. Your advisor also weighs your roster so far.</p></section>` +
    `<section class="card"><h3>Draft board</h3><div class="scroll"><table class="draft"><thead><tr><th>round</th>${s.state.draft.order
      .map((t) => `<th class="${t === me ? 'hot' : ''}">${esc(tavernName(t))}</th>`)
      .join('')}</tr></thead><tbody>${boardRows || `<tr><td colspan="${n + 1}" class="muted">No picks yet.</td></tr>`}</tbody></table></div></section>`
  );
}

/** The advisor's pick as a card: portrait, name, base and tagline, and a button to take it. */
function renderPlayWeek(s: SeasonSession, week: number): string {
  const me = s.humanTavern!;
  const mission = missionOf(week);
  const roster = myRoster(s);
  const lineup = builderLineup();
  const hurt = injuredFor(s.state, week);
  const violations = lineup === null ? [] : validateLineup(lineup, { tavern: me, characters: roster }, crOf, config, { unavailable: hurt });
  const projection = lineup === null || play.picks.length === 0 ? null : projectMission(partyFrom(lineup.starters, input.statsOf, hexOn(s.state, me, week)), mission, input.baseOf, input.battleModel, { retreat: lineup.retreat });
  const home = homeTavern(s.state, week) === me;
  const total = play.picks.reduce((t, id) => t + crOf(id), 0);
  const legal = lineup !== null && violations.length === 0;
  // With no legal lineup on the roster at all, the week can still be played (and scores 0).
  const stuck = !legal && s.suggestLineup() === null;

  // Starters (in lineup order) and the bench as two labelled groups, so where someone sits never hangs on a button's label.
  const starters = play.picks.filter((id) => roster.includes(id));
  const bench = roster.filter((id) => !play.picks.includes(id));
  const full = play.picks.length >= config.roster.starters;
  const rosterRow = (id: string): string => {
    const on = play.picks.includes(id);
    const btn = on
      ? `<button type="button" class="small" data-action="play-lu-remove" data-id="${esc(id)}" aria-label="Move ${esc(charName(id))} to the bench">Bench</button>`
      : hurt.has(id)
        ? '<span class="tag bad" title="Hurt in last week\'s DNF: can\'t start this week (D-51)">injured</span>'
        : `<button type="button" class="small" data-action="play-lu-add" data-id="${esc(id)}" ${full ? 'disabled title="Bench a starter first"' : ''}>Start</button>`;
    const slot = on ? `<span class="small muted">${play.picks.indexOf(id) + 1}</span>` : '';
    return charRow(id, btn, `<td>${slot}</td>`).replace('<tr>', `<tr class="${on ? 'sel' : ''}">`);
  };
  const groupRow = (label: string): string => `<tr class="group"><td colspan="8">${label}</td></tr>`;
  const rosterRows =
    groupRow(`Starting · <b>${starters.length} of ${config.roster.starters}</b>`) +
    (starters.map(rosterRow).join('') || '<tr><td colspan="8" class="muted">Nobody yet: press Start on the bench below.</td></tr>') +
    groupRow(`Bench · <b>${bench.length}</b>`) +
    (bench.map(rosterRow).join('') || '<tr><td colspan="8" class="muted">Nobody on the bench.</td></tr>');

  const lineupCardHtml =
    `<section class="card" id="play-lineup"><div class="row" style="justify-content:space-between"><h2>Week ${week}: ${esc(mission.id)}</h2><span class="muted small">${esc(environmentOf(week))} · ${homeLine(s, week)}</span></div>` +
    keywordsLine(week) +
    `<div class="scroll"><table><thead><tr>${CHAR_HEAD}<th></th></tr></thead><tbody>${rosterRows}</tbody></table></div>` +
    `<p class="small">CR total ${num(formatCrTotal(total))} of ${num(formatCrTotal(BUDGET))}</p>${crMeter(total)}` +
    `<div class="row">${retreatSelect('play-retreat', 'play-retreat', play.retreat)}</div>` +
    (lineup === null ? '' : violations.length === 0 ? '<p class="okline">Legal lineup</p>' : violationList(violations)) +
    (projection === null
      ? ''
      : `<div class="kv"><div><span class="label">expected points</span><span class="v">${projectedPoints(projection.expectedScore, config.scoring, home).toFixed(1)}</span></div>` +
        `<div><span class="label">chance of DNF</span><span class="v">${pct(projection.pDnf)}</span></div>` +
        `<div><span class="label">chance to turn back</span><span class="v">${pct(projection.pRetreat)}</span></div></div>` +
        (home ? `<p class="hint">Includes your home bonus (× ${config.scoring.homeBonus}).</p>` : '') +
        retreatTable(partyFrom(lineup!.starters, input.statsOf, hexOn(s.state, me, week)), mission, play.retreat, home)) +
    `<div class="row"><button type="button" data-action="play-lu-advice">Use the advisor's lineup</button></div>` +
    (projection === null ? '' : graphSvg(layouts.get(week)!, { reach: projection.reach }) + graphLegend({ reach: projection.reach })) +
    `</section>`;

  let waivers = '';
  if (week < config.weeks) {
    const fa = freeAgents(s.state);
    const claims = s.pendingClaims().filter((c) => c.tavern === me);
    const advice = s.suggestClaims();
    waivers =
      `<section class="card"><h2>Waivers</h2>` +
      `<p class="small muted">Claims resolve after week ${week}'s run, in waiver priority order (yours: ${waiverPriority(s.state).indexOf(me) + 1} of ${waiverPriority(s.state).length}${config.waivers.priority === 'reverse_standings' ? ', lowest on the table first' : ''}). A claim cannot be withdrawn.</p>` +
      `<div class="row"><label class="label" for="play-add">Add</label><select id="play-add" data-action="play-add"><option value="">choose a free agent</option>${fa
        .map((id) => `<option value="${esc(id)}" ${id === play.add ? 'selected' : ''}>${esc(charName(id))} (CR ${formatCr(crOf(id))})</option>`)
        .join('')}</select>` +
      `<label class="label" for="play-drop">Drop</label><select id="play-drop" data-action="play-drop"><option value="">nobody${roster.length >= config.roster.size ? ' (roster is full)' : ''}</option>${roster
        .map((id) => `<option value="${esc(id)}" ${id === play.drop ? 'selected' : ''}>${esc(charName(id))} (CR ${formatCr(crOf(id))})</option>`)
        .join('')}</select>` +
      `<button type="button" data-action="play-claim" ${play.add === '' ? 'disabled' : ''}>Claim</button></div>` +
      `<p class="small">Advisor: ${
        advice.length === 0
          ? '<span class="muted">no claims</span>'
          : advice.map((c) => `+${esc(charName(c.add))}${c.drop === null ? '' : ` −${esc(charName(c.drop))}`}`).join(', ') +
            ` <button type="button" class="small" data-action="play-claim-advice">Make these claims</button>`
      }</p>` +
      (claims.length === 0 ? '' : `<p class="small">Your pending claims: ${claims.map((c) => `+<b>${esc(charName(c.add))}</b>${c.drop === null ? '' : ` −${esc(charName(c.drop))}`}`).join('; ')}</p>`) +
      `</section>`;
  }

  const playNote = legal
    ? `Plays the lineup above: ${starters.map((id) => esc(charName(id))).join(', ')}. The bots set their lineups and claims when you play the week.`
    : stuck
      ? '<span class="fail">No legal lineup exists on your roster, so you will score 0 this week.</span> Claim cheaper characters on waivers.'
      : '<span class="fail">Your lineup is not legal yet.</span> Fix it above, or use the advisor\'s lineup, to play the week.';
  return (
    lineupCardHtml +
    renderPlayHex(s, week) +
    waivers +
    `<section class="card"><div class="row" style="justify-content:space-between"><span class="small">${playNote}</span>` +
    `<button type="button" class="primary" data-action="play-week" ${legal || stuck ? '' : 'disabled'}>Play week ${week}</button></div></section>`
  );
}

const ABILITY_NAMES: Readonly<Record<Ability, string>> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };

/**
 * Every hex declared so far, and the person's hex form while they still hold it (D-52). A hex is public at once and
 * can't be withdrawn, so declaring takes a second click. Rows wear a banner only when they involve you: your own hex
 * in your colours, a rival's hex on you in theirs.
 */
function renderPlayHex(s: SeasonSession, week: number): string {
  const me = s.humanTavern!;
  const declared = s.state.hexes;
  const list =
    declared.length === 0
      ? '<p class="muted small">No hexes declared yet.</p>'
      : `<ul class="hexes small">${declared
          .map((h) => {
            const by = h.tavern === me ? me : h.target === me ? h.tavern : null;
            const flag = by === null || bannerOf(by) === null ? '' : '<i class="flag" aria-hidden="true"></i> ';
            return (
              `<li class="${by === null ? '' : 'curse'}"${by === null ? '' : ` data-hex="${esc(`${h.tavern}>${h.target}>${h.week}`)}"${bannerAttr(by)}`}>${flag}` +
              `${h.tavern === me ? '<b>You</b>' : esc(tavernName(h.tavern))} hexed ${h.target === me ? '<b>you</b>' : esc(tavernName(h.target))}: <b>${h.ability}</b>, week ${h.week}</li>`
            );
          })
          .join('')}</ul>`;
  const used = declared.some((h) => h.tavern === me);
  const rivals = s.taverns.filter((t) => t !== me);
  const weeks = WEEKS.filter((w) => w >= week);
  const target = play.hexTarget !== '' && rivals.includes(play.hexTarget) ? play.hexTarget : rivals[0]!;
  const hexWeek = Math.max(play.hexWeek, week);
  const form = used
    ? '<p class="small muted">You have used your hex this season.</p>'
    : play.confirmHex
      ? `<div class="row curse-confirm"${bannerAttr(me)} role="alert"><span>Curse <b>${esc(tavernName(target))}</b>: disadvantage on every ${esc(ABILITY_NAMES[play.hexAbility])} check and save in week ${hexWeek}? ` +
        `Everyone sees it at once, and it can't be withdrawn.</span>` +
        `<button type="button" class="primary" data-action="play-hex-confirm">Lay the curse</button><button type="button" data-action="play-hex-cancel">Not yet</button></div>`
      : `<div class="row"><label class="label" for="play-hex-target">Rival</label><select id="play-hex-target" data-action="play-hex-target">${rivals
          .map((t) => `<option value="${esc(t)}" ${t === play.hexTarget ? 'selected' : ''}>${esc(tavernName(t))}</option>`)
          .join('')}</select>` +
        `<label class="label" for="play-hex-ability">Ability</label><select id="play-hex-ability" data-action="play-hex-ability">${ABILITIES.map((a) => `<option value="${a}" ${a === play.hexAbility ? 'selected' : ''}>${a}</option>`).join('')}</select>` +
        `<label class="label" for="play-hex-week">Week</label><select id="play-hex-week" data-action="play-hex-week">${weeks
          .map((w) => `<option value="${w}" ${w === play.hexWeek ? 'selected' : ''}>${w}: ${esc(missionOf(w).id)}</option>`)
          .join('')}</select>` +
        `<button type="button" data-action="play-hex">Declare hex…</button></div>` +
        `<p class="hint">Once a season: that week the rival has disadvantage on every check and save using the ability. It is public at once and can't be withdrawn, and only the first hex on a rival in a week counts.</p>`;
  return `<section class="card"><h2>Hexes</h2>${list}${form}</section>`;
}

/** Whose home week it is, from the sponsors in the season package. */
function homeLine(s: SeasonSession, week: number): string {
  const home = homeTavern(s.state, week);
  if (home === null) return 'no sponsor this week';
  if (home === s.humanTavern!) return `<b>your home week</b>: loot × ${config.scoring.homeBonus}`;
  return `home week for <b>${esc(tavernName(home))}</b> (× ${config.scoring.homeBonus})`;
}

function renderPlayResult(s: SeasonSession, week: number): string {
  const me = s.humanTavern!;
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
        `<tr class="${r.tavern === me ? 'sel mine' : ''}"${r.tavern === me ? bannerAttr(me) : ''}><td class="n">${r.rank}</td><td><span class="${r.rank === 1 ? 'win' : ''}">${esc(tavernName(r.tavern))}</span></td><td class="n">${r.points}</td></tr>`,
    )
    .join('');
  const outcome =
    mine === undefined || res === undefined
      ? 'quiet'
      : weekOutcome({ rank: mine.rank, points: mine.points, projected: results.get(me)?.projected ?? mine.points, dnf: res.run.dnf, retreated: res.run.retreatedBefore !== null });
  const claimed = new Map(s.events.flatMap((e) => (e.type === 'waiver.claimed' ? [[e.payload.claim, e.payload] as const] : [])));
  const waivers = s.events
    .flatMap((e) => (e.type === 'waiver.resolved' && e.payload.week === week ? e.payload.outcomes : []))
    .filter((o) => claimed.get(o.claim)?.tavern === me);
  // The week reveal (fx.ts revealWeek) plays the run back node by node and keeps everything marked data-spoiler, and
  // every section after this card, out of sight until it ends. Without it (a reload, reduced motion) all shows at once.
  return (
    `<section class="card week-result"${res === undefined ? '' : ` data-path="${esc(JSON.stringify(res.run.path))}"`} data-outcome="${outcome}" tabindex="-1">` +
    `<div class="row" style="justify-content:space-between"><h2>Week ${week} result</h2><span class="small" data-spoiler data-headline>${headline}</span></div>` +
    (res === undefined
      ? '<p class="muted">You fielded no lineup and scored 0.</p>'
      : graphSvg(layouts.get(week)!, { path: res.run.path, outcomes: outcomesOf(res.run) }) +
        taleHtml(mission, res.run, curseOn(s, me, week)) +
        `<details data-spoiler><summary>Your roll log</summary>${rollLog(mission, res.run, homeTavern(s.state, week) === me)}</details>`) +
    (others === '' ? '' : `<div class="stack" data-spoiler><h3>This week's table</h3><div class="scroll"><table><tbody>${others}</tbody></table></div></div>`) +
    (waivers.length === 0
      ? ''
      : `<p class="small" data-spoiler>Your claims: ${waivers
          .map((o) => {
            const c = claimed.get(o.claim);
            const what = c === undefined ? '' : `+${esc(charName(c.add))}${c.drop === null ? '' : ` −${esc(charName(c.drop))}`}: `;
            return `${what}<span class="${o.awarded ? 'pass' : 'fail'}">${esc(waiverReasonLabel(o.reason))}</span>`;
          })
          .join('; ')}</p>`) +
    `</section>`
  );
}

/**
 * The scrying ball's account of a run: one line per check or battle in path order, then how it ended, beside the loot
 * carried. Each line carries the loot banked so far (`data-total`) for the reveal's counter; the outcome sits in
 * `.outcome` and the die in `[data-roll]`, so the reveal can roll the die and hold the outcome back.
 */
function taleHtml(mission: Mission, run: RunResult, curse: { readonly by: string; readonly ability: Ability } | null = null): string {
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));
  const steps = taleSteps(mission, run);
  const banked = steps.at(-1)?.total ?? 0;
  // A rival's hex opens the tale, in the rival's colours: the curse falls before the party sets out.
  const head =
    curse === null
      ? []
      : [
          `<li data-head="curse" class="curse"${bannerAttr(curse.by)}>${bannerOf(curse.by) === null ? '' : '<i class="flag" aria-hidden="true"></i> '}` +
            `<b>${esc(godOf.has(curse.by) ? godName(godOf.get(curse.by)!) : tavernName(curse.by))}</b>'s curse falls on your party, from <b>${esc(tavernName(curse.by))}</b>: ` +
            `disadvantage on every ${esc(ABILITY_NAMES[curse.ability])} check and save.</li>`,
        ];
  const lines = steps.flatMap(({ node: id, record: r, bank, total }) => {
    if (r === null) return [];
    const node = byId.get(id);
    const loot = bank > 0 ? ` <span class="tag brass" data-bank>+${bank} loot</span>` : '';
    const attrs = `data-node="${esc(id)}" data-total="${total}"`;
    if (r.kind === 'check') {
      const sum = r.d20 + r.modifier;
      const gated = node?.kind === 'check' && node.check.requires !== undefined && sum >= r.dc && r.outcome === 'fail';
      const what = node?.kind === 'check' ? checkLabel(node.check) : id;
      const edge = r.advantage ? ' <span class="tag brass">adv</span>' : r.disadvantage ? ' <span class="tag bad" title="Hexed: the lower of two d20s">dis</span>' : '';
      return [
        `<li ${attrs} data-kind="check"><b>${esc(what)}</b>: ${esc(charName(r.actor))} rolls ` +
          `<span class="die ${r.d20 === 20 ? 'hi' : r.d20 === 1 ? 'lo' : ''}" data-roll="d20">${r.d20}</span>${edge} ` +
          `<span class="outcome">${signed(r.modifier)} = ${sum}: <span class="${r.outcome}">${r.outcome}</span>${gated ? ' <span class="tag bad">gate</span>' : ''}${loot}</span></li>`,
      ];
    }
    const foes = node?.kind === 'battle' ? node.encounter.creatures.map((c) => `${c.count}× ${c.ref}`).join(', ') : id;
    return [
      `<li ${attrs} data-kind="battle"><b>Battle</b> with ${esc(foes)}: needs under ${r.pWin.toFixed(3)}, the ball shows ` +
        `<span class="die" data-roll="unit">${r.roll.toFixed(3)}</span> <span class="outcome"><span class="${r.outcome === 'win' ? 'pass' : 'fail'}">${r.outcome === 'win' ? 'won' : 'lost'}</span>${loot}</span></li>`,
    ];
  });
  if (run.retreatedBefore !== null) {
    lines.push(`<li data-tail="retreat" data-total="${run.loot}">The party thinks better of <b>${esc(run.retreatedBefore)}</b> and turns for home, keeping ${run.loot} loot.</li>`);
  }
  if (run.dnf) {
    lines.push(`<li data-tail="dnf" data-total="0"><span class="fail">Beaten.</span> The party flees, dropping all ${banked} loot.</li>`);
    if (run.injury !== null) lines.push(`<li data-tail="injury" data-total="0"><b data-hurt>${esc(charName(run.injury.character))}</b> limps home hurt and sits out next week.</li>`);
  } else if (run.retreatedBefore === null) {
    lines.push(`<li data-tail="home" data-total="${run.loot}">Home with ${run.loot} loot.</li>`);
  }
  return (
    `<div class="tale-box"><div class="row" style="justify-content:space-between"><span class="label">The scrying ball</span>` +
    `<div class="row"><span class="small">loot carried <b class="num loot-count" data-loot="${run.loot}">${run.loot}</b></span>` +
    `<button type="button" class="small" data-reveal-skip title="Show the result now (Esc)">Skip</button>` +
    `<button type="button" class="small" data-action="play-replay" data-after-reveal>Watch again</button></div></div>` +
    `<ol class="tale" aria-live="polite">${[...head, ...lines].join('')}</ol></div>`
  );
}

/** The hex that counted against `tavern` in `week` (the first declared, D-52), and who laid it. */
function curseOn(s: SeasonSession, tavern: string, week: number): { readonly by: string; readonly ability: Ability } | null {
  const hex = s.state.hexes.find((h) => h.target === tavern && h.week === week);
  return hex === undefined ? null : { by: hex.tavern, ability: hex.ability };
}

/** The hex moment: your declared hex lands in the list, in your colours. */
function layMyCurse(key: string): void {
  layCurse(panel.querySelector<HTMLElement>(`.hexes [data-hex="${CSS.escape(key)}"]`), bannerColours(play.session?.humanTavern ?? null));
}

/** A tavern's banner colours for an effect, if it has a banner. */
function bannerColours(tavern: string | null): Banner | undefined {
  const god = tavern === null ? null : bannerOf(tavern);
  return god === null ? undefined : data.gods[god]!.banner;
}

/** The week reveal: your run plays back over the result card, ending in a moment the size of the week (fx.ts). */
function revealMyWeek(): void {
  const card = panel.querySelector<HTMLElement>('.week-result[data-path]');
  if (card === null) return;
  const s = play.session;
  const me = s?.humanTavern ?? null;
  const mine = bannerColours(me);
  // The last week's reveal ends the season: its fanfare takes the place of the week's own moment if you won.
  const final = panel.querySelector<HTMLElement>('.season-final');
  // When it ends, the table below slides from last week's order into this week's.
  const slide = (): void => slideStandings(panel.querySelector<HTMLTableElement>('#play-standings'));
  if (s === null || s.stage.kind !== 'complete' || final === null) {
    revealWeek(card, mine, () => {
      weekMoment(card, mine);
      slide();
    });
    return;
  }
  const champs = seasonStandings(s.state).filter((r) => r.rank === 1).map((r) => r.tavern);
  revealWeek(card, mine, () => {
    slide();
    if (me !== null && champs.includes(me)) {
      crownChampion(final, mine);
      return;
    }
    weekMoment(card, mine);
    window.setTimeout(() => hailChampion(final, bannerColours(champs[0] ?? null)), 1200);
  });
}

function renderPlayStandings(s: SeasonSession): string {
  const me = s.humanTavern!;
  const rows = seasonStandings(s.state);
  if (s.state.finalizedWeeks.size === 0) return '';
  const done = s.stage.kind === 'complete';
  // How the table moved this week: against the standings before the latest week (none after week 1). The rows carry
  // their previous row, so fx.ts slideStandings can slide them from there when the week's reveal ends.
  const played = [...s.state.finalizedWeeks].sort((a, b) => a - b);
  const before = played.length < 2 ? null : standings([...s.state.taverns.keys()], played.slice(0, -1).flatMap((w) => weekResults(s.state, w)));
  const moves = before === null ? null : tableMoves(before, rows);
  const moveCell = (tavern: string): string => {
    const rose = moves?.get(tavern)?.rose ?? 0;
    if (moves === null) return '';
    return `<td class="n move">${rose > 0 ? `<span class="pass" title="Up ${rose} since last week">▲${rose}</span>` : rose < 0 ? `<span class="fail" title="Down ${-rose} since last week">▼${-rose}</span>` : '<span class="muted" title="No change since last week">–</span>'}</td>`;
  };
  const body = rows
    .map(
      (r) =>
        `<tr class="${r.tavern === me ? 'sel mine' : ''} ${done && r.rank === 1 ? 'champ' : ''}"${r.tavern === me ? bannerAttr(me) : ''}${moves === null ? '' : ` data-was="${moves.get(r.tavern)?.wasRow ?? 0}"`}><td class="n">${r.rank}</td>${moveCell(r.tavern)}<td><b>${esc(tavernName(r.tavern))}</b></td>` +
        `<td><span class="tag ${r.tavern === me ? (bannerOf(me) === null ? 'brass' : 'banner') : ''}">${r.tavern === me ? 'you' : esc(botOf(r.tavern))}</span></td><td class="n">${r.points}</td></tr>`,
    )
    .join('');
  const table =
    `<div class="scroll"><table id="play-standings"><thead><tr><th class="n">#</th>${moves === null ? '' : '<th class="n" title="Places moved since last week">±</th>'}<th>tavern</th><th>manager</th><th class="n">loot</th></tr></thead><tbody>${body}</tbody></table></div>` +
    (done ? '<p class="hint">The season is loaded into the other tabs: Standings, Weeks, Draft board, Pool and Event log.</p>' : '');
  if (!done) return `<section class="card"><h2>Standings</h2>${table}</section>`;

  // The season's end (fx.ts crownChampion / hailChampion play over this card when the last week's reveal ends).
  const champs = rows.filter((r) => r.rank === 1).map((r) => r.tavern);
  const mine = rows.find((r) => r.tavern === me);
  const godLine = (tavern: string): string => {
    const god = godOf.get(tavern);
    return god === undefined ? '' : ` under the banner of <b>${esc(godName(god))}</b>`;
  };
  if (mine?.rank === 1) {
    const chrome = bannerColours(me) === undefined ? undefined : data.gods[godOf.get(me)!];
    return (
      `<section class="card season-final champion${chrome === undefined ? '' : ' banner-card'}"${bannerAttr(me)}>${chrome === undefined ? '' : '<div class="pennant" aria-hidden="true"></div>'}` +
      `<h2>${champs.length === 1 ? 'Champions of the League' : 'Co-champions of the League'}</h2>` +
      `<p class="banner-call">${esc(tavernName(me))} ${champs.length === 1 ? 'takes the season' : 'shares the title'} with ${num(mine.points)} loot${godLine(me)}.</p>` +
      table +
      `</section>`
    );
  }
  const weeks = [...s.state.finalizedWeeks].flatMap((week) => {
    const row = standings([], weekResults(s.state, week)).find((r) => r.tavern === me);
    return row === undefined ? [] : [{ week, points: row.points, rank: row.rank }];
  });
  const best = bestWeek(weeks);
  const champLine = champs
    .map((t) => `<span class="champ-line"${bannerAttr(t)}>${bannerOf(t) === null ? '' : '<i class="flag" aria-hidden="true"></i> '}<b>${esc(tavernName(t))}</b>${godLine(t)}</span>`)
    .join(' and ');
  return (
    `<section class="card season-final">` +
    `<h2>Final standings</h2>` +
    `<p>${champLine} ${champs.length === 1 ? 'wins' : 'share'} the season.</p>` +
    `<p class="finish">You finish <b>${ordinal(mine?.rank ?? rows.length)} of ${rows.length}</b> with ${num(mine?.points ?? 0)} loot.` +
    (best === null || best.points === 0 ? '' : ` Your best week was week ${best.week}: ${num(best.points)} loot${best.topped ? ', and you topped it' : ''}.`) +
    `</p>` +
    table +
    `</section>`
  );
}

function resetPlay(): void {
  Object.assign(play, { session: null, error: null, notice: null, seed: '', moves: [], confirmReset: false, confirmHex: false });
  storageRemove(PLAY_KEY);
}

function playClick(action: string, id: string | undefined): boolean {
  switch (action) {
    case 'play-start':
      startPlay();
      return true;
    case 'play-reset':
      // A finished season needs no confirmation; one in progress does.
      if (play.session !== null && play.session.stage.kind !== 'complete') play.confirmReset = true;
      else resetPlay();
      renderTab();
      return true;
    case 'play-reset-confirm':
      resetPlay();
      renderTab();
      return true;
    case 'play-reset-cancel':
      play.confirmReset = false;
      renderTab();
      return true;
    case 'play-tavern-pick':
      // Only once the engine accepts the pick: a refusal skips `after`, so no banner goes up.
      if (id !== undefined) playMoves([{ t: 'tavern', id }], () => (pendingFx = raiseMyBanner));
      return true;
    case 'play-draft':
      // The drafted card turns over into your colours once it lands in your roster.
      if (id !== undefined) {
        playMoves([{ t: 'draft', id }], () => {
          pendingFx = () => {
            turnCard(panel.querySelector<HTMLElement>(`#play-roster [data-card="${CSS.escape(id)}"]`));
            clockBack(panel.querySelector<HTMLElement>('#play-clock'));
          };
        });
      }
      return true;
    case 'play-lu-add':
      if (id !== undefined && play.picks.length < config.roster.starters && !play.picks.includes(id)) {
        play.picks.push(id);
        const over = play.picks.reduce((t, p) => t + crOf(p), 0) > BUDGET;
        pendingFx = () => nodMeter(panel.querySelector('#play-lineup .meter'), over ? 'over' : 'fits');
        renderTab();
      }
      return true;
    case 'play-lu-remove':
      if (id !== undefined) {
        play.picks = play.picks.filter((p) => p !== id);
        renderTab();
      }
      return true;
    case 'play-lu-advice':
      playAct((s) => {
        const lineup = s.suggestLineup();
        if (lineup === null) throw new Error('The advisor finds no legal lineup on this roster.');
        play.picks = [...lineup.starters];
        play.retreat = lineup.retreat;
        pendingFx = () => nodMeter(panel.querySelector('#play-lineup .meter'), 'fits');
      });
      return true;
    case 'play-hex':
      play.confirmHex = true;
      renderTab();
      return true;
    case 'play-hex-cancel':
      play.confirmHex = false;
      renderTab();
      return true;
    case 'play-hex-confirm': {
      const s = play.session;
      const stage = s?.stage;
      play.confirmHex = false;
      if (s === null || stage?.kind !== 'week') return true;
      const rivals = s.taverns.filter((t) => t !== s.humanTavern);
      const target = play.hexTarget !== '' && rivals.includes(play.hexTarget) ? play.hexTarget : rivals[0]!;
      const week = Math.max(play.hexWeek, stage.week);
      playMoves([{ t: 'hex', target, ability: play.hexAbility, week }], () => (pendingFx = () => layMyCurse(`${s.humanTavern}>${target}>${week}`)));
      return true;
    }
    case 'play-claim':
      playMoves([{ t: 'claim', add: play.add, drop: play.drop === '' ? null : play.drop }], () => {
        play.add = '';
        play.drop = '';
      });
      return true;
    case 'play-claim-advice': {
      const s = play.session;
      if (s !== null) playMoves(s.suggestClaims().map(({ add, drop }) => ({ t: 'claim', add, drop })));
      return true;
    }
    case 'play-week': {
      // Playing the week locks in the lineup on screen: what you see is what plays.
      const s = play.session;
      const stage = s?.stage;
      if (s === null || stage?.kind !== 'week') return true;
      const lineup = builderLineup();
      const pending = s.pendingLineup();
      const same =
        pending !== null && lineup !== null && pending.starters.join() === lineup.starters.join() && retreatValue(pending.retreat) === retreatValue(lineup.retreat);
      const unavailable = injuredFor(s.state, stage.week);
      const legal = lineup !== null && validateLineup(lineup, { tavern: s.humanTavern!, characters: myRoster(s) }, crOf, config, { unavailable }).length === 0;
      const moves: PlayMove[] = lineup === null || same || !legal ? [] : [{ t: 'lineup', starters: [...lineup.starters], retreat: lineup.retreat }];
      playMoves([...moves, { t: 'week' }], () => {
        play.played = stage.week;
        pendingFx = revealMyWeek;
      });
      return true;
    }
    case 'play-replay':
      pendingFx = revealMyWeek;
      renderTab();
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
    case 'play-tavern':
      play.manager = target.value;
      break;
    case 'play-add':
      play.add = target.value;
      renderTab();
      break;
    case 'play-drop':
      play.drop = target.value;
      break;
    case 'play-hex-target':
      play.hexTarget = target.value;
      break;
    case 'play-hex-ability':
      play.hexAbility = target.value as Ability;
      break;
    case 'play-hex-week':
      play.hexWeek = Number(target.value);
      break;
    case 'play-retreat':
      play.retreat = parseRetreat(target.value);
      renderTab();
      break;
    case 'lab-retreat':
      lab.retreat = parseRetreat(target.value);
      lab.roll = null;
      lab.sample = null;
      refreshLab({ analysis: true });
      break;
    case 'play-sort':
      play.draftSort = target.value as typeof play.draftSort;
      renderTab();
      break;
    case 'play-fa-view':
      play.faView = target.value === 'table' ? 'table' : 'cards';
      storageSet('lot-playground-fa-view', play.faView);
      renderTab();
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

// Arrow keys, Home and End move between tabs, as in any tab list.
$('tabs').addEventListener('keydown', (ev) => {
  const order = [...document.querySelectorAll<HTMLButtonElement>('#tabs button[data-tab]')].map((b) => b.dataset.tab as Tab);
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
  `Playground · <b>${esc(config.id)}</b> · ${config.weeks} weeks · ${input.managers.length} bots · ${poolIds.length} pooled · ` +
  `party budget CR ${formatCrTotal(BUDGET)} · engine ${esc(input.engineVersion)} · ${esc(input.battleModel.id)}`;
const savedTab = storageGet('lot-playground-tab');
if (savedTab !== null && (TABS as ReadonlyArray<string>).includes(savedTab)) tab = savedTab as Tab;
markTabs();
restorePlay();
// Run after the first paint, so "Running…" shows; the timer covers a tab opened in the background, where frames never come.
let booted = false;
const boot = (): void => {
  if (booted) return;
  booted = true;
  doRun(($('seed') as HTMLInputElement).value.trim() || 'sim-1');
};
requestAnimationFrame(() => setTimeout(boot, 0));
setTimeout(boot, 250);
