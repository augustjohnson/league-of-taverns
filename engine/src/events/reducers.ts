/**
 * Reducers: one pure handler per event type, `(state, event) → state`.
 *
 * Every handler checks its own preconditions (whose pick it is, whether a
 * call is legal, whether a recorded vote holds together) and throws
 * `InvalidEventError` when they fail. The same handlers serve two callers:
 * a writer calls `applyEvent` on a candidate event before appending it, so
 * an illegal command is rejected with a reason and never written; and
 * `replay` folds the whole log, where an invalid event is corruption.
 *
 * Handlers never mutate the state they are given.
 *
 * ## Envelope
 *
 * `applyEvent` checks `seq === state.lastSeq + 1` and, once the season exists,
 * that `event.season` is the season's id. It does **not** check `prev`: the
 * hash chain commits to the raw bytes of the previous line, which only the
 * log reader sees, so `replayLog` checks it. `at` and `actor` are never read.
 *
 * ## Error codes
 *
 * `InvalidEventError.code` is `<area>.<reason>` and stable:
 *
 * | Event | Codes |
 * |---|---|
 * | envelope | `envelope.seq`, `envelope.season`, `season.not_created`, `season.already_created` |
 * | `season.created` | `season.id_mismatch`, `season.bad_taverns`, `season.bad_config`, `season.bad_challenges` |
 * | `character.pooled` | `pool.wrong_phase`, `pool.duplicate`, `pool.cast_full`, `pool.registry_version`, `pool.over_budget`, `pool.invalid_modifiers` |
 * | `manager.joined` | `manager.wrong_phase`, `manager.duplicate`, `manager.account_taken`, `manager.league_full` |
 * | `tavern.chosen` | `choose.wrong_phase`, `choose.unknown_manager`, `choose.already_chose`, `choose.unknown_tavern`, `choose.taken`, `choose.bad_order`, `choose.not_on_clock` |
 * | `draft.pick` | `draft.complete`, `draft.cast_incomplete`, `draft.tavern_pick_incomplete`, `draft.wrong_pick`, `draft.not_on_clock`, `draft.not_pooled`, `draft.already_owned` |
 * | `call.made` | `call.wrong_phase`, `call.unknown_tavern`, `call.bad_episode`, `call.not_in`, `call.immune` |
 * | `challenge.resolved` | `challenge.wrong_phase`, `challenge.bad_episode`, `challenge.commitment`, `challenge.result` |
 * | `vote.resolved` | `vote.wrong_phase`, `vote.bad_episode`, `vote.no_challenge`, `vote.result` |
 * | `finale.resolved` | `finale.wrong_phase`, `finale.votes_left`, `finale.result` |
 * | `round.finalized` | `round.wrong_phase`, `round.bad_round`, `round.episodes_left`, `round.no_finale` |
 *
 * ## Rules
 *
 * - The cast is the pool: exactly `contest.castSize` monsters are pooled
 *   before the draft starts.
 * - The tavern pick: the first `tavern.chosen` freezes the draft order over
 *   the joined managers (`draftOrder`), and managers then choose in its
 *   reverse. The first `draft.pick` needs every manager to have chosen, and
 *   freezes the snake order as their taverns in draft order. The draft runs
 *   `roster.size` rounds; the contest starts after the last pick.
 * - An episode is open from the vote before it until its own vote. A call
 *   is for the open episode, names a monster still in, and replaces the
 *   tavern's earlier call. Before the episode's challenge it is early; after
 *   it, it can't name the immune monster and is late. An early call on the
 *   monster that then wins immunity stands (it can't be right) until
 *   replaced.
 * - `challenge.resolved` must match the episode's commitment and hold
 *   together (`challengeProblem`); `vote.resolved` must be legal and its
 *   boot must follow from its ballots (`voteProblem`); likewise the finale
 *   (`finaleProblem`). The dice themselves are audited against the seed by
 *   `verifyContest`.
 * - Rounds are finalized in order once their episodes are voted; the last
 *   needs the finale and completes the season.
 */
