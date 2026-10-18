/**
 * Test-only builders for event logs: a `LogBuilder` that stamps envelopes,
 * chains `prev` hashes and folds each event as it goes, and a scripted
 * mini-season of the contest (4 taverns, a cast of 10, roster 2, 8 votes,
 * the final 2) with state checkpoints for precondition tests.
 */
import { contestant } from '../../src/contest/cards';
import { genericChallenge } from '../../src/contest/challenge';
import { voteModel } from '../../src/contest/model';
import { castMap, playChallenge, playFinale, playVote } from '../../src/contest/run';
import { applyEpisode, initialContest } from '../../src/contest/state';
import type { Challenge, VotingStrategy } from '../../src/contest/types';
import { challengeSha256, lineHash } from '../../src/events/canonical';
import { applyEvent, initialState } from '../../src/events/reducers';
import { serializeEvent } from '../../src/events/replay';
import { onTheClock, tavernPickOnTheClock } from '../../src/events/selectors';
import type { LeagueState } from '../../src/events/state';
import type { Actor, EventOf, EventType, LeagueEvent, PayloadByType } from '../../src/events/types';
import { episodesOf, type SeasonConfig } from '../../src/league';
import { contestSeed, rngFor } from '../../src/rng';
import type { CrEighths } from '../../src/vocabulary';
import type { EffectiveStats } from '../../src/characters';
import { member } from './builders';

export const SEASON = 'season-01';
export const AT = '2026-11-02T18:04:11Z';
export const SYSTEM: Actor = { kind: 'system', workflow: 'episode' };
export const COMMISSIONER: Actor = { kind: 'commissioner', githubId: 1, login: 'gm' };
export const MANAGER: Actor = { kind: 'manager', githubId: 101, login: 'flagon' };

/** The season's taverns, in package order. */
export const TAVERNS = ['the-gilded-flagon', 'the-rusty-nail', 'the-salty-dog', 'the-quiet-crow'] as const;

/** Managers in join order. `manager-i` chooses `TAVERNS[i]` when its turn in the tavern pick comes. */
export const MANAGERS = ['manager-0', 'manager-1', 'manager-2', 'manager-3'] as const;

export function tavernList(): PayloadByType['season.created']['taverns'] {
  return TAVERNS.map((id) => ({ id, name: id }));
}

export function miniConfig(overrides: Partial<SeasonConfig> = {}): SeasonConfig {
  return {
    id: SEASON,
    snapshot: 'open5e-v1-2026-10',
    modifierRegistryVersion: 1,
    budget: { modifierPointsPerCharacter: 3 },
    roster: { size: 2 },
    draft: { format: 'snake', order: { mode: 'seeded' } },
    contest: { castSize: 10, finalists: 2, lapDc: 1, model: {} },
    scoring: { survive: 2, immunity: 3, juryVote: 2, winner: 10, call: 2, earlyCallBonus: 1 },
    schedule: { rounds: [3, 3, 2] },
    ...overrides,
  };
}

const STRATEGIES: ReadonlyArray<VotingStrategy> = [{ kind: 'threat' }, { kind: 'coattails' }, { kind: 'grudge' }, { kind: 'floater' }, { kind: 'loyal', tag: 'type:giant' }];

/** The cast: `char-01`…`char-10`, rising strength, cycling strategies. All on the ogre fixture. */
export const CAST: ReadonlyArray<{ readonly id: string; readonly strategy: VotingStrategy; readonly stats: EffectiveStats }> = Array.from({ length: 10 }, (_, i) => {
  const id = `char-${String(i + 1).padStart(2, '0')}`;
  return { id, strategy: STRATEGIES[i % STRATEGIES.length]!, stats: member(id, { all: i % 5 }) };
});

