/**
 * The game: one season against five bots, told in the Common Room.
 *
 * The Common Room is the season's running story: every tavern's tavern pick
 * and draft pick, every hex, the lineup lock, each week's race and its
 * table, and the waivers, as messages in a chat no one can type into (the
 * items come from the event log, ./feed.ts). Beside it sit a workspace for
 * your move (the taverns, the draft, your lineup, hex and claims) and the
 * standings.
 *
 * The bots decide at once and the engine records it all at once, but the
 * room announces it at a person's pace: a rival is "on the clock" for a
 * second or so before its pick lands, rivals say they are ready over a few
 * seconds when a week opens, and a week plays out as a race. Everything on
 * the page (the free agents, the standings) shows the league as the room
 * has announced it, so nothing gets ahead of the story. Skip (or Esc) tells
 * the rest at once; a reload shows everything.
 *
 * Your season is saved in this browser as its seed, tavern seat and your
 * moves, and replayed on reload.
 */
import {
  ABILITIES,
  applyEvent,
  freeAgents,
  hexOn,
  homeTavern,
  initialState,
  injuredFor,
  projectMission,
  projectedPoints,
  seasonStandings,
  waiverPriority,
  validateLineup,
} from '@league-of-taverns/engine';
import type { Ability, LeagueEvent, LeagueState, Lineup, Mission, RetreatOrder, RunResult } from '@league-of-taverns/engine';
import { SeasonSession } from '../season-runner';
import { currentRound, feedItems, latestResults, type FeedItem, type FeedRun } from './feed';
import { clockBack, crownChampion, hailChampion, layCurse, micron, nodMeter, pacer, raceWeek, raiseBanner, reducedMotion, slideStandings, turnCard, weekMoment, type Pacer } from './fx';
import {
  $,
  ABILITY_NAMES,
  BUDGET,
  CHAR_HEAD,
  WEEKS,
  bannerAttr,
  bannerOf,
  charCard,
  charName,
  charRow,
  config,
  crMeter,
  crOf,
  cryptoRand,
  data,
  environmentOf,
  esc,
  godName,
  godOf,
  graphLegend,
  graphSvg,
  input,
  keywordsLine,
  layouts,
  matchesFilter,
  missionOf,
  num,
  ordinal,
  portrait,
  retreatSelect,
  retreatTable,
  storageGet,
  storageRemove,
  storageSet,
  tavernName,
  violationList,
} from './shared';
import { bestWeek, checkLabel, draftBoard, formatCr, formatCrTotal, parseRetreat, partyFrom, pct, retreatValue, seedWords, signed, taleSteps, waiverReasonLabel, weekOutcome } from './view';
import type { Banner } from '@league-of-taverns/scripts/lib/god-schema';

/** The room's name, in one place. */
const ROOM = 'The Common Room';

// ── the people at the table ────────────────────────────────────────────────

/** The bots' keepers, by seat in managers order: page-only names, so the room reads like a table of people. */
const KEEPERS = ['Mags Thornbury', 'Old Wendel', 'Ottilie Brisk', 'Hob Galloway', 'Sister Pell', 'Corwin the Lesser', 'Dagny Two-Pints', 'Tamsin Reed'];
const seatOf = new Map(input.managers.map((m, i) => [m.id, i]));
const botOfManager = new Map(input.managers.map((m) => [m.id, m.bot]));

/** A manager's keeper: "You" for your seat, else the seat's keeper name. */
function keeper(manager: string): string {
  if (game.session?.human?.manager === manager) return 'You';
  return KEEPERS[seatOf.get(manager) ?? 0] ?? manager;
}
/** The manager running `tavern`, as of what the room has shown. */
function managerOf(tavern: string): string | null {
  return shown.state.taverns.get(tavern)?.managerId ?? null;
}
/** A tavern by name, or "You" for yours (`you` for the object of a sentence). */
function who(tavern: string, me: string | null, object = false): string {
  return tavern === me ? (object ? 'you' : 'You') : tavernName(tavern);
}
/** A tavern's flag, in its own colours wherever it sits. Nothing for a tavern without a banner. */
const flagOf = (tavern: string): string => (bannerOf(tavern) === null ? '' : `<i class="flag"${bannerAttr(tavern)} aria-hidden="true"></i>`);

// ── moves, saved ───────────────────────────────────────────────────────────

/** One of your moves. A season is its seed, your seat and these, replayed in order, so it can be saved and restored. */
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

type View = 'room' | 'work' | 'table';
const VIEWS: ReadonlyArray<View> = ['room', 'work', 'table'];

const game = {
  session: null as SeasonSession | null,
  /** The manager seat you take. */
  manager: input.managers[0]?.id ?? '',
  seed: '',
  error: null as string | null,
  notice: null as string | null,
  moves: [] as PlayMove[],
  /** "New season" waits for a second, confirming click. */
  confirmReset: false,
  /** The hex form asks "are you sure?" (a hex is public and final). */
  confirmHex: false,
  /** Waiting on the rivals to ready before your week plays. */
  locking: false,
  /** On a narrow screen, the one view showing; on a wide one the room always shows, beside `work` or `table`. */
  view: ((VIEWS as ReadonlyArray<string>).includes(storageGet('lot-play-view') ?? '') ? storageGet('lot-play-view') : 'room') as View,
  draftSort: 'value' as 'value' | 'cr',
  /** Free agents as character cards or the dense table; remembered in this browser. */
  faView: (storageGet('lot-playground-fa-view') === 'table' ? 'table' : 'cards') as 'cards' | 'table',
  filter: '',
  /** The lineup builder: starters in lineup order, and the retreat order, for `builderWeek`. */
  picks: [] as string[],
  retreat: 'never' as RetreatOrder,
  builderWeek: 0,
  add: '',
  drop: '',
  hexTarget: '',
  hexAbility: 'wis' as Ability,
  hexWeek: 1,
};

// ── what the room has shown ────────────────────────────────────────────────

/** The events the room has announced, and the league folded from them: what every view shows. */
const shown = { n: 0, state: initialState() as LeagueState };

function events(): ReadonlyArray<LeagueEvent> {
  return game.session?.events ?? [];
}
function foldTo(n: number): void {
  const log = events();
  if (n < shown.n) {
    shown.n = 0;
    shown.state = initialState();
  }
  while (shown.n < n && shown.n < log.length) shown.state = applyEvent(shown.state, log[shown.n++]!);
}
/** True when the room has caught up with the log, so the session's stage is the room's. */
const caughtUp = (): boolean => game.session !== null && shown.n >= game.session.events.length;

/**
 * Taverns that have said they're ready, per week, and every "ready" with where the log stood when it was said.
 * Presence only: it is not in the log, so a reload forgets it.
 */
const presence = { week: 0, ready: new Map<number, string[]>(), said: [] as Array<{ week: number; tavern: string; at: number }>, timers: [] as number[] };

/** The telling under way, if any: its clock, and who is "typing" right now. */
interface Pump {
  readonly pace: Pacer;
  typing: { readonly tavern: string | null; readonly label: string; readonly verb: string } | null;
}
let pump: Pump | null = null;
/** Keys of the items the room has presented; anything else is new. */
const presented = new Set<string>();
/** Folds you opened or closed yourself, by key, so a re-render keeps them. */
const folds = new Map<string, boolean>();

// ── the season ─────────────────────────────────────────────────────────────

