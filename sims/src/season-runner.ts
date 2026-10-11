/**
 * The mock season loop (T9.2), as pure functions over in-memory data.
 *
 * - `prepareSeason` turns a loaded season (scripts' `loadSeason`), its
 *   missions and the raw config text into a `SeasonInput`: everything a run
 *   needs, with one `statsOf` and one `baseOf` shared by every run, so the
 *   bots' per-(statsOf, pool) cache keeps hitting.
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
 * so it does not vary with the sim seed.
 */
import { isDeepStrictEqual } from 'node:util';
import { BOT_IDS, botManager } from '@league-of-taverns/bots';
import type { BotId, BotManager, PublicView } from '@league-of-taverns/bots';
import {
  BATTLE_MODELS,
  TRAITS,
  applyEvent,
  carriedLineup,
  cyrb128,
  effectiveStats,
  freeAgents,
  headToHeadSchedule,
  initialState,
  lineHash,
  matchupWinner,
  onTheClock,
  projectMission,
  replayLog,
  resolveWaivers,
  rngFor,
  runMission,
  seasonStandings,
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
  Party,
  PayloadByType,
  PooledCharacter,
  SeasonConfig,
  WaiverClaim,
} from '@league-of-taverns/engine';
import type { LoadedSeason } from '@league-of-taverns/scripts/lib/season';

// ── input ──────────────────────────────────────────────────────────────────

export type ScheduleEntry = PayloadByType['season.created']['schedule'][number];