/** Stats by id, for `verifyContest`. */
export const statsOf = (id: string): EffectiveStats => {
  const c = CAST.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no ${id}`);
  return c.stats;
};

/** One challenge per episode, drawn from a fixed stream. */
export const CHALLENGES: ReadonlyArray<Challenge> = Array.from({ length: 8 }, (_, i) => ({ ...genericChallenge(rngFor('mini', `challenge:${i}`)), id: `task-${i + 1}` }));

export const SEED = contestSeed(SEASON, 'mini');

/** Stamps envelopes, chains `prev` and folds every event, as an Action would. */
export class LogBuilder {
  readonly events: LeagueEvent[] = [];
  readonly lines: string[] = [];
  state: LeagueState = initialState();

  append<T extends EventType>(type: T, payload: EventOf<T>['payload'], actor: Actor = SYSTEM): EventOf<T> {
    const event = this.draft(type, payload, actor);
    this.state = applyEvent(this.state, event);
    const line = serializeEvent(event);
    this.state = { ...this.state, lastHash: lineHash(line) };
    this.events.push(event);
    this.lines.push(line);
    return event;
  }

  /** The next event, stamped but not applied. */
  draft<T extends EventType>(type: T, payload: EventOf<T>['payload'], actor: Actor = SYSTEM): EventOf<T> {
    const prev = this.lines.length === 0 ? null : lineHash(this.lines.at(-1)!);
    return { v: 1, seq: this.state.lastSeq + 1, type, season: SEASON, at: AT, actor, prev, payload } as unknown as EventOf<T>;
  }

  get ndjson(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

export interface MiniSeason {
  readonly log: LogBuilder;
  readonly afterPreseason: LeagueState;
  readonly afterDraft: LeagueState;
  /** After episode 1's challenge, before its vote. */
  readonly midEpisode1: LeagueState;
  readonly final: LeagueState;
}

/** The setup events: season, cast, managers. */
export function preseason(log: LogBuilder, config: SeasonConfig = miniConfig()): void {
  log.append(
    'season.created',
    {
      config,
      configSha256: lineHash('config'),
      engineVersion: '0.0.0',
      taverns: tavernList(),
      challenges: CHALLENGES.map((c, i) => ({ episode: i + 1, sha256: challengeSha256(c) })),
      abilityMix: { str: 5, dex: 5, con: 6, int: 5, wis: 6, cha: 5 },
    },
    COMMISSIONER,
  );
  for (const c of CAST) log.append('character.pooled', { character: c.id, base: 'ogre', cr: 16 as CrEighths, modifiers: [], strategy: c.strategy }, COMMISSIONER);
  for (const m of MANAGERS) log.append('manager.joined', { manager: m, account: { bot: 'test' } }, COMMISSIONER);
}

/** The tavern pick and the snake draft, each manager taking the next open tavern and the first free monster. */
export function draft(log: LogBuilder): void {
  for (let m = tavernPickOnTheClock(log.state); m !== null; m = tavernPickOnTheClock(log.state)) {
    const tavern = TAVERNS[MANAGERS.indexOf(m as (typeof MANAGERS)[number])]!;
    log.append('tavern.chosen', { manager: m, tavern }, { kind: 'bot', strategy: 'test' });
  }
  for (let t = onTheClock(log.state); t !== null; t = onTheClock(log.state)) {
    const free = [...log.state.pool.keys()].find((id) => !log.state.owner.has(id))!;
    log.append('draft.pick', { pick: log.state.draft.picks, tavern: t, character: free, auto: false }, { kind: 'bot', strategy: 'test' });
  }
}

/**
 * The whole mini season: every tavern calls the first monster still in before
 * each challenge, the first tavern changes its call after it, and the
 * contest plays from `SEED`.
 */
export function miniSeason(): MiniSeason {
  const log = new LogBuilder();
  const config = miniConfig();
  const model = voteModel(config.contest.model);
  preseason(log, config);
  const afterPreseason = log.state;
  draft(log);
  const afterDraft = log.state;
  // The same cards `verifyContest` builds.
  const cast = CAST.map((c) => contestant(c.stats, c.strategy));
  const map = castMap(cast);
  let s = initialContest(cast, model);
  let midEpisode1: LeagueState | null = null;
  for (let episode = 1; episode <= CHALLENGES.length; episode++) {
    for (const t of TAVERNS) log.append('call.made', { episode, tavern: t, target: s.alive[0]! }, { kind: 'bot', strategy: 'test' });
    const result = playChallenge(s, map, CHALLENGES[episode - 1]!, SEED, episode, config.contest.lapDc);
    log.append('challenge.resolved', { episode, challenge: CHALLENGES[episode - 1]!, sha256: challengeSha256(CHALLENGES[episode - 1]!), seed: SEED, result });
    if (episode === 1) midEpisode1 = log.state;
    const late = s.alive.find((id) => id !== result.winner && id !== s.alive[0])!;
    log.append('call.made', { episode, tavern: TAVERNS[0], target: late }, MANAGER);
    const vote = playVote(s, map, result.winner, SEED, episode, model);
    log.append('vote.resolved', { episode, vote });
    s = applyEpisode(s, { episode, immune: result.winner, vote }, model);
    const round = config.schedule.rounds.findIndex((_, i) => episodesOf(config, i + 1).at(-1) === episode) + 1;
    if (round > 0 && round < config.schedule.rounds.length) log.append('round.finalized', { round });
  }
  log.append('finale.resolved', { result: playFinale(s, map, SEED, model) });
  log.append('round.finalized', { round: config.schedule.rounds.length });
  return { log, afterPreseason, afterDraft, midEpisode1: midEpisode1!, final: log.state };
}