function newSession(manager: string, seed: string): SeasonSession {
  const session = new SeasonSession(input, { seed, human: { manager, login: 'you', githubId: 1 } });
  session.advanceDraft();
  return session;
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

function save(): void {
  const s = game.session;
  if (s === null) return;
  const saved: SavedPlay = { v: 1, fingerprint: PLAY_FINGERPRINT, manager: s.human!.manager, seed: s.seed, moves: game.moves };
  storageSet(PLAY_KEY, JSON.stringify(saved));
}

function clearRoom(): void {
  shown.n = 0;
  shown.state = initialState();
  presented.clear();
  folds.clear();
  for (const t of presence.timers) window.clearTimeout(t);
  presence.week = 0;
  presence.ready.clear();
  presence.said = [];
  presence.timers = [];
  pump?.pace.skip();
  pump = null;
  game.locking = false;
  $('g-feed').innerHTML = '';
}

/** Rebuild a saved season by replaying its moves, so a reload or a closed tab loses nothing. The room shows it all at once. */
function restore(): void {
  const raw = storageGet(PLAY_KEY);
  if (raw === null) return;
  try {
    const saved = JSON.parse(raw) as SavedPlay;
    if (saved.v !== 1 || saved.fingerprint !== PLAY_FINGERPRINT) throw new Error('it was played against another version of the season or engine');
    const session = newSession(saved.manager, saved.seed);
    for (const m of saved.moves) applyMove(session, m);
    Object.assign(game, { session, manager: saved.manager, seed: saved.seed, moves: [...saved.moves] });
    foldTo(session.events.length);
    if (session.stage.kind === 'complete') loadIntoWorkshop(session);
  } catch (e) {
    storageRemove(PLAY_KEY);
    game.notice = `Your saved season could not be restored: ${e instanceof Error ? e.message : String(e)}.`;
  }
}

function start(): void {
  const seed = game.seed.trim() || seedWords(cryptoRand);
  game.error = null;
  game.notice = null;
  try {
    const session = newSession(game.manager, seed);
    clearRoom();
    Object.assign(game, { session, seed, moves: [], filter: '', picks: [], retreat: 'never', builderWeek: 0, add: '', drop: '', confirmReset: false, confirmHex: false });
    save();
    // The preseason is already done when the room opens; the tavern pick is told as it happens.
    const first = session.events.findIndex((e) => e.type === 'tavern.chosen');
    foldTo(first < 0 ? session.events.length : first);
  } catch (e) {
    game.error = e instanceof Error ? e.message : String(e);
  }
  renderAll();
  void tell();
}

function reset(): void {
  clearRoom();
  Object.assign(game, { session: null, error: null, notice: null, seed: '', moves: [], confirmReset: false, confirmHex: false });
  storageRemove(PLAY_KEY);
  renderAll();
}

/** Make moves, keeping each one the engine accepts; a refusal shows as an error and stops there. Then the room tells what followed. */
function move(moves: ReadonlyArray<PlayMove>, after?: () => void): void {
  const s = game.session;
  if (s === null) return;
  game.error = null;
  game.notice = null;
  try {
    for (const m of moves) {
      applyMove(s, m);
      game.moves.push(m);
    }
    after?.();
  } catch (e) {
    game.error = e instanceof Error ? e.message : String(e);
  }
  save();
  if (s.stage.kind === 'complete') loadIntoWorkshop(s);
  void tell();
}

let loadIntoWorkshop: (s: SeasonSession) => void = () => {};

function myRoster(s: SeasonSession): ReadonlyArray<string> {
  return s.state.taverns.get(s.humanTavern!)?.roster ?? [];
}

// ── the room tells it ──────────────────────────────────────────────────────

/** A random wait in [lo, hi) ms, from the page's crypto: presentation only, never the engine's dice. */
const jitter = (lo: number, hi: number): number => Math.round(lo + (hi - lo) * cryptoRand());

/** Who is "typing" before an event lands, and for how long; null for an event that lands at once. */
function typingFor(e: LeagueEvent, me: string | null): { tavern: string | null; label: string; verb: string; ms: number } | null {
  const bot = e.actor.kind === 'bot';
  switch (e.type) {
    case 'tavern.chosen':
      return bot ? { tavern: null, label: keeper(e.payload.manager), verb: 'is choosing a tavern', ms: jitter(1100, 2300) } : null;
    case 'draft.pick': {
      if (!bot) return null;
      // The first rounds take a little longer: there is more to weigh.
      const early = e.payload.pick < 2 * input.managers.length ? 350 : 0;
      return { tavern: e.payload.tavern, label: who(e.payload.tavern, me), verb: 'is on the clock', ms: early + jitter(600, 1500) };
    }
    case 'hex.declared':
      return bot ? { tavern: e.payload.tavern, label: who(e.payload.tavern, me), verb: 'is muttering', ms: jitter(900, 1400) } : null;
    case 'lineup.locked':
      return { tavern: null, label: 'The crier', verb: 'is collecting the lineups', ms: 700 };
    case 'mission.revealed':
      return { tavern: null, label: 'The scrying ball', verb: 'is clouding over', ms: 1000 };
    case 'waiver.resolved':
      return { tavern: null, label: 'The steward', verb: 'is reading the claims', ms: 1100 };
    default:
      return null;
  }
}

/** How long the room rests after an item lands, by kind. */
const REST: Partial<Record<FeedItem['kind'], number>> = { divider: 200, season: 600, tavern: 450, 'draft-done': 900, 'week-open': 600, hex: 900, claim: 250, lock: 900, table: 900, waivers: 1000 };

/**
 * Tell the room what the log holds and it hasn't shown: an event at a time, each with its typing pause, each new item
 * presented with its own moment. Skip (or Esc) shows the rest at once.
 */
async function tell(): Promise<void> {
  const s = game.session;
  if (s === null || pump !== null) return;
  const pace = pacer();
  const mine: Pump = { pace, typing: null };
  pump = mine;
  // Under reduced motion the room tells everything at once, as a skip does.
  if (reducedMotion()) pace.skip();
  renderBar();
  // The workspace follows the room: a week in play takes its builder away until the room has told the week.
  renderWork();
  // A new season (or a reset) mid-tale ends this one: it skips, and nothing here touches the new room.
  const gone = (): boolean => game.session !== s || pump !== mine;
  try {
    await present(pace, null);
    while (!pace.skipped && !gone() && shown.n < s.events.length) {
      const e = s.events[shown.n]!;
      const typing = typingFor(e, s.humanTavern);
      if (typing !== null) {
        mine.typing = typing;
        renderBar();
        await pace.sleep(typing.ms);
        mine.typing = null;
        renderBar();
        if (pace.skipped || gone()) break;
      }
      foldTo(shown.n + 1);
      await present(pace, e);
    }
  } finally {
    if (!gone()) {
      if (pace.skipped) foldTo(s.events.length);
      pump = null;
      renderAll();
      afterTelling();
    }
  }
}

/** Put any new items in the room, one at a time with their moments; re-render the ones that changed. */
async function present(pace: Pacer | null, landed: LeagueEvent | null): Promise<void> {
  const s = game.session;
  if (s === null) return;
  const items = roomItems();
  for (const item of items) {
    if (presented.has(item.key)) continue;
    presented.add(item.key);
    renderFeed(items.filter((it) => presented.has(it.key)), item.key);
    if (pace === null || pace.skipped) continue;
    await momentFor(item, pace);
    await pace.sleep(REST[item.kind] ?? 0);
  }
  // Items that grew (a draft round) re-render in place.
  renderFeed(items.filter((it) => presented.has(it.key)), null);
  if (landed?.type === 'tavern.chosen' || landed?.type === 'week.finalized') renderWork();
  if (landed?.type === 'draft.pick') {
    const line = $('g-feed').querySelector<HTMLElement>(`[data-seq="${landed.seq}"]`);
    line?.classList.add('fresh');
    followFeed();
    if (pace !== null && !pace.skipped) {
      stampTaken(landed.payload.character, landed.payload.tavern);
      if (landed.payload.tavern === s.humanTavern) await pace.sleep(500);
      else await pace.sleep(200);
    }
  }
  renderHead();
  renderTabs();
  renderTable();
}

/** The moment that comes with an item as it lands, if any. */
async function momentFor(item: FeedItem, pace: Pacer): Promise<void> {
  const el = $('g-feed').querySelector<HTMLElement>(`[data-key="${CSS.escape(item.key)}"]`);
  if (el === null) return;
  const me = game.session?.humanTavern ?? null;
  switch (item.kind) {
    case 'tavern':
      if (item.tavern === me) {
        renderHead();
        const god = bannerOf(me);
        if (god !== null) raiseBanner($('g-head').querySelector<HTMLElement>('.banner-card'), data.gods[god]!.banner);
      }
      return;
    case 'hex':
      if (item.tavern === me || item.target === me) layCurse(el.querySelector<HTMLElement>('.curse') ?? el, bannerColours(item.tavern));
      return;
    case 'ready':
      micron(el, 'pop', { duration: 0.4 });
      return;
    case 'results': {
      if (pump !== null) {
        pump.typing = { tavern: null, label: 'The scrying ball', verb: `shows week ${item.week}` };
        renderBar();
      }
      await raceWeek(el, pace);
      if (pump !== null) pump.typing = null;
      if (el.isConnected) weekMoment(el, bannerColours(me));
      return;
    }
    case 'table':
      slideStandings(el.querySelector('table'));
      if (item.final) {
        const champs = item.rows.filter((r) => r.rank === 1).map((r) => r.tavern);
        await pace.sleep(900);
        if (me !== null && champs.includes(me)) crownChampion(el, bannerColours(me));
        else hailChampion(el, bannerColours(champs[0] ?? null));
      }
      return;
    default:
      return;
  }
}

/** When the room has caught up: open the week to the rivals' readiness, and nod if the move is yours again. */
function afterTelling(): void {
  const s = game.session;
  if (s === null || !caughtUp()) return;
  const stage = s.stage;
  if (stage.kind === 'week') startPresence(stage.week);
  const yours =
    (stage.kind === 'tavern' && stage.manager === s.human?.manager) || (stage.kind === 'draft' && stage.tavern === s.humanTavern);
  if (yours && !game.locking) clockBack($('g-bar'));
}

/** Rivals say they're ready over the next few seconds, as people would. */
function startPresence(week: number): void {
  const s = game.session;
  if (s === null || presence.week === week) return;
  presence.week = week;
  for (const t of presence.timers) window.clearTimeout(t);
  presence.timers = [];
  const rivals = s.taverns.filter((t) => t !== s.humanTavern);
  presence.ready.set(week, []);
  for (const tavern of rivals) {
    presence.timers.push(window.setTimeout(() => ready(week, tavern), jitter(1500, 11000)));
  }
}

function ready(week: number, tavern: string): void {
  const list = presence.ready.get(week);
  if (list === undefined || list.includes(tavern) || presence.week !== week) return;
  list.push(tavern);
  presence.said.push({ week, tavern, at: events().length });
  if (pump === null) {
    void present(null, null).then(() => {
      const el = $('g-feed').querySelector<HTMLElement>(`[data-key="${CSS.escape(`ready:${week}:${tavern}`)}"]`);
      micron(el, 'pop', { duration: 0.4 });
      followFeed();
      renderBar();
    });
  }
}

/** Lock in: you're ready; wait for any rival who isn't (they hurry), then play the week. */
async function lockIn(moves: ReadonlyArray<PlayMove>): Promise<void> {
  const s = game.session;
  const stage = s?.stage;
  if (s === null || stage?.kind !== 'week' || game.locking) return;
  game.locking = true;
  const week = stage.week;
  const me = s.humanTavern!;
  const list = presence.ready.get(week) ?? [];
  presence.ready.set(week, list);
  if (!list.includes(me)) {
    list.push(me);
    presence.said.push({ week, tavern: me, at: events().length });
  }
  for (const t of presence.timers) window.clearTimeout(t);
  presence.timers = [];
  await present(null, null);
  followFeed();
  renderAll();
  const waiting = s.taverns.filter((t) => !list.includes(t));
  for (const tavern of waiting) {
    if (reducedMotion()) {
      ready(week, tavern);
      continue;
    }
    await new Promise((r) => window.setTimeout(r, jitter(350, 1000)));
    if (game.session !== s) return;
    ready(week, tavern);
  }
  await present(null, null);
  game.locking = false;
  if (game.session !== s) return;
  move([...moves, { t: 'week' }]);
}

/** A bot's pick lands: if its card is in your free agents, it is stamped taken until the list catches up. */
function stampTaken(character: string, tavern: string): void {
  const card = $('g-work').querySelector<HTMLElement>(`#g-fa [data-card="${CSS.escape(character)}"], #g-fa tr[data-row="${CSS.escape(character)}"]`);
  if (card !== null && tavern !== game.session?.humanTavern) {
    card.classList.add('taken');
    card.insertAdjacentHTML('beforeend', `<span class="stamp"${bannerAttr(tavern)}>${flagOf(tavern)} ${esc(tavernName(tavern))}</span>`);
  }
  window.clearTimeout(workTimer);
  workTimer = window.setTimeout(renderWork, 900);
}
let workTimer = 0;

function bannerColours(tavern: string | null): Banner | undefined {
  const god = tavern === null ? null : bannerOf(tavern);
  return god === null ? undefined : data.gods[god]!.banner;
}

// ── the room ───────────────────────────────────────────────────────────────

const ADP: ReadonlyMap<string, number> = new Map(Object.entries(data.adp));

function roomItems(): ReadonlyArray<FeedItem> {
  const s = game.session;
  if (s === null) return [];
  return feedItems(events().slice(0, shown.n), {
    me: s.humanTavern,
    teams: input.managers.length,
    rounds: config.draft.rounds,
    weeks: config.weeks,
    adp: ADP,
    ready: presence.said,
  });
}

/** Re-render the room from `items`, keeping every message whose markup hasn't changed; `fresh` is the one just added. */
function renderFeed(items: ReadonlyArray<FeedItem>, fresh: string | null): void {
  const feed = $('g-feed');
  if (game.session === null) {
    feed.innerHTML = setupHtml();
    return;
  }
  const ctx: Ctx = { me: game.session.humanTavern, round: currentRound(items), week: latestResults(items), state: shown.state };
  const existing = new Map([...feed.children].flatMap((el) => (el instanceof HTMLElement && el.dataset.key !== undefined ? [[el.dataset.key, el] as const] : [])));
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  let prev: Element | null = null;
  const keep = new Set<string>();
  for (const item of items) {
    keep.add(item.key);
    const html = itemHtml(item, ctx);
    let el = existing.get(item.key) ?? null;
    if (el === null || el.dataset.html !== hashOf(html)) {
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const next = tpl.content.firstElementChild as HTMLElement | null;
      if (next === null) continue;
      next.dataset.html = hashOf(html);
      if (item.key === fresh) next.classList.add('fresh');
      if (el === null) {
        if (prev === null) feed.prepend(next);
        else prev.after(next);
      } else el.replaceWith(next);
      el = next;
    }
    prev = el;
  }
  for (const [key, el] of existing) if (!keep.has(key)) el.remove();
  if (fresh !== null || atBottom) followFeed();
}

/** A short hash of a message's markup, to tell whether it changed. */
function hashOf(html: string): string {
  let h = 2166136261;
  for (let i = 0; i < html.length; i++) h = Math.imul(h ^ html.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36) + html.length.toString(36);
}

/** Keep the newest message in view, as a chat does. */
function followFeed(): void {
  const feed = $('g-feed');
  feed.scrollTop = feed.scrollHeight;
}

interface Ctx {
  readonly me: string | null;
  /** The draft's current round (earlier ones fold away). */
  readonly round: number;
  /** The latest week with results (earlier weeks fold away). */
  readonly week: number;
  readonly state: LeagueState;
}

const ICONS = {
  crier:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h3l6 4V6L6 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  ball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="7"/><path d="M7 19h10l1 3H6z"/><circle cx="9.5" cy="7.5" r="1.6" class="glint"/></svg>',
  steward: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2h9l4 4v16H6zM14 3v4h4M9 11h7M9 14h7M9 17h5"/></svg>',
} as const;

/** A message: an avatar, who said it, a note beside the name, and what they said. */
function msg(
  item: FeedItem,
  { avatar, author, note = '', body, cls = '', attrs = '' }: { avatar: string; author: string; note?: string; body: string; cls?: string; attrs?: string },
): string {
  return (
    `<li class="msg ${item.kind}${cls === '' ? '' : ` ${cls}`}" data-key="${esc(item.key)}"${attrs}>` +
    `<div class="av">${avatar}</div><div class="mbody"><div class="meta"><b class="author">${author}</b>${note === '' ? '' : ` <span class="note">${note}</span>`}</div>` +
    `<div class="text">${body}</div></div></li>`
  );
}
const sysAvatar = (icon: keyof typeof ICONS): string => `<span class="sys ${icon}">${ICONS[icon]}</span>`;
const tavernAvatar = (tavern: string): string => `<span class="tav"${bannerAttr(tavern)}>${flagOf(tavern) || `<span class="initial">${esc(tavernName(tavern).replace(/^The /, '').charAt(0))}</span>`}</span>`;

/** A `<details>` that remembers your choice, else opens by `open`. */
function fold(key: string, open: boolean, summary: string, body: string, cls = ''): string {
  const isOpen = folds.get(key) ?? open;
  return `<details class="fold${cls === '' ? '' : ` ${cls}`}" data-fold="${esc(key)}"${isOpen ? ' open' : ''}><summary>${summary}</summary>${body}</details>`;
}

function itemHtml(item: FeedItem, ctx: Ctx): string {
  const { me } = ctx;
  switch (item.kind) {
    case 'divider':
      return `<li class="divider" data-key="${esc(item.key)}"><span>${esc(item.label)}</span></li>`;
    case 'season': {
      const order = [...ctx.state.draft.managerOrder];
      const pickOrder = [...order].reverse();
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        body:
          `A new season opens: ${input.managers.length} taverns, ${item.pool} characters in the pool, ${config.weeks} weeks. ` +
          `Each keeper takes a tavern, then drafts ${config.draft.rounds} characters, and each week sends four of them on the week's mission. Most loot over the season wins.` +
          (pickOrder.length === 0 ? '' : `<p class="small muted">Taverns are chosen in reverse draft order: ${pickOrder.map((m) => esc(keeper(m))).join(' → ')}.</p>`),
      });
    }
    case 'tavern': {
      const god = godOf.get(item.tavern);
      const week = god === undefined ? null : (input.schedule.find((w) => w.sponsor === god)?.week ?? null);
      const mine = item.tavern === me;
      return msg(item, {
        avatar: tavernAvatar(item.tavern),
        author: esc(tavernName(item.tavern)),
        note: mine ? 'you' : esc(keeper(item.manager)),
        cls: mine ? 'mine' : '',
        attrs: mine ? bannerAttr(item.tavern) : '',
        body:
          `${mine ? 'You take' : `${esc(keeper(item.manager))} takes`} the tavern` +
          (god === undefined ? '.' : `, under the banner of <span class="god-name"${bannerAttr(item.tavern)}>${esc(godName(god))}</span>${week === null ? '' : `, whose mission is week ${week}`}.`),
      });
    }
    case 'round': {
      const open = item.round === ctx.round;
      const faces = item.calls.map((c) => portrait(c.character, 'sm')).join('');
      const lines = item.calls
        .map((c) => {
          const st = input.statsOf(c.character);
          const usually = `Usually goes around pick ${Math.round(c.adp ?? 0) + 1}; taken at ${c.pick + 1}`;
          const notes = c.notes.map((n) => (n === 'steal' ? ` <span class="tag good" title="${usually}">steal</span>` : ` <span class="tag" title="${usually}">reach</span>`)).join('');
          const mine = c.tavern === me;
          return (
            `<li class="call${mine ? ' mine' : ''}" data-seq="${c.seq}"${bannerAttr(c.tavern)}><span class="pk">${c.pick + 1}</span>` +
            `<span class="line">${flagOf(c.tavern)} <b>${esc(who(c.tavern, me))}</b> ${mine ? 'take' : 'takes'} ${portrait(c.character, 'sm')}<b class="who">${esc(charName(c.character))}</b> ` +
            `<span class="muted small">${esc(st.base.typeName)} · CR ${formatCr(crOf(c.character))}</span>${notes}</span></li>`
          );
        })
        .join('');
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        note: `round ${item.round} of ${config.draft.rounds}`,
        body: fold(
          item.key,
          open,
          `<span class="faces mini">${faces}</span><span class="muted small">${item.complete ? `${item.calls.length} picks` : `${item.calls.length} of ${input.managers.length}`}</span>`,
          `<ol class="calls">${lines}</ol>`,
        ),
      });
    }
    case 'draft-done': {
      const mine = me === null ? [] : (ctx.state.taverns.get(me)?.roster ?? []);
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        body:
          `The draft is done: every tavern has its ${item.rounds}.` +
          (mine.length === 0 ? '' : `<p class="small">Yours: <span class="faces">${mine.map((id) => `<span class="face">${portrait(id, 'sm')}${esc(charName(id))}</span>`).join('')}</span></p>`),
      });
    }
    case 'week-open': {
      const w = item.week;
      const title = input.schedule.find((x) => x.week === w)?.title ?? missionOf(w).id;
      const home = homeTavern(ctx.state, w);
      const homeText = home === null ? '' : home === me ? ' It is <b>your</b> god\'s week.' : ` It is ${esc(tavernName(home))}'s god's week.`;
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        note: `week ${w} of ${config.weeks}`,
        body:
          `Week ${w}: <b>${esc(title)}</b>, ${esc(environmentOf(w))}.${homeText} Lineups lock when every tavern is ready.` +
          keywordsLine(w),
      });
    }
    case 'ready': {
      const mine = item.tavern === me;
      return msg(item, {
        avatar: tavernAvatar(item.tavern),
        author: esc(tavernName(item.tavern)),
        cls: `compact${mine ? ' mine' : ''}`,
        attrs: mine ? bannerAttr(item.tavern) : '',
        body: mine ? 'You lock in your lineup.' : `${esc(keeper(managerOf(item.tavern) ?? ''))} has set a lineup and is ready.`,
      });
    }
    case 'hex': {
      const involves = item.tavern === me || item.target === me;
      const by = item.tavern;
      return msg(item, {
        avatar: tavernAvatar(by),
        author: esc(tavernName(by)),
        note: 'a hex',
        cls: involves ? 'involves' : '',
        body:
          `<div class="${involves ? 'curse' : ''}"${involves ? bannerAttr(item.tavern === me ? me : by) : ''}>${esc(who(by, me))} ${by === me ? 'hex' : 'hexes'} <b>${esc(who(item.target, me, true))}</b> for week ${item.week}: ` +
          `disadvantage on every ${esc(ABILITY_NAMES[item.ability])} check and save.</div>`,
      });
    }
    case 'claim':
      return msg(item, {
        avatar: tavernAvatar(item.tavern),
        author: esc(tavernName(item.tavern)),
        note: 'only you can see this',
        cls: 'mine private',
        attrs: bannerAttr(item.tavern),
        body: `You put in a claim: <b>+${esc(charName(item.add))}</b>${item.drop === null ? '' : `, dropping ${esc(charName(item.drop))}`}. It stays sealed until the claims resolve after the week.`,
      });
    case 'lock': {
      const rows = item.lineups
        .map((l) => {
          const source =
            l.source === 'carried'
              ? ' <span class="tag" title="No new lineup: last week\'s plays again">carried</span>'
              : l.source === 'fallback'
                ? ' <span class="tag bad" title="Last week\'s lineup could not play; the best legal one stands in">fallback</span>'
                : l.source === 'none'
                  ? ' <span class="tag bad">no lineup</span>'
                  : '';
          return (
            `<li class="${l.tavern === me ? 'mine' : ''}"${l.tavern === me ? bannerAttr(l.tavern) : ''}>${flagOf(l.tavern)} <b>${esc(who(l.tavern, me))}</b>${source} ` +
            `<span class="faces">${(l.lineup?.starters ?? []).map((id) => portrait(id, 'sm')).join('')}</span></li>`
          );
        })
        .join('');
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        note: `week ${item.week}`,
        body: `Lineups are locked for week ${item.week}.` + fold(item.key, false, '<span class="small">Every tavern\'s four</span>', `<ul class="lineups">${rows}</ul>`),
      });
    }
    case 'results':
      return resultsHtml(item, ctx);
    case 'table':
      return tableHtml(item, ctx);
    case 'waivers': {
      const awarded = item.outcomes.filter((o) => o.awarded).length;
      const mine = item.outcomes.filter((o) => o.tavern === me);
      const line = (o: (typeof item.outcomes)[number]): string =>
        `${flagOf(o.tavern)} <b>${esc(who(o.tavern, me))}</b>: +${esc(charName(o.add))}${o.drop === null ? '' : ` −${esc(charName(o.drop))}`} ` +
        `<span class="${o.awarded ? 'pass' : 'fail'}">${esc(waiverReasonLabel(o.reason))}</span>`;
      const all = item.outcomes.map((o) => `<li class="${o.tavern === me ? 'mine' : ''}">${line(o)}</li>`).join('');
      return msg(item, {
        avatar: sysAvatar('steward'),
        author: 'The steward',
        note: `after week ${item.week}`,
        body:
          (item.outcomes.length === 0 ? 'No claims this week.' : `Waivers: ${awarded} of ${item.outcomes.length} claim${item.outcomes.length === 1 ? '' : 's'} awarded.`) +
          (mine.length === 0 ? '' : `<ul class="claims">${mine.map((o) => `<li class="mine"${bannerAttr(o.tavern)}>${line(o)}</li>`).join('')}</ul>`) +
          (item.outcomes.length === 0 ? '' : fold(item.key, false, '<span class="small">Every claim</span>', `<ul class="claims">${all}</ul>`)),
      });
    }
  }
}