export interface SeasonInput {
  readonly config: SeasonConfig;
  /** sha256 of config.yaml's text, for `season.created`. */
  readonly configSha256: string;
  /** engine/package.json `version`. */
  readonly engineVersion: string;
  /** The public schedule, with every `commitment` null (missions are open, D-08). */
  readonly schedule: ReadonlyArray<ScheduleEntry>;
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
 * Build a `SeasonInput` from a loaded season. Each schedule week is matched to
 * the one mission with its environment. Throws if a week has no mission or
 * several, if a tavern is managed by a human (sims seat only bots), or if the
 * battle model is unknown. Pure: the caller reads the files.
 */
export function prepareSeason(
  loaded: Pick<LoadedSeason, 'config' | 'snapshot' | 'pool' | 'managers' | 'schedule'>,
  missions: ReadonlyArray<Mission>,
  configText: string,
  engineVersion: string,
): SeasonInput {
  const { config } = loaded;
  const battleModel = BATTLE_MODELS[config.missions.battleModel];
  if (battleModel === undefined) {
    throw new Error(`unknown battle model "${config.missions.battleModel}" (known: ${Object.keys(BATTLE_MODELS).join(', ')})`);
  }

  const bases = new Map<string, BaseStats>();
  for (const record of loaded.snapshot) if (!bases.has(record.slug)) bases.set(record.slug, toBaseStats(record).stats);
  const baseOf = (slug: string): BaseStats => {
    const base = bases.get(slug);
    if (base === undefined) throw new Error(`"${slug}" is not in snapshot ${config.snapshot}`);
    return base;
  };

  const stats = new Map<string, EffectiveStats>();
  const pool = loaded.pool.characters.map((character) => {
    const cr = loaded.pool.cr.get(character.ref.id);
    if (cr === undefined) throw new Error(`pool: no CR for "${character.ref.id}"`);
    stats.set(character.ref.id, effectiveStats(character, baseOf(character.ref.base), TRAITS));
    return { character, cr };
  });
  const statsOf = (id: string): EffectiveStats => {
    const s = stats.get(id);
    if (s === undefined) throw new Error(`"${id}" is not pooled`);
    return s;
  };

  const taverns = loaded.managers.taverns.map((tavern) => {
    if (!('bot' in tavern.manager)) throw new Error(`tavern "${tavern.id}" has a human manager; mock seasons seat only bots`);
    return { id: tavern.id, name: tavern.name, bot: tavern.manager.bot };
  });

  const byWeek = new Map<number, { mission: Mission; sha256: string }>();
  for (const week of loaded.schedule.weeks) {
    const matching = missions.filter((m) => m.environment === week.environment);
    if (matching.length !== 1) {
      throw new Error(
        `week ${week.week} (${week.environment}) needs exactly one mission with that environment, found ${matching.length}` +
          (matching.length > 0 ? `: ${matching.map((m) => m.id).join(', ')}` : ''),
      );
    }
    const mission = matching[0]!;
    byWeek.set(week.week, { mission, sha256: missionSha256(mission) });
  }

  const { githubId, login } = loaded.managers.commissioner;
  return {
    config,
    configSha256: lineHash(configText),
    engineVersion,
    schedule: loaded.schedule.weeks.map((week) => ({ ...week, commitment: null })),
    pool,
    taverns,
    commissioner: githubId === null ? null : { githubId, login },
    missions: byWeek,
    baseOf,
    statsOf,
    battleModel,
  };
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

export interface RunOptions {
  /** The sim seed: bot randomness, the per-week dice salt and the timestamps. Non-empty, no `/`. */
  readonly seed: string;
}

export interface TavernResult {
  readonly tavern: string;
  readonly bot: BotId;
  readonly source: 'submitted' | 'carried' | 'fallback' | 'none';
  /** Captain first. Null when the tavern played nobody. */
  readonly starters: ReadonlyArray<string> | null;
  readonly points: number;
  readonly projectedPoints: number;
  readonly checksPassed: number;
  readonly checksAttempted: number;
  /** Null when the tavern played nobody. */
  readonly dnf: boolean | null;
}

export interface MatchupResult {
  readonly home: string;
  readonly away: string;
  /** The winning tavern, or null for a tie. */
  readonly winner: string | null;
  /** The tavern with more projected points, or null when level. */
  readonly higherProjected: string | null;
}

export interface WeekSummary {
  readonly week: number;
  readonly mission: string;
  readonly results: ReadonlyArray<TavernResult>;
  readonly matchups: ReadonlyArray<MatchupResult>;
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
  readonly champion: { readonly tavern: string; readonly bot: BotId };
  readonly taverns: ReadonlyArray<{ readonly tavern: string; readonly name: string; readonly bot: BotId }>;
  /** Final standings, best first (`seasonStandings`). */
  readonly standings: ReadonlyArray<{
    readonly rank: number;
    readonly tavern: string;
    readonly bot: BotId;
    readonly wins: number;
    readonly losses: number;
    readonly ties: number;
    readonly pointsFor: number;
    readonly pointsAgainst: number;
  }>;
  readonly draft: ReadonlyArray<{ readonly pick: number; readonly tavern: string; readonly bot: BotId; readonly character: string }>;
  readonly weeks: ReadonlyArray<WeekSummary>;
}

export interface MockSeasonResult {
  readonly events: ReadonlyArray<LeagueEvent>;
  /** The canonical log, one line per event, with a trailing newline. */
  readonly ndjson: string;
  /** The folded state, with `lastHash` set as `replayLog` sets it. */
  readonly state: LeagueState;
  readonly summary: RunSummary;
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

/**
 * Play one season: `season.created` → `character.pooled` × pool →
 * `tavern.joined` × taverns → the whole snake draft → for each week
 * `lineup.set` × bots, `lineup.locked`, `mission.revealed`,
 * `mission.resolved` × taverns with a lineup, `week.finalized`, and (before
 * the last week) `waiver.claimed` × claims and `waiver.resolved`.
 *
 * Throws if the engine rejects any event (a bot or runner bug, never
 * swallowed), if the NDJSON does not replay to the built state, or if
 * `verifyResolutions` finds a mismatch.
 */
export function runMockSeason(input: SeasonInput, options: RunOptions): MockSeasonResult {
  const { config } = input;
  const simSeed = options.seed;
  if (simSeed.length === 0 || simSeed.includes('/')) throw new Error(`sim seed must be non-empty with no "/", got ${JSON.stringify(simSeed)}`);
  const season = config.id;
  const log = new LogBuilder(season);
  const start = EPOCH + (cyrb128(`${simSeed}::start`)[0] % 520) * WEEK;
  const weekStart = (week: number): number => start + (week - 1) * WEEK;

  const setupActor: Actor =
    input.commissioner === null ? { kind: 'system', workflow: 'mock-season' } : { kind: 'commissioner', ...input.commissioner };
  const system = (workflow: string): Actor => ({ kind: 'system', workflow });
  const bots = new Map<string, { id: BotId; manager: BotManager; actor: Actor }>(
    input.taverns.map((t) => [t.id, { id: t.bot, manager: botManager(t.bot), actor: { kind: 'bot', strategy: t.bot } }]),
  );
  const botOf = (tavern: string): { id: BotId; manager: BotManager; actor: Actor } => {
    const bot = bots.get(tavern);
    if (bot === undefined) throw new Error(`no bot for tavern "${tavern}"`);
    return bot;
  };
  const missionFor = (week: number): Mission | null => input.missions.get(week)?.mission ?? null;
  const viewFor = (tavern: string, decision: string): PublicView => ({
    state: log.state,
    tavern,
    statsOf: input.statsOf,
    schedule: input.schedule,
    missionFor,
    baseOf: input.baseOf,
    battleModel: input.battleModel,
    rng: rngFor(simSeed, `bot:${tavern}:${decision}`),
  });

  // 1–3. Preseason: the season, the pool, the taverns.
  const preseason = start - 14 * DAY + 9 * HOUR;
  let k = 0;
  log.append(
    'season.created',
    { config, configSha256: input.configSha256, engineVersion: input.engineVersion, schedule: input.schedule },
    setupActor,
    preseason + k++ * SECOND,
  );
  for (const { character, cr } of input.pool) {
    log.append(
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
  const joinRng = rngFor(simSeed, 'join-order');
  for (let i = joinOrder.length - 1; i > 0; i--) {
    const j = Math.floor(joinRng() * (i + 1));
    [joinOrder[i], joinOrder[j]] = [joinOrder[j]!, joinOrder[i]!];
  }
  for (const tavern of joinOrder) {
    log.append('tavern.joined', { tavern: tavern.id, name: tavern.name, manager: { bot: tavern.bot } }, setupActor, preseason + k++ * SECOND);
  }

  // 4. The draft, one pick an hour.
  const draftStart = start - 10 * DAY + 18 * HOUR;
  while (!log.state.draft.complete) {
    const tavern = onTheClock(log.state);
    if (tavern === null) throw new Error(`draft stalled at pick ${log.state.draft.picks}: nobody is on the clock`);
    const pick = log.state.draft.picks;
    const bot = botOf(tavern);
    const character = bot.manager.draft.pick(viewFor(tavern, `draft:${pick}`), freeAgents(log.state));
    log.append('draft.pick', { pick, tavern, character, auto: false }, bot.actor, draftStart + pick * HOUR);
  }

  // 5. The weeks.
  const crOf = (id: string): CrEighths => {
    const entry = log.state.pool.get(id);
    if (entry === undefined) throw new Error(`"${id}" is not pooled`);
    return entry.cr;
  };
  const waiverLog = new Map<number, WeekSummary['waivers']>();
  for (let week = 1; week <= config.weeks; week++) {
    const base = weekStart(week);
    const scheduled = input.missions.get(week);
    if (scheduled === undefined) throw new Error(`no mission for week ${week}`);

    // Lineups, then the lock.
    input.taverns.forEach(({ id: tavern }, i) => {
      const bot = botOf(tavern);
      const lineup = bot.manager.lineup.lineup(viewFor(tavern, `lineup:${week}`), week);
      if (lineup !== null) log.append('lineup.set', { tavern, week, lineup }, bot.actor, base + 17 * HOUR + i * MINUTE);
    });
    const submitted = log.state.pendingLineups.get(week);
    const previous = log.state.lockedLineups.get(week - 1);
    const lineups = input.taverns.map(({ id: tavern }): PayloadByType['lineup.locked']['lineups'][number] => {
      const own = submitted?.get(tavern);
      if (own !== undefined) return { tavern, lineup: own, source: 'submitted' };
      const last = previous?.find((entry) => entry.tavern === tavern)?.lineup ?? null;
      const roster = { tavern, characters: log.state.taverns.get(tavern)?.roster ?? [] };
      const lineup = carriedLineup(last, roster, crOf, config);
      if (lineup === null) return { tavern, lineup: null, source: 'none' };
      return { tavern, lineup, source: lineup === last ? 'carried' : 'fallback' };
    });
    log.append('lineup.locked', { week, lineups }, system('lineup-lock'), base + 18 * HOUR);

    // Reveal, run, finalize.
    const run = base + 18 * HOUR + 15 * MINUTE;
    let r = 0;
    const { mission, sha256 } = scheduled;
    log.append('mission.revealed', { week, mission, sha256, salt: null }, system('weekly-run'), run + r++ * SECOND);
    for (const { tavern, lineup } of lineups) {
      if (lineup === null) continue;
      const party = partyOf(lineup, input.statsOf);
      const seed = weekSeed({ season, week, tavern, salt: simSeed });
      const result = runMission(party, mission, (node) => rngFor(seed, `roll:${node}`), input.baseOf, input.battleModel);
      const projection = projectMission(party, mission, input.baseOf, input.battleModel);
      log.append(
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
          points: Math.round(result.score * config.scoring.pointsScale),
          // Exact expected points (docs/rules.md §7), unrounded like the projection itself.
          projectedPoints: projection.expectedScore * config.scoring.pointsScale,
        },
        system('weekly-run'),
        run + r++ * SECOND,
      );
    }
    log.append('week.finalized', { week }, system('weekly-run'), run + r * SECOND);

    // Waivers between weeks: every bot's claims, then one resolution.
    if (week < config.weeks) {
      // Claim ids by seq (resolveWaivers orders a tavern's claims by seq) and back.
      const claimAt = new Map<number, string>();
      const seqOf = new Map<string, number>();
      let c = 0;
      for (const { id: tavern } of input.taverns) {
        const bot = botOf(tavern);
        const claims = bot.manager.waivers.claims(viewFor(tavern, `waivers:${week}`), freeAgents(log.state));
        claims.forEach(({ add, drop }, i) => {
          const claim = `w${week}-${tavern}-${i + 1}`;
          const event = log.append('waiver.claimed', { claim, tavern, add, drop }, bot.actor, base + 20 * HOUR + c++ * SECOND);
          claimAt.set(event.seq, claim);
          seqOf.set(claim, event.seq);
        });
      }
      const pending: WaiverClaim[] = log.state.waivers.pending.map((p) => {
        const seq = seqOf.get(p.claim);
        if (seq === undefined) throw new Error(`pending claim "${p.claim}" was not made this week`);
        return { tavern: p.tavern, add: p.add, drop: p.drop, seq };
      });
      const rosters = [...log.state.taverns.values()].map((t) => ({ tavern: t.id, characters: t.roster }));
      const resolved = resolveWaivers(pending, log.state.waivers.priority, rosters, new Set(freeAgents(log.state)), config);
      const outcomes = resolved.awards.map(({ claim, awarded, reason }) => ({ claim: claimAt.get(claim.seq)!, awarded, reason }));
      const claimed = new Map(log.state.waivers.pending.map((p) => [p.claim, p]));
      log.append('waiver.resolved', { week, outcomes, priorityAfter: resolved.priority }, system('waivers'), base + DAY + 12 * HOUR);
      waiverLog.set(
        week,
        outcomes.map((o) => {
          const p = claimed.get(o.claim)!;
          return { claim: o.claim, tavern: p.tavern, add: p.add, drop: p.drop, awarded: o.awarded, reason: o.reason };
        }),
      );
    }
  }

  if (log.state.phase !== 'complete') throw new Error(`season ended in phase "${log.state.phase}", expected "complete"`);

  // Replay and audit: the log alone must rebuild the same state.
  const ndjson = log.ndjson;
  const replayed = replayLog(ndjson);
  if (!isDeepStrictEqual(replayed, log.state)) throw new Error(`seed ${simSeed}: replayLog(ndjson) differs from the state built event by event`);
  const mismatches = verifyResolutions(log.events);
  if (mismatches.length > 0) {
    throw new Error(
      `seed ${simSeed}: verifyResolutions found ${mismatches.length} mismatch(es):\n` +
        mismatches.map((m) => `  seq ${m.seq} week ${m.week} ${m.tavern} ${m.field}: ${m.message}`).join('\n'),
    );
  }

  return { events: log.events, ndjson, state: log.state, summary: summarize(input, simSeed, log.state, log.events, waiverLog) };
}

function partyOf(lineup: Lineup, statsOf: (id: string) => EffectiveStats): Party {
  return { captain: lineup.captain, members: [lineup.captain, ...lineup.allies].map(statsOf) };
}

// ── summary ────────────────────────────────────────────────────────────────

function summarize(
  input: SeasonInput,
  seed: string,
  state: LeagueState,
  events: ReadonlyArray<LeagueEvent>,
  waivers: ReadonlyMap<number, WeekSummary['waivers']>,
): RunSummary {
  const config = state.config!;
  const botId = new Map(input.taverns.map((t) => [t.id, t.bot]));
  const bot = (tavern: string): BotId => botId.get(tavern)!;
  const order = [...state.taverns.keys()];

  // Matchup winners exactly as `standings` decides them: (week, home, away)
  // order, one shared coin stream.
  const matchups = headToHeadSchedule(order, config.weeks);
  const results = new Map<string, ReturnType<typeof weekResults>[number]>();
  for (let week = 1; week <= config.weeks; week++) for (const r of weekResults(state, week)) results.set(`${week}\u0000${r.tavern}`, r);
  const coin = rngFor(`${config.id}/standings`, 'coin');
  const decided = new Map<number, MatchupResult[]>();
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  for (const m of [...matchups].sort((a, b) => a.week - b.week || cmp(a.home, b.home) || cmp(a.away, b.away))) {
    const home = results.get(`${m.week}\u0000${m.home}`);
    const away = results.get(`${m.week}\u0000${m.away}`);
    if (home === undefined || away === undefined) continue;
    const outcome = matchupWinner(home, away, config.scoring.tiebreakers, coin);
    const winner = outcome === 'home' ? m.home : outcome === 'away' ? m.away : null;
    const higherProjected = home.projected > away.projected ? m.home : home.projected < away.projected ? m.away : null;
    decided.set(m.week, [...(decided.get(m.week) ?? []), { home: m.home, away: m.away, winner, higherProjected }]);
  }

  const standings = seasonStandings(state).map((row, i) => ({ rank: i + 1, ...row, bot: bot(row.tavern) }));
  // Cross-check: the winners above must add up to the standings' records.
  for (const row of standings) {
    const wins = [...decided.values()].flat().filter((m) => m.winner === row.tavern).length;
    if (wins !== row.wins) throw new Error(`summary: ${row.tavern} has ${wins} matchup wins but ${row.wins} in the standings`);
  }
  const champion = standings[0];
  if (champion === undefined) throw new Error('summary: no standings');

  const weeks: WeekSummary[] = [];
  for (let week = 1; week <= config.weeks; week++) {
    const locked = state.lockedLineups.get(week) ?? [];
    const resolved = state.results.get(week);
    weeks.push({
      week,
      mission: state.revealed.get(week)?.id ?? '',
      results: locked.map(({ tavern, lineup, source }) => {
        const r = resolved?.get(tavern);
        return {
          tavern,
          bot: bot(tavern),
          source,
          starters: lineup === null ? null : [lineup.captain, ...lineup.allies],
          points: r?.points ?? 0,
          projectedPoints: r?.projectedPoints ?? 0,
          checksPassed: r?.run.checksPassed ?? 0,
          checksAttempted: r?.run.checksAttempted ?? 0,
          dnf: r === undefined ? null : r.run.dnf,
        };
      }),
      matchups: decided.get(week) ?? [],
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
    champion: { tavern: champion.tavern, bot: champion.bot },
    taverns: input.taverns.map((t) => ({ tavern: t.id, name: t.name, bot: t.bot })),
    standings,
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
  readonly titles: number;
  /** titles / seats: the chance a given seat with this bot wins the title. 1 / taverns is par. */
  readonly titlesPerSeat: number;
  /** Mean points per tavern-week (0 for a week played with nobody). */
  readonly meanPoints: number;
  readonly meanProjected: number;
  /** Share of this bot's runs that ended in a DNF. */
  readonly dnfRate: number;
  /** Matchup win share (ties count half). */
  readonly winRate: number;
}

export interface Aggregate {
  readonly runs: number;
  readonly byBot: Readonly<Record<string, BotAggregate>>;
  /** Titles by tavern seat, since seats keep their draft slot in every run. */
  readonly titlesByTavern: Readonly<Record<string, number>>;
  /** Matchups where projected points differed, and how often the higher-projected tavern won. */
  readonly higherProjectedWins: { readonly matchups: number; readonly wins: number; readonly share: number };
  /** Share of all mission runs that ended in a DNF. */
  readonly dnfRate: number;
  /** Tavern-weeks played with no lineup. */
  readonly noLineupWeeks: number;
}

export function aggregate(runs: ReadonlyArray<RunSummary>): Aggregate {
  const blank = (): { seats: number; titles: number; points: number; projected: number; weeks: number; runs: number; dnfs: number; wins: number; games: number } => ({
    seats: 0,
    titles: 0,
    points: 0,
    projected: 0,
    weeks: 0,
    runs: 0,
    dnfs: 0,
    wins: 0,
    games: 0,
  });
  const tally = new Map<string, ReturnType<typeof blank>>(BOT_IDS.map((id) => [id, blank()]));
  const of = (id: string): ReturnType<typeof blank> => {
    let t = tally.get(id);
    if (t === undefined) tally.set(id, (t = blank()));
    return t;
  };
  const titlesByTavern: Record<string, number> = {};
  let decided = 0;
  let projectedWon = 0;
  let mission = 0;
  let dnfs = 0;
  let noLineup = 0;

  for (const run of runs) {
    for (const t of run.taverns) {
      of(t.bot).seats++;
      titlesByTavern[t.tavern] ??= 0;
    }
    of(run.champion.bot).titles++;
    titlesByTavern[run.champion.tavern] = (titlesByTavern[run.champion.tavern] ?? 0) + 1;
    const botOf = new Map(run.taverns.map((t) => [t.tavern, t.bot]));
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
      for (const m of week.matchups) {
        for (const side of [m.home, m.away]) {
          const t = of(botOf.get(side)!);
          t.games++;
          t.wins += m.winner === side ? 1 : m.winner === null ? 0.5 : 0;
        }
        if (m.higherProjected !== null) {
          decided++;
          if (m.winner === m.higherProjected) projectedWon++;
        }
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
      winRate: ratio(t.wins, t.games),
    };
  }
  return {
    runs: runs.length,
    byBot,
    titlesByTavern,
    higherProjectedWins: { matchups: decided, wins: projectedWon, share: ratio(projectedWon, decided) },
    dnfRate: ratio(dnfs, mission),
    noLineupWeeks: noLineup,
  };
}
