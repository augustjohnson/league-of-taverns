/**
 * The game: one season of the Lich's contest against the bot taverns, told
 * in the Common Room.
 *
 * The Common Room is the season's running story: the tavern pick, the draft
 * pick by pick, every episode's calls, the challenge in the scrying ball,
 * the vote read one parchment at a time, each head-to-head round's results
 * and the finale, as messages in a chat no one can type into (the items
 * come from the event log, ./feed.ts). Beside it sit a workspace for your
 * move (the taverns, the draft, the episode's cast to call from) and the
 * standings.
 *
 * The bots decide at once and the engine records it all at once, but the
 * room announces it at a person's pace: a rival is "on the clock" for a
 * second or so before its pick lands, and whispers its call before the
 * challenge. Everything on the page shows the league as the room has told
 * it, so nothing gets ahead of the story. Skip (or Esc) tells the rest at
 * once; a reload shows everything.
 *
 * Your season is saved in this browser as its seed, tavern seat and your
 * moves, and replayed on reload.
 */
import { applyEvent, episodeScore, initialState, roundMatchups, roundOf, seasonStandings } from '@league-of-taverns/engine';
import type { LeagueEvent, LeagueState } from '@league-of-taverns/engine';
import type { Banner } from '@league-of-taverns/scripts/lib/banner';
import { ContestSession } from '../season-runner';
import { currentDraftRound, feedItems, latestEpisode, type FeedItem } from './feed';
import { clockBack, crownChampion, hailChampion, micron, pacer, raiseBanner, readJury, readVotes, reducedMotion, revealChallenge, roundMoment, slideStandings, turnCard, type Pacer } from './fx';
import {
  $,
  ABILITY_NAMES,
  VOTES,
  bannerAttr,
  bannerOf,
  challengeChrome,
  charCard,
  charName,
  config,
  cryptoRand,
  data,
  esc,
  flagOf,
  input,
  matchesFilter,
  num,
  ordinal,
  portrait,
  storageGet,
  storageRemove,
  storageSet,
  strategyBadge,
  tavernName,
} from './shared';
import { checkLabel, decidedAfter, draftBoard, ranksOf, readingOrder, runningTally, seedWords, signed, voteOrdinal } from './view';

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
/** A tavern by name, or "You" for yours (`you` for the object of a sentence). */
function who(tavern: string, me: string | null, object = false): string {
  return tavern === me ? (object ? 'you' : 'You') : tavernName(tavern);
}
/** Your possessive or the tavern's. */
function whose(tavern: string, me: string | null): string {
  return tavern === me ? 'your' : `${tavernName(tavern)}'s`;
}

// ── moves, saved ───────────────────────────────────────────────────────────

/** One of your moves. A season is its seed, your seat and these, replayed in order, so it can be saved and restored. */
type PlayMove =
  | { readonly t: 'tavern'; readonly id: string }
  | { readonly t: 'draft'; readonly id: string }
  | { readonly t: 'call'; readonly target: string }
  | { readonly t: 'challenge' }
  | { readonly t: 'vote' }
  | { readonly t: 'finale' };

interface SavedPlay {
  readonly v: 2;
  /** The season package and engine the moves were made against; anything else would replay differently. */
  readonly fingerprint: string;
  readonly manager: string;
  readonly seed: string;
  readonly moves: ReadonlyArray<PlayMove>;
}

const PLAY_KEY = 'lot-playground-contest';
const PLAY_FINGERPRINT = `${data.version}:${config.id}:${data.configSha256}:${input.engineVersion}:${input.challenges.map((c) => c.sha256.slice(0, 12)).join(',')}`;

type View = 'room' | 'work' | 'table';
const VIEWS: ReadonlyArray<View> = ['room', 'work', 'table'];

