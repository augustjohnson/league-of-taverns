/**
 * The mock season loop (T9.2), as pure functions over in-memory data.
 *
 * - `seasonParts` checks a loaded season (scripts' `loadSeason`) and its
 *   missions and reduces them to `SeasonParts`: plain, JSON-safe data.
 *   `seasonInput` turns parts into a `SeasonInput`: everything a run needs,
 *   with one `statsOf` and one `baseOf` shared by every run, so the bots'
 *   per-(statsOf, pool) cache keeps hitting. `prepareSeason` does both. The
 *   browser playground ships parts as JSON and calls `seasonInput` itself.
 * - `runMockSeason` plays one whole season headless with bot managers and
 *   returns the event log, the folded state and a summary. Every event goes
 *   through the engine's `applyEvent` as it is built, so bots obey the real
 *   rules. At the end the log is replayed from its NDJSON (`replayLog`) and
 *   audited (`verifyResolutions`), and any disagreement throws.
 *
 * No I/O, no clock, no ambient randomness: the sim seed drives the bots'
 * randomness, the per-week dice salt and the event timestamps, so the same
 * input and seed always give byte-identical NDJSON. ./load.ts reads the files
 * and ./mock-season.ts is the CLI.
 *
 * Seeds (docs/decisions.md D-13): a live week rolls real dice once, but sims
 * use `weekSeed({ season, week, tavern, salt: simSeed })` so every run is
 * reproducible. The draft order is the engine's (`draftOrderSeed(config.id)`),
 * but the runner shuffles tavern join order per sim seed, so each seat's draft
 * slot varies across runs.
 */
import { BOT_IDS, botManager, valueOf } from '@league-of-taverns/bots';
import type { BotId, BotManager, PublicView } from '@league-of-taverns/bots';
import {
  BATTLE_MODELS,
  TRAITS,
  applyEvent,
  carriedLineup,
  cyrb128,
  effectiveStats,
  freeAgents,
  homeTavern,
  initialState,
  lineHash,
  onTheClock,
  projectMission,
  projectedPoints,
  replayLog,
  resolveWaivers,
  rngFor,
  runMission,
  runPoints,
  seasonStandings,
  standings,
  serializeEvent,
  toBaseStats,
  verifyResolutions,
  weekResults,
  weekSeed,
} from '@league-of-taverns/engine';
import type {
  Actor,
  BaseStats,
  BattleModel,
  CrEighths,
  EffectiveStats,
  EventOf,
  EventType,
  LeagueEvent,
  LeagueState,
  Lineup,
  Mission,
  Open5eMonster,
  Party,
  PayloadByType,
  PooledCharacter,
  ResolutionMismatch,
  SeasonConfig,
  WaiverClaim,
} from '@league-of-taverns/engine';
import { deepEqual } from './deep-equal';

// ── input ──────────────────────────────────────────────────────────────────

export type ScheduleEntry = PayloadByType['season.created']['schedule'][number];
export type SponsorEntry = PayloadByType['season.created']['sponsors'][number];

export interface SeasonInput {
  readonly config: SeasonConfig;
  /** sha256 of config.yaml's text, for `season.created`. */
  readonly configSha256: string;
  /** engine/package.json `version`. */
  readonly engineVersion: string;
  /** The public schedule, with every `commitment` null (missions are open, D-08). */
  readonly schedule: ReadonlyArray<ScheduleEntry>;
  /** The GM's sponsors: which god backs which tavern (D-44). */
  readonly sponsors: ReadonlyArray<SponsorEntry>;
  /** In pool-file order: the order `character.pooled` events are written. */
  readonly pool: ReadonlyArray<{ readonly character: PooledCharacter; readonly cr: CrEighths }>;
  /** In managers-file order: the join order. */
  readonly taverns: ReadonlyArray<{ readonly id: string; readonly name: string; readonly bot: BotId }>;
  /** The commissioner as an actor, or null without a GitHub id (setup events then use the system actor). */
  readonly commissioner: { readonly githubId: number; readonly login: string } | null;
  /** Each week's mission and the sha256 of its canonical JSON. */
  readonly missions: ReadonlyMap<number, { readonly mission: Mission; readonly sha256: string }>;
  /** Base stats by Open5e slug, for encounter creatures. */
  readonly baseOf: (slug: string) => BaseStats;
  /** Effective stats (base + modifiers) by pooled character id. */
  readonly statsOf: (characterId: string) => EffectiveStats;
  /** `BATTLE_MODELS[config.missions.battleModel]`. */
  readonly battleModel: BattleModel;
}

/**
 * What `seasonParts` reads from a loaded season. Scripts' `LoadedSeason`
 * satisfies it; it is spelled out here so this module (and the browser
 * bundle) never imports the I/O layer.
 */
export interface SeasonSource {
  readonly config: SeasonConfig;
  readonly snapshot: ReadonlyArray<Open5eMonster>;
  readonly pool: { readonly characters: ReadonlyArray<PooledCharacter>; readonly cr: ReadonlyMap<string, CrEighths> };
  readonly managers: {
    readonly commissioner: { readonly login: string; readonly githubId: number | null };
    readonly taverns: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly manager: { readonly bot: BotId } | { readonly login: string; readonly githubId: number | null };
    }>;
  };
  readonly schedule: { readonly sponsors: ReadonlyArray<SponsorEntry>; readonly weeks: ReadonlyArray<ScheduleEntry> };
}