// ── a week's race ──────────────────────────────────────────────────────────

/** The steps of a run as pips: green for a pass or a win, red for a fail or a loss, a battle drawn wider. */
function strip(mission: Mission, run: RunResult | null): string {
  if (run === null) return '<span class="strip"><span class="run-end none">no lineup</span></span>';
  const pips = taleSteps(mission, run)
    .filter((st) => st.record !== null)
    .map((st) => {
      const r = st.record!;
      const ok = r.outcome === 'pass' || r.outcome === 'win';
      const what = r.kind === 'check' ? `${st.node}: ${r.outcome}` : `battle at ${st.node}: ${r.outcome === 'win' ? 'won' : 'lost'}`;
      return `<i class="pip ${ok ? 'ok' : 'no'}${r.kind === 'battle' ? ' battle' : ''}${st.bank > 0 ? ' bank' : ''}" title="${esc(what)}${st.bank > 0 ? ` (+${st.bank} loot)` : ''}"></i>`;
    })
    .join('');
  const cap = run.dnf
    ? '<span class="run-end dnf" title="Beaten: the party fled and dropped everything">DNF</span>'
    : run.retreatedBefore !== null
      ? `<span class="run-end back" title="Turned back before ${esc(run.retreatedBefore)}">turned back</span>`
      : '<span class="run-end home" title="Home with the loot">home</span>';
  return `<span class="strip">${pips}${cap}</span>`;
}