const game = {
  session: null as ContestSession | null,
  /** The manager seat you take. */
  manager: input.managers[0]?.id ?? '',
  seed: '',
  error: null as string | null,
  notice: null as string | null,
  moves: [] as PlayMove[],
  /** "New season" waits for a second, confirming click. */
  confirmReset: false,
  /** On a narrow screen, the one view showing; on a wide one the room always shows, beside `work` or `table`. */
  view: ((VIEWS as ReadonlyArray<string>).includes(storageGet('lot-play-view') ?? '') ? storageGet('lot-play-view') : 'room') as View,
  draftSort: 'scouts' as 'scouts' | 'power' | 'cr' | 'name',
  filter: '',
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

/** The telling under way, if any: its clock, and who is "typing" right now. */
interface Pump {
  readonly pace: Pacer;
  typing: { readonly tavern: string | null; readonly label: string; readonly verb: string } | null;
  /** A "Watch again": it gives way to anything new in the log. */
  readonly replay?: boolean;
}
let pump: Pump | null = null;
/** Keys of the items the room has presented; anything else is new. */
const presented = new Set<string>();
/** Folds you opened or closed yourself, by key, so a re-render keeps them. */
const folds = new Map<string, boolean>();

// ── the season ─────────────────────────────────────────────────────────────

function newSession(manager: string, seed: string): ContestSession {
  const session = new ContestSession(input, { seed, human: { manager, login: 'you', githubId: 1 } });
  session.advanceDraft();
  return session;
}

function applyMove(s: ContestSession, m: PlayMove): void {
  switch (m.t) {
    case 'tavern':
      s.chooseTavern(m.id);
      s.advanceDraft();
      break;
    case 'draft':
      s.draftPick(m.id);
      s.advanceDraft();
      break;
    case 'call':
      s.call(m.target);
      break;
    case 'challenge':
      s.runChallenge();
      break;
    case 'vote':
      s.runVote();
      break;
    case 'finale':
      s.runFinale();
      break;
  }
}

function save(): void {
  const s = game.session;
  if (s === null) return;
  const saved: SavedPlay = { v: 2, fingerprint: PLAY_FINGERPRINT, manager: s.human!.manager, seed: s.seed, moves: game.moves };
  storageSet(PLAY_KEY, JSON.stringify(saved));
}

function clearRoom(): void {
  shown.n = 0;
  shown.state = initialState();
  presented.clear();
  folds.clear();
  pump?.pace.skip();
  pump = null;
  $('g-feed').innerHTML = '';
}

/** Rebuild a saved season by replaying its moves, so a reload or a closed tab loses nothing. The room shows it all at once. */
function restore(): void {
  const raw = storageGet(PLAY_KEY);
  if (raw === null) return;
  try {
    const saved = JSON.parse(raw) as SavedPlay;
    if (saved.v !== 2 || saved.fingerprint !== PLAY_FINGERPRINT) throw new Error('it was played against another version of the season or engine');
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
    Object.assign(game, { session, seed, moves: [], filter: '', confirmReset: false });
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
  Object.assign(game, { session: null, error: null, notice: null, seed: '', moves: [], confirmReset: false });
  storageRemove(PLAY_KEY);
  renderAll();
}

/** Make moves, keeping each one the engine accepts; a refusal shows as an error and stops there. Then the room tells what followed. */
function move(moves: ReadonlyArray<PlayMove>): void {
  const s = game.session;
  if (s === null) return;
  game.error = null;
  game.notice = null;
  try {
    for (const m of moves) {
      applyMove(s, m);
      game.moves.push(m);
    }
  } catch (e) {
    game.error = e instanceof Error ? e.message : String(e);
  }
  save();
  if (s.stage.kind === 'complete') loadIntoWorkshop(s);
  void tell();
}

let loadIntoWorkshop: (s: ContestSession) => void = () => {};

function myRoster(state: LeagueState, me: string | null): ReadonlyArray<string> {
  return me === null ? [] : (state.taverns.get(me)?.roster ?? []);
}

// ── the room tells it ──────────────────────────────────────────────────────

/** A random wait in [lo, hi) ms, from the page's crypto: presentation only, never the engine's dice. */
const jitter = (lo: number, hi: number): number => Math.round(lo + (hi - lo) * cryptoRand());

/** Who is "typing" before an event lands, and for how long; null for an event that lands at once. */
function typingFor(e: LeagueEvent, me: string | null): { tavern: string | null; label: string; verb: string; ms: number } | null {
  const bot = e.actor.kind === 'bot';
  switch (e.type) {
    case 'tavern.chosen':
      return bot ? { tavern: null, label: keeper(e.payload.manager), verb: 'is choosing a tavern', ms: jitter(900, 1800) } : null;
    case 'draft.pick': {
      if (!bot) return null;
      // The first rounds take a little longer: there is more to weigh.
      const early = e.payload.pick < input.managers.length ? 350 : 0;
      return { tavern: e.payload.tavern, label: who(e.payload.tavern, me), verb: 'is on the clock', ms: early + jitter(600, 1400) };
    }
    case 'call.made':
      return bot ? { tavern: e.payload.tavern, label: who(e.payload.tavern, me), verb: 'is whispering to the barkeep', ms: jitter(350, 800) } : null;
    case 'challenge.resolved':
      return { tavern: null, label: 'The scrying ball', verb: 'is clouding over', ms: 900 };
    case 'vote.resolved':
      return { tavern: null, label: 'The Lich', verb: 'is collecting the ballots', ms: 1100 };
    case 'finale.resolved':
      return { tavern: null, label: 'The jury', verb: 'is shuffling in', ms: 1300 };
    case 'round.finalized':
      return { tavern: null, label: 'The crier', verb: 'is tallying the round', ms: 700 };
    default:
      return null;
  }
}

/** How long the room rests after an item lands, by kind. */
const REST: Partial<Record<FeedItem['kind'], number>> = { divider: 200, season: 600, tavern: 450, 'draft-done': 900, 'episode-open': 500, call: 150, challenge: 600, vote: 700, round: 900, finale: 900 };

/**
 * Tell the room what the log holds and it hasn't shown: an event at a time, each with its typing pause, each new item
 * presented with its own moment. Skip (or Esc) shows the rest at once.
 */
async function tell(): Promise<void> {
  const s = game.session;
  if (s === null) return;
  // A replay gives way: the log has news, and the room tells it.
  if (pump?.replay === true) pump.pace.skip();
  else if (pump !== null) return;
  const pace = pacer();
  const mine: Pump = { pace, typing: null };
  pump = mine;
  if (reducedMotion()) pace.skip();
  renderBar();
  renderWork();
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
  const told = (): ReadonlyArray<FeedItem> => items.filter((it) => presented.has(it.key));
  if (pace === null || pace.skipped) {
    const fresh = new Set(items.flatMap((it) => (presented.has(it.key) ? [] : [it.key])));
    for (const key of fresh) presented.add(key);
    renderFeed(told(), fresh);
  } else {
    for (const item of items) {
      if (presented.has(item.key)) continue;
      presented.add(item.key);
      renderFeed(told(), new Set([item.key]));
      if (pace.skipped) continue;
      await momentFor(item, pace);
      await pace.sleep(REST[item.kind] ?? 0);
    }
    // Items that grew (a draft round) re-render in place.
    renderFeed(told(), new Set());
  }
  if (landed?.type === 'tavern.chosen' || landed?.type === 'vote.resolved' || landed?.type === 'challenge.resolved') renderWork();
  if (landed?.type === 'draft.pick') {
    const line = $('g-feed').querySelector<HTMLElement>(`[data-seq="${landed.seq}"]`);
    line?.classList.add('fresh');
    followFeed();
    if (pace !== null && !pace.skipped) {
      const { character, tavern } = landed.payload;
      if (tavern === s.humanTavern) {
        renderWork();
        turnCard($('g-work').querySelector<HTMLElement>(`#g-roster [data-card="${CSS.escape(character)}"]`));
        await pace.sleep(500);
      } else {
        stampTaken(character, tavern);
        await pace.sleep(200);
      }
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
  const say = (label: string, verb: string): void => {
    if (pump === null) return;
    pump.typing = { tavern: null, label, verb };
    renderBar();
  };
  const hush = (): void => {
    if (pump === null) return;
    pump.typing = null;
    renderBar();
  };
  switch (item.kind) {
    case 'tavern':
      if (item.tavern === me) {
        renderHead();
        const banner = bannerColours(me);
        if (banner !== undefined) raiseBanner($('g-head').querySelector<HTMLElement>('.banner-card'), banner);
      }
      return;
    case 'call':
      micron(el, 'pop', { duration: 0.4 });
      return;
    case 'challenge':
      say('The scrying ball', `shows episode ${item.episode}`);
      await revealChallenge(el, pace, bannerColours(me));
      hush();
      return;
    case 'vote':
      say('The Lich', 'reads the votes');
      await readVotes(el, pace, bannerColours(me));
      hush();
      return;
    case 'finale':
      say('The Lich', 'reads the jury');
      await readJury(el, pace);
      hush();
      return;
    case 'round': {
      slideStandings(el.querySelector('table'));
      const mine = item.matchups.find((m) => m.home === me || m.away === me);
      const outcome = mine === undefined ? 'none' : mine.winner === null ? 'tied' : mine.winner === me ? 'won' : 'lost';
      roundMoment(el, outcome, bannerColours(me));
      if (item.final) {
        const champs = item.rows.filter((r) => r.rank === 1).map((r) => r.tavern);
        await pace.sleep(900);
        if (me !== null && champs.includes(me)) crownChampion(el, bannerColours(me));
        else hailChampion(el, bannerColours(champs[0] ?? null));
      }
      return;
    }
    default:
      return;
  }
}

/** When the room has caught up: nod if the move is yours again. */
function afterTelling(): void {
  const s = game.session;
  if (s === null || !caughtUp()) return;
  const stage = s.stage;
  const yours =
    (stage.kind === 'tavern' && stage.manager === s.human?.manager) ||
    (stage.kind === 'draft' && stage.tavern === s.humanTavern) ||
    stage.kind === 'challenge' ||
    stage.kind === 'vote' ||
    stage.kind === 'finale';
  if (yours) clockBack($('g-bar'));
}

/** A bot's pick lands: if its card is in your free agents, it is stamped taken until the list catches up. */
function stampTaken(character: string, tavern: string): void {
  const card = $('g-work').querySelector<HTMLElement>(`#g-fa [data-card="${CSS.escape(character)}"]`);
  if (card !== null) {
    card.classList.add('taken');
    card.insertAdjacentHTML('beforeend', `<span class="stamp"${bannerAttr(tavern)}>${flagOf(tavern)} ${esc(tavernName(tavern))}</span>`);
  }
  window.clearTimeout(workTimer);
  workTimer = window.setTimeout(renderWork, 900);
}
let workTimer = 0;

function bannerColours(tavern: string | null): Banner | undefined {
  return tavern === null || bannerOf(tavern) === null ? undefined : data.tavernChrome[tavern]!.banner;
}

// ── the scouts ─────────────────────────────────────────────────────────────

/** The scouts' report: each cast member's expected points (the number the scouting bots draft by), cached per season. */
let scoutCache: { seed: string; values: ReadonlyMap<string, number>; ranks: ReadonlyMap<string, number> } | null = null;
function scouting(s: ContestSession): { readonly values: ReadonlyMap<string, number>; readonly ranks: ReadonlyMap<string, number> } {
  if (scoutCache?.seed !== s.seed) {
    const values = s.scouting();
    scoutCache = { seed: s.seed, values, ranks: ranksOf(values) };
  }
  return scoutCache;
}

/** The scouts' rating as stars, 1 to 5, by where the monster ranks in the cast. */
function stars(s: ContestSession, id: string): string {
  const { ranks } = scouting(s);
  const rank = ranks.get(id) ?? ranks.size;
  const n = Math.max(1, 5 - Math.floor((5 * rank) / Math.max(1, ranks.size)));
  return `<span class="stars" title="The scouts' rating: ${n} of 5, from simulated contests with this cast. The real challenges are secret.">${'★'.repeat(n)}<span class="dim">${'★'.repeat(5 - n)}</span></span>`;
}

// ── the room ───────────────────────────────────────────────────────────────

function roomItems(): ReadonlyArray<FeedItem> {
  const s = game.session;
  if (s === null) return [];
  return feedItems(events().slice(0, shown.n), {
    me: s.humanTavern,
    teams: input.managers.length,
    rounds: config.roster.size,
    ranks: shown.state.draft.picks > 0 ? scouting(s).ranks : new Map(),
  });
}

/** Re-render the room from `items`, keeping every message whose markup hasn't changed; `fresh` are the ones just added. */
function renderFeed(items: ReadonlyArray<FeedItem>, fresh: ReadonlySet<string>): void {
  const feed = $('g-feed');
  if (game.session === null) {
    feed.innerHTML = setupHtml();
    return;
  }
  const ctx: Ctx = { me: game.session.humanTavern, round: currentDraftRound(items), episode: latestEpisode(items), state: shown.state };
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
      if (fresh.has(item.key)) next.classList.add('fresh');
      if (el === null) {
        if (prev === null) feed.prepend(next);
        else prev.after(next);
      } else el.replaceWith(next);
      el = next;
    }
    prev = el;
  }
  for (const [key, el] of existing) if (!keep.has(key)) el.remove();
  if (fresh.size > 0 || atBottom) followFeed();
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
  /** The latest episode opened (earlier ones fold away). */
  readonly episode: number;
  readonly state: LeagueState;
}

const ICONS = {
  crier:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h3l6 4V6L6 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  ball: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="10" r="7"/><path d="M7 19h10l1 3H6z"/><circle cx="9.5" cy="7.5" r="1.6" class="glint"/></svg>',
  lich: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2C7.6 2 4 5.4 4 9.7c0 2.6 1.3 4.6 3 5.8V19l2 1 1-1.4L11 20h2l1-1.4 1 1.4 2-1v-3.5c1.7-1.2 3-3.2 3-5.8C20 5.4 16.4 2 12 2zm-3.5 11a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6zm7 0a1.8 1.8 0 1 1 0-3.6 1.8 1.8 0 0 1 0 3.6z"/></svg>',
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

/** A monster's name with its face, and its tavern's flag when someone drafted it. */
function monster(id: string, state: LeagueState, me: string | null, size: 'sm' | 'md' = 'sm'): string {
  const owner = state.owner.get(id);
  const mine = owner !== undefined && owner === me;
  return `<span class="mon${mine ? ' mine' : ''}"${owner === undefined ? '' : bannerAttr(owner)} title="${esc(charName(id))}${owner === undefined ? ', undrafted' : `, ${whose(owner, me)}`}">${portrait(id, size)}<b>${esc(charName(id))}</b>${owner === undefined ? '' : flagOf(owner)}</span>`;
}

function itemHtml(item: FeedItem, ctx: Ctx): string {
  const { me, state } = ctx;
  switch (item.kind) {
    case 'divider':
      return `<li class="divider" data-key="${esc(item.key)}"><span>${esc(item.label)}</span></li>`;
    case 'season': {
      const pickOrder = [...state.draft.managerOrder].reverse();
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        body:
          `The Lich wants a new assistant, and ${item.cast.length} monsters have come for the job. Every episode he sets a task: the winner is safe, and the rest vote one of their own out. ` +
          `When ${config.contest.finalists} are left, the voted-out choose the winner.` +
          `<p>Each tavern drafts ${config.roster.size}, then watches. Call the boot each episode for ${config.scoring.call} (+${config.scoring.earlyCallBonus} if you call before the challenge). ` +
          `Taverns meet head to head over ${config.schedule.rounds.length} rounds: best record wins the season.</p>` +
          (pickOrder.length === 0 ? '' : `<p class="small muted">Taverns are chosen in reverse draft order: ${pickOrder.map((m) => esc(keeper(m))).join(' → ')}.</p>`),
      });
    }
    case 'tavern': {
      const mine = item.tavern === me;
      const toast = data.tavernChrome[item.tavern]?.toast;
      return msg(item, {
        avatar: tavernAvatar(item.tavern),
        author: esc(tavernName(item.tavern)),
        note: mine ? 'you' : esc(keeper(item.manager)),
        cls: mine ? 'mine' : '',
        attrs: mine ? bannerAttr(item.tavern) : '',
        body: `${mine ? 'You take' : `${esc(keeper(item.manager))} takes`} the tavern.${toast === undefined ? '' : ` <i class="toast">"${esc(toast)}"</i>`}`,
      });
    }
    case 'draft-round': {
      const open = item.round === ctx.round;
      const faces = item.calls.map((c) => portrait(c.character, 'sm')).join('');
      const lines = item.calls
        .map((c) => {
          const card = input.cardOf(c.character);
          const usually = c.rank === null ? '' : `The scouts rank them ${ordinal(c.rank + 1)}; taken ${ordinal(c.pick + 1)}`;
          const notes = c.notes.map((n) => (n === 'steal' ? ` <span class="tag good" title="${usually}">steal</span>` : ` <span class="tag" title="${usually}">reach</span>`)).join('');
          const mine = c.tavern === me;
          return (
            `<li class="call${mine ? ' mine' : ''}" data-seq="${c.seq}"${bannerAttr(c.tavern)}><span class="pk">${c.pick + 1}</span>` +
            `<span class="line">${flagOf(c.tavern)} <b>${esc(who(c.tavern, me))}</b> ${mine ? 'take' : 'takes'} ${portrait(c.character, 'sm')}<b class="who">${esc(charName(c.character))}</b> ` +
            `<span class="muted small">${esc(card.stats.base.typeName)}</span> ${strategyBadge(card.strategy)}${notes}</span></li>`
          );
        })
        .join('');
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        note: `round ${item.round} of ${config.roster.size}`,
        body: fold(
          item.key,
          open,
          `<span class="faces mini">${faces}</span><span class="muted small">${item.complete ? `${item.calls.length} picks` : `${item.calls.length} of ${input.managers.length}`}</span>`,
          `<ol class="calls">${lines}</ol>`,
        ),
      });
    }
    case 'draft-done': {
      const mine = myRoster(state, me);
      return msg(item, {
        avatar: sysAvatar('crier'),
        author: 'The crier',
        body:
          `The draft is done: every tavern has its ${item.rounds}.` +
          (mine.length === 0 ? '' : `<p class="small">Yours: <span class="faces">${mine.map((id) => monster(id, state, me)).join('')}</span></p>`) +
          (item.undrafted.length === 0 ? '' : `<p class="small muted">Nobody's: <span class="faces">${item.undrafted.map((id) => monster(id, state, me)).join('')}</span></p>`),
      });
    }
    case 'episode-open': {
      const mine = myRoster(state, me).filter((id) => item.alive.includes(id));
      const pair = me === null ? undefined : roundMatchups(state, item.round).find((m) => m.home === me || m.away === me);
      const rival = pair === undefined ? null : pair.home === me ? pair.away : pair.home;
      const last = item.episode === VOTES;
      const riders = item.alive.filter((id) => input.cardOf(id).strategy.kind === 'coattails');
      const turning =
        item.alive.length === input.model.betrayAt && riders.length > 0
          ? `<p class="betrayal">The coattail riders have stopped smiling at their friends: <span class="faces">${riders.map((id) => monster(id, state, me)).join('')}</span> now go after the strongest.</p>`
          : '';
      return msg(item, {
        avatar: sysAvatar('lich'),
        author: 'The Lich',
        note: `episode ${item.episode} of ${VOTES} · round ${item.round}`,
        body:
          (last ? `Final ${item.alive.length}. One more task, one more vote, and then the dead will choose.` : `${item.alive.length} of you left. I have another little job.`) +
          `<p class="small muted">${mine.length === 0 ? 'None of your monsters is still in. ' : `Yours still in: <span class="faces">${mine.map((id) => monster(id, state, me)).join('')}</span>. `}` +
          `${rival === null ? '' : `This round you face ${flagOf(rival)} <b>${esc(tavernName(rival))}</b>. `}Calls are open.</p>` +
          turning,
      });
    }
    case 'call': {
      const mine = item.tavern === me;
      if (mine) {
        return msg(item, {
          avatar: tavernAvatar(item.tavern),
          author: esc(tavernName(item.tavern)),
          note: 'only you can see this',
          cls: 'compact mine private',
          attrs: bannerAttr(item.tavern),
          body: `You ${item.change ? 'change your call to' : 'call'} <b>${esc(charName(item.target ?? ''))}</b> to go home${item.early ? ` <span class="tag brass" title="Called before the challenge: +${config.scoring.earlyCallBonus} if right">early</span>` : ''}.`,
        });
      }
      return msg(item, {
        avatar: tavernAvatar(item.tavern),
        author: esc(tavernName(item.tavern)),
        cls: 'compact',
        body: `<span class="muted">${item.change ? 'changes its call' : `has made ${item.early ? 'an early' : 'a'} call`}. Sealed until the vote.</span>`,
      });
    }
    case 'challenge':
      return challengeHtml(item, ctx);
    case 'vote':
      return voteHtml(item, ctx);
    case 'finale':
      return finaleHtml(item, ctx);
    case 'round':
      return roundHtml(item, ctx);
  }
}