import { REGISTRY_VERSION, TRAITS, validateModifiers } from '../characters';
import { challengeProblem, finaleProblem, voteProblem } from '../contest/check';
import { MAX_TAVERNS, configIssues, episodesOf, votesIn, type SeasonConfig } from '../league';
import { draftOrderSeed, rngFor } from '../rng';
import { draftOrder, snakePickOwner } from '../roster';
import { challengeSha256 } from './canonical';
import type { CallState, EpisodeState, LeagueState, TavernState } from './state';
import type { EventOf, EventType, LeagueEvent } from './types';

export class InvalidEventError extends Error {
  constructor(
    readonly seq: number,
    readonly code: string,
    message: string,
  ) {
    super(`event ${seq}: ${message}`);
    this.name = 'InvalidEventError';
  }
}

export function initialState(): LeagueState {
  return {
    lastSeq: 0,
    lastHash: null,
    phase: 'empty',
    config: null,
    tavernList: [],
    commitments: [],
    abilityMix: null,
    managers: new Map(),
    pool: new Map(),
    taverns: new Map(),
    owner: new Map(),
    draft: { managerOrder: [], order: [], picks: 0, complete: false },
    alive: [],
    jury: [],
    episodes: [],
    calls: new Map(),
    finale: null,
    finalizedRounds: new Set(),
  };
}

/**
 * Apply one event. Throws `InvalidEventError` if its envelope (seq, season)
 * or its preconditions fail. Pure: `state` is never mutated. Leaves
 * `lastHash` unchanged (see `replayLog`).
 */
export function applyEvent(state: LeagueState, event: LeagueEvent): LeagueState {
  checkEnvelope(state, event);
  const handler = handlers[event.type] as Handler<EventType>;
  const next = handler(state, event as EventOf<EventType>);
  return { ...next, lastSeq: event.seq };
}

/** The episode open for calls and results: votes so far + 1, or null once every vote is in (or before the contest). */
export function openEpisode(state: LeagueState): number | null {
  if (state.phase !== 'contest' || state.config === null) return null;
  const voted = state.episodes.filter((e) => e.vote !== null).length;
  return voted >= votesIn(state.config) ? null : voted + 1;
}

// ── envelope ───────────────────────────────────────────────────────────────

function checkEnvelope(state: LeagueState, event: LeagueEvent): void {
  if (event.seq !== state.lastSeq + 1) {
    fail(event, 'envelope.seq', `seq must be ${state.lastSeq + 1} (contiguous), got ${event.seq}`);
  }
  if (state.config === null) {
    if (event.type !== 'season.created') fail(event, 'season.not_created', 'the first event must be season.created');
    return;
  }
  if (event.type === 'season.created') fail(event, 'season.already_created', `season "${state.config.id}" already exists`);
  if (event.season !== state.config.id) {
    fail(event, 'envelope.season', `event is for season "${event.season}" but this log is "${state.config.id}"`);
  }
}

// ── handlers ───────────────────────────────────────────────────────────────

type Handler<T extends EventType> = (state: LeagueState, event: EventOf<T>) => LeagueState;

