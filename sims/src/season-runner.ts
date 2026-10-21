/**
 * The Lich's contest, played as a season with bot taverns, as pure
 * functions over in-memory data.
 *
 * - `seasonParts` checks a loaded season (scripts' `loadSeason`) and reduces
 *   it to `SeasonParts`: plain, JSON-safe data. `seasonInput` turns parts
 *   into a `SeasonInput` with the cards built once. The browser playground
 *   ships parts as JSON and calls `seasonInput` itself.
 * - `ContestSession` plays one season a step at a time, with at most one
 *   tavern run by a person: the tavern pick, the draft, then each episode's
 *   challenge and vote, the finale and the head-to-head rounds. Every event
 *   goes through the engine's `applyEvent`, so bots and people obey the same
 *   rules. `runSeason` is a session with no person, driven straight through.
 * - `finish()` replays the NDJSON (`replayLog`), recomputes the contest from
 *   the seed (`verifyContest`), and throws on any disagreement.
 *
 * No I/O, no clock, no ambient randomness: the sim seed draws the cast,
 * salts the contest seed and drives the bots, so the same input and seed
 * always give byte-identical NDJSON. ./load.ts reads the files and
 * ./sim.ts is the CLI.
 */
import { BOT_IDS, botManager, expectedPoints, scoutSeed } from '@league-of-taverns/bots';
import type { BotId, BotManager, PublicView } from '@league-of-taverns/bots';
import {
  TRAITS,
  applyEvent,
  castMap,
  challengeSha256,
  contestSeed,
  contestState,
  contestant,
  cyrb128,
  effectiveStats,
  episodeOdds,
  episodeScore,
  episodeStage,
  freeAgents,
  initialState,
  lineHash,
  onTheClock,
  playChallenge,
  playFinale,
  playVote,
  replayLog,
  rngFor,
  seasonStandings,
  serializeEvent,
  tavernPickOnTheClock,
  toBaseStats,
  verifyContest,
  voteModel,
} from '@league-of-taverns/engine';
import type {
  Ability,
  Actor,
  CallState,
  BaseStats,
  Challenge,
  ContestMismatch,
  ContestState,
  Contestant,
  CrEighths,
  EffectiveStats,
  EpisodeOdds,
  EventOf,
  EventType,
  LeagueEvent,
  LeagueState,
  Open5eMonster,
  PooledCharacter,
  SeasonConfig,
  VoteModel,
  VotingStrategy,
} from '@league-of-taverns/engine';
import { deepEqual } from './deep-equal';

// ── input ──────────────────────────────────────────────────────────────────

/** One pool entry: the character, its CR and its voting strategy. */
export interface PoolPart {
  readonly character: PooledCharacter;
  readonly cr: CrEighths;
  readonly strategy: VotingStrategy;
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
  /** The whole pool, in pool-file order. Each season's cast is drawn from it. */
  readonly pool: ReadonlyArray<PoolPart>;
  /** In taverns-file order. */
  readonly taverns: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** In managers-file order. */
  readonly managers: ReadonlyArray<{ readonly id: string; readonly bot: BotId }>;
  readonly commissioner: { readonly githubId: number; readonly login: string } | null;
  /** One challenge per episode, in order, with its commitment. */
  readonly challenges: ReadonlyArray<{ readonly episode: number; readonly challenge: Challenge; readonly sha256: string }>;
  /** The public hint: checks per ability over the season. */
  readonly abilityMix: Readonly<Record<Ability, number>>;
  /** Verbatim Open5e records, covering at least every pool base. The first record per slug wins. */
  readonly snapshot: ReadonlyArray<Open5eMonster>;
}

export interface SeasonInput extends Omit<SeasonParts, 'snapshot'> {
  /** Effective stats (base + modifiers) by pooled character id. */
  readonly statsOf: (characterId: string) => EffectiveStats;
  /** A pool member's card. */
  readonly cardOf: (characterId: string) => Contestant;
  /** The season's vote model. */
  readonly model: VoteModel;
}

/** What `seasonParts` reads from a loaded season: scripts' `LoadedSeason` satisfies it. */
export interface SeasonSource {
  readonly config: SeasonConfig;
  readonly snapshot: ReadonlyArray<Open5eMonster>;
  readonly pool: {
    readonly characters: ReadonlyArray<PooledCharacter>;
    readonly cr: ReadonlyMap<string, CrEighths>;
    readonly strategies: ReadonlyMap<string, VotingStrategy>;
  };
  readonly managers: {
    readonly commissioner: { readonly login: string; readonly githubId: number | null };
    readonly managers: ReadonlyArray<{ readonly id: string; readonly account: { readonly bot: BotId } | { readonly login: string; readonly githubId: number | null } }>;
  };
  readonly taverns: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly challenges: ReadonlyArray<{ readonly episode: number; readonly challenge: Challenge }>;
}