// ── a challenge, in the scrying ball ───────────────────────────────────────

function challengeHtml(item: Extract<FeedItem, { kind: 'challenge' }>, ctx: Ctx): string {
  const { me, state } = ctx;
  const chrome = challengeChrome(item.episode);
  const mineSet = new Set(myRoster(state, me));
  const field = item.field
    .map((id) => `<span class="fm${mineSet.has(id) ? ' mine' : ''}" data-id="${esc(id)}" title="${esc(charName(id))}">${portrait(id, 'sm')}</span>`)
    .join('');
  let left = item.field.length;
  const rounds = item.result.rounds
    .map((r, i) => {
      const check = item.challenge.checks[r.check]!;
      const line = chrome.lines[r.check] ?? '';
      left -= r.out.length;
      const yours = r.rolls.filter((roll) => mineSet.has(roll.id));
      const rolls = yours
        .map(
          (roll) =>
            `<span class="roll ${roll.pass ? 'pass' : 'fail'}">${portrait(roll.id, 'sm')}<span class="die ${roll.d20 === 20 ? 'hi' : roll.d20 === 1 ? 'lo' : ''}">${roll.d20}</span>${roll.advantage ? '<span class="tag brass">adv</span>' : ''}${signed(roll.modifier)} = ${roll.d20 + roll.modifier}${roll.eligible ? '' : ' <span class="tag bad">can\'t</span>'}</span>`,
        )
        .join('');
      const dropped = r.replay
        ? '<span class="muted">Everyone fails. The Lich sighs and tries the next one.</span>'
        : r.out.length === 0
          ? '<span class="muted">Nobody drops out.</span>'
          : `<span class="faces">${r.out.map((id) => monster(id, state, me)).join('')}</span> <span class="muted">out · ${left} left</span>`;
      return (
        `<li data-round="${i + 1}" data-out="${esc(r.out.join(' '))}" data-replay="${r.replay ? 1 : 0}"><div><b>${esc(line === '' ? `Round ${i + 1}` : line.charAt(0).toUpperCase() + line.slice(1))}</b> ` +
        `<span class="muted small">${esc(checkLabel(check, r.dc))}${r.lap > 0 ? ', again and harder' : ''}</span></div>` +
        (rolls === '' ? '' : `<div class="rolls">${rolls}</div>`) +
        `<div class="dropped">${dropped}</div></li>`
      );
    })
    .join('');
  const winner = item.result.winner;
  const owner = state.owner.get(winner);
  const latest = item.episode === ctx.episode;
  return msg(item, {
    avatar: sysAvatar('ball'),
    author: 'The scrying ball',
    note: `episode ${item.episode}: ${esc(chrome.title)}`,
    attrs: ` data-episode="${item.episode}"`,
    body:
      (chrome.story === '' ? '' : `<p class="lich-says">"${esc(chrome.story)}"</p>`) +
      fold(
        item.key,
        latest,
        `<span class="small spoiler">${monster(winner, state, me)} wins immunity in ${item.result.rounds.length} round${item.result.rounds.length === 1 ? '' : 's'}</span>` +
          `<span class="small muted while-revealing">${item.field.length} monsters, one task</span>`,
        `<div class="field" aria-label="The field">${field}</div><ol class="rounds">${rounds}</ol>` +
          `<p class="winner" data-winner${owner === me && me !== null ? ' data-mine="1"' : ''}>${monster(winner, state, me, 'md')} is the last one standing: <b>safe tonight</b>.</p>`,
      ) +
      (latest ? `<p class="race-foot"><button type="button" class="link small" data-action="g-replay" data-key="${esc(item.key)}">Watch again</button></p>` : ''),
  });
}