/**
 * A season as plain data: no Maps, no functions, so it round-trips through
 * JSON. `seasonInput` builds the run-ready `SeasonInput` from it.
 */
export interface SeasonParts {
  readonly config: SeasonConfig;
  /** sha256 of config.yaml's text, for `season.created`. */
  readonly configSha256: string;
  /** engine/package.json `version`. */
  readonly engineVersion: string;
  /** The public schedule, with every `commitment` null (missions are open, D-08). */
  readonly schedule: ReadonlyArray<ScheduleEntry>;
  /** The GM's sponsors: which god backs which tavern (D-44). */
  readonly sponsors: ReadonlyArray<SponsorEntry>;
  /** In pool-file order. */
  readonly pool: ReadonlyArray<{ readonly character: PooledCharacter; readonly cr: CrEighths }>;
  /** In managers-file order. */
  readonly taverns: ReadonlyArray<{ readonly id: string; readonly name: string; readonly bot: BotId }>;
  readonly commissioner: { readonly githubId: number; readonly login: string } | null;
  /** One mission per schedule week, in week order. */
  readonly missions: ReadonlyArray<{ readonly week: number; readonly mission: Mission; readonly sha256: string }>;
  /** Verbatim Open5e records, covering at least every pool base and encounter creature. The first record per slug wins. */
  readonly snapshot: ReadonlyArray<Open5eMonster>;
}

/**
 * Check a loaded season and reduce it to `SeasonParts`. Each schedule week is
 * matched to the one mission with its environment. Throws if a week has no
 * mission or several, if a tavern is managed by a human (sims seat only
 * bots), or if a pooled character has no CR. Pure: the caller reads the files.
 */
export function seasonParts(
  loaded: SeasonSource,
  missions: ReadonlyArray<Mission>,
  configText: string,
  engineVersion: string,
): SeasonParts {
  const pool = loaded.pool.characters.map((character) => {
    const cr = loaded.pool.cr.get(character.ref.id);
    if (cr === undefined) throw new Error(`pool: no CR for "${character.ref.id}"`);
    return { character, cr };
  });

  const taverns = loaded.managers.taverns.map((tavern) => {
    if (!('bot' in tavern.manager)) throw new Error(`tavern "${tavern.id}" has a human manager; mock seasons seat only bots`);
    return { id: tavern.id, name: tavern.name, bot: tavern.manager.bot };
  });

  const byWeek = loaded.schedule.weeks.map((week) => {
    const matching = missions.filter((m) => m.environment === week.environment);
    if (matching.length !== 1) {
      throw new Error(
        `week ${week.week} (${week.environment}) needs exactly one mission with that environment, found ${matching.length}` +
          (matching.length > 0 ? `: ${matching.map((m) => m.id).join(', ')}` : ''),
      );
    }
    const mission = matching[0]!;
    return { week: week.week, mission, sha256: missionSha256(mission) };
  });

  const { githubId, login } = loaded.managers.commissioner;
  return {
    config: loaded.config,
    configSha256: lineHash(configText),
    engineVersion,
    schedule: loaded.schedule.weeks.map((week) => ({ ...week, commitment: null })),
    sponsors: loaded.schedule.sponsors,
    pool,
    taverns,
    commissioner: githubId === null ? null : { githubId, login },
    missions: byWeek,
    snapshot: loaded.snapshot,
  };
}

/**
 * Build the run-ready `SeasonInput` from `SeasonParts`: base stats from the
 * snapshot records, effective stats per pooled character, the missions by
 * week and the battle model. Throws if the battle model is unknown or a pool
 * base is missing from the snapshot. Pure, and safe in a browser.
 */
export function seasonInput(parts: SeasonParts): SeasonInput {
  const { config } = parts;
  const battleModel = BATTLE_MODELS[config.missions.battleModel];
  if (battleModel === undefined) {
    throw new Error(`unknown battle model "${config.missions.battleModel}" (known: ${Object.keys(BATTLE_MODELS).join(', ')})`);
  }

  const bases = new Map<string, BaseStats>();
  for (const record of parts.snapshot) if (!bases.has(record.slug)) bases.set(record.slug, toBaseStats(record).stats);
  const baseOf = (slug: string): BaseStats => {
    const base = bases.get(slug);
    if (base === undefined) throw new Error(`"${slug}" is not in snapshot ${config.snapshot}`);
    return base;
  };

  const stats = new Map<string, EffectiveStats>();
  for (const { character } of parts.pool) stats.set(character.ref.id, effectiveStats(character, baseOf(character.ref.base), TRAITS));
  const statsOf = (id: string): EffectiveStats => {
    const s = stats.get(id);
    if (s === undefined) throw new Error(`"${id}" is not pooled`);
    return s;
  };

  return {
    config,
    configSha256: parts.configSha256,
    engineVersion: parts.engineVersion,
    schedule: parts.schedule,
    sponsors: parts.sponsors,
    pool: parts.pool,
    taverns: parts.taverns,
    commissioner: parts.commissioner,
    missions: new Map(parts.missions.map(({ week, mission, sha256 }) => [week, { mission, sha256 }])),
    baseOf,
    statsOf,
    battleModel,
  };
}