/**
 * Check a loaded season and reduce it to `SeasonParts`. Throws if a manager
 * is a person (sims seat only bots) or a pooled character lacks a CR or a
 * strategy. Pure: the caller reads the files.
 */
export function seasonParts(loaded: SeasonSource, abilityMix: Readonly<Record<Ability, number>>, configText: string, engineVersion: string): SeasonParts {
  const pool = loaded.pool.characters.map((character) => {
    const cr = loaded.pool.cr.get(character.ref.id);
    const strategy = loaded.pool.strategies.get(character.ref.id);
    if (cr === undefined || strategy === undefined) throw new Error(`pool: "${character.ref.id}" has no CR or strategy`);
    return { character, cr, strategy };
  });
  const managers = loaded.managers.managers.map((manager) => {
    if (!('bot' in manager.account)) throw new Error(`manager "${manager.id}" is a person; sims seat only bots`);
    return { id: manager.id, bot: manager.account.bot };
  });
  const { githubId, login } = loaded.managers.commissioner;
  return {
    config: loaded.config,
    configSha256: lineHash(configText),
    engineVersion,
    pool,
    taverns: loaded.taverns.map(({ id, name }) => ({ id, name })),
    managers,
    commissioner: githubId === null ? null : { githubId, login },
    challenges: loaded.challenges.map(({ episode, challenge }) => ({ episode, challenge, sha256: challengeSha256(challenge) })),
    abilityMix,
    snapshot: loaded.snapshot,
  };
}

/** Build the run-ready `SeasonInput` from `SeasonParts`. Throws if a pool base is missing from the snapshot. Pure, and safe in a browser. */
export function seasonInput(parts: SeasonParts): SeasonInput {
  const bases = new Map<string, BaseStats>();
  for (const record of parts.snapshot) if (!bases.has(record.slug)) bases.set(record.slug, toBaseStats(record).stats);
  const stats = new Map<string, EffectiveStats>();
  const cards = new Map<string, Contestant>();
  for (const { character, strategy } of parts.pool) {
    const base = bases.get(character.ref.base);
    if (base === undefined) throw new Error(`"${character.ref.base}" is not in snapshot ${parts.config.snapshot}`);
    const s = effectiveStats(character, base, TRAITS);
    stats.set(character.ref.id, s);
    cards.set(character.ref.id, contestant(s, strategy));
  }
  const lookup = <T>(m: ReadonlyMap<string, T>) => (id: string): T => {
    const v = m.get(id);
    if (v === undefined) throw new Error(`"${id}" is not pooled`);
    return v;
  };
  const { snapshot: _snapshot, ...rest } = parts;
  return { ...rest, statsOf: lookup(stats), cardOf: lookup(cards), model: voteModel(parts.config.contest.model) };
}

// ── output ─────────────────────────────────────────────────────────────────

/** Who manages a seat in a summary: a bot, or `human` for the person's tavern. */
export type Seat = BotId | 'human';

export interface RunOptions {
  /** The sim seed: the cast, the contest's dice, the bots and the timestamps. Non-empty, no `/`. */
  readonly seed: string;
}

export interface EpisodeSummary {
  readonly episode: number;
  readonly immune: string;
  readonly boot: string;
  /** The favourite to go home once immunity was known, by the public odds, and its chance. */
  readonly favourite: string;
  readonly favouriteChance: number;
  readonly revote: boolean;
  readonly draw: boolean;
  /** Each tavern's call (null for none), whether it was early, and its points this vote. */
  readonly taverns: ReadonlyArray<{ readonly tavern: string; readonly call: string | null; readonly early: boolean; readonly right: boolean; readonly points: number }>;
}

export interface RunSummary {
  readonly seed: string;
  readonly season: string;
  readonly events: number;
  /** Every tavern ranked first. More than one only on an exact tie. */
  readonly champions: ReadonlyArray<{ readonly tavern: string; readonly bot: Seat }>;
  readonly taverns: ReadonlyArray<{ readonly tavern: string; readonly name: string; readonly bot: Seat; readonly roster: ReadonlyArray<string> }>;
  readonly standings: ReadonlyArray<{ readonly rank: number; readonly tavern: string; readonly bot: Seat; readonly points: number; readonly callPoints: number }>;
  readonly draft: ReadonlyArray<{ readonly pick: number; readonly tavern: string; readonly bot: Seat; readonly character: string }>;
  readonly episodes: ReadonlyArray<EpisodeSummary>;
  /** The cast in cast order: each one's strategy, power and placement (1 = winner, 20 = first out). */
  readonly cast: ReadonlyArray<{ readonly id: string; readonly strategy: VotingStrategy['kind']; readonly power: number; readonly place: number; readonly owner: string | null }>;
  readonly winner: string;
  /** The champion would change without call points: calls decided the title. */
  readonly callDecided: boolean;
}