// ── the vote, read aloud ───────────────────────────────────────────────────

function voteHtml(item: Extract<FeedItem, { kind: 'vote' }>, ctx: Ctx): string {
  const { me, state } = ctx;
  const { vote } = item;
  const order = readingOrder(vote.ballots, vote.boot);
  const tally = runningTally(order);
  const targets = [...new Set(vote.ballots.map((b) => b.target))];
  const chips = (ids: ReadonlyArray<string>, ballots: typeof vote.ballots): string =>
    `<div class="tally">${ids.map((id) => `<span class="chip" data-target="${esc(id)}">${portrait(id, 'sm')}${esc(charName(id))} <b class="num" data-count="${ballots.filter((b) => b.target === id).length}">${ballots.filter((b) => b.target === id).length}</b></span>`).join('')}</div>`;
  // A ballot that ties the leader holds its breath a little longer.
  const counts = new Map<string, number>();
  // Survivor style: once nobody can catch the boot, the Lich stops reading; the rest show after.
  const decided = vote.revote === null ? decidedAfter(order, vote.boot) : order.length;
  const ballots = order
    .map((b, i) => {
      counts.set(b.target, tally[i]!);
      const top = Math.max(...counts.values());
      const tie = [...counts.values()].filter((n) => n === top).length > 1;
      const step = i < decided ? ` data-step="ballot" data-target="${esc(b.target)}" data-tally="${tally[i]}"${tie ? ' data-tie="1"' : ''}` : ' class="rest"';
      const enough = i === decided && decided < order.length ? `<li data-step="note" class="note-line">That's ${tally[decided - 1]} for ${esc(charName(vote.boot))}. I needn't read the rest.</li>` : '';
      return `${enough}<li${step}><span class="ord">${voteOrdinal(i)}</span> ${monster(b.target, state, me)}</li>`;
    })
    .join('');
  let revote = '';
  if (vote.revote !== null) {
    const r = vote.revote;
    const rOrder = readingOrder(r.ballots, vote.draw === null ? vote.boot : (r.ballots.at(-1)?.target ?? vote.boot));
    const rTally = runningTally(rOrder);
    revote =
      `<li data-step="note" class="note-line">A tie between ${r.tied.map((id) => `<b>${esc(charName(id))}</b>`).join(' and ')}. ${r.ballots.length === 0 ? 'Nobody else can vote.' : 'Everyone else votes again.'}</li>` +
      rOrder.map((b, i) => `<li data-step="ballot" data-target="${esc(b.target)}" data-tally="${rTally[i]}"><span class="ord">Revote ${i + 1}</span> ${monster(b.target, state, me)}</li>`).join('');
  }
  const draw = vote.draw === null ? '' : `<li data-step="note" class="note-line">Still tied. The Lich draws a name from his hat.</li>`;
  const boot = vote.boot;
  const bootOwner = state.owner.get(boot);
  const callLines = [...item.calls]
    .sort((a, b) => Number(b.tavern === me) - Number(a.tavern === me))
    .map((c) => {
      const mine = c.tavern === me;
      const call = c.target === null ? '<span class="muted">no call</span>' : `called <b>${esc(charName(c.target))}</b>${c.early ? ' <span class="tag brass">early</span>' : ''}`;
      const pts = c.score.total;
      const parts = [
        c.score.survive > 0 ? `${c.score.survive} survival` : '',
        c.score.immunity > 0 ? `${c.score.immunity} immunity` : '',
        c.score.call + c.score.early > 0 ? `${c.score.call + c.score.early} call` : '',
      ].filter((x) => x !== '');
      return `<li class="${mine ? 'mine' : ''}${c.right ? ' right' : ''}"${mine ? bannerAttr(c.tavern) : ''}>${flagOf(c.tavern)} <b>${esc(who(c.tavern, me))}</b> ${call} ${c.right ? '<span class="pass">✓</span>' : ''}<span class="pts num" title="${esc(parts.join(', '))}">+${pts}</span></li>`;
    })
    .join('');
  const byWhom = vote.ballots.map((b) => `<li>${portrait(b.voter, 'sm')} ${esc(charName(b.voter))} → <b>${esc(charName(b.target))}</b></li>`).join('');
  const latest = item.episode === ctx.episode || item.episode === ctx.episode - 1;
  const myCall = item.calls.find((c) => c.tavern === me);
  return msg(item, {
    avatar: sysAvatar('lich'),
    author: 'The Lich',
    note: `the vote, episode ${item.episode}`,
    attrs: ` data-episode="${item.episode}"`,
    body:
      `<p>${item.immune === '' ? '' : `${monster(item.immune, state, me)} is immune. `}I'll read the votes.</p>` +
      chips(targets, vote.ballots) +
      `<ol class="parchments">${ballots}${revote}${draw}` +
      `<li data-step="boot" class="boot-line${bootOwner !== undefined && bootOwner === me ? ' mine' : ''}">${monster(boot, state, me, 'md')} <span>${bootOwner === me && me !== null ? '<b>Your monster</b> is out.' : 'is out.'} The dead have room for one more. <span class="muted">${item.left} left.</span></span></li>` +
      `<li data-step="calls" class="calls-wrap">${fold(`${item.key}:calls`, latest, `<span class="small">The calls, unsealed${myCall === undefined ? '' : `: you ${myCall.right ? '<b class="pass">called it</b>' : myCall.target === null ? 'made no call' : 'missed'}`}</span>`, `<ul class="calls-out">${callLines}</ul>`)}</li></ol>` +
      `<div class="spoiler">${fold(`${item.key}:who`, false, '<span class="small">Who voted for whom</span>', `<ul class="ballots">${byWhom}</ul>`)}</div>` +
      (latest ? `<p class="race-foot"><button type="button" class="link small" data-action="g-replay" data-key="${esc(item.key)}">Hear it again</button></p>` : ''),
  });
}