/** `seasonInput(seasonParts(...))`: build a `SeasonInput` from a loaded season. See both. */
export function prepareSeason(
  loaded: SeasonSource,
  missions: ReadonlyArray<Mission>,
  configText: string,
  engineVersion: string,
): SeasonInput {
  return seasonInput(seasonParts(loaded, missions, configText, engineVersion));
}

/**
 * sha256 of a mission's canonical JSON: keys sorted recursively (UTF-16 code
 * unit order), undefined fields dropped, arrays in order, no whitespace. The
 * same rules `serializeEvent` uses for log lines.
 */
export function missionSha256(mission: Mission): string {
  return lineHash(canonicalJson(mission));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(',')}}`;
  }
  throw new Error(`canonicalJson: cannot serialize a ${typeof value}`);
}

// ── output ─────────────────────────────────────────────────────────────────

/** Who manages a seat in a summary: a bot, or `human` for the person's tavern in a played season. */
export type Seat = BotId | 'human';

export interface RunOptions {
  /** The sim seed: bot randomness, the per-week dice salt and the timestamps. Non-empty, no `/`. */
  readonly seed: string;
}

export interface TavernResult {
  readonly tavern: string;
  readonly bot: Seat;
  readonly source: 'submitted' | 'carried' | 'fallback' | 'none';
  /** Captain first. Null when the tavern played nobody. */
  readonly starters: ReadonlyArray<string> | null;
  readonly points: number;
  readonly projectedPoints: number;
  readonly checksPassed: number;
  readonly checksAttempted: number;
  /** Null when the tavern played nobody. */
  readonly dnf: boolean | null;
  /** This week's rank by points, 1-based; equal points share a rank. */
  readonly rank: number;
  /** True on this tavern's sponsor's week: its points include the home bonus. */
  readonly home: boolean;
}

export interface WeekSummary {
  readonly week: number;
  readonly mission: string;
  /** The tavern whose sponsor set this week's mission, or null. */
  readonly home: string | null;
  readonly results: ReadonlyArray<TavernResult>;
  /** Claims made after this week's run and how they resolved. Empty after the last week. */
  readonly waivers: ReadonlyArray<{
    readonly claim: string;
    readonly tavern: string;
    readonly add: string;
    readonly drop: string | null;
    readonly awarded: boolean;
    readonly reason: string;
  }>;
}

export interface RunSummary {
  readonly seed: string;
  readonly season: string;
  readonly events: number;
  /** Every tavern ranked first. More than one only on an exact tie in total points. */
  readonly champions: ReadonlyArray<{ readonly tavern: string; readonly bot: Seat }>;
  readonly taverns: ReadonlyArray<{ readonly tavern: string; readonly name: string; readonly bot: Seat }>;
  /** Final standings, best first (`seasonStandings`). */
  readonly standings: ReadonlyArray<{
    readonly rank: number;
    readonly tavern: string;
    readonly bot: Seat;
    readonly points: number;
  }>;
  readonly draft: ReadonlyArray<{ readonly pick: number; readonly tavern: string; readonly bot: Seat; readonly character: string }>;
  readonly weeks: ReadonlyArray<WeekSummary>;
}

export interface MockSeasonResult {
  readonly events: ReadonlyArray<LeagueEvent>;
  /** The canonical log, one line per event, with a trailing newline. */
  readonly ndjson: string;
  /** The folded state, with `lastHash` set as `replayLog` sets it. */
  readonly state: LeagueState;
  readonly summary: RunSummary;
  /** The self-check every run passes before it returns (a failure throws instead). */
  readonly audit: SeasonAudit;
}

/** The replay and resolution audit `runMockSeason` runs on every season. */
export interface SeasonAudit {
  /** `replayLog(ndjson)` deep-equals the state built event by event. */
  readonly replayMatches: boolean;
  /** `verifyResolutions(events)`: empty when every `mission.resolved` checks out. */
  readonly mismatches: ReadonlyArray<ResolutionMismatch>;
}

/** Replay `ndjson` and compare it to `state`, then audit every resolution. Reports mismatches; never throws on one. */
export function auditSeason(events: ReadonlyArray<LeagueEvent>, ndjson: string, state: LeagueState): SeasonAudit {
  return { replayMatches: deepEqual(replayLog(ndjson), state), mismatches: verifyResolutions(events) };
}

// ── the season loop ────────────────────────────────────────────────────────

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Thursday 2027-01-07 00:00 UTC. Seasons start on a Thursday 0–519 weeks after it, picked by the seed. */
const EPOCH = Date.UTC(2027, 0, 7);

/** Stamps envelopes, chains `prev`, folds every event through `applyEvent`, and keeps `lastHash` as `replayLog` does. */
class LogBuilder {
  readonly events: LeagueEvent[] = [];
  readonly lines: string[] = [];
  state: LeagueState = initialState();

  constructor(private readonly season: string) {}

  append<T extends EventType>(type: T, payload: EventOf<T>['payload'], actor: Actor, atMs: number): EventOf<T> {
    const prev = this.lines.length === 0 ? null : lineHash(this.lines.at(-1)!);
    const event = { v: 1, seq: this.state.lastSeq + 1, type, season: this.season, at: iso(atMs), actor, prev, payload } as unknown as EventOf<T>;
    const next = applyEvent(this.state, event);
    const line = serializeEvent(event);
    this.state = { ...next, lastHash: lineHash(line) };
    this.events.push(event);
    this.lines.push(line);
    return event;
  }

  get ndjson(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/** ISO-8601 UTC to the second, e.g. `2027-01-07T18:00:00Z`. Arithmetic only: never reads the clock. */
function iso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** A human seat: which tavern a person manages instead of its bot. */
export interface HumanSeat {
  readonly tavern: string;
  /** The `tavern.joined` manager and the actor on the person's events. */
  readonly login: string;
  readonly githubId: number;
}

export interface SessionOptions extends RunOptions {
  /** The tavern a person manages, or null/absent for an all-bot season. Its bot stays on as the advisor (`suggest*`). */
  readonly human?: HumanSeat | null;
}

/** Where a session stands: what has to happen next. */
export type SessionStage =
  | { readonly kind: 'draft'; readonly pick: number; readonly tavern: string }
  | { readonly kind: 'week'; readonly week: number }
  | { readonly kind: 'complete' };

/**
 * One season played a step at a time, with at most one tavern managed by a
 * person and the rest by bots. `runMockSeason` is a session with no person,
 * driven straight through, so both paths build the same events.
 *
 * - `advanceDraft()` makes bot picks until the person is on the clock or the
 *   draft is done; `draftPick(id)` is the person's pick.
 * - Between weeks the person may `setLineup` for the next week (again, to
 *   change it) and `claimWaiver`; claims resolve after that week's run.
 * - `playWeek()` runs the next week: bot lineups, the lock, the reveal, every
 *   resolution, `week.finalized`, then bot claims and `waiver.resolved`.
 * - `finish()` audits the completed log and returns the `MockSeasonResult`.
 *
 * Every command goes through the engine's `applyEvent`, so an illegal one
 * throws an `InvalidEventError` and leaves the session unchanged.
 */
export class SeasonSession {
  readonly input: SeasonInput;
  readonly seed: string;
  readonly human: HumanSeat | null;
  private readonly log: LogBuilder;
  private readonly start: number;
  private readonly bots: Map<string, { id: BotId; manager: BotManager; actor: Actor }>;
  private readonly humanActor: Actor | null;
  private readonly waiverLog = new Map<number, WeekSummary['waivers']>();
  /** Per-week claim ids → seq, for `waiver.resolved`. */
  private claimSeq = new Map<string, number>();
  private claimCount = 0;
  private lastAt = 0;
  /** The next week to play. */
  private week = 1;

  constructor(input: SeasonInput, options: SessionOptions) {
    const simSeed = options.seed;
    if (simSeed.length === 0 || simSeed.includes('/')) throw new Error(`sim seed must be non-empty with no "/", got ${JSON.stringify(simSeed)}`);
    const human = options.human ?? null;
    if (human !== null && !input.taverns.some((t) => t.id === human.tavern)) throw new Error(`no tavern "${human.tavern}" to seat a person in`);
    this.input = input;
    this.seed = simSeed;
    this.human = human;
    this.log = new LogBuilder(input.config.id);
    this.start = EPOCH + (cyrb128(`${simSeed}::start`)[0] % 520) * WEEK;
    this.bots = new Map(input.taverns.map((t) => [t.id, { id: t.bot, manager: botManager(t.bot), actor: { kind: 'bot', strategy: t.bot } }]));
    this.humanActor = human === null ? null : { kind: 'manager', githubId: human.githubId, login: human.login };
    this.preseason();
  }

  get state(): LeagueState {
    return this.log.state;
  }

  get events(): ReadonlyArray<LeagueEvent> {
    return this.log.events;
  }

  get ndjson(): string {
    return this.log.ndjson;
  }

  get stage(): SessionStage {
    const { state } = this.log;
    if (!state.draft.complete) {
      const tavern = onTheClock(state);
      if (tavern === null) throw new Error(`draft stalled at pick ${state.draft.picks}: nobody is on the clock`);
      return { kind: 'draft', pick: state.draft.picks, tavern };
    }
    if (this.week > this.input.config.weeks) return { kind: 'complete' };
    return { kind: 'week', week: this.week };
  }

  /** True when `tavern` is the person's. */
  isHuman(tavern: string): boolean {
    return this.human?.tavern === tavern;
  }

  // ── the draft ────────────────────────────────────────────────────────────

  /** Bot picks, one an hour, until the person is on the clock or the draft is done. */
  advanceDraft(): void {
    for (let stage = this.stage; stage.kind === 'draft' && !this.isHuman(stage.tavern); stage = this.stage) {
      const bot = this.botOf(stage.tavern);
      const character = bot.manager.draft.pick(this.viewFor(stage.tavern, `draft:${stage.pick}`), freeAgents(this.log.state));
      this.append('draft.pick', { pick: stage.pick, tavern: stage.tavern, character, auto: false }, bot.actor, this.draftAt(stage.pick));
    }
  }

  /** The person's pick. Throws unless they are on the clock and the pick is legal. */
  draftPick(character: string): void {
    const stage = this.stage;
    if (stage.kind !== 'draft' || !this.isHuman(stage.tavern)) throw new Error('you are not on the clock');
    this.append('draft.pick', { pick: stage.pick, tavern: stage.tavern, character, auto: false }, this.humanActor!, this.draftAt(stage.pick));
  }

  /** What the person's advisor bot would draft now. */
  suggestPick(): string {
    const stage = this.stage;
    if (stage.kind !== 'draft') throw new Error('the draft is over');
    return this.botOf(stage.tavern).manager.draft.pick(this.viewFor(stage.tavern, `advice:draft:${stage.pick}`), freeAgents(this.log.state));
  }

  /** The bots' `value` rating (strength and skill breadth per CR) for each id, as the person's view sees the pool. Higher is better. */
  draftValues(ids: ReadonlyArray<string>): ReadonlyMap<string, number> {
    const human = this.requireHuman();
    const view = this.viewFor(human.tavern, 'advice:value');
    return new Map(ids.map((id) => [id, valueOf(view, id)]));
  }

  // ── between weeks ────────────────────────────────────────────────────────

  /** Set (or replace) the person's lineup for the next week. Throws if it is illegal. */
  setLineup(lineup: Lineup): void {
    const human = this.requireHuman();
    const week = this.requireWeek();
    this.append('lineup.set', { tavern: human.tavern, week, lineup }, this.humanActor!, this.lastAt + MINUTE);
  }

  /** What the person's advisor bot would field next week, or null if no legal lineup exists. */
  suggestLineup(): Lineup | null {
    const human = this.requireHuman();
    const week = this.requireWeek();
    return this.botOf(human.tavern).manager.lineup.lineup(this.viewFor(human.tavern, `advice:lineup:${week}`), week);
  }

  /** The person's submitted lineup for the next week, or null if none yet (the lock then carries one over). */
  pendingLineup(): Lineup | null {
    const human = this.requireHuman();
    return this.log.state.pendingLineups.get(this.week)?.get(human.tavern) ?? null;
  }

  /** Claim a free agent for the person, resolved after the next week's run. Not in the last week (no waivers follow it). */
  claimWaiver(add: string, drop: string | null): string {
    const human = this.requireHuman();
    const week = this.requireWeek();
    if (week >= this.input.config.weeks) throw new Error('no waivers after the last week');
    return this.claim(human.tavern, add, drop, this.humanActor!, this.lastAt + MINUTE);
  }

  /** The advisor bot's claims for the person right now. */
  suggestClaims(): ReadonlyArray<{ readonly add: string; readonly drop: string | null }> {
    const human = this.requireHuman();
    const week = this.requireWeek();
    return this.botOf(human.tavern).manager.waivers.claims(this.viewFor(human.tavern, `advice:waivers:${week}`), freeAgents(this.log.state));
  }

  /** Claims waiting for the next resolution. */
  pendingClaims(): LeagueState['waivers']['pending'] {
    return this.log.state.waivers.pending;
  }

  // ── a week ───────────────────────────────────────────────────────────────

  /** Play the next week: lineups, lock, reveal, runs, `week.finalized`, then (before the last week) waivers. */
  playWeek(): void {
    const { input } = this;
    const { config } = input;
    const week = this.requireWeek();
    const season = config.id;
    const base = this.start + (week - 1) * WEEK;
    const scheduled = input.missions.get(week);
    if (scheduled === undefined) throw new Error(`no mission for week ${week}`);
    const system = (workflow: string): Actor => ({ kind: 'system', workflow });

    // Lineups, then the lock.
    input.taverns.forEach(({ id: tavern }, i) => {
      if (this.isHuman(tavern)) return;
      const bot = this.botOf(tavern);
      const lineup = bot.manager.lineup.lineup(this.viewFor(tavern, `lineup:${week}`), week);
      if (lineup !== null) this.append('lineup.set', { tavern, week, lineup }, bot.actor, base + 17 * HOUR + i * MINUTE);
    });
    const state = this.log.state;
    const submitted = state.pendingLineups.get(week);
    const previous = state.lockedLineups.get(week - 1);
    const crOf = (id: string): CrEighths => {
      const entry = state.pool.get(id);
      if (entry === undefined) throw new Error(`"${id}" is not pooled`);
      return entry.cr;
    };
    const lineups = input.taverns.map(({ id: tavern }): PayloadByType['lineup.locked']['lineups'][number] => {
      const own = submitted?.get(tavern);
      if (own !== undefined) return { tavern, lineup: own, source: 'submitted' };
      const last = previous?.find((entry) => entry.tavern === tavern)?.lineup ?? null;
      const roster = { tavern, characters: state.taverns.get(tavern)?.roster ?? [] };
      const lineup = carriedLineup(last, roster, crOf, config);
      if (lineup === null) return { tavern, lineup: null, source: 'none' };
      return { tavern, lineup, source: lineup === last ? 'carried' : 'fallback' };
    });
    this.append('lineup.locked', { week, lineups }, system('lineup-lock'), base + 18 * HOUR);

    // Reveal, run, finalize.
    const run = base + 18 * HOUR + 15 * MINUTE;
    let r = 0;
    const { mission, sha256 } = scheduled;
    const home = homeTavern(this.log.state, week);
    this.append('mission.revealed', { week, mission, sha256, salt: null }, system('weekly-run'), run + r++ * SECOND);
    for (const { tavern, lineup } of lineups) {
      if (lineup === null) continue;
      const party = partyOf(lineup, input.statsOf);
      const seed = weekSeed({ season, week, tavern, salt: this.seed });
      const result = runMission(party, mission, (node) => rngFor(seed, `roll:${node}`), input.baseOf, input.battleModel);
      const projection = projectMission(party, mission, input.baseOf, input.battleModel);
      this.append(
        'mission.resolved',
        {
          week,
          tavern,
          mission: mission.id,
          seed,
          engineVersion: input.engineVersion,
          battleModel: input.battleModel.id,
          lineup,
          run: result,
          projected: { expectedScore: projection.expectedScore, pDnf: projection.pDnf },
          points: runPoints(result.score, config.scoring, tavern === home),
          // Exact expected points (docs/rules.md §7), unrounded like the projection itself.
          projectedPoints: projectedPoints(projection.expectedScore, config.scoring, tavern === home),
        },
        system('weekly-run'),
        run + r++ * SECOND,
      );
    }
    this.append('week.finalized', { week }, system('weekly-run'), run + r * SECOND);

    // Waivers between weeks: every bot's claims, then one resolution.
    if (week < config.weeks) {
      for (const { id: tavern } of input.taverns) {
        if (this.isHuman(tavern)) continue;
        const bot = this.botOf(tavern);
        const claims = bot.manager.waivers.claims(this.viewFor(tavern, `waivers:${week}`), freeAgents(this.log.state));
        for (const { add, drop } of claims) this.claim(tavern, add, drop, bot.actor, base + 20 * HOUR + this.claimCount * SECOND);
      }
      const now = this.log.state;
      // Claim ids by seq (resolveWaivers orders a tavern's claims by seq) and back.
      const claimAt = new Map<number, string>();
      const pending: WaiverClaim[] = now.waivers.pending.map((p) => {
        const seq = this.claimSeq.get(p.claim);
        if (seq === undefined) throw new Error(`pending claim "${p.claim}" was not made this week`);
        claimAt.set(seq, p.claim);
        return { tavern: p.tavern, add: p.add, drop: p.drop, seq };
      });
      const rosters = [...now.taverns.values()].map((t) => ({ tavern: t.id, characters: t.roster }));
      const resolved = resolveWaivers(pending, now.waivers.priority, rosters, new Set(freeAgents(now)), config);
      const outcomes = resolved.awards.map(({ claim, awarded, reason }) => ({ claim: claimAt.get(claim.seq)!, awarded, reason }));
      const claimed = new Map(now.waivers.pending.map((p) => [p.claim, p]));
      this.append('waiver.resolved', { week, outcomes, priorityAfter: resolved.priority }, system('waivers'), base + DAY + 12 * HOUR);
      this.waiverLog.set(
        week,
        outcomes.map((o) => {
          const p = claimed.get(o.claim)!;
          return { claim: o.claim, tavern: p.tavern, add: p.add, drop: p.drop, awarded: o.awarded, reason: o.reason };
        }),
      );
      this.claimSeq = new Map();
      this.claimCount = 0;
    }
    this.week++;
  }

  /**
   * Audit the completed season and return its result. Throws if the season
   * is not complete, the NDJSON does not replay to the built state, or
   * `verifyResolutions` finds a mismatch.
   */
  finish(): MockSeasonResult {
    const { log } = this;
    const simSeed = this.seed;
    if (log.state.phase !== 'complete') throw new Error(`season ended in phase "${log.state.phase}", expected "complete"`);
    // Replay and audit: the log alone must rebuild the same state.
    const ndjson = log.ndjson;
    const audit = auditSeason(log.events, ndjson, log.state);
    if (!audit.replayMatches) throw new Error(`seed ${simSeed}: replayLog(ndjson) differs from the state built event by event`);
    const { mismatches } = audit;
    if (mismatches.length > 0) {
      throw new Error(
        `seed ${simSeed}: verifyResolutions found ${mismatches.length} mismatch(es):\n` +
          mismatches.map((m) => `  seq ${m.seq} week ${m.week} ${m.tavern} ${m.field}: ${m.message}`).join('\n'),
      );
    }
    return { events: log.events, ndjson, state: log.state, summary: summarize(this.input, simSeed, log.state, log.events, this.waiverLog, this.human), audit };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** 1–3. Preseason: the season, the pool, the taverns. */
  private preseason(): void {
    const { input } = this;
    const setupActor: Actor =
      input.commissioner === null ? { kind: 'system', workflow: 'mock-season' } : { kind: 'commissioner', ...input.commissioner };
    const preseason = this.start - 14 * DAY + 9 * HOUR;
    let k = 0;
    this.append(
      'season.created',
      { config: input.config, configSha256: input.configSha256, engineVersion: input.engineVersion, schedule: input.schedule, sponsors: input.sponsors },
      setupActor,
      preseason + k++ * SECOND,
    );
    for (const { character, cr } of input.pool) {
      this.append(
        'character.pooled',
        { character: character.ref.id, base: character.ref.base, cr, modifiers: character.modifiers },
        setupActor,
        preseason + k++ * SECOND,
      );
    }
    // Join order feeds the seeded draft-order shuffle, which is keyed by season
    // only. Shuffling join order per sim seed varies each seat's draft slot
    // across runs, so per-bot results aren't confounded with a fixed slot.
    const joinOrder = [...input.taverns];
    const joinRng = rngFor(this.seed, 'join-order');
    for (let i = joinOrder.length - 1; i > 0; i--) {
      const j = Math.floor(joinRng() * (i + 1));
      [joinOrder[i], joinOrder[j]] = [joinOrder[j]!, joinOrder[i]!];
    }
    for (const tavern of joinOrder) {
      const human = this.isHuman(tavern.id) ? this.human! : null;
      const manager = human === null ? { bot: tavern.bot } : { githubId: human.githubId, login: human.login };
      this.append('tavern.joined', { tavern: tavern.id, name: tavern.name, manager }, setupActor, preseason + k++ * SECOND);
    }
  }

  /** 4. The draft, one pick an hour. */
  private draftAt(pick: number): number {
    return this.start - 10 * DAY + 18 * HOUR + pick * HOUR;
  }

  private claim(tavern: string, add: string, drop: string | null, actor: Actor, atMs: number): string {
    const claim = `w${this.week}-${tavern}-${this.log.state.waivers.pending.filter((p) => p.tavern === tavern).length + 1}`;
    const event = this.append('waiver.claimed', { claim, tavern, add, drop }, actor, atMs);
    this.claimSeq.set(claim, event.seq);
    this.claimCount++;
    return claim;
  }

  /** Append through the log, keeping timestamps in order: a person's moves can run ahead of the bots' schedule. */
  private append<T extends EventType>(type: T, payload: EventOf<T>['payload'], actor: Actor, atMs: number): EventOf<T> {
    const at = Math.max(atMs, this.lastAt);
    const event = this.log.append(type, payload, actor, at);
    this.lastAt = at;
    return event;
  }

  private botOf(tavern: string): { id: BotId; manager: BotManager; actor: Actor } {
    const bot = this.bots.get(tavern);
    if (bot === undefined) throw new Error(`no bot for tavern "${tavern}"`);
    return bot;
  }

  private viewFor(tavern: string, decision: string): PublicView {
    const { input } = this;
    return {
      state: this.log.state,
      tavern,
      statsOf: input.statsOf,
      schedule: input.schedule,
      missionFor: (week) => input.missions.get(week)?.mission ?? null,
      baseOf: input.baseOf,
      battleModel: input.battleModel,
      rng: rngFor(this.seed, `bot:${tavern}:${decision}`),
    };
  }

  private requireHuman(): HumanSeat {
    if (this.human === null) throw new Error('this season has no human seat');
    return this.human;
  }

  private requireWeek(): number {
    const stage = this.stage;
    if (stage.kind !== 'week') throw new Error(stage.kind === 'draft' ? 'the draft is not over' : 'the season is over');
    return stage.week;
  }
}

/**
 * Play one season with bots in every seat: `season.created` →
 * `character.pooled` × pool → `tavern.joined` × taverns → the whole snake
 * draft → for each week `lineup.set` × bots, `lineup.locked`,
 * `mission.revealed`, `mission.resolved` × taverns with a lineup,
 * `week.finalized`, and (before the last week) `waiver.claimed` × claims and
 * `waiver.resolved`.
 *
 * Throws if the engine rejects any event (a bot or runner bug, never
 * swallowed), if the NDJSON does not replay to the built state, or if
 * `verifyResolutions` finds a mismatch.
 */
export function runMockSeason(input: SeasonInput, options: RunOptions): MockSeasonResult {
  const session = new SeasonSession(input, { seed: options.seed });
  session.advanceDraft();
  while (session.stage.kind === 'week') session.playWeek();
  return session.finish();
}

function partyOf(lineup: Lineup, statsOf: (id: string) => EffectiveStats): Party {
  return { members: lineup.starters.map(statsOf) };
}

// ── summary ────────────────────────────────────────────────────────────────

function summarize(
  input: SeasonInput,
  seed: string,
  state: LeagueState,
  events: ReadonlyArray<LeagueEvent>,
  waivers: ReadonlyMap<number, WeekSummary['waivers']>,
  human: HumanSeat | null = null,
): RunSummary {
  const config = state.config!;
  const botId = new Map<string, Seat>(input.taverns.map((t) => [t.id, t.id === human?.tavern ? 'human' : t.bot]));
  const bot = (tavern: string): Seat => botId.get(tavern)!;

  const table = seasonStandings(state).map((row) => ({ ...row, bot: bot(row.tavern) }));
  const champions = table.filter((row) => row.rank === 1).map(({ tavern, bot }) => ({ tavern, bot }));
  if (champions.length === 0) throw new Error('summary: no standings');

  const weeks: WeekSummary[] = [];
  for (let week = 1; week <= config.weeks; week++) {
    const locked = state.lockedLineups.get(week) ?? [];
    const resolved = state.results.get(week);
    const rankOf = new Map(standings([], weekResults(state, week)).map((r) => [r.tavern, r.rank]));
    const home = homeTavern(state, week);
    weeks.push({
      week,
      mission: state.revealed.get(week)?.id ?? '',
      home,
      results: locked.map(({ tavern, lineup, source }) => {
        const r = resolved?.get(tavern);
        return {
          tavern,
          bot: bot(tavern),
          source,
          starters: lineup === null ? null : lineup.starters,
          points: r?.points ?? 0,
          projectedPoints: r?.projectedPoints ?? 0,
          checksPassed: r?.run.checksPassed ?? 0,
          checksAttempted: r?.run.checksAttempted ?? 0,
          dnf: r === undefined ? null : r.run.dnf,
          rank: rankOf.get(tavern) ?? 1,
          home: tavern === home,
        };
      }),
      waivers: waivers.get(week) ?? [],
    });
  }

  const draft = events
    .filter((e): e is EventOf<'draft.pick'> => e.type === 'draft.pick')
    .map(({ payload: { pick, tavern, character } }) => ({ pick, tavern, bot: bot(tavern), character }));

  return {
    seed,
    season: config.id,
    events: events.length,
    champions,
    taverns: input.taverns.map((t) => ({ tavern: t.id, name: t.name, bot: bot(t.id) })),
    standings: table,
    draft,
    weeks,
  };
}

// ── many runs ──────────────────────────────────────────────────────────────

/** Run n's seed (1-based): the base seed itself for run 1, so one run reproduces `runMockSeason({ seed })`; then `<seed>~<n>`. */
export function runSeed(seed: string, n: number): string {
  return n === 1 ? seed : `${seed}~${n}`;
}

export interface BotAggregate {
  /** Tavern-seasons this bot managed. */
  readonly seats: number;
  /** Titles won; co-champions split one title evenly. */
  readonly titles: number;
  /** titles / seats: the chance a given seat with this bot wins the title. 1 / taverns is par. */
  readonly titlesPerSeat: number;
  /** Mean points per tavern-week (0 for a week played with nobody). */
  readonly meanPoints: number;
  readonly meanProjected: number;
  /** Share of this bot's runs that ended in a DNF. */
  readonly dnfRate: number;
  /** Share of tavern-weeks this bot topped the week (a shared top splits evenly). 1 / taverns is par. */
  readonly weekTopRate: number;
}

export interface Aggregate {
  readonly runs: number;
  readonly byBot: Readonly<Record<string, BotAggregate>>;
  /** Titles by tavern seat. Draft slots vary per run (join order is shuffled per seed). */
  readonly titlesByTavern: Readonly<Record<string, number>>;
  /** Weeks with a single highest-projected tavern, and how often it topped the week (alone or shared). */
  readonly bestProjectedTops: { readonly weeks: number; readonly tops: number; readonly share: number };
  /** Share of all mission runs that ended in a DNF. */
  readonly dnfRate: number;
  /** Tavern-weeks played with no lineup. */
  readonly noLineupWeeks: number;
}

export function aggregate(runs: ReadonlyArray<RunSummary>): Aggregate {
  const blank = (): { seats: number; titles: number; points: number; projected: number; weeks: number; runs: number; dnfs: number; tops: number } => ({
    seats: 0,
    titles: 0,
    points: 0,
    projected: 0,
    weeks: 0,
    runs: 0,
    dnfs: 0,
    tops: 0,
  });
  const tally = new Map<string, ReturnType<typeof blank>>(BOT_IDS.map((id) => [id, blank()]));
  const of = (id: string): ReturnType<typeof blank> => {
    let t = tally.get(id);
    if (t === undefined) tally.set(id, (t = blank()));
    return t;
  };
  const titlesByTavern: Record<string, number> = {};
  let projectedWeeks = 0;
  let projectedTops = 0;
  let mission = 0;
  let dnfs = 0;
  let noLineup = 0;

  for (const run of runs) {
    for (const t of run.taverns) {
      of(t.bot).seats++;
      titlesByTavern[t.tavern] ??= 0;
    }
    for (const c of run.champions) {
      of(c.bot).titles += 1 / run.champions.length;
      titlesByTavern[c.tavern] = (titlesByTavern[c.tavern] ?? 0) + 1 / run.champions.length;
    }
    for (const week of run.weeks) {
      for (const r of week.results) {
        const t = of(r.bot);
        t.points += r.points;
        t.projected += r.projectedPoints;
        t.weeks++;
        if (r.dnf === null) {
          noLineup++;
          continue;
        }
        t.runs++;
        mission++;
        if (r.dnf) {
          t.dnfs++;
          dnfs++;
        }
      }
      const top = week.results.filter((r) => r.rank === 1);
      for (const r of top) of(r.bot).tops += 1 / top.length;
      const best = Math.max(...week.results.map((r) => r.projectedPoints));
      const bestProjected = week.results.filter((r) => r.projectedPoints === best);
      if (bestProjected.length === 1) {
        projectedWeeks++;
        if (bestProjected[0]!.rank === 1) projectedTops++;
      }
    }
  }

  const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);
  const byBot: Record<string, BotAggregate> = {};
  for (const [id, t] of tally) {
    if (t.seats === 0) continue;
    byBot[id] = {
      seats: t.seats,
      titles: t.titles,
      titlesPerSeat: ratio(t.titles, t.seats),
      meanPoints: ratio(t.points, t.weeks),
      meanProjected: ratio(t.projected, t.weeks),
      dnfRate: ratio(t.dnfs, t.runs),
      weekTopRate: ratio(t.tops, t.weeks),
    };
  }
  return {
    runs: runs.length,
    byBot,
    titlesByTavern,
    bestProjectedTops: { weeks: projectedWeeks, tops: projectedTops, share: ratio(projectedTops, projectedWeeks) },
    dnfRate: ratio(dnfs, mission),
    noLineupWeeks: noLineup,
  };
}