const handlers: { readonly [T in EventType]: Handler<T> } = {
  'season.created': (state, event) => {
    const { config, taverns, challenges, abilityMix } = event.payload;
    if (event.season !== config.id) {
      fail(event, 'season.id_mismatch', `envelope season "${event.season}" differs from config.id "${config.id}"`);
    }
    const ids = new Set(taverns.map((t) => t.id));
    if (ids.size !== taverns.length) fail(event, 'season.bad_taverns', 'a tavern is listed twice');
    if (taverns.length > MAX_TAVERNS) fail(event, 'season.bad_taverns', `${taverns.length} taverns; a league has at most ${MAX_TAVERNS}`);
    const issues = configIssues(config, taverns.length);
    if (issues.length > 0) fail(event, 'season.bad_config', issues.join('; '));
    const votes = votesIn(config);
    if (challenges.length !== votes || challenges.some((c, i) => c.episode !== i + 1)) {
      fail(event, 'season.bad_challenges', `expected one commitment for each of episodes 1..${votes}, in order`);
    }
    return { ...state, phase: 'preseason', config, tavernList: taverns, commitments: challenges, abilityMix };
  },

  'character.pooled': (state, event) => {
    const config = configOf(state);
    const { character, base, cr, modifiers, strategy } = event.payload;
    if (state.phase !== 'preseason' || state.draft.picks > 0) fail(event, 'pool.wrong_phase', `the cast is pooled before the draft, not in ${state.phase}`);
    if (state.pool.has(character)) fail(event, 'pool.duplicate', `"${character}" is already pooled`);
    if (state.pool.size >= config.contest.castSize) fail(event, 'pool.cast_full', `the cast is full (${config.contest.castSize})`);
    if (config.modifierRegistryVersion !== REGISTRY_VERSION) {
      fail(event, 'pool.registry_version', `season pins modifier registry v${config.modifierRegistryVersion}, but this engine prices v${REGISTRY_VERSION}`);
    }
    const issues = validateModifiers({ ref: { id: character, base }, modifiers }, config.budget.modifierPointsPerCharacter, TRAITS);
    if (issues.length > 0) {
      const code = issues.some((i) => i.code === 'over_budget') ? 'pool.over_budget' : 'pool.invalid_modifiers';
      fail(event, code, `"${character}" modifiers: ${issues.map((i) => i.message).join('; ')}`);
    }
    return { ...state, pool: mapSet(state.pool, character, { base, cr, modifiers, strategy }) };
  },

  'manager.joined': (state, event) => {
    const { manager, account } = event.payload;
    if (state.phase !== 'preseason' || state.draft.managerOrder.length > 0) {
      fail(event, 'manager.wrong_phase', 'managers join in preseason, before the tavern pick starts');
    }
    if (state.managers.has(manager)) fail(event, 'manager.duplicate', `manager "${manager}" has already joined`);
    if ('githubId' in account) {
      for (const other of state.managers.values()) {
        if ('githubId' in other.account && other.account.githubId === account.githubId) {
          fail(event, 'manager.account_taken', `${account.login} (${account.githubId}) already manages as "${other.id}"`);
        }
      }
    }
    const limit = Math.min(MAX_TAVERNS, state.tavernList.length);
    if (state.managers.size >= limit) fail(event, 'manager.league_full', `the league is full: ${limit} manager(s) for ${state.tavernList.length} tavern(s)`);
    return { ...state, managers: mapSet(state.managers, manager, { id: manager, account, tavern: null }) };
  },

  'tavern.chosen': (state, event) => {
    const config = configOf(state);
    const { manager, tavern } = event.payload;
    if (state.phase !== 'preseason' || state.draft.picks > 0) fail(event, 'choose.wrong_phase', 'taverns are chosen before the first draft pick');
    const m = state.managers.get(manager);
    if (m === undefined) fail(event, 'choose.unknown_manager', `no manager "${manager}"`);
    if (m.tavern !== null) fail(event, 'choose.already_chose', `"${manager}" already chose "${m.tavern}"`);
    const entry = state.tavernList.find((t) => t.id === tavern);
    if (entry === undefined) fail(event, 'choose.unknown_tavern', `"${tavern}" is not one of this season's taverns`);
    if (state.taverns.has(tavern)) fail(event, 'choose.taken', `"${tavern}" is already ${state.taverns.get(tavern)!.managerId}'s`);
    let managerOrder = state.draft.managerOrder;
    if (managerOrder.length === 0) {
      // The first choice freezes the draft order over the joined managers.
      try {
        managerOrder = draftOrder([...state.managers.keys()], config, rngFor(draftOrderSeed(config.id), 'order'));
      } catch (error) {
        fail(event, 'choose.bad_order', error instanceof Error ? error.message : String(error));
      }
    }
    const onClock = [...managerOrder].reverse()[state.taverns.size];
    if (manager !== onClock) fail(event, 'choose.not_on_clock', `tavern pick ${state.taverns.size + 1} belongs to "${onClock}", not "${manager}"`);
    return {
      ...state,
      managers: mapSet(state.managers, manager, { ...m, tavern }),
      taverns: mapSet(state.taverns, tavern, { id: tavern, name: entry.name, managerId: manager, manager: m.account, roster: [] }),
      draft: { ...state.draft, managerOrder },
    };
  },

  'draft.pick': (state, event) => {
    const config = configOf(state);
    const { pick, tavern, character } = event.payload;
    if (state.draft.complete || (state.phase !== 'preseason' && state.phase !== 'drafting')) fail(event, 'draft.complete', 'the draft is over');
    let order = state.draft.order;
    if (state.draft.picks === 0) {
      if (state.pool.size !== config.contest.castSize) fail(event, 'draft.cast_incomplete', `the cast has ${state.pool.size} of ${config.contest.castSize}`);
      // The first pick needs every manager in a tavern, and freezes the snake order: their taverns, in draft order.
      const waiting = [...state.managers.values()].filter((m) => m.tavern === null).map((m) => `"${m.id}"`);
      if (state.managers.size === 0 || waiting.length > 0) {
        fail(event, 'draft.tavern_pick_incomplete', waiting.length > 0 ? `still to choose a tavern: ${waiting.join(', ')}` : 'no managers have joined');
      }
      order = state.draft.managerOrder.map((id) => state.managers.get(id)!.tavern!);
    }
    if (pick !== state.draft.picks) fail(event, 'draft.wrong_pick', `pick must be ${state.draft.picks} (picks so far), got ${pick}`);
    const onClock = snakePickOwner(order, pick);
    if (tavern !== onClock) fail(event, 'draft.not_on_clock', `pick ${pick} belongs to "${onClock}", not "${tavern}"`);
    if (!state.pool.has(character)) fail(event, 'draft.not_pooled', `"${character}" is not in this season's cast`);
    const owner = state.owner.get(character);
    if (owner !== undefined) fail(event, 'draft.already_owned', `"${character}" already belongs to "${owner}"`);
    const picks = state.draft.picks + 1;
    const complete = picks >= config.roster.size * order.length;
    const t = state.taverns.get(tavern)!;
    return {
      ...state,
      owner: mapSet(state.owner, character, tavern),
      taverns: mapSet(state.taverns, tavern, { ...t, roster: [...t.roster, character] }),
      phase: complete ? 'contest' : 'drafting',
      draft: { ...state.draft, order, picks, complete },
      alive: complete ? [...state.pool.keys()] : state.alive,
    };
  },

  'call.made': (state, event) => {
    const { episode, tavern, target } = event.payload;
    const open = openEpisode(state);
    if (open === null) fail(event, 'call.wrong_phase', state.phase === 'contest' ? 'every vote is in' : 'calls open when the contest starts');
    tavernOr(state, event, tavern, 'call.unknown_tavern');
    if (episode !== open) fail(event, 'call.bad_episode', `calls are for episode ${open}, not ${episode}`);
    if (!state.alive.includes(target)) fail(event, 'call.not_in', `"${target}" is not in the contest`);
    const challenge = state.episodes[episode - 1]?.challenge ?? null;
    if (challenge !== null && challenge.result.winner === target) fail(event, 'call.immune', `"${target}" won immunity: they can't be voted out`);
    const call: CallState = { target, early: challenge === null, seq: event.seq };
    const calls = state.calls.get(episode) ?? new Map<string, CallState>();
    return { ...state, calls: mapSet(state.calls, episode, mapSet(calls, tavern, call)) };
  },

  'challenge.resolved': (state, event) => {
    const { episode, challenge, sha256, result } = event.payload;
    const open = openEpisode(state);
    if (open === null) fail(event, 'challenge.wrong_phase', 'no episode is open');
    if (episode !== open) fail(event, 'challenge.bad_episode', `episode ${open} is open, not ${episode}`);
    if (state.episodes[episode - 1]?.challenge != null) fail(event, 'challenge.bad_episode', `episode ${episode}'s challenge has already run`);
    const committed = state.commitments[episode - 1]?.sha256;
    if (sha256 !== committed || challengeSha256(challenge) !== sha256) {
      fail(event, 'challenge.commitment', `the challenge does not match episode ${episode}'s commitment`);
    }
    const problem = challengeProblem(state.alive, result);
    if (problem !== null) fail(event, 'challenge.result', problem);
    const entry: EpisodeState = { episode, challenge: { id: challenge.id, result }, vote: null };
    return { ...state, episodes: [...state.episodes, entry] };
  },

  'vote.resolved': (state, event) => {
    const { episode, vote } = event.payload;
    const open = openEpisode(state);
    if (open === null) fail(event, 'vote.wrong_phase', 'no episode is open');
    if (episode !== open) fail(event, 'vote.bad_episode', `episode ${open} is open, not ${episode}`);
    const entry = state.episodes[episode - 1];
    if (entry?.challenge == null) fail(event, 'vote.no_challenge', `episode ${episode}'s challenge hasn't run`);
    const problem = voteProblem(state.alive, entry.challenge.result.winner, vote);
    if (problem !== null) fail(event, 'vote.result', problem);
    const episodes = [...state.episodes];
    episodes[episode - 1] = { ...entry, vote };
    return { ...state, episodes, alive: state.alive.filter((id) => id !== vote.boot), jury: [...state.jury, vote.boot] };
  },

  'finale.resolved': (state, event) => {
    if (state.phase !== 'contest' || state.finale !== null) fail(event, 'finale.wrong_phase', 'the finale comes once, at the end of the contest');
    if (openEpisode(state) !== null) fail(event, 'finale.votes_left', 'votes are still to come');
    const problem = finaleProblem(state.alive, state.jury, event.payload.result);
    if (problem !== null) fail(event, 'finale.result', problem);
    return { ...state, finale: event.payload.result };
  },

  'round.finalized': (state, event) => {
    const config = configOf(state);
    const { round } = event.payload;
    if (state.phase !== 'contest') fail(event, 'round.wrong_phase', 'rounds are finalized during the contest');
    if (round !== state.finalizedRounds.size + 1 || round > config.schedule.rounds.length) {
      fail(event, 'round.bad_round', `the next round to finalize is ${state.finalizedRounds.size + 1}`);
    }
    const left = episodesOf(config, round).filter((e) => state.episodes[e - 1]?.vote == null);
    if (left.length > 0) fail(event, 'round.episodes_left', `episodes ${left.join(', ')} have not been voted`);
    const last = round === config.schedule.rounds.length;
    if (last && state.finale === null) fail(event, 'round.no_finale', 'the last round needs the finale');
    const finalizedRounds = new Set(state.finalizedRounds);
    finalizedRounds.add(round);
    return { ...state, finalizedRounds, phase: last ? 'complete' : state.phase };
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function fail(event: LeagueEvent, code: string, message: string): never {
  throw new InvalidEventError(event.seq, code, `${event.type} rejected [${code}]: ${message}`);
}

/** The season's config. `checkEnvelope` guarantees it exists for every event but `season.created`. */
function configOf(state: LeagueState): SeasonConfig {
  if (state.config === null) throw new Error('reducers: no season config (checkEnvelope should have rejected this)');
  return state.config;
}

function tavernOr(state: LeagueState, event: LeagueEvent, tavern: string, code: string): TavernState {
  const t = state.taverns.get(tavern);
  if (t === undefined) fail(event, code, `unknown tavern "${tavern}"`);
  return t;
}

function mapSet<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}