// ── the finale ─────────────────────────────────────────────────────────────

function finaleHtml(item: Extract<FeedItem, { kind: 'finale' }>, ctx: Ctx): string {
  const { me, state } = ctx;
  const { result } = item;
  const ballots = result.ballots.map((b) => ({ voter: b.juror, target: b.finalist }));
  const order = readingOrder(ballots, result.winner);
  const tally = runningTally(order);
  const chips = `<div class="tally">${result.finalists.map((id) => `<span class="chip" data-target="${esc(id)}">${portrait(id, 'sm')}${esc(charName(id))} <b class="num" data-count="${ballots.filter((b) => b.target === id).length}">${ballots.filter((b) => b.target === id).length}</b></span>`).join('')}</div>`;
  const lines = order
    .map((b, i) => `<li data-step="ballot" data-target="${esc(b.target)}" data-tally="${tally[i]}"><span class="ord">${portrait(b.voter, 'sm')}${esc(charName(b.voter))}</span> → ${monster(b.target, state, me)}</li>`)
    .join('');
  const owner = state.owner.get(result.winner);
  const scores = item.scores
    .filter((s) => s.score.total > 0)
    .map((s) => `<li class="${s.tavern === me ? 'mine' : ''}"${s.tavern === me ? bannerAttr(s.tavern) : ''}>${flagOf(s.tavern)} <b>${esc(who(s.tavern, me))}</b> <span class="pts num">+${s.score.total}</span></li>`)
    .join('');
  return msg(item, {
    avatar: sysAvatar('lich'),
    author: 'The Lich',
    note: 'the jury votes',
    body:
      `<p>The final ${result.finalists.length}: <span class="faces">${result.finalists.map((id) => monster(id, state, me)).join('')}</span>. The dead will now choose my assistant.</p>` +
      chips +
      `<ol class="parchments">${lines}${result.draw === null ? '' : '<li data-step="note" class="note-line">A tie. The Lich draws a name.</li>'}` +
      `<li data-step="winner" class="winner-line">${monster(result.winner, state, me, 'md')} <span>is the Lich's new assistant${owner === undefined ? '' : `, and ${whose(owner, me)} candidate`}.</span></li></ol>` +
      (scores === '' ? '' : `<ul class="calls-out">${scores}</ul>`),
  });
}

// ── a head-to-head round ───────────────────────────────────────────────────

function roundHtml(item: Extract<FeedItem, { kind: 'round' }>, ctx: Ctx): string {
  const { me } = ctx;
  const matchups = item.matchups
    .map((m) => {
      const mine = m.home === me || m.away === me;
      const side = (t: string, pts: number): string => `<span class="side${m.winner === t ? ' won' : ''}">${flagOf(t)} <b>${esc(who(t, me))}</b> <span class="num">${pts}</span></span>`;
      return `<li class="${mine ? 'mine' : ''}"${mine && me !== null ? bannerAttr(me) : ''}>${side(m.home, m.homePoints)}<span class="vs">${m.winner === null ? 'tie' : 'v'}</span>${side(m.away, m.awayPoints)}</li>`;
    })
    .join('');
  const rows = item.rows
    .map((r) => {
      const move = item.round === 1 ? '' : `<td class="n move">${r.rose > 0 ? `<span class="pass">▲${r.rose}</span>` : r.rose < 0 ? `<span class="fail">▼${-r.rose}</span>` : '<span class="muted">–</span>'}</td>`;
      const mine = r.tavern === me;
      return (
        `<tr class="${mine ? 'mine' : ''}${item.final && r.rank === 1 ? ' champ' : ''}"${mine ? bannerAttr(r.tavern) : ''} data-was="${r.wasRow}"><td class="n">${r.rank}</td>${move}` +
        `<td>${flagOf(r.tavern)} <b>${esc(who(r.tavern, me))}</b></td><td class="n">${r.wins}–${r.losses}${r.ties > 0 ? `–${r.ties}` : ''}</td><td class="n">${r.points}</td></tr>`
      );
    })
    .join('');
  const table = `<table class="mini-table"><thead><tr><th class="n">#</th>${item.round === 1 ? '' : '<th></th>'}<th>tavern</th><th class="n">W–L</th><th class="n">pts</th></tr></thead><tbody>${rows}</tbody></table>`;
  const myMatch = item.matchups.find((m) => m.home === me || m.away === me);
  const headline =
    myMatch === undefined || me === null
      ? ''
      : `<p class="headline">${myMatch.winner === null ? 'You <b>tie</b>' : myMatch.winner === me ? '<b class="pass">You win</b>' : 'You <b>lose</b>'} round ${item.round}, ${myMatch.home === me ? myMatch.homePoints : myMatch.awayPoints}–${myMatch.home === me ? myMatch.awayPoints : myMatch.homePoints}.</p>`;
  if (!item.final) {
    return msg(item, {
      avatar: sysAvatar('crier'),
      author: 'The crier',
      note: `round ${item.round} of ${config.schedule.rounds.length}`,
      body: headline + `<ul class="matchups">${matchups}</ul>` + fold(item.key, true, '<span class="small">The table</span>', table),
    });
  }
  const champs = item.rows.filter((r) => r.rank === 1).map((r) => r.tavern);
  const mine = item.rows.find((r) => r.tavern === me);
  if (me !== null && champs.includes(me)) {
    return (
      `<li class="msg round season-final champion banner-card" data-key="${esc(item.key)}"${bannerAttr(me)}><div class="pennant" aria-hidden="true"></div>` +
      `<h2>${flagOf(me)} ${champs.length === 1 ? 'Champions of the Contest' : 'Co-champions'}</h2>` +
      `<p class="banner-call">${esc(tavernName(me))} ${champs.length === 1 ? 'takes the season' : 'shares the season'} at ${mine?.wins ?? 0}–${mine?.losses ?? 0}, with ${num(mine?.points ?? 0)} points.</p>` +
      headline +
      `<ul class="matchups">${matchups}</ul>` +
      table +
      `</li>`
    );
  }
  const champLine = champs.map((t) => `<span class="champ-line"${bannerAttr(t)}>${flagOf(t)} <b>${esc(tavernName(t))}</b></span>`).join(' and ');
  return (
    `<li class="msg round season-final" data-key="${esc(item.key)}"><div class="av">${sysAvatar('crier')}</div><div class="mbody">` +
    `<div class="meta"><b class="author">The crier</b> <span class="note">the season is over</span></div><div class="text">` +
    headline +
    `<ul class="matchups">${matchups}</ul>` +
    `<h2>Final standings</h2><p>${champLine} ${champs.length === 1 ? 'wins' : 'share'} the season.</p>` +
    (mine === undefined ? '' : `<p class="finish">You finish <b>${ordinal(mine.rank)} of ${item.rows.length}</b>, ${mine.wins}–${mine.losses}${mine.ties > 0 ? `–${mine.ties}` : ''}, with ${num(mine.points)} points.</p>`) +
    table +
    `</div></div></li>`
  );
}