export interface SeasonResult {
  readonly events: ReadonlyArray<LeagueEvent>;
  /** The canonical log, one line per event, with a trailing newline. */
  readonly ndjson: string;
  /** The folded state, with `lastHash` set as `replayLog` sets it. */
  readonly state: LeagueState;
  readonly summary: RunSummary;
  readonly audit: SeasonAudit;
}

/** The replay and seed audit every season passes before it returns. */
export interface SeasonAudit {
  /** `replayLog(ndjson)` deep-equals the state built event by event. */
  readonly replayMatches: boolean;
  /** `verifyContest(events)`: empty when every challenge, vote and the finale follow from the seed. */
  readonly mismatches: ReadonlyArray<ContestMismatch>;
}

export function auditSeason(events: ReadonlyArray<LeagueEvent>, ndjson: string, state: LeagueState, statsOf: (id: string) => EffectiveStats): SeasonAudit {
  return { replayMatches: deepEqual(replayLog(ndjson), state), mismatches: verifyContest(events, statsOf) };
}

// ── the session ────────────────────────────────────────────────────────────

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
/** Thursday 2027-01-07 00:00 UTC. Seasons start on a Thursday 0–519 weeks after it, picked by the seed. */
const EPOCH = Date.UTC(2027, 0, 7);

/** Samples behind each set of public odds. */
export const ODDS_SAMPLES = 150;

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