/** The hex that counted against `tavern` in `week` (the first declared, D-52), and who laid it. */
function curseOn(state: LeagueState, tavern: string, week: number): { readonly by: string; readonly ability: Ability } | null {
  const hex = state.hexes.find((h) => h.target === tavern && h.week === week);
  return hex === undefined ? null : { by: hex.tavern, ability: hex.ability };
}

/**
 * The scrying ball's account of a run: one line per check or battle in path order, then how it ended. Each line
 * carries its pip's index (`data-step`) and the loot banked so far (`data-total`); the outcome sits in `.outcome` and
 * the die in `[data-roll]`, so the race (fx.ts raceWeek) can roll the die and hold the outcome back.
 */
function taleHtml(mission: Mission, run: RunResult, mine: boolean, curse: { readonly by: string; readonly ability: Ability } | null): string {
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));
  const steps = taleSteps(mission, run);
  const banked = steps.at(-1)?.total ?? 0;
  const party = mine ? 'your party' : 'their party';
  const head =
    curse === null
      ? []
      : [
          `<li data-head="curse" class="curse"${bannerAttr(curse.by)}>${flagOf(curse.by)} ` +
            `<b>${esc(godOf.has(curse.by) ? godName(godOf.get(curse.by)!) : tavernName(curse.by))}</b>'s curse falls on ${party}, from <b>${esc(tavernName(curse.by))}</b>: ` +
            `disadvantage on every ${esc(ABILITY_NAMES[curse.ability])} check and save.</li>`,
        ];
  let step = 0;
  const lines = steps.flatMap(({ node: id, record: r, bank, total }) => {
    if (r === null) return [];
    const node = byId.get(id);
    const loot = bank > 0 ? ` <span class="tag brass" data-bank>+${bank} loot</span>` : '';
    const attrs = `data-node="${esc(id)}" data-step="${step++}" data-total="${total}"`;
    if (r.kind === 'check') {
      const sum = r.d20 + r.modifier;
      const gated = node?.kind === 'check' && node.check.requires !== undefined && sum >= r.dc && r.outcome === 'fail';
      const what = node?.kind === 'check' ? checkLabel(node.check) : id;
      const edge = r.advantage ? ' <span class="tag brass">adv</span>' : r.disadvantage ? ' <span class="tag bad" title="Hexed: the lower of two d20s">dis</span>' : '';
      return [
        `<li ${attrs} data-kind="check"><b>${esc(what)}</b>: ${esc(charName(r.actor))} rolls ` +
          `<span class="die ${r.d20 === 20 ? 'hi' : r.d20 === 1 ? 'lo' : ''}" data-roll="d20">${r.d20}</span>${edge} ` +
          `<span class="outcome">${signed(r.modifier)} = ${sum} vs DC ${r.dc}: <span class="${r.outcome}">${r.outcome}</span>${gated ? ' <span class="tag bad">gate</span>' : ''}${loot}</span></li>`,
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
    lines.push(`<li data-tail="dnf" data-total="0"><span class="fail">Beaten.</span> The party flees${banked > 0 ? `, dropping all ${banked} loot` : ' with nothing'}.</li>`);
    if (run.injury !== null) lines.push(`<li data-tail="injury" data-total="0"><b data-hurt>${esc(charName(run.injury.character))}</b> limps home hurt and sits out next week.</li>`);
  } else if (run.retreatedBefore === null) {
    lines.push(`<li data-tail="home" data-total="${run.loot}">Home with ${run.loot} loot.</li>`);
  }
  return `<ol class="tale">${[...head, ...lines].join('')}</ol>`;
}

function resultsHtml(item: Extract<FeedItem, { kind: 'results' }>, ctx: Ctx): string {
  const { me } = ctx;
  const mission = missionOf(item.week);
  const title = input.schedule.find((x) => x.week === item.week)?.title ?? mission.id;
  const latest = item.week === ctx.week;
  const order = [...ctx.state.draft.order];
  const mineRun = item.runs.find((r) => r.tavern === me);
  const outcome =
    mineRun === undefined || mineRun.run === null
      ? 'quiet'
      : weekOutcome({ rank: mineRun.rank, points: mineRun.points, projected: mineRun.projectedPoints, dnf: mineRun.run.dnf, retreated: mineRun.run.retreatedBefore !== null });
  const headline =
    mineRun === undefined
      ? ''
      : mineRun.rank === 1 && mineRun.points > 0
        ? `<b class="pass">You topped the week</b> with ${num(mineRun.points)}`
        : `You came <b>${ordinal(mineRun.rank)}</b> of ${item.runs.length} with ${num(mineRun.points)}`;
  const lane = (r: FeedRun): string => {
    const mine = r.tavern === me;
    const tale = r.run === null ? '<p class="small muted">Fielded no legal lineup, so ran nothing (D-27).</p>' : taleHtml(mission, r.run, mine, curseOn(ctx.state, r.tavern, item.week));
    const counter = mine && r.run !== null ? `<p class="small loot-line">loot carried <b class="num" data-loot="${r.run.loot}">${r.run.loot}</b></p>` : '';
    const graph =
      mine && r.run !== null
        ? fold(`${item.key}:map`, false, '<span class="small">The map of your run</span>', graphSvg(layouts.get(item.week)!, { path: r.run.path, outcomes: new Map(r.run.nodes.map((n) => [n.node, n.outcome])) }) + graphLegend({ path: r.run.path }))
        : '';
    const summary =
      `<span class="rk">${r.rank}</span>${flagOf(r.tavern)}<b class="tn">${esc(who(r.tavern, me))}</b>${strip(mission, r.run)}` +
      `<b class="pts num" data-pts="${r.points}" title="Projected ${r.projectedPoints.toFixed(0)}">${r.points}</b>`;
    return (
      `<li class="lane${mine ? ' mine' : ''}" data-tavern="${esc(r.tavern)}" data-rank="${r.rank}" data-order="${mine ? 99 : Math.max(0, order.indexOf(r.tavern))}"${mine ? bannerAttr(r.tavern) : ''}>` +
      fold(`${item.key}:${r.tavern}`, mine && latest, summary, `<div class="lane-tale">${counter}${tale}${graph}</div>`) +
      `</li>`
    );
  };
  return msg(item, {
    avatar: sysAvatar('ball'),
    author: 'The scrying ball',
    note: `week ${item.week}: ${esc(title)}`,
    attrs: ` data-outcome="${outcome}" data-week="${item.week}"`,
    body:
      (headline === '' ? '' : `<p class="headline" data-headline>${headline}.</p>`) +
      `<ol class="race">${[...item.runs].sort((a, b) => a.rank - b.rank || order.indexOf(a.tavern) - order.indexOf(b.tavern)).map(lane).join('')}</ol>` +
      (latest ? `<p class="race-foot"><button type="button" class="link small" data-action="g-replay" data-key="${esc(item.key)}">Watch again</button></p>` : ''),
  });
}

function tableHtml(item: Extract<FeedItem, { kind: 'table' }>, ctx: Ctx): string {
  const { me } = ctx;
  const latest = item.week === ctx.week;
  const rows = item.rows
    .map((r) => {
      const move =
        item.week === 1
          ? ''
          : `<td class="n move">${r.rose > 0 ? `<span class="pass" title="Up ${r.rose}">▲${r.rose}</span>` : r.rose < 0 ? `<span class="fail" title="Down ${-r.rose}">▼${-r.rose}</span>` : '<span class="muted">–</span>'}</td>`;
      const mine = r.tavern === me;
      return (
        `<tr class="${mine ? 'mine' : ''}${item.final && r.rank === 1 ? ' champ' : ''}"${mine ? bannerAttr(r.tavern) : ''} data-was="${r.wasRow}"><td class="n">${r.rank}</td>${move}` +
        `<td>${flagOf(r.tavern)} <b>${esc(who(r.tavern, me))}</b></td><td class="n">${r.points}</td></tr>`
      );
    })
    .join('');
  const table = `<table class="mini-table"><tbody>${rows}</tbody></table>`;
  if (!item.final) {
    return msg(item, {
      avatar: sysAvatar('crier'),
      author: 'The crier',
      note: `the table after week ${item.week}`,
      body: fold(item.key, latest, `<span class="small">${esc(leaderLine(item.rows, me))}</span>`, table),
    });
  }
  // The season's end: a champion's message flies their banner (fx.ts crownChampion), else the champion is hailed.
  const champs = item.rows.filter((r) => r.rank === 1).map((r) => r.tavern);
  const mine = item.rows.find((r) => r.tavern === me);
  if (me !== null && champs.includes(me)) {
    return (
      `<li class="msg table season-final champion banner-card" data-key="${esc(item.key)}"${bannerAttr(me)}><div class="pennant" aria-hidden="true"></div>` +
      `<h2>${flagOf(me)} ${champs.length === 1 ? 'Champions of the League' : 'Co-champions of the League'}</h2>` +
      `<p class="banner-call">${esc(tavernName(me))} ${champs.length === 1 ? 'takes the season' : 'shares the title'} with ${num(mine?.points ?? 0)} loot${godOf.has(me) ? ` under the banner of <b>${esc(godName(godOf.get(me)!))}</b>` : ''}.</p>` +
      table +
      `</li>`
    );
  }
  const weeks = [...ctx.state.finalizedWeeks].flatMap((week) => {
    const res = ctx.state.results.get(week);
    if (res === undefined || me === null) return [];
    const pts = [...res.values()].map((x) => x.points);
    const mineRes = res.get(me);
    if (mineRes === undefined) return [];
    return [{ week, points: mineRes.points, rank: 1 + pts.filter((p) => p > mineRes.points).length }];
  });
  const best = bestWeek(weeks);
  const champLine = champs
    .map((t) => `<span class="champ-line"${bannerAttr(t)}>${flagOf(t)} <b>${esc(tavernName(t))}</b>${godOf.has(t) ? ` under the banner of <b>${esc(godName(godOf.get(t)!))}</b>` : ''}</span>`)
    .join(' and ');
  return (
    `<li class="msg table season-final" data-key="${esc(item.key)}"><div class="av">${sysAvatar('crier')}</div><div class="mbody">` +
    `<div class="meta"><b class="author">The crier</b> <span class="note">the season is over</span></div><div class="text">` +
    `<h2>Final standings</h2><p>${champLine} ${champs.length === 1 ? 'wins' : 'share'} the season.</p>` +
    (mine === undefined
      ? ''
      : `<p class="finish">You finish <b>${ordinal(mine.rank)} of ${item.rows.length}</b> with ${num(mine.points)} loot.` +
        (best === null || best.points === 0 ? '' : ` Your best week was week ${best.week}: ${num(best.points)} loot${best.topped ? ', and you topped it' : ''}.`) +
        `</p>`) +
    table +
    `</div></div></li>`
  );
}

/** One line on the table: who leads and where you stand. */
function leaderLine(rows: ReadonlyArray<{ readonly tavern: string; readonly rank: number; readonly points: number }>, me: string | null): string {
  const leaders = rows.filter((r) => r.rank === 1);
  const mine = rows.find((r) => r.tavern === me);
  const lead = leaders.map((r) => (r.tavern === me ? 'You' : tavernName(r.tavern))).join(' and ');
  const you = mine === undefined || mine.rank === 1 ? '' : `; you are ${ordinal(mine.rank)} with ${mine.points}`;
  return `${lead} ${leaders.length === 1 ? (leaders[0]!.tavern === me ? 'lead' : 'leads') : 'share the lead'} with ${leaders[0]?.points ?? 0}${you}`;
}

// ── setup ──────────────────────────────────────────────────────────────────

function setupHtml(): string {
  const options = input.managers.map((m) => `<option value="${esc(m.id)}" ${m.id === game.manager ? 'selected' : ''}>${esc(KEEPERS[seatOf.get(m.id) ?? 0] ?? m.id)}'s seat (${esc(m.bot)} bot)</option>`).join('');
  return (
    `<li class="welcome" data-key="welcome"><div class="card">` +
    `<h2>Play against the bots</h2>` +
    `<p>Take one of the ${input.managers.length} seats and run a tavern against the five keepers in the others. Choose a tavern, draft ${config.draft.rounds} characters, ` +
    `and each week send four on the week's mission. The most loot after ${config.weeks} weeks wins.</p>` +
    `<p class="small muted">Everything that happens is told here, in ${ROOM}. The keepers think quickly, but not instantly.</p>` +
    (game.error === null ? '' : `<div class="error">${esc(game.error)}</div>`) +
    (game.notice === null ? '' : `<p class="hint" role="status">${esc(game.notice)}</p>`) +
    `<div class="row"><label class="label" for="g-seat">Seat</label><select id="g-seat" data-action="g-seat">${options}</select>` +
    `<label class="label" for="g-seed">Seed</label><input type="text" id="g-seed" data-action="g-seed" placeholder="random" value="${esc(game.seed)}" spellcheck="false" autocomplete="off"></div>` +
    `<div class="row"><button type="button" class="primary" data-action="g-start">Start the season</button></div>` +
    `<p class="hint">The seed drives the draft order, the keepers and the dice, so the same seed and the same moves give the same season. Your season is saved in this browser as you play.</p>` +
    `</div></li>`
  );
}

// ── the action bar ─────────────────────────────────────────────────────────

function renderBar(): void {
  const bar = $('g-bar');
  const s = game.session;
  bar.hidden = s === null;
  if (s === null) return;
  const typingLine = (t: { tavern: string | null; label: string; verb: string }): string =>
    `<span class="typing">${t.tavern === null ? '' : `<span class="tav"${bannerAttr(t.tavern)}>${flagOf(t.tavern)}</span>`}<b>${esc(t.label)}</b> ${esc(t.verb)}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></span>`;
  if (pump !== null) {
    bar.innerHTML =
      `<div class="bar-line">${pump.typing === null ? '<span class="muted small">…</span>' : typingLine(pump.typing)}</div>` +
      `<button type="button" class="small" data-action="g-skip" title="Tell the rest at once (Esc)">Skip</button>`;
    return;
  }
  const stage = s.stage;
  const err = game.error === null ? '' : `<div class="error small">${esc(game.error)}</div>`;
  if (stage.kind === 'tavern') {
    bar.innerHTML =
      stage.manager === s.human?.manager
        ? `${err}<div class="bar-line" data-clock><b>Your turn to choose a tavern.</b></div><button type="button" class="primary" data-action="g-view" data-view="work">Choose a tavern</button>`
        : `<div class="bar-line muted">Waiting on ${esc(keeper(stage.manager))}…</div>`;
    return;
  }
  if (stage.kind === 'draft') {
    const n = input.managers.length;
    bar.innerHTML =
      stage.tavern === s.humanTavern
        ? `${err}<div class="bar-line" data-clock><b>You're on the clock:</b> pick ${stage.pick + 1}, round ${Math.floor(stage.pick / n) + 1} of ${config.draft.rounds}.</div>` +
          `<button type="button" class="primary" data-action="g-view" data-view="work">Open the draft</button>`
        : `<div class="bar-line muted">Waiting on ${esc(tavernName(stage.tavern))}…</div>`;
    return;
  }
  if (stage.kind === 'week') {
    const w = stage.week;
    const list = presence.ready.get(w) ?? [];
    const me = s.humanTavern!;
    const flags = s.taverns
      .map((t) => `<span class="rdy${list.includes(t) ? ' on' : ''}" title="${esc(tavernName(t))}${list.includes(t) ? ' is ready' : ' is still setting a lineup'}"${bannerAttr(t)}>${flagOf(t) || esc(tavernName(t).charAt(0))}</span>`)
      .join('');
    const waiting = s.taverns.filter((t) => !list.includes(t) && t !== me).length;
    const status = game.locking ? `Waiting on ${waiting} tavern${waiting === 1 ? '' : 's'}…` : waiting === 0 ? 'Every rival is ready: waiting on you.' : `${s.taverns.length - 1 - waiting} of ${s.taverns.length - 1} rivals ready.`;
    const check = lineupCheck(s, w);
    bar.innerHTML =
      `${err}<div class="bar-line"${waiting === 0 && !game.locking ? ' data-clock' : ''}><span class="ready-row">${flags}</span> <span class="small">${status}</span></div>` +
      `<span class="bar-actions">${game.view === 'work' ? '<button type="button" class="small narrow-only" data-action="g-view" data-view="room">Common Room</button>' : '<button type="button" class="small narrow-only" data-action="g-view" data-view="work">Lineup</button>'}` +
      `<button type="button" class="primary" data-action="g-lock" ${check.ok && !game.locking ? '' : 'disabled'} title="${esc(check.why)}">Lock in · play week ${w}</button></span>`;
    return;
  }
  bar.innerHTML =
    `<div class="bar-line"><b>The season is over.</b></div>` +
    `<span class="bar-actions"><button type="button" class="small" data-action="g-workshop">Open it in the workshop</button><button type="button" class="primary" data-action="g-reset">New season</button></span>`;
}

// ── the header ─────────────────────────────────────────────────────────────

function renderHead(): void {
  const s = game.session;
  const head = $('g-head');
  const me = s?.humanTavern ?? null;
  // Your tavern shows once the room has told it.
  const told = me !== null && shown.state.taverns.has(me);
  // Where the season stands, as far as the room has told it.
  const st = shown.state;
  const where =
    s === null
      ? 'A season against the bots'
      : st.taverns.size < s.state.managers.size
        ? `Tavern pick · ${st.taverns.size + 1} of ${s.state.managers.size}`
        : !st.draft.complete
          ? `Draft · pick ${st.draft.picks + 1} of ${config.draft.rounds * s.state.managers.size}`
          : st.finalizedWeeks.size < config.weeks
            ? `Week ${st.finalizedWeeks.size + 1} of ${config.weeks}`
            : 'Season complete';
  const rows = seasonStandings(shown.state);
  const row = rows.find((r) => r.tavern === me);
  const rec = row === undefined || shown.state.finalizedWeeks.size === 0 ? '' : ` · ${ordinal(row.rank)} of ${rows.length}, ${row.points} loot`;
  const god = told ? bannerOf(me) : null;
  const chrome = god === null ? undefined : data.gods[god];
  const reset =
    s === null
      ? ''
      : game.confirmReset
        ? `<span class="small" role="alert">Abandon this season?</span><button type="button" class="small" data-action="g-reset-confirm">Abandon</button><button type="button" class="small primary" data-action="g-reset-cancel">Keep playing</button>`
        : `<button type="button" class="small" data-action="g-reset">New season</button>`;
  head.innerHTML =
    (told
      ? `<div class="you${chrome === undefined ? '' : ' banner-card'}"${bannerAttr(me)}>${chrome === undefined ? '' : '<div class="pennant" aria-hidden="true"></div>'}` +
        `<div class="you-line">${flagOf(me)}<b class="you-name">${esc(tavernName(me))}</b><span class="small">${esc(where)}${rec}</span></div>` +
        (chrome === undefined ? '' : `<p class="banner-call"><span class="label">${esc(chrome.name)}</span> ${esc(chrome.call ?? `You fight under the banner of ${chrome.name}.`)}</p>`) +
        `</div>`
      : `<div class="you plain"><div class="you-line"><b class="you-name">${s === null ? 'No season yet' : 'No tavern yet'}</b><span class="small">${esc(where)}</span></div></div>`) +
    `<div class="head-actions">${reset}${s === null ? '' : `<span class="small muted">seed ${esc(s.seed)}</span>`}</div>`;
}

// ── tabs ───────────────────────────────────────────────────────────────────

/** The workspace's tab follows the season: the taverns, the draft, your lineup, and your roster at the end. */
function workLabel(): string {
  const s = game.session;
  if (s === null) return 'Draft';
  if (shown.state.taverns.size < s.state.managers.size) return 'Taverns';
  if (!shown.state.draft.complete) return 'Draft';
  return caughtUp() && s.stage.kind === 'complete' ? 'Roster' : 'Lineup';
}

function renderTabs(): void {
  $('g-tab-work').textContent = workLabel();
  for (const b of document.querySelectorAll<HTMLButtonElement>('#g-tabs button[data-view]')) {
    const on = b.dataset.view === game.view;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('game').dataset.view = game.view;
}

function setView(next: View): void {
  game.view = next;
  storageSet('lot-play-view', next);
  renderTabs();
  renderBar();
  if (next === 'room') followFeed();
}

// ── the workspace ──────────────────────────────────────────────────────────

/** Re-render the workspace, keeping its scroll and the filter box's focus. */
function renderWork(): void {
  const work = $('g-work');
  const top = work.scrollTop;
  const active = document.activeElement;
  const focusId = active instanceof HTMLElement && work.contains(active) ? active.id : '';
  const caret = active instanceof HTMLInputElement ? active.selectionStart : null;
  work.innerHTML = workHtml();
  work.scrollTop = top;
  if (focusId !== '') {
    const el = document.getElementById(focusId);
    el?.focus({ preventScroll: true });
    if (el instanceof HTMLInputElement && caret !== null) el.setSelectionRange(caret, caret);
  }
}

function workHtml(): string {
  const s = game.session;
  if (s === null) return '<div class="empty"><p class="muted">Start a season in the Common Room.</p></div>';
  const told = caughtUp();
  const stage = s.stage;
  // During the tavern pick and the draft, the workspace follows the room pick by pick; a week waits for the room.
  if (!shown.state.draft.complete || (told && stage.kind === 'draft')) {
    if (shown.state.taverns.size < s.state.managers.size || (told && stage.kind === 'tavern')) return workTaverns(s, told);
    return workDraft(s, told);
  }
  if (!told) {
    return `<div class="empty"><p>The week is playing out in ${ROOM}.</p><button type="button" class="small" data-action="g-skip">Skip to the end</button></div>`;
  }
  if (stage.kind === 'week') return workWeek(s, stage.week);
  return workDone(s);
}

/** The tavern pick (D-52): every tavern is already blessed by its god; you choose a tavern, not a god. */
function workTaverns(s: SeasonSession, told: boolean): string {
  const state = shown.state;
  const yours = told && s.stage.kind === 'tavern' && s.stage.manager === s.human?.manager;
  const rows = input.taverns
    .map((t) => {
      const owner = state.taverns.get(t.id)?.managerId;
      const god = godOf.get(t.id);
      const week = god === undefined ? null : (input.schedule.find((w) => w.sponsor === god)?.week ?? null);
      const action =
        owner === undefined
          ? `<button type="button" class="small${yours ? ' primary' : ''}" data-action="g-tavern" data-id="${esc(t.id)}" ${yours ? '' : 'disabled title="Not your turn yet"'}>Choose</button>`
          : `<span class="small">${esc(keeper(owner))}</span>`;
      return (
        `<tr class="${owner === undefined ? '' : 'taken-row'}"${bannerAttr(t.id)}><td>${action}</td><td>${flagOf(t.id)} <b>${esc(t.name)}</b></td>` +
        `<td class="small"><span class="${bannerOf(t.id) === null ? '' : 'god-name'}">${god === undefined ? '—' : esc(godName(god))}</span></td><td class="n small">${week ?? '—'}</td></tr>`
      );
    })
    .join('');
  return (
    `<section class="card"><div class="row spread"><h2>Choose your tavern</h2><span class="muted small">${yours ? 'your turn' : 'in reverse draft order'}</span></div>` +
    `<p class="small">Every tavern is already blessed by one god, who sets one week's mission, and fights under that god's banner. For now the taverns differ only in their god's week.</p>` +
    `<div class="scroll"><table><thead><tr><th></th><th>tavern</th><th>god</th><th class="n">god's week</th></tr></thead><tbody>${rows}</tbody></table></div></section>`
  );
}

function workDraft(s: SeasonSession, told: boolean): string {
  const state = shown.state;
  const me = s.humanTavern!;
  const yours = told && s.stage.kind === 'draft' && s.stage.tavern === me;
  const mine = state.taverns.get(me)?.roster ?? [];
  const q = game.filter.trim().toLowerCase();
  const available = freeAgents(state);
  const values = s.draftValues(available);
  const list = available
    .filter((id) => matchesFilter(id, q))
    .sort((a, b) => (game.draftSort === 'value' ? values.get(b)! - values.get(a)! : crOf(b) - crOf(a)) || charName(a).localeCompare(charName(b)));
  const draftButton = (id: string): string =>
    `<button type="button" class="small${yours ? ' primary' : ''}" data-action="g-draft" data-id="${esc(id)}" ${yours ? '' : 'disabled'}>Draft</button>`;
  const fa =
    game.faView === 'cards'
      ? `<div id="g-fa" class="deck">${list.map((id) => charCard(id, { foot: `${draftButton(id)}<span class="small muted" title="The bots' rating">value ${values.get(id)!.toFixed(2)}</span>` })).join('') || '<p class="muted">No match.</p>'}</div>`
      : `<div id="g-fa" class="scroll"><table><thead><tr>${CHAR_HEAD}<th class="n" title="The bots' rating">value</th></tr></thead><tbody>${
          list.map((id) => charRow(id, draftButton(id), `<td class="n small">${values.get(id)!.toFixed(2)}</td>`).replace('<tr>', `<tr data-row="${esc(id)}">`)).join('') ||
          '<tr><td colspan="8" class="muted">No match.</td></tr>'
        }</tbody></table></div>`;
  const picks = s.events.slice(0, shown.n).flatMap((e) => (e.type === 'draft.pick' ? [e.payload] : []));
  const board = draftBoard(state.draft.order, picks)
    .map(
      (row) =>
        `<tr class="${row.direction}"><td class="rd">R${row.round}</td>${row.cells
          .map((c) => (c === null ? '<td></td>' : `<td class="${c.tavern === me ? 'hot' : ''}"><span class="face">${portrait(c.character, 'sm')}<span><span class="pk">#${c.pick + 1}</span> ${esc(charName(c.character))}</span></span></td>`))
          .join('')}</tr>`,
    )
    .join('');
  const stage = told ? s.stage : null;
  const status = yours
    ? `<b>You're on the clock</b> · pick ${(stage as { pick: number }).pick + 1}`
    : `<span class="muted">${stage?.kind === 'draft' ? `${esc(tavernName(stage.tavern))} is on the clock` : 'The picks are coming in'}</span>`;
  return (
    `<section class="card${yours ? ' on-clock' : ''}" id="g-clock"><div class="row spread"><h2>The draft</h2><span class="small">${status}</span></div>` +
    `<div class="stack"><span class="label">Your roster · ${mine.length} of ${config.roster.size}</span>` +
    (mine.length === 0 ? '<p class="muted small">Nobody yet.</p>' : `<div class="deck" id="g-roster">${mine.map((id) => charCard(id, { owner: me })).join('')}</div>`) +
    `<p class="hint">Each week you start ${config.roster.starters} with total CR at most ${formatCr(BUDGET)}.</p></div></section>` +
    `<section class="card"><div class="row"><h3>Free agents</h3><input type="text" id="g-filter" placeholder="Filter by name, base or skill" value="${esc(game.filter)}" data-action="g-filter">` +
    `<label class="label" for="g-sort">Sort</label><select id="g-sort" data-action="g-sort"><option value="value" ${game.draftSort === 'value' ? 'selected' : ''}>value, best first</option><option value="cr" ${game.draftSort === 'cr' ? 'selected' : ''}>CR, high first</option></select>` +
    `<label class="label" for="g-fa-view">Show</label><select id="g-fa-view" data-action="g-fa-view"><option value="cards" ${game.faView === 'cards' ? 'selected' : ''}>cards</option><option value="table" ${game.faView === 'table' ? 'selected' : ''}>table</option></select></div>` +
    fa +
    `<p class="hint">Value is the bots' rating: battle strength plus skill breadth, per CR, with the cheapest picks rated as if they cost more, since unspent budget is worth nothing.</p></section>` +
    `<section class="card">${fold('work:board', false, '<h3 style="display:inline">Draft board</h3>', `<div class="scroll"><table class="draft"><thead><tr><th>round</th>${state.draft.order.map((t) => `<th class="${t === me ? 'hot' : ''}">${esc(who(t, me))}</th>`).join('')}</tr></thead><tbody>${board || `<tr><td colspan="${state.draft.order.length + 1}" class="muted">No picks yet.</td></tr>`}</tbody></table></div>`)}</section>`
  );
}

/** Point the builder at the week: the submitted lineup, else last week's, else nobody. Drops anyone no longer on the roster or hurt. */
function syncBuilder(s: SeasonSession, week: number): void {
  const roster = new Set(myRoster(s));
  if (game.builderWeek !== week) {
    game.builderWeek = week;
    const me = s.humanTavern!;
    const lineup = s.pendingLineup() ?? s.state.lockedLineups.get(week - 1)?.find((l) => l.tavern === me)?.lineup ?? null;
    game.picks = lineup === null ? [] : [...lineup.starters];
    game.retreat = lineup?.retreat ?? 'never';
  }
  const hurt = injuredFor(s.state, week);
  game.picks = game.picks.filter((id) => roster.has(id) && !hurt.has(id));
  if (!roster.has(game.drop)) game.drop = '';
  if (!freeAgents(s.state).includes(game.add)) game.add = '';
}

function builderLineup(): Lineup | null {
  if (game.picks.length === 0) return null;
  return { starters: game.picks, retreat: game.retreat } as unknown as Lineup;
}

/** Whether the lineup on screen can play, and why not. With no legal lineup on the roster at all, the week still plays (and scores 0). */
function lineupCheck(s: SeasonSession, week: number): { readonly ok: boolean; readonly why: string; readonly stuck: boolean } {
  syncBuilder(s, week);
  const lineup = builderLineup();
  const hurt = injuredFor(s.state, week);
  const violations = lineup === null ? [{ code: 'empty', message: 'Pick your starters first.' }] : validateLineup(lineup, { tavern: s.humanTavern!, characters: myRoster(s) }, crOf, config, { unavailable: hurt });
  const stuck = violations.length > 0 && s.suggestLineup() === null;
  return { ok: violations.length === 0 || stuck, why: violations.length === 0 ? '' : stuck ? 'No legal lineup exists on your roster: you will score 0.' : violations.map((v) => v.message).join(' '), stuck };
}

function homeLine(s: SeasonSession, week: number): string {
  const home = homeTavern(s.state, week);
  if (home === null) return 'no sponsor this week';
  if (home === s.humanTavern!) return `<b>your god's week</b>${config.scoring.homeBonus === 1 ? '' : `: loot × ${config.scoring.homeBonus}`}`;
  return `${esc(tavernName(home))}'s god's week`;
}

function workWeek(s: SeasonSession, week: number): string {
  const me = s.humanTavern!;
  const mission = missionOf(week);
  const title = input.schedule.find((x) => x.week === week)?.title ?? mission.id;
  const roster = myRoster(s);
  const check = lineupCheck(s, week);
  const lineup = builderLineup();
  const hurt = injuredFor(s.state, week);
  const violations = lineup === null ? [] : validateLineup(lineup, { tavern: me, characters: roster }, crOf, config, { unavailable: hurt });
  const projection = lineup === null ? null : projectMission(partyFrom(lineup.starters, input.statsOf, hexOn(s.state, me, week)), mission, input.baseOf, input.battleModel, { retreat: lineup.retreat });
  const home = homeTavern(s.state, week) === me;
  const total = game.picks.reduce((t, id) => t + crOf(id), 0);

  const starters = game.picks.filter((id) => roster.includes(id));
  const bench = roster.filter((id) => !game.picks.includes(id));
  const full = game.picks.length >= config.roster.starters;
  const starterCard = (id: string): string =>
    charCard(id, {
      owner: me,
      foot: `<span class="small muted">#${game.picks.indexOf(id) + 1}</span><button type="button" class="small" data-action="g-bench" data-id="${esc(id)}" aria-label="Move ${esc(charName(id))} to the bench">Bench</button>`,
    });
  const benchCard = (id: string): string =>
    hurt.has(id)
      ? charCard(id, { dim: true, foot: '<span class="tag bad" title="Hurt in last week\'s DNF: can\'t start this week (D-51)">injured</span>' })
      : charCard(id, { foot: `<button type="button" class="small" data-action="g-start-char" data-id="${esc(id)}" aria-label="Start ${esc(charName(id))}" ${full ? 'disabled title="Bench a starter first"' : ''}>Start</button>` });
  const lineupCard =
    `<section class="card" id="g-lineup"><div class="row spread"><h2>Week ${week}: ${esc(title)}</h2><span class="muted small">${esc(environmentOf(week))} · ${homeLine(s, week)}</span></div>` +
    keywordsLine(week) +
    `<div class="stack"><span class="label">Starting · <b>${starters.length} of ${config.roster.starters}</b></span>` +
    (starters.length === 0 ? '<p class="muted small">Nobody yet: press Start on the bench below.</p>' : `<div class="deck" id="g-starters">${starters.map(starterCard).join('')}</div>`) +
    `</div><div class="stack"><span class="label">Bench · <b>${bench.length}</b></span>` +
    (bench.length === 0 ? '<p class="muted small">Nobody on the bench.</p>' : `<div class="deck" id="g-bench">${bench.map(benchCard).join('')}</div>`) +
    `</div>` +
    `<p class="small">CR total ${num(formatCrTotal(total))} of ${num(formatCrTotal(BUDGET))}</p>${crMeter(total)}` +
    `<div class="row">${retreatSelect('g-retreat', 'g-retreat', game.retreat)}</div>` +
    (lineup === null ? '' : violations.length === 0 ? '<p class="okline">Legal lineup</p>' : violationList(violations)) +
    (projection === null
      ? ''
      : `<div class="kv"><div><span class="label">expected points</span><span class="v">${projectedPoints(projection.expectedScore, config.scoring, home).toFixed(1)}</span></div>` +
        `<div><span class="label">chance of DNF</span><span class="v">${pct(projection.pDnf)}</span></div>` +
        `<div><span class="label">chance to turn back</span><span class="v">${pct(projection.pRetreat)}</span></div></div>` +
        retreatTable(partyFrom(lineup!.starters, input.statsOf, hexOn(s.state, me, week)), mission, game.retreat, home) +
        fold('work:graph', false, '<span class="small">The mission map, with your chance to reach each step</span>', graphSvg(layouts.get(week)!, { reach: projection.reach }) + graphLegend({ reach: projection.reach }))) +
    `<div class="row spread lock-row"><span class="small">${check.ok ? (check.stuck ? '<span class="fail">No legal lineup exists on your roster, so you will score 0.</span>' : 'Ready when you are.') : `<span class="fail">${esc(check.why)}</span>`}</span>` +
    `<button type="button" class="primary" data-action="g-lock" ${check.ok && !game.locking ? '' : 'disabled'}>Lock in · play week ${week}</button></div>` +
    `</section>`;

  let waivers = '';
  if (week < config.weeks) {
    const fa = freeAgents(s.state);
    const claims = s.pendingClaims().filter((c) => c.tavern === me);
    const priority = waiverPriority(s.state);
    waivers =
      `<section class="card"><h2>Waivers</h2>` +
      `<p class="small muted">Claims are sealed and resolve after week ${week}'s run, in waiver priority order (yours: ${priority.indexOf(me) + 1} of ${priority.length}${config.waivers.priority === 'reverse_standings' ? ', lowest on the table first' : ''}). A claim can't be withdrawn.</p>` +
      `<div class="row"><label class="label" for="g-add">Add</label><select id="g-add" data-action="g-add"><option value="">choose a free agent</option>${fa
        .map((id) => `<option value="${esc(id)}" ${id === game.add ? 'selected' : ''}>${esc(charName(id))} (CR ${formatCr(crOf(id))})</option>`)
        .join('')}</select>` +
      `<label class="label" for="g-drop">Drop</label><select id="g-drop" data-action="g-drop"><option value="">nobody${roster.length >= config.roster.size ? ' (roster is full)' : ''}</option>${roster
        .map((id) => `<option value="${esc(id)}" ${id === game.drop ? 'selected' : ''}>${esc(charName(id))} (CR ${formatCr(crOf(id))})</option>`)
        .join('')}</select>` +
      `<button type="button" data-action="g-claim" ${game.add === '' ? 'disabled' : ''}>Claim</button></div>` +
      (claims.length === 0 ? '' : `<p class="small">Your sealed claims: ${claims.map((c) => `+<b>${esc(charName(c.add))}</b>${c.drop === null ? '' : ` −${esc(charName(c.drop))}`}`).join('; ')}</p>`) +
      `</section>`;
  }
  return lineupCard + workHex(s, week) + waivers;
}

/** Your hex form while you still hold it (D-52). A hex is public at once and can't be withdrawn, so declaring takes a second click. */
function workHex(s: SeasonSession, week: number): string {
  const me = s.humanTavern!;
  const used = s.state.hexes.some((h) => h.tavern === me);
  if (used) return '';
  const rivals = s.taverns.filter((t) => t !== me);
  const weeks = WEEKS.filter((w) => w >= week);
  const target = game.hexTarget !== '' && rivals.includes(game.hexTarget) ? game.hexTarget : rivals[0]!;
  const hexWeek = Math.max(game.hexWeek, week);
  const form = game.confirmHex
    ? `<div class="row curse-confirm"${bannerAttr(me)} role="alert"><span>Curse <b>${esc(tavernName(target))}</b>: disadvantage on every ${esc(ABILITY_NAMES[game.hexAbility])} check and save in week ${hexWeek}? ` +
      `Everyone sees it at once, and it can't be withdrawn.</span>` +
      `<button type="button" class="primary" data-action="g-hex-confirm">Lay the curse</button><button type="button" data-action="g-hex-cancel">Not yet</button></div>`
    : `<div class="row"><label class="label" for="g-hex-target">Rival</label><select id="g-hex-target" data-action="g-hex-target">${rivals
        .map((t) => `<option value="${esc(t)}" ${t === target ? 'selected' : ''}>${esc(tavernName(t))}</option>`)
        .join('')}</select>` +
      `<label class="label" for="g-hex-ability">Ability</label><select id="g-hex-ability" data-action="g-hex-ability">${ABILITIES.map((a) => `<option value="${a}" ${a === game.hexAbility ? 'selected' : ''}>${esc(ABILITY_NAMES[a])}</option>`).join('')}</select>` +
      `<label class="label" for="g-hex-week">Week</label><select id="g-hex-week" data-action="g-hex-week">${weeks
        .map((w) => `<option value="${w}" ${w === hexWeek ? 'selected' : ''}>${w}: ${esc(input.schedule.find((x) => x.week === w)?.title ?? missionOf(w).id)}</option>`)
        .join('')}</select>` +
      `<button type="button" data-action="g-hex">Declare hex…</button></div>`;
  return (
    `<section class="card">${fold(
      'work:hex',
      game.confirmHex,
      '<h2 style="display:inline">Your hex</h2> <span class="small muted">once a season</span>',
      `${form}<p class="hint">That week the rival has disadvantage on every check and save using the ability. It is public at once and can't be withdrawn, and only the first hex on a rival in a week counts.</p>`,
    )}</section>`
  );
}

function workDone(s: SeasonSession): string {
  const me = s.humanTavern!;
  const roster = myRoster(s);
  return (
    `<section class="card"><h2>Your tavern's roster</h2><div class="deck">${roster.map((id) => charCard(id, { owner: me })).join('')}</div></section>` +
    `<section class="card"><p>The whole season is in the workshop: every week's table, title odds, luck and the loot left on the bench.</p>` +
    `<div class="row"><button type="button" data-action="g-workshop">Open it in the workshop</button><button type="button" class="primary" data-action="g-reset">New season</button></div></section>`
  );
}

// ── the standings ──────────────────────────────────────────────────────────

function renderTable(): void {
  const el = $('g-table');
  const s = game.session;
  if (s === null) {
    el.innerHTML = '<div class="empty"><p class="muted">No season yet.</p></div>';
    return;
  }
  const state = shown.state;
  const me = s.humanTavern;
  const rows = seasonStandings(state);
  const played = [...state.finalizedWeeks].sort((a, b) => a - b);
  const weekly = (tavern: string): string =>
    WEEKS.map((w) => {
      const res = state.results.get(w);
      if (res === undefined) return '<td class="n muted">·</td>';
      const pts = res.get(tavern)?.points ?? 0;
      const top = Math.max(...[...res.values()].map((x) => x.points));
      return `<td class="n ${pts === top && pts > 0 ? 'win' : 'muted'}" title="Week ${w}${pts === top && pts > 0 ? ': topped the week' : ''}">${pts}</td>`;
    }).join('');
  const before = played.length < 2 ? null : (() => {
    const prev = new Map<string, number>();
    for (const w of played.slice(0, -1)) for (const [t, r] of state.results.get(w) ?? []) prev.set(t, (prev.get(t) ?? 0) + r.points);
    const list = [...state.taverns.keys()].map((t) => ({ tavern: t, points: prev.get(t) ?? 0 }));
    return new Map(list.map((r) => [r.tavern, 1 + list.filter((o) => o.points > r.points).length]));
  })();
  const body = rows
    .map((r) => {
      const was = before?.get(r.tavern);
      const rose = was === undefined ? 0 : was - r.rank;
      const mv = before === null ? '' : `<td class="n move">${rose > 0 ? `<span class="pass">▲${rose}</span>` : rose < 0 ? `<span class="fail">▼${-rose}</span>` : '<span class="muted">–</span>'}</td>`;
      const m = state.taverns.get(r.tavern)?.managerId ?? '';
      const mine = r.tavern === me;
      return (
        `<tr class="${mine ? 'mine' : ''}"${mine ? bannerAttr(r.tavern) : ''}><td class="n">${r.rank}</td>${mv}<td>${flagOf(r.tavern)} <b>${esc(tavernName(r.tavern))}</b></td>` +
        `<td class="small">${mine ? 'you' : `${esc(keeper(m))} <span class="muted">${esc(botOfManager.get(m) ?? '')}</span>`}</td><td class="n"><b>${r.points}</b></td>${weekly(r.tavern)}</tr>`
      );
    })
    .join('');
  const table =
    state.taverns.size === 0
      ? '<p class="muted">No taverns chosen yet.</p>'
      : `<div class="scroll"><table><thead><tr><th class="n">#</th>${before === null ? '' : '<th class="n" title="Places moved since last week">±</th>'}<th>tavern</th><th>keeper</th><th class="n">loot</th>${WEEKS.map((w) => `<th class="n">W${w}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>` +
        `<p class="hint">Ranked by total loot; equal totals share a rank. W1–W${config.weeks} are each week's loot, bold where the tavern topped the week.</p>`;
  const rosters = [...state.taverns.values()]
    .map((t) => `<li class="${t.id === me ? 'mine' : ''}"${t.id === me ? bannerAttr(t.id) : ''}>${flagOf(t.id)} <b>${esc(who(t.id, me))}</b> <span class="faces">${t.roster.map((id) => `<span title="${esc(charName(id))}">${portrait(id, 'sm')}</span>`).join('')}</span></li>`)
    .join('');
  const hexes = state.hexes.map((h) => `<li>${flagOf(h.tavern)} ${esc(who(h.tavern, me))} → ${esc(who(h.target, me, true))}: ${esc(ABILITY_NAMES[h.ability])}, week ${h.week}</li>`).join('');
  el.innerHTML =
    `<section class="card"><div class="row spread"><h2>Standings</h2><span class="small muted">${played.length === 0 ? 'no week played yet' : `after week ${played.at(-1)} of ${config.weeks}`}</span></div>${table}</section>` +
    (rosters === '' ? '' : `<section class="card"><h3>Rosters</h3><ul class="rosters">${rosters}</ul></section>`) +
    (hexes === '' ? '' : `<section class="card"><h3>Hexes declared</h3><ul class="hexes small">${hexes}</ul></section>`);
}

// ── rendering ──────────────────────────────────────────────────────────────

function renderAll(): void {
  renderHead();
  renderTabs();
  if (game.session === null) $('g-feed').innerHTML = setupHtml();
  else void present(null, null);
  renderBar();
  renderWork();
  renderTable();
}

// ── wiring ─────────────────────────────────────────────────────────────────

/** Skip whatever the room is telling. */
function skip(): void {
  pump?.pace.skip();
}

function onClick(action: string, el: HTMLElement): void {
  const id = el.dataset.id;
  const s = game.session;
  switch (action) {
    case 'g-start':
      start();
      return;
    case 'g-skip':
      skip();
      return;
    case 'g-view':
      setView((el.dataset.view as View | undefined) ?? 'work');
      return;
    case 'g-workshop':
      document.dispatchEvent(new CustomEvent('lot:mode', { detail: 'workshop' }));
      return;
    case 'g-reset':
      if (s !== null && s.stage.kind !== 'complete') game.confirmReset = true;
      else {
        reset();
        return;
      }
      renderHead();
      return;
    case 'g-reset-confirm':
      reset();
      return;
    case 'g-reset-cancel':
      game.confirmReset = false;
      renderHead();
      return;
    case 'g-tavern':
      if (id !== undefined) move([{ t: 'tavern', id }]);
      return;
    case 'g-draft':
      if (id !== undefined) {
        move([{ t: 'draft', id }]);
        // Your pick lands in your roster and turns over into your colours.
        renderWork();
        turnCard($('g-work').querySelector<HTMLElement>(`#g-roster [data-card="${CSS.escape(id)}"]`));
      }
      return;
    case 'g-start-char':
      if (id !== undefined && game.picks.length < config.roster.starters && !game.picks.includes(id)) {
        game.picks.push(id);
        const over = game.picks.reduce((t, p) => t + crOf(p), 0) > BUDGET;
        renderWork();
        renderBar();
        turnCard($('g-work').querySelector<HTMLElement>(`#g-starters [data-card="${CSS.escape(id)}"]`));
        nodMeter($('g-work').querySelector('#g-lineup .meter'), over ? 'over' : 'fits');
      }
      return;
    case 'g-bench':
      if (id !== undefined) {
        game.picks = game.picks.filter((p) => p !== id);
        renderWork();
        renderBar();
      }
      return;
    case 'g-hex':
      game.confirmHex = true;
      renderWork();
      return;
    case 'g-hex-cancel':
      game.confirmHex = false;
      renderWork();
      return;
    case 'g-hex-confirm': {
      const stage = s?.stage;
      game.confirmHex = false;
      if (s === null || stage?.kind !== 'week') return;
      const rivals = s.taverns.filter((t) => t !== s.humanTavern);
      const target = game.hexTarget !== '' && rivals.includes(game.hexTarget) ? game.hexTarget : rivals[0]!;
      move([{ t: 'hex', target, ability: game.hexAbility, week: Math.max(game.hexWeek, stage.week) }]);
      renderWork();
      return;
    }
    case 'g-claim':
      move([{ t: 'claim', add: game.add, drop: game.drop === '' ? null : game.drop }], () => {
        game.add = '';
        game.drop = '';
      });
      renderWork();
      return;
    case 'g-lock': {
      // Locking in plays the lineup on screen: what you see is what plays.
      const stage = s?.stage;
      if (s === null || stage?.kind !== 'week') return;
      const check = lineupCheck(s, stage.week);
      if (!check.ok) return;
      const lineup = builderLineup();
      const pending = s.pendingLineup();
      const same = pending !== null && lineup !== null && pending.starters.join() === lineup.starters.join() && retreatValue(pending.retreat) === retreatValue(lineup.retreat);
      const moves: PlayMove[] = lineup === null || same || check.stuck ? [] : [{ t: 'lineup', starters: [...lineup.starters], retreat: lineup.retreat }];
      setView('room');
      void lockIn(moves);
      return;
    }
    case 'g-replay': {
      const key = el.dataset.key;
      const msgEl = key === undefined ? null : $('g-feed').querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (msgEl === null || pump !== null) return;
      const pace = pacer();
      pump = { pace, typing: null };
      renderBar();
      void raceWeek(msgEl, pace).then(() => {
        pump = null;
        renderBar();
        if (!pace.skipped) weekMoment(msgEl, bannerColours(game.session?.humanTavern ?? null));
      });
      return;
    }
  }
}

function onChange(action: string, target: HTMLInputElement | HTMLSelectElement): void {
  switch (action) {
    case 'g-seat':
      game.manager = target.value;
      return;
    case 'g-add':
      game.add = target.value;
      renderWork();
      return;
    case 'g-drop':
      game.drop = target.value;
      return;
    case 'g-hex-target':
      game.hexTarget = target.value;
      return;
    case 'g-hex-ability':
      game.hexAbility = target.value as Ability;
      return;
    case 'g-hex-week':
      game.hexWeek = Number(target.value);
      return;
    case 'g-retreat':
      game.retreat = parseRetreat(target.value);
      renderWork();
      return;
    case 'g-sort':
      game.draftSort = target.value as typeof game.draftSort;
      renderWork();
      return;
    case 'g-fa-view':
      game.faView = target.value === 'table' ? 'table' : 'cards';
      storageSet('lot-playground-fa-view', game.faView);
      renderWork();
      return;
  }
}

/** Back from the workshop: the room picks up at its newest message. */
export function showGame(): void {
  renderTabs();
  followFeed();
}

/** Wire the game to the page and show it: the saved season if there is one, else the welcome. */
export function initGame({ onComplete }: { readonly onComplete: (s: SeasonSession) => void }): void {
  loadIntoWorkshop = onComplete;
  const root = $('game');
  root.addEventListener('click', (ev) => {
    const target = ev.target as HTMLElement;
    // A fold you open or close yourself stays that way through re-renders.
    const summary = target.closest('summary');
    const details = summary?.parentElement;
    if (details instanceof HTMLDetailsElement && details.dataset.fold !== undefined && !target.closest('button, a, input, select')) {
      folds.set(details.dataset.fold, !details.open);
    }
    const el = target.closest<HTMLElement>('[data-action]');
    if (el?.dataset.action !== undefined && !(el instanceof HTMLSelectElement) && !(el instanceof HTMLInputElement)) onClick(el.dataset.action, el);
  });
  root.addEventListener('change', (ev) => {
    const target = ev.target as HTMLInputElement | HTMLSelectElement;
    if (target.dataset.action !== undefined) onChange(target.dataset.action, target);
  });
  root.addEventListener('input', (ev) => {
    const target = ev.target as HTMLInputElement;
    if (target.dataset.action === 'g-seed') game.seed = target.value;
    if (target.dataset.action === 'g-filter') {
      game.filter = target.value;
      renderWork();
    }
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && pump !== null && $('game').offsetParent !== null) skip();
  });
  // Arrow keys, Home and End move between the tabs, as in any tab list.
  $('g-tabs').addEventListener('keydown', (ev) => {
    const order = [...document.querySelectorAll<HTMLButtonElement>('#g-tabs button[data-view]')].filter((b) => b.offsetParent !== null).map((b) => b.dataset.view as View);
    const i = order.indexOf(game.view);
    const next =
      ev.key === 'ArrowRight' ? order[(i + 1) % order.length] : ev.key === 'ArrowLeft' ? order[(i - 1 + order.length) % order.length] : ev.key === 'Home' ? order[0] : ev.key === 'End' ? order.at(-1) : undefined;
    if (next === undefined) return;
    ev.preventDefault();
    setView(next);
    document.querySelector<HTMLButtonElement>(`#g-tabs button[data-view="${next}"]`)?.focus();
  });
  restore();
  // A restored season is shown whole: everything in the log is already told.
  if (game.session !== null) for (const item of roomItems()) presented.add(item.key);
  renderAll();
  followFeed();
  afterTelling();
}