// ── setup ──────────────────────────────────────────────────────────────────

function setupHtml(): string {
  const options = input.managers.map((m) => `<option value="${esc(m.id)}" ${m.id === game.manager ? 'selected' : ''}>${esc(KEEPERS[seatOf.get(m.id) ?? 0] ?? m.id)}'s seat (${esc(m.bot)} bot)</option>`).join('');
  return (
    `<li class="welcome" data-key="welcome"><div class="card">` +
    `<h2>The Lich's contest</h2>` +
    `<p>The Lich wants a new assistant. ${config.contest.castSize} monsters compete: each episode one wins his task and is safe, and the rest vote one of their own out. The voted-out choose the winner.</p>` +
    `<p>You run a tavern against ${input.managers.length - 1} keepers. Draft ${config.roster.size} monsters, then watch, and call the boot each episode. Taverns meet head to head; the best record after ${config.schedule.rounds.length} rounds wins.</p>` +
    `<p class="small muted">Everything that happens is told here, in ${ROOM}. The keepers think quickly, but not instantly.</p>` +
    (game.error === null ? '' : `<div class="error">${esc(game.error)}</div>`) +
    (game.notice === null ? '' : `<p class="hint" role="status">${esc(game.notice)}</p>`) +
    `<div class="row"><label class="label" for="g-seat">Seat</label><select id="g-seat" data-action="g-seat">${options}</select>` +
    `<label class="label" for="g-seed">Seed</label><input type="text" id="g-seed" data-action="g-seed" placeholder="random" value="${esc(game.seed)}" spellcheck="false" autocomplete="off"></div>` +
    `<div class="row"><button type="button" class="primary" data-action="g-start">Start the season</button></div>` +
    `<p class="hint">The seed draws the cast and drives the contest and the keepers, so the same seed and the same moves give the same season. Your season is saved in this browser as you play.</p>` +
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
  const me = s.humanTavern;
  const toWork = (label: string): string =>
    game.view === 'work' ? '' : `<button type="button" class="small${stage.kind === 'challenge' || stage.kind === 'vote' ? ' narrow-only' : ''}" data-action="g-view" data-view="work">${label}</button>`;
  switch (stage.kind) {
    case 'tavern':
      bar.innerHTML =
        stage.manager === s.human?.manager
          ? `${err}<div class="bar-line" data-clock><b>Your turn to choose a tavern.</b></div><button type="button" class="primary" data-action="g-view" data-view="work">Choose a tavern</button>`
          : `<div class="bar-line muted">Waiting on ${esc(keeper(stage.manager))}…</div>`;
      return;
    case 'draft': {
      const n = input.managers.length;
      bar.innerHTML =
        stage.tavern === me
          ? `${err}<div class="bar-line" data-clock><b>You're on the clock:</b> pick ${stage.pick + 1}, round ${Math.floor(stage.pick / n) + 1} of ${config.roster.size}.</div>` +
            `<button type="button" class="primary" data-action="g-view" data-view="work">Open the draft</button>`
          : `<div class="bar-line muted">Waiting on ${esc(tavernName(stage.tavern))}…</div>`;
      return;
    }
    case 'challenge': {
      const call = me === null ? undefined : s.callsFor(stage.episode).get(me);
      bar.innerHTML =
        `${err}<div class="bar-line" data-clock><b>Episode ${stage.episode}.</b> <span class="small">${call === undefined ? `Call the boot now for +${config.scoring.earlyCallBonus}, or wait for the challenge.` : `Your early call: <b>${esc(charName(call.target))}</b>.`}</span></div>` +
        `<span class="bar-actions">${toWork(call === undefined ? 'Call early' : 'Change call')}<button type="button" class="primary" data-action="g-challenge">Run the challenge</button></span>`;
      return;
    }
    case 'vote': {
      const call = me === null ? undefined : s.callsFor(stage.episode).get(me);
      const immune = s.state.episodes[stage.episode - 1]?.challenge?.result.winner ?? '';
      bar.innerHTML =
        `${err}<div class="bar-line" data-clock><b>${esc(charName(immune))} is immune.</b> <span class="small">${call === undefined ? 'Call the boot, then go to the vote.' : `Your call: <b>${esc(charName(call.target))}</b>${call.early ? ' (early)' : ''}.`}</span></div>` +
        `<span class="bar-actions">${toWork(call === undefined ? 'Call the boot' : 'Change call')}<button type="button" class="primary" data-action="g-vote">Go to the vote</button></span>`;
      return;
    }
    case 'finale':
      bar.innerHTML = `${err}<div class="bar-line" data-clock><b>The final ${s.state.alive.length}.</b> <span class="small">The dead are waiting to vote.</span></div><button type="button" class="primary" data-action="g-finale">Read the jury's votes</button>`;
      return;
    case 'complete':
      bar.innerHTML =
        `<div class="bar-line"><b>The season is over.</b></div>` +
        `<span class="bar-actions"><button type="button" class="small" data-action="g-workshop">Open it in the workshop</button><button type="button" class="primary" data-action="g-reset">New season</button></span>`;
      return;
  }
}

// ── the header ─────────────────────────────────────────────────────────────

function renderHead(): void {
  const s = game.session;
  const head = $('g-head');
  const me = s?.humanTavern ?? null;
  const told = me !== null && shown.state.taverns.has(me);
  const st = shown.state;
  const voted = st.jury.length;
  const where =
    s === null
      ? 'A season against the bots'
      : st.taverns.size < s.state.managers.size
        ? `Tavern pick · ${st.taverns.size + 1} of ${s.state.managers.size}`
        : !st.draft.complete
          ? `Draft · pick ${st.draft.picks + 1} of ${config.roster.size * s.state.managers.size}`
          : st.phase === 'complete'
            ? 'Season complete'
            : voted >= VOTES
              ? 'The finale'
              : `Episode ${voted + 1} of ${VOTES} · round ${roundOf(config, voted + 1)}`;
  const rows = seasonStandings(st);
  const row = rows.find((r) => r.tavern === me);
  const rec = row === undefined || st.finalizedRounds.size === 0 ? '' : ` · ${row.wins}–${row.losses}${row.ties > 0 ? `–${row.ties}` : ''}, ${ordinal(row.rank)}`;
  const chrome = told ? data.tavernChrome[me] : undefined;
  const reset =
    s === null
      ? ''
      : game.confirmReset
        ? `<span class="small" role="alert">Abandon this season?</span><button type="button" class="small" data-action="g-reset-confirm">Abandon</button><button type="button" class="small primary" data-action="g-reset-cancel">Keep playing</button>`
        : `<button type="button" class="small" data-action="g-reset">New season</button>`;
  head.innerHTML =
    (told
      ? `<div class="you${bannerOf(me) === null ? '' : ' banner-card'}"${bannerAttr(me)}>${bannerOf(me) === null ? '' : '<div class="pennant" aria-hidden="true"></div>'}` +
        `<div class="you-line">${flagOf(me)}<b class="you-name">${esc(tavernName(me))}</b><span class="small">${esc(where)}${rec}</span></div>` +
        (chrome?.toast === undefined ? '' : `<p class="banner-call">"${esc(chrome.toast)}"</p>`) +
        `</div>`
      : `<div class="you plain"><div class="you-line"><b class="you-name">${s === null ? 'No season yet' : 'No tavern yet'}</b><span class="small">${esc(where)}</span></div></div>`) +
    `<div class="head-actions">${reset}${s === null ? '' : `<span class="small muted">seed ${esc(s.seed)}</span>`}</div>`;
}

// ── tabs ───────────────────────────────────────────────────────────────────

/** The workspace's tab follows the season: the taverns, the draft, the episode, and your roster at the end. */
function workLabel(): string {
  const s = game.session;
  if (s === null) return 'Draft';
  if (shown.state.taverns.size < s.state.managers.size) return 'Taverns';
  if (!shown.state.draft.complete) return 'Draft';
  return shown.state.phase === 'complete' ? 'Roster' : 'The cast';
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
  if (!shown.state.draft.complete || (told && stage.kind === 'draft')) {
    if (shown.state.taverns.size < s.state.managers.size || (told && stage.kind === 'tavern')) return workTaverns(s, told);
    return workDraft(s, told);
  }
  if (shown.state.phase === 'complete') return workDone(s);
  return workCast(s, told);
}

function workTaverns(s: ContestSession, told: boolean): string {
  const state = shown.state;
  const yours = told && s.stage.kind === 'tavern' && s.stage.manager === s.human?.manager;
  const rows = input.taverns
    .map((t) => {
      const owner = state.taverns.get(t.id)?.managerId;
      const toast = data.tavernChrome[t.id]?.toast;
      const action =
        owner === undefined
          ? `<button type="button" class="small${yours ? ' primary' : ''}" data-action="g-tavern" data-id="${esc(t.id)}" ${yours ? '' : 'disabled title="Not your turn yet"'}>Choose</button>`
          : `<span class="small">${esc(keeper(owner))}</span>`;
      return `<tr class="${owner === undefined ? '' : 'taken-row'}"${bannerAttr(t.id)}><td>${action}</td><td>${flagOf(t.id)} <b>${esc(t.name)}</b></td><td class="small wrap-ok"><i>${toast === undefined ? '' : `"${esc(toast)}"`}</i></td></tr>`;
    })
    .join('');
  return (
    `<section class="card"><div class="row spread"><h2>Choose your tavern</h2><span class="muted small">${yours ? 'your turn' : 'in reverse draft order'}</span></div>` +
    `<p class="small">Every tavern is a franchise of the Lich's front company, and its regulars dream of the job going to their favourite. The taverns differ only in name and banner.</p>` +
    `<div class="scroll"><table><tbody>${rows}</tbody></table></div></section>`
  );
}

/** The season's public hint: how many checks test each ability across all the challenges. */
function mixHtml(): string {
  const mix = input.abilityMix;
  const total = Object.values(mix).reduce((a, b) => a + b, 0);
  return (
    `<div class="mix" title="Checks across the season's ${VOTES} challenges, by ability. The challenges themselves are secret.">` +
    (Object.keys(mix) as Array<keyof typeof mix>).map((a) => `<span><i>${esc(ABILITY_NAMES[a].slice(0, 3))}</i><b class="num">${mix[a]}</b><em style="width:${((100 * mix[a]) / Math.max(1, total)) * 3}%"></em></span>`).join('') +
    `</div>`
  );
}

function workDraft(s: ContestSession, told: boolean): string {
  const state = shown.state;
  const me = s.humanTavern!;
  const yours = told && s.stage.kind === 'draft' && s.stage.tavern === me;
  const mine = state.taverns.get(me)?.roster ?? [];
  const q = game.filter.trim().toLowerCase();
  const available = [...state.pool.keys()].filter((id) => !state.owner.has(id));
  const { values } = scouting(s);
  const list = available
    .filter((id) => matchesFilter(id, q))
    .sort((a, b) => {
      const ca = input.cardOf(a);
      const cb = input.cardOf(b);
      switch (game.draftSort) {
        case 'scouts':
          return (values.get(b) ?? 0) - (values.get(a) ?? 0);
        case 'power':
          return cb.power - ca.power;
        case 'cr':
          return cb.stats.cr - ca.stats.cr;
        case 'name':
          return charName(a).localeCompare(charName(b));
      }
    });
  const draftButton = (id: string): string => `<button type="button" class="small${yours ? ' primary' : ''}" data-action="g-draft" data-id="${esc(id)}" ${yours ? '' : 'disabled'}>Draft</button>`;
  const fa = `<div id="g-fa" class="deck">${list.map((id) => charCard(id, { foot: `${draftButton(id)}${stars(s, id)}` })).join('') || '<p class="muted">No match.</p>'}</div>`;
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
    `<div class="stack"><span class="label">Your candidates · ${mine.length} of ${config.roster.size}</span>` +
    (mine.length === 0 ? '<p class="muted small">Nobody yet.</p>' : `<div class="deck" id="g-roster">${mine.map((id) => charCard(id, { owner: me })).join('')}</div>`) +
    `<p class="hint">They are yours all season: no trades, no waivers. They score ${config.scoring.survive} for each vote they survive, ${config.scoring.immunity} per immunity, ${config.scoring.juryVote} per jury vote and ${config.scoring.winner} for winning.</p></div>` +
    `<div class="stack"><span class="label">This season's challenges test</span>${mixHtml()}</div></section>` +
    `<section class="card"><div class="row"><h3>The cast</h3><input type="text" id="g-filter" placeholder="Filter: name, type, strategy, tag" value="${esc(game.filter)}" data-action="g-filter">` +
    `<label class="label" for="g-sort">Sort</label><select id="g-sort" data-action="g-sort">${(
      [
        ['scouts', "scouts' rating"],
        ['power', 'challenge power'],
        ['cr', 'CR'],
        ['name', 'name'],
      ] as const
    )
      .map(([v, l]) => `<option value="${v}" ${game.draftSort === v ? 'selected' : ''}>${l}</option>`)
      .join('')}</select></div>` +
    fa +
    `<p class="hint">Read the cards: who wins challenges, who the cast will protect, who makes enemies. The scouts' stars come from simulated contests with this cast, without knowing the real challenges.</p></section>` +
    `<section class="card">${fold('work:board', false, '<h3 style="display:inline">Draft board</h3>', `<div class="scroll"><table class="draft"><thead><tr><th>round</th>${state.draft.order.map((t) => `<th class="${t === me ? 'hot' : ''}">${esc(who(t, me))}</th>`).join('')}</tr></thead><tbody>${board || `<tr><td colspan="${state.draft.order.length + 1}" class="muted">No picks yet.</td></tr>`}</tbody></table></div>`)}</section>`
  );
}