/** ISO-8601 UTC to the second. Arithmetic only: never reads the clock. */
function iso(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

/** A human seat: which manager a person plays instead of its bot. */
export interface HumanSeat {
  /** A manager id from `SeasonInput.managers`. */
  readonly manager: string;
  /** The `manager.joined` account and the actor on the person's events. */
  readonly login: string;
  readonly githubId: number;
  /**
   * The tavern the person brings, an id from `SeasonInput.taverns`: no bot
   * chooses it, and it is chosen for them on their turn. Absent, they choose
   * from the open taverns like a bot.
   */
  readonly tavern?: string;
}

export interface SessionOptions extends RunOptions {
  /** The manager a person plays, or null/absent for an all-bot season. */
  readonly human?: HumanSeat | null;
}

/** Where a session stands: what has to happen next. */
export type SessionStage =
  | { readonly kind: 'tavern'; readonly manager: string }
  | { readonly kind: 'draft'; readonly pick: number; readonly tavern: string }
  | { readonly kind: 'challenge'; readonly episode: number }
  | { readonly kind: 'vote'; readonly episode: number }
  | { readonly kind: 'finale' }
  | { readonly kind: 'complete' };

/**
 * One season played a step at a time, with at most one tavern managed by a
 * person and the rest by bots.
 *
 * - `advanceDraft()` makes bot tavern choices and picks until the person is
 *   on the clock or the draft is done; `chooseTavern(id)` and `draftPick(id)`
 *   are the person's moves.
 * - In each episode the person may `call(target)` before the challenge
 *   (early) and again after it (late, replacing an early call).
 *   `runChallenge()` makes the bots' early calls and plays the challenge;
 *   `runVote()` makes their late calls, plays the vote, and closes the round
 *   when it is the round's last episode. After the last vote, `runFinale()`.
 * - `finish()` audits the completed log and returns the `SeasonResult`.
 *
 * Every command goes through the engine's `applyEvent`, so an illegal one
 * throws an `InvalidEventError` and leaves the session unchanged.
 */
export class ContestSession {
  readonly input: SeasonInput;
  readonly seed: string;
  readonly human: HumanSeat | null;
  /** The season's cast: its cards, in cast order. */
  readonly cast: ReadonlyArray<Contestant>;
  /** The contest's seed: every die in the contest comes from it. */
  readonly contestSeed: string;
  private readonly castById: ReadonlyMap<string, Contestant>;
  private readonly log: LogBuilder;
  private readonly start: number;
  private readonly bots: Map<string, { id: BotId; manager: BotManager; actor: Actor }>;
  private readonly humanActor: Actor | null;
  private lastAt = 0;
  private readonly oddsCache = new Map<string, EpisodeOdds>();
  private readonly favourites = new Map<number, { id: string; p: number }>();
  private contestMemo: { votes: number; state: ContestState } | null = null;

  constructor(input: SeasonInput, options: SessionOptions) {
    const simSeed = options.seed;
    if (simSeed.length === 0 || simSeed.includes('/')) throw new Error(`sim seed must be non-empty with no "/", got ${JSON.stringify(simSeed)}`);
    const human = options.human ?? null;
    if (human !== null && !input.managers.some((m) => m.id === human.manager)) throw new Error(`no manager "${human.manager}" to seat a person in`);
    if (human?.tavern !== undefined && !input.taverns.some((t) => t.id === human.tavern)) throw new Error(`no tavern "${human.tavern}" for the person to bring`);
    this.input = input;
    this.seed = simSeed;
    this.human = human;
    this.cast = drawCast(input, simSeed).map((id) => input.cardOf(id));
    this.castById = castMap(this.cast);
    this.contestSeed = contestSeed(input.config.id, simSeed);
    this.log = new LogBuilder(input.config.id);
    this.start = EPOCH + (cyrb128(`${simSeed}::start`)[0] % 520) * WEEK;
    this.bots = new Map(input.managers.map((m) => [m.id, { id: m.bot, manager: botManager(m.bot), actor: { kind: 'bot', strategy: m.bot } }]));
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
    if (state.phase === 'complete') return { kind: 'complete' };
    const choosing = tavernPickOnTheClock(state);
    if (choosing !== null) return { kind: 'tavern', manager: choosing };
    if (!state.draft.complete) {
      const tavern = onTheClock(state);
      if (tavern === null) throw new Error(`draft stalled at pick ${state.draft.picks}: nobody is on the clock`);
      return { kind: 'draft', pick: state.draft.picks, tavern };
    }
    const open = episodeStage(state);
    if (open !== null) return { kind: open.stage, episode: open.episode };
    return { kind: 'finale' };
  }

  /** The taverns in play, in the order they were chosen. */
  get taverns(): ReadonlyArray<string> {
    return [...this.log.state.taverns.keys()];
  }

  /** The person's tavern, or null before they choose one (or with no person). */
  get humanTavern(): string | null {
    return this.human === null ? null : (this.log.state.managers.get(this.human.manager)?.tavern ?? null);
  }

  isHuman(tavern: string): boolean {
    return this.humanTavern === tavern;
  }

  /** The season's taverns nobody has chosen yet, in file order, less the one the person brings. */
  openTaverns(): ReadonlyArray<string> {
    return this.input.taverns.map((t) => t.id).filter((id) => id !== this.human?.tavern && !this.log.state.taverns.has(id));
  }

  /** A cast member's card. */
  card(id: string): Contestant {
    const c = this.castById.get(id);
    if (c === undefined) throw new Error(`"${id}" is not in the cast`);
    return c;
  }

  /** The vote model's state after every vote so far. */
  contest(): ContestState {
    const votes = this.log.state.jury.length;
    if (this.contestMemo?.votes !== votes) this.contestMemo = { votes, state: contestState(this.log.state, this.cast, this.input.model) };
    return this.contestMemo.state;
  }

  /**
   * The public odds for the open episode's vote: before the challenge
   * (`immune` null) or after it. Memoized, so every bot at the table sees the
   * same numbers. Uses only public information.
   */
  odds(immune: string | null): EpisodeOdds {
    const open = episodeStage(this.log.state);
    const episode = open?.episode ?? 0;
    const key = `${episode}:${immune ?? '-'}`;
    let odds = this.oddsCache.get(key);
    if (odds === undefined) {
      odds = episodeOdds(this.contest(), this.castById, immune, this.input.model, `${this.seed}/odds/${key}`, ODDS_SAMPLES);
      this.oddsCache.set(key, odds);
    }
    return odds;
  }

  /** The scouts' estimate: each cast member's expected points, the number the `scout` bots draft by. */
  scouting(): ReadonlyMap<string, number> {
    return expectedPoints(this.cast, this.input.config, this.input.model, scoutSeed(this.input.config.id));
  }

  // ── the tavern pick and the draft ────────────────────────────────────────

  /** Bot tavern choices (and the person's, when they bring a tavern), then bot picks, until the person is on the clock or the draft is done. */
  advanceDraft(): void {
    for (let stage = this.stage; ; stage = this.stage) {
      if (stage.kind === 'tavern' && stage.manager === this.human?.manager && this.human.tavern !== undefined) {
        this.append('tavern.chosen', { manager: stage.manager, tavern: this.human.tavern }, this.humanActor!, this.tavernPickAt());
      } else if (stage.kind === 'tavern' && stage.manager !== this.human?.manager) {
        const bot = this.botOfManager(stage.manager);
        const tavern = bot.manager.tavern.choose(this.openTaverns(), rngFor(this.seed, `bot:${stage.manager}:tavern`));
        this.append('tavern.chosen', { manager: stage.manager, tavern }, bot.actor, this.tavernPickAt());
      } else if (stage.kind === 'draft' && !this.isHuman(stage.tavern)) {
        const bot = this.botOf(stage.tavern);
        const character = bot.manager.draft.pick(this.viewFor(stage.tavern, `draft:${stage.pick}`), freeAgents(this.log.state));
        this.append('draft.pick', { pick: stage.pick, tavern: stage.tavern, character, auto: false }, bot.actor, this.draftAt(stage.pick));
      } else {
        return;
      }
    }
  }

  /** The person's tavern. Throws unless it is their turn and the tavern is open. */
  chooseTavern(tavern: string): void {
    const stage = this.stage;
    if (stage.kind !== 'tavern' || stage.manager !== this.human?.manager) throw new Error('it is not your turn to choose a tavern');
    this.append('tavern.chosen', { manager: stage.manager, tavern }, this.humanActor!, this.tavernPickAt());
  }

  /** The person's pick. Throws unless they are on the clock and the pick is legal. */
  draftPick(character: string): void {
    const stage = this.stage;
    if (stage.kind !== 'draft' || !this.isHuman(stage.tavern)) throw new Error('you are not on the clock');
    this.append('draft.pick', { pick: stage.pick, tavern: stage.tavern, character, auto: false }, this.humanActor!, this.draftAt(stage.pick));
  }

  // ── the contest ──────────────────────────────────────────────────────────

  /** The person's call for the open episode (replacing any earlier one). Throws if it is illegal. */
  call(target: string): void {
    const tavern = this.requireHumanTavern();
    const stage = this.stage;
    if (stage.kind !== 'challenge' && stage.kind !== 'vote') throw new Error('no episode is open for calls');
    const at = stage.kind === 'challenge' ? this.episodeAt(stage.episode) + 12 * HOUR : this.episodeAt(stage.episode) + 19 * HOUR;
    this.append('call.made', { episode: stage.episode, tavern, target }, this.humanActor!, at);
  }

  /** Each tavern's standing call for `episode`, as the log has it. */
  callsFor(episode: number): ReadonlyMap<string, CallState> {
    return this.log.state.calls.get(episode) ?? new Map();
  }

  /** The bots' early calls, then the episode's challenge. */
  runChallenge(): void {
    const stage = this.stage;
    if (stage.kind !== 'challenge') throw new Error(`no challenge to run: the session is at ${stage.kind}`);
    const { episode } = stage;
    const base = this.episodeAt(episode);
    this.taverns.forEach((tavern, i) => {
      if (this.isHuman(tavern)) return;
      const bot = this.botOf(tavern);
      const target = bot.manager.calls.early(this.viewFor(tavern, `call:${episode}:early`), episode);
      if (target !== null) this.append('call.made', { episode, tavern, target }, bot.actor, base + 14 * HOUR + i * MINUTE);
    });
    const scheduled = this.input.challenges[episode - 1];
    if (scheduled === undefined || scheduled.episode !== episode) throw new Error(`no challenge for episode ${episode}`);
    const result = playChallenge(this.contest(), this.castById, scheduled.challenge, this.contestSeed, episode, this.input.config.contest.lapDc);
    this.append(
      'challenge.resolved',
      { episode, challenge: scheduled.challenge, sha256: scheduled.sha256, seed: this.contestSeed, result },
      { kind: 'system', workflow: 'episode' },
      base + 18 * HOUR,
    );
  }

  /** The bots' late calls, the vote, and the round's close if this was its last episode. */
  runVote(): void {
    const stage = this.stage;
    if (stage.kind !== 'vote') throw new Error(`no vote to run: the session is at ${stage.kind}`);
    const { episode } = stage;
    const base = this.episodeAt(episode);
    const immune = this.log.state.episodes[episode - 1]!.challenge!.result.winner;
    this.taverns.forEach((tavern, i) => {
      if (this.isHuman(tavern)) return;
      const bot = this.botOf(tavern);
      const target = bot.manager.calls.late(this.viewFor(tavern, `call:${episode}:late`), episode, this.callsFor(episode).get(tavern));
      if (target !== null) this.append('call.made', { episode, tavern, target }, bot.actor, base + 20 * HOUR + i * MINUTE);
    });
    const odds = this.odds(immune).boot;
    let fav = { id: '', p: -1 };
    for (const [id, p] of odds) if (p > fav.p) fav = { id, p };
    this.favourites.set(episode, fav);
    const vote = playVote(this.contest(), this.castById, immune, this.contestSeed, episode, this.input.model);
    const system: Actor = { kind: 'system', workflow: 'episode' };
    this.append('vote.resolved', { episode, vote }, system, base + 21 * HOUR);
  }

  /** The jury's vote, which completes the season. */
  runFinale(): void {
    const stage = this.stage;
    if (stage.kind !== 'finale') throw new Error(`no finale yet: the session is at ${stage.kind}`);
    const votes = this.log.state.jury.length;
    const at = this.episodeAt(votes + 1) + 20 * HOUR;
    const system: Actor = { kind: 'system', workflow: 'finale' };
    this.append('finale.resolved', { result: playFinale(this.contest(), this.castById, this.contestSeed, this.input.model) }, system, at);
  }

  /** Play whatever comes next until the person has a decision (the draft) or the season is over. Bots only past the draft. */
  playToEnd(): void {
    this.advanceDraft();
    for (let stage = this.stage; stage.kind !== 'complete'; stage = this.stage) {
      if (stage.kind === 'challenge') this.runChallenge();
      else if (stage.kind === 'vote') this.runVote();
      else if (stage.kind === 'finale') this.runFinale();
      else throw new Error(`playToEnd: waiting on a person at ${stage.kind}`);
    }
  }

  /**
   * Audit the completed season and return its result. Throws if the season
   * is not complete, the NDJSON does not replay to the built state, or the
   * contest does not follow from its seed.
   */
  finish(): SeasonResult {
    const { log } = this;
    if (log.state.phase !== 'complete') throw new Error(`season ended in phase "${log.state.phase}", expected "complete"`);
    const ndjson = log.ndjson;
    const audit = auditSeason(log.events, ndjson, log.state, this.input.statsOf);
    if (!audit.replayMatches) throw new Error(`seed ${this.seed}: replayLog(ndjson) differs from the state built event by event`);
    if (audit.mismatches.length > 0) {
      throw new Error(`seed ${this.seed}: verifyContest found ${audit.mismatches.length} mismatch(es):\n` + audit.mismatches.map((m) => `  seq ${m.seq} ${m.what} ${m.episode ?? ''}: ${m.message}`).join('\n'));
    }
    return { events: log.events, ndjson, state: log.state, summary: this.summarize(), audit };
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** The season, the cast, the managers. The tavern pick follows in `advanceDraft`. */
  private preseason(): void {
    const { input } = this;
    const setupActor: Actor = input.commissioner === null ? { kind: 'system', workflow: 'sims' } : { kind: 'commissioner', ...input.commissioner };
    const preseason = this.start - 14 * DAY + 9 * HOUR;
    let k = 0;
    this.append(
      'season.created',
      {
        config: input.config,
        configSha256: input.configSha256,
        engineVersion: input.engineVersion,
        taverns: input.taverns,
        challenges: input.challenges.map(({ episode, sha256 }) => ({ episode, sha256 })),
        abilityMix: input.abilityMix,
      },
      setupActor,
      preseason + k++ * SECOND,
    );
    const byId = new Map(input.pool.map((p) => [p.character.ref.id, p]));
    for (const c of this.cast) {
      const p = byId.get(c.id)!;
      this.append('character.pooled', { character: c.id, base: p.character.ref.base, cr: p.cr, modifiers: p.character.modifiers, strategy: p.strategy }, setupActor, preseason + k++ * SECOND);
    }
    // Join order feeds the seeded draft-order shuffle, which is keyed by season only. Shuffling join order per sim
    // seed varies each seat's draft slot across runs.
    const joinOrder = [...input.managers];
    const joinRng = rngFor(this.seed, 'join-order');
    for (let i = joinOrder.length - 1; i > 0; i--) {
      const j = Math.floor(joinRng() * (i + 1));
      [joinOrder[i], joinOrder[j]] = [joinOrder[j]!, joinOrder[i]!];
    }
    for (const manager of joinOrder) {
      const human = manager.id === this.human?.manager ? this.human : null;
      const account = human === null ? { bot: manager.bot } : { githubId: human.githubId, login: human.login };
      this.append('manager.joined', { manager: manager.id, account }, setupActor, preseason + k++ * SECOND);
    }
  }

  /** The tavern pick, one choice an hour, the day before the draft. */
  private tavernPickAt(): number {
    return this.start - 11 * DAY + 18 * HOUR + this.log.state.taverns.size * HOUR;
  }

  /** The draft, one pick an hour. */
  private draftAt(pick: number): number {
    return this.start - 10 * DAY + 18 * HOUR + pick * HOUR;
  }

  /** Midnight on the day of `episode`: one episode a day from the season's start. */
  private episodeAt(episode: number): number {
    return this.start + (episode - 1) * DAY;
  }

  /** Append through the log, keeping timestamps in order: a person's moves can run ahead of the bots' schedule. */
  private append<T extends EventType>(type: T, payload: EventOf<T>['payload'], actor: Actor, atMs: number): EventOf<T> {
    const at = Math.max(atMs, this.lastAt);
    const event = this.log.append(type, payload, actor, at);
    this.lastAt = at;
    return event;
  }

  private botOf(tavern: string): { id: BotId; manager: BotManager; actor: Actor } {
    const manager = this.log.state.taverns.get(tavern)?.managerId;
    if (manager === undefined) throw new Error(`nobody has chosen tavern "${tavern}"`);
    return this.botOfManager(manager);
  }

  private botOfManager(manager: string): { id: BotId; manager: BotManager; actor: Actor } {
    const bot = this.bots.get(manager);
    if (bot === undefined) throw new Error(`no bot for manager "${manager}"`);
    return bot;
  }

  private viewFor(tavern: string, decision: string): PublicView {
    return {
      state: this.log.state,
      tavern,
      config: this.input.config,
      cast: this.cast,
      model: this.input.model,
      contest: () => this.contest(),
      odds: (immune) => this.odds(immune),
      rng: rngFor(this.seed, `bot:${tavern}:${decision}`),
    };
  }

  private requireHumanTavern(): string {
    if (this.human === null) throw new Error('this season has no human seat');
    const tavern = this.humanTavern;
    if (tavern === null) throw new Error('you have not chosen a tavern yet');
    return tavern;
  }

  private summarize(): RunSummary {
    const { input } = this;
    const state = this.log.state;
    const human = this.human;
    const botOfManager = new Map(input.managers.map((m) => [m.id, m.bot]));
    const seat = (tavern: string): Seat => {
      const m = state.taverns.get(tavern)!.managerId;
      return m === human?.manager ? 'human' : botOfManager.get(m)!;
    };
    const callPoints = new Map([...state.taverns.keys()].map((t) => [t, 0]));
    const episodes: EpisodeSummary[] = state.episodes.map((e) => {
      const calls = state.calls.get(e.episode);
      const fav = this.favourites.get(e.episode) ?? { id: '', p: 0 };
      return {
        episode: e.episode,
        immune: e.challenge!.result.winner,
        boot: e.vote!.boot,
        favourite: fav.id,
        favouriteChance: fav.p,
        revote: e.vote!.revote !== null,
        draw: e.vote!.draw !== null,
        taverns: [...state.taverns.keys()].map((tavern) => {
          const call = calls?.get(tavern);
          const score = episodeScore(state, tavern, e.episode);
          callPoints.set(tavern, callPoints.get(tavern)! + score.call + score.early);
          return { tavern, call: call?.target ?? null, early: call?.early ?? false, right: call !== undefined && call.target === e.vote!.boot, points: score.total };
        }),
      };
    });
    const finale = state.finale!;
    const finalists = [...finale.finalists].sort((a, b) => (a === finale.winner ? -1 : b === finale.winner ? 1 : 0));
    const place = new Map<string, number>();
    finalists.forEach((id, i) => place.set(id, i + 1));
    [...state.jury].reverse().forEach((id, i) => place.set(id, finalists.length + i + 1));
    const table = seasonStandings(state).map((r) => ({ ...r, bot: seat(r.tavern), callPoints: callPoints.get(r.tavern) ?? 0 }));
    // Calls decide the title when taking every tavern's call points away changes who is first.
    const firsts = (points: (r: (typeof table)[number]) => number): string => {
      const top = Math.max(...table.map(points));
      return table.filter((r) => points(r) === top).map((r) => r.tavern).sort().join(' ');
    };
    const callDecided = firsts((r) => r.points) !== firsts((r) => r.points - r.callPoints);
    return {
      seed: this.seed,
      season: input.config.id,
      events: this.log.events.length,
      champions: table.filter((r) => r.rank === 1).map(({ tavern, bot }) => ({ tavern, bot })),
      taverns: [...state.taverns.values()].map((t) => ({ tavern: t.id, name: t.name, bot: seat(t.id), roster: t.roster })),
      standings: table,
      draft: this.log.events.flatMap((e) => (e.type === 'draft.pick' ? [{ pick: e.payload.pick, tavern: e.payload.tavern, bot: seat(e.payload.tavern), character: e.payload.character }] : [])),
      episodes,
      cast: this.cast.map((c) => ({ id: c.id, strategy: c.strategy.kind, power: c.power, place: place.get(c.id) ?? 0, owner: state.owner.get(c.id) ?? null })),
      winner: finale.winner,
      callDecided,
    };
  }
}

/**
 * The season's cast: the whole pool when it is exactly `castSize`, else a
 * seeded draw of `castSize` from it (stream `cast` under the sim seed), kept
 * in pool order.
 */
export function drawCast(input: Pick<SeasonInput, 'pool' | 'config'>, seed: string): ReadonlyArray<string> {
  const ids = input.pool.map((p) => p.character.ref.id);
  const size = input.config.contest.castSize;
  if (ids.length < size) throw new Error(`the pool has ${ids.length} characters, fewer than the cast of ${size}`);
  if (ids.length === size) return ids;
  const rng = rngFor(seed, 'cast');
  const shuffled = [...ids];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const chosen = new Set(shuffled.slice(0, size));
  return ids.filter((id) => chosen.has(id));
}

/** Play one season with bots in every seat, then audit it. */
export function runSeason(input: SeasonInput, options: RunOptions): SeasonResult {
  const session = new ContestSession(input, { seed: options.seed });
  session.playToEnd();
  return session.finish();
}

// ── many runs ──────────────────────────────────────────────────────────────

/** Run n's seed (1-based): the base seed itself for run 1, then `<seed>~<n>`. */
export function runSeed(seed: string, n: number): string {
  return n === 1 ? seed : `${seed}~${n}`;
}

export interface BotAggregate {
  readonly seats: number;
  /** Titles won; co-champions split one title evenly. */
  readonly titles: number;
  /** titles / seats. 1 / taverns is par. */
  readonly titlesPerSeat: number;
  readonly meanPoints: number;
  /** Share of votes this bot called right. */
  readonly callRate: number;
  /** Share of its calls made early. */
  readonly earlyShare: number;
}

export interface Aggregate {
  readonly runs: number;
  readonly byBot: Readonly<Record<string, BotAggregate>>;
  /** How often the favourite (by the public odds once immunity is known) went home, and its mean chance. */
  readonly favouriteRate: number;
  readonly favouriteChance: number;
  /** Pearson correlation of challenge power with finishing position (higher = stronger monsters last longer). */
  readonly powerPlacement: number;
  /** Win share per seat, by voting strategy. 1 / cast size is par. */
  readonly strategyWins: Readonly<Record<string, { readonly seats: number; readonly wins: number; readonly rate: number }>>;
  readonly distinctWinners: number;
  readonly topWinners: ReadonlyArray<{ readonly id: string; readonly wins: number }>;
  /** Share of seasons whose champion would change without call points. */
  readonly callDecidedShare: number;
  /** Share of all points that came from calls. */
  readonly callPointShare: number;
  readonly revotesPerSeason: number;
  readonly drawsPerSeason: number;
}

export function aggregate(runs: ReadonlyArray<RunSummary>): Aggregate {
  const tally = new Map<string, { seats: number; titles: number; points: number; calls: number; right: number; early: number; votes: number }>();
  const of = (id: string) => {
    let t = tally.get(id);
    if (t === undefined) tally.set(id, (t = { seats: 0, titles: 0, points: 0, calls: 0, right: 0, early: 0, votes: 0 }));
    return t;
  };
  for (const id of BOT_IDS) of(id);
  let favHits = 0;
  let favN = 0;
  let favP = 0;
  const pairs: Array<[number, number]> = [];
  const strategy = new Map<string, { seats: number; wins: number }>();
  const winners = new Map<string, number>();
  let decided = 0;
  let callPts = 0;
  let allPts = 0;
  let revotes = 0;
  let draws = 0;
  for (const run of runs) {
    const botOf = new Map(run.taverns.map((t) => [t.tavern, t.bot]));
    for (const row of run.standings) {
      const t = of(row.bot);
      t.seats++;
      t.points += row.points;
      callPts += row.callPoints;
      allPts += row.points;
    }
    for (const c of run.champions) of(c.bot).titles += 1 / run.champions.length;
    for (const e of run.episodes) {
      favN++;
      favP += e.favouriteChance;
      if (e.favourite === e.boot) favHits++;
      if (e.revote) revotes++;
      if (e.draw) draws++;
      for (const t of e.taverns) {
        const a = of(botOf.get(t.tavern)!);
        a.votes++;
        if (t.call !== null) a.calls++;
        if (t.right) a.right++;
        if (t.early) a.early++;
      }
    }
    const n = run.cast.length;
    for (const c of run.cast) {
      pairs.push([c.power, n + 1 - c.place]);
      const s = strategy.get(c.strategy) ?? { seats: 0, wins: 0 };
      s.seats++;
      if (c.id === run.winner) s.wins++;
      strategy.set(c.strategy, s);
    }
    winners.set(run.winner, (winners.get(run.winner) ?? 0) + 1);
    if (run.callDecided) decided++;
  }
  const ratio = (a: number, b: number): number => (b === 0 ? 0 : a / b);
  const byBot: Record<string, BotAggregate> = {};
  for (const [id, t] of tally) {
    if (t.seats === 0) continue;
    byBot[id] = {
      seats: t.seats,
      titles: t.titles,
      titlesPerSeat: ratio(t.titles, t.seats),
      meanPoints: ratio(t.points, t.seats),
      callRate: ratio(t.right, t.votes),
      earlyShare: ratio(t.early, t.calls),
    };
  }
  return {
    runs: runs.length,
    byBot,
    favouriteRate: ratio(favHits, favN),
    favouriteChance: ratio(favP, favN),
    powerPlacement: pearson(pairs),
    strategyWins: Object.fromEntries([...strategy].map(([k, s]) => [k, { ...s, rate: ratio(s.wins, s.seats) }])),
    distinctWinners: winners.size,
    topWinners: [...winners].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id, wins]) => ({ id, wins })),
    callDecidedShare: ratio(decided, runs.length),
    callPointShare: ratio(callPts, allPts),
    revotesPerSeason: ratio(revotes, runs.length),
    drawsPerSeason: ratio(draws, runs.length),
  };
}

function pearson(pairs: ReadonlyArray<readonly [number, number]>): number {
  if (pairs.length < 2) return 0;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length;
  const my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}