/** The episode: the monsters still in, as cards to call from, with what the room knows about each. */
function workCast(s: ContestSession, told: boolean): string {
  const state = shown.state;
  const me = s.humanTavern!;
  if (!told) {
    return `<div class="empty"><p>The episode is playing out in ${ROOM}.</p><button type="button" class="small" data-action="g-skip">Skip to the end</button></div>`;
  }
  const stage = s.stage;
  const episode = stage.kind === 'challenge' || stage.kind === 'vote' ? stage.episode : null;
  const immune = episode === null ? null : (state.episodes[episode - 1]?.challenge?.result.winner ?? null);
  const call = episode === null ? undefined : s.callsFor(episode).get(me);
  const contest = s.contest();
  const lastVote = [...state.episodes].reverse().find((e) => e.vote !== null)?.vote ?? null;
  const votesLast = new Map<string, number>();
  for (const b of lastVote?.ballots ?? []) votesLast.set(b.target, (votesLast.get(b.target) ?? 0) + 1);
  const mineFirst = [...state.alive].sort((a, b) => Number(state.owner.get(b) === me) - Number(state.owner.get(a) === me));
  const cards = mineFirst
    .map((id) => {
      const owner = state.owner.get(id) ?? null;
      const wins = contest.wins[id] ?? 0;
      const against = votesLast.get(id) ?? 0;
      const chips = [
        wins > 0 ? `<span class="tag brass" title="Immunity wins">${wins} win${wins === 1 ? '' : 's'}</span>` : '',
        against > 0 ? `<span class="tag bad" title="Votes against at the last vote">${against} vote${against === 1 ? '' : 's'} last time</span>` : '',
        owner === null ? '<span class="tag">nobody\'s</span>' : owner === me ? '' : `<span class="tag owner"${bannerAttr(owner)}>${flagOf(owner)} ${esc(tavernName(owner))}</span>`,
      ].join('');
      const called = call?.target === id;
      const button =
        episode === null
          ? ''
          : id === immune
            ? '<span class="tag good">immune</span>'
            : called
              ? `<span class="tag brass">your call${call.early ? ', early' : ''}</span>`
              : `<button type="button" class="small" data-action="g-call" data-id="${esc(id)}">${call === undefined ? 'Call' : 'Call instead'}</button>`;
      return charCard(id, {
        owner,
        foot: `${button}${chips}`,
        ...(id === immune ? { mark: '<span class="ribbon good">immune</span>' } : called ? { mark: '<span class="ribbon">called</span>' } : {}),
      });
    })
    .join('');
  const jury = state.jury.map((id) => `<span title="${esc(charName(id))}, out in episode ${state.jury.indexOf(id) + 1}">${portrait(id, 'sm')}</span>`).join('');
  const lastBallots =
    lastVote === null
      ? ''
      : fold(
          'work:last-vote',
          false,
          '<span class="small">Who voted for whom last time</span>',
          `<ul class="ballots">${lastVote.ballots.map((b) => `<li>${portrait(b.voter, 'sm')} ${esc(charName(b.voter))} → <b>${esc(charName(b.target))}</b></li>`).join('')}</ul>`,
        );
  const pair = episode === null ? undefined : roundMatchups(state, roundOf(config, episode)).find((m) => m.home === me || m.away === me);
  const rival = pair === undefined ? null : pair.home === me ? pair.away : pair.home;
  const roundPts = (t: string): number => {
    if (episode === null) return 0;
    const r = roundOf(config, episode);
    let n = 0;
    for (let e = 1; e <= state.jury.length; e++) if (roundOf(config, e) === r) n += episodeScore(state, t, e).total;
    return n;
  };
  const head =
    episode === null
      ? `<h2>The final ${state.alive.length}</h2><p class="small">Every vote is in. The jury of ${state.jury.length} is waiting.</p>`
      : `<div class="row spread"><h2>Episode ${episode} of ${VOTES}</h2><span class="small muted">${stage.kind === 'challenge' ? 'before the challenge' : 'after the challenge'}</span></div>` +
        `<p class="small">${
          call === undefined
            ? stage.kind === 'challenge'
              ? `Call who goes home now for ${config.scoring.call} + ${config.scoring.earlyCallBonus} if right, or wait to see who wins immunity.`
              : `Call who goes home for ${config.scoring.call} if right.`
            : `Your call: <b>${esc(charName(call.target))}</b>${call.early ? ` (early: ${config.scoring.call + config.scoring.earlyCallBonus} if right; changing it now makes it late)` : ''}.`
        }</p>` +
        (rival === null ? '' : `<p class="small">Round ${roundOf(config, episode)}: you ${roundPts(me)} – ${roundPts(rival)} ${flagOf(rival)} ${esc(tavernName(rival))}, so far.</p>`);
  return (
    `<section class="card">${head}</section>` +
    `<section class="card"><div class="row spread"><h3>Still in · ${state.alive.length}</h3><span class="small muted">yours first</span></div><div class="deck" id="g-cast">${cards}</div>${lastBallots}</section>` +
    (jury === '' ? '' : `<section class="card"><h3>The jury · ${state.jury.length}</h3><span class="faces">${jury}</span></section>`)
  );
}

function workDone(s: ContestSession): string {
  const me = s.humanTavern!;
  const roster = myRoster(shown.state, me);
  const winner = shown.state.finale?.winner;
  return (
    `<section class="card"><h2>Your candidates</h2><div class="deck">${roster.map((id) => charCard(id, { owner: me, ...(id === winner ? { mark: '<span class="ribbon good">the assistant</span>' } : {}) })).join('')}</div></section>` +
    `<section class="card"><p>The whole season is in the workshop: every episode, the odds at each vote, and the event log.</p>` +
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
  const body = rows
    .map((r) => {
      const m = state.taverns.get(r.tavern)?.managerId ?? '';
      const mine = r.tavern === me;
      return (
        `<tr class="${mine ? 'mine' : ''}"${mine ? bannerAttr(r.tavern) : ''}><td class="n">${r.rank}</td><td>${flagOf(r.tavern)} <b>${esc(tavernName(r.tavern))}</b></td>` +
        `<td class="small">${mine ? 'you' : `${esc(keeper(m))} <span class="muted">${esc(botOfManager.get(m) ?? '')}</span>`}</td><td class="n"><b>${r.wins}–${r.losses}${r.ties > 0 ? `–${r.ties}` : ''}</b></td><td class="n">${r.points}</td></tr>`
      );
    })
    .join('');
  const table =
    state.taverns.size === 0
      ? '<p class="muted">No taverns chosen yet.</p>'
      : `<div class="scroll"><table><thead><tr><th class="n">#</th><th>tavern</th><th>keeper</th><th class="n">W–L</th><th class="n">pts</th></tr></thead><tbody>${body}</tbody></table></div>` +
        `<p class="hint">Ranked by record (a tie counts half), then points over the rounds played.</p>`;
  const rounds = config.schedule.rounds
    .map((_, i) => {
      const round = i + 1;
      const done = state.finalizedRounds.has(round);
      const list = roundMatchups(state, round)
        .map((m) => {
          const mine = m.home === me || m.away === me;
          const pts = (t: string, p: number): string => `${flagOf(t)} ${esc(tavernName(t))}${done || p > 0 ? ` <span class="num">${p}</span>` : ''}`;
          return `<li class="${mine ? 'mine' : ''}"${mine && me !== null ? bannerAttr(me) : ''}>${pts(m.home, m.homePoints)} <span class="muted">v</span> ${pts(m.away, m.awayPoints)}${done ? (m.winner === null ? ' <span class="muted">tie</span>' : '') : ''}</li>`;
        })
        .join('');
      const eps = config.schedule.rounds.slice(0, i).reduce((a, b) => a + b, 0);
      const span = `episodes ${eps + 1}–${eps + config.schedule.rounds[i]!}${round === config.schedule.rounds.length ? ' and the finale' : ''}`;
      return `<li><b>Round ${round}</b> <span class="small muted">${span}${done ? ', final' : ''}</span><ul class="matchups small">${list}</ul></li>`;
    })
    .join('');
  const rosters = [...state.taverns.values()]
    .map(
      (t) =>
        `<li class="${t.id === me ? 'mine' : ''}"${t.id === me ? bannerAttr(t.id) : ''}>${flagOf(t.id)} <b>${esc(who(t.id, me))}</b> <span class="faces">${t.roster
          .map((id) => `<span class="${state.alive.includes(id) || !state.draft.complete ? '' : 'gone'}" title="${esc(charName(id))}${state.jury.includes(id) ? `, out in episode ${state.jury.indexOf(id) + 1}` : ''}">${portrait(id, 'sm')}</span>`)
          .join('')}</span></li>`,
    )
    .join('');
  el.innerHTML =
    `<section class="card"><div class="row spread"><h2>Standings</h2><span class="small muted">${state.finalizedRounds.size === 0 ? 'no round played yet' : `after round ${state.finalizedRounds.size} of ${config.schedule.rounds.length}`}</span></div>${table}</section>` +
    (state.draft.order.length === 0 ? '' : `<section class="card"><h3>Head to head</h3><ol class="schedule">${rounds}</ol></section>`) +
    (rosters === '' ? '' : `<section class="card"><h3>Candidates</h3><ul class="rosters">${rosters}</ul></section>`);
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
      if (id !== undefined) move([{ t: 'draft', id }]);
      return;
    case 'g-call':
      if (id !== undefined) {
        move([{ t: 'call', target: id }]);
        renderWork();
        renderBar();
      }
      return;
    case 'g-challenge':
      if (pump === null && s?.stage.kind === 'challenge') {
        setView('room');
        move([{ t: 'challenge' }]);
      }
      return;
    case 'g-vote':
      if (pump === null && s?.stage.kind === 'vote') {
        setView('room');
        move([{ t: 'vote' }]);
      }
      return;
    case 'g-finale':
      if (pump === null && s?.stage.kind === 'finale') {
        setView('room');
        move([{ t: 'finale' }]);
      }
      return;
    case 'g-replay': {
      const key = el.dataset.key;
      const msgEl = key === undefined ? null : $('g-feed').querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
      if (msgEl === null || pump !== null) return;
      const pace = pacer();
      const mine: Pump = { pace, typing: null, replay: true };
      pump = mine;
      renderBar();
      const me = game.session?.humanTavern ?? null;
      const details = msgEl.querySelector('details');
      if (details !== null) details.open = true;
      const run = msgEl.classList.contains('vote') ? readVotes(msgEl, pace, bannerColours(me)) : revealChallenge(msgEl, pace, bannerColours(me));
      void run.then(() => {
        if (pump !== mine) return;
        pump = null;
        renderBar();
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
    case 'g-sort':
      game.draftSort = target.value as typeof game.draftSort;
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
export function initGame({ onComplete }: { readonly onComplete: (s: ContestSession) => void }): void {
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
