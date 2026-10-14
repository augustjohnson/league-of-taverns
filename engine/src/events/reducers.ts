/**
 * Reducers: one pure handler per event type, `(state, event) → state`.
 *
 * Every handler checks its own preconditions (whose pick it is, whether a
 * lineup is legal, whether a week is already locked) and throws
 * `InvalidEventError` when they fail. The same handlers serve two callers:
 * - Actions call `applyEvent` on a candidate event before appending it, so an
 *   illegal command is rejected with a reason and never written.
 * - `replay` folds the whole log. An invalid event in a committed log is
 *   corruption, and replay stops on it.
 *
 * Handlers never mutate the state they are given: every change copies the
 * map, set or array it touches, and untouched branches are shared.
 *
 * Fold rules per event: docs/schema.md § Reducers. Preconditions: the table
 * in docs/schema.md § Events.
 *
 * ## Envelope
 *
 * `applyEvent` checks `seq === state.lastSeq + 1` and, once the season exists,
 * that `event.season` is the season's id. It does **not** check `prev`: the
 * hash chain commits to the raw bytes of the previous line, which only the
 * log reader sees, so `replayLog` checks it. `at` and `actor` are never
 * read: reducers don't use clocks, and who may send which command is the
 * Action's job (it maps an issue author to a tavern before building the event).
 *
 * ## Error codes
 *
 * `InvalidEventError.code` is `<area>.<reason>` and stable:
 *
 * | Area | Codes |
 * |---|---|
 * | envelope | `envelope.seq`, `envelope.season` |
 * | `season.created` | `season.not_created` (any other event first), `season.already_created`, `season.id_mismatch`, `season.bad_schedule`, `season.bad_sponsors`, `season.bad_taverns` |
 * | `character.pooled` | `pool.wrong_phase`, `pool.duplicate`, `pool.registry_version`, `pool.over_budget`, `pool.invalid_modifiers` |
 * | `manager.joined` | `manager.wrong_phase`, `manager.duplicate`, `manager.account_taken`, `manager.league_full` |
 * | `tavern.chosen` | `choose.wrong_phase`, `choose.unknown_manager`, `choose.already_chose`, `choose.unknown_tavern`, `choose.taken`, `choose.bad_order`, `choose.not_on_clock` |
 * | `character.retained` | `retain.wrong_phase`, `retain.unknown_tavern`, `retain.not_pooled`, `retain.already_owned`, `retain.over_limit`, `retain.roster_full` |
 * | `draft.pick` | `draft.complete`, `draft.tavern_pick_incomplete`, `draft.wrong_pick`, `draft.not_on_clock`, `draft.not_pooled`, `draft.already_owned`, `draft.roster_full` |
 * | `lineup.set` | `lineup.draft_incomplete`, `lineup.unknown_tavern`, `lineup.bad_week`, `lineup.week_locked`, and `lineup.<code>` for the first `validateLineup` violation (`wrong_size`, `bad_retreat`, `duplicate`, `not_owned`, `injured`, `unknown_character`, `over_budget`) |
 * | `lineup.locked` | `lock.draft_incomplete`, `lock.bad_week`, `lock.already_locked`, `lock.previous_not_finalized`, `lock.unknown_tavern`, `lock.duplicate_tavern`, `lock.missing_tavern`, `lock.source_mismatch`, `lock.illegal_lineup` |
 * | `waiver.claimed` | `waiver.draft_incomplete`, `waiver.unknown_tavern`, `waiver.duplicate_claim`, `waiver.not_pooled`, `waiver.not_free_agent`, `waiver.drop_not_owned` |
 * | `waiver.resolved` | `waiver.bad_week`, `waiver.week_not_finalized`, `waiver.already_resolved`, `waiver.unknown_claim`, `waiver.duplicate_outcome`, `waiver.missing_outcome`, `waiver.bad_priority`, `waiver.outcome_mismatch` |
 * | `trade.*` | `trade.draft_incomplete`, `trade.duplicate_id`, `trade.unknown_tavern`, `trade.unknown`, `trade.not_proposed`, `trade.not_accepted`, `trade.not_open`, `trade.past_deadline` (at acceptance), and the `validateTrade` codes below |
 * | `mission.revealed` | `reveal.bad_week`, `reveal.week_not_locked`, `reveal.already_revealed`, `reveal.wrong_season`, `reveal.commitment_mismatch`, `reveal.invalid_mission` |
 * | `mission.resolved` | `resolve.bad_week`, `resolve.week_not_locked`, `resolve.not_revealed`, `resolve.wrong_mission`, `resolve.week_finalized`, `resolve.unknown_tavern`, `resolve.duplicate`, `resolve.no_lineup`, `resolve.lineup_mismatch`, `resolve.counts_mismatch`, `resolve.score_mismatch`, `resolve.bad_injury` |
 * | `week.finalized` | `finalize.bad_week`, `finalize.already_finalized`, `finalize.week_not_locked`, `finalize.missing_result` |
 *
 * `trade.proposed` and `trade.completed` run `validateTrade` and report its
 * first violation (in its order) under these codes:
 *
 * | `validateTrade` | Event code |
 * |---|---|
 * | `same_tavern` | `trade.self` |
 * | `empty_side` | `trade.empty` |
 * | `duplicate` | `trade.duplicate_piece` |
 * | `give_not_owned`, `receive_not_owned` | `trade.not_owned` |
 * | `roster_size` | `trade.roster_size` |
 * | `past_deadline` | `trade.past_deadline` |
 * | anything added later | `trade.<code>` |
 *
 * `waiver.add_not_free`, `waiver.drop_not_owned` and `waiver.roster_full` are
 * no longer raised by `waiver.resolved`: an award that breaks them disagrees
 * with `resolveWaivers` and is `waiver.outcome_mismatch`.
 * (`waiver.drop_not_owned` is still `waiver.claimed`'s.)
 *
 * ## Interpretations
 *
 * - Ownership is modelled as exclusive (D-01): one owner per character.
 * - `manager.joined`: "manager not already in the league" compares GitHub ids
 *   (D-35). Bot managers are exempt, since sims seat many managers with the
 *   same strategy. A league holds at most `MAX_TAVERNS` managers (D-01), and
 *   no more than the season has taverns. Joining closes when the tavern pick
 *   starts.
 * - The tavern pick (D-52): the first `tavern.chosen` freezes the draft order
 *   over the joined managers (`draftOrder`), and managers then choose in its
 *   reverse, one tavern each, from the season's taverns. The first
 *   `draft.pick` needs every manager to have chosen, and freezes the snake
 *   order as the managers' taverns in draft order.
 * - `character.retained`: the keeper limit is `keepersPerTavern` for basis
 *   `keeper` and `championBonusKeepers` for `champion_reward`, and both are 0
 *   when `carryover.mode` is `none`. The kept character takes a roster slot.
 * - Keeper-forfeited picks (D-11, OPEN) are recorded in `state.retained` but
 *   not yet removed from the draft: the draft still runs `rounds × taverns`
 *   picks in plain snake order, and a tavern whose keepers fill its roster
 *   hits `draft.roster_full`. When D-11 lands (T10.3), the hook is in the
 *   `draft.pick` handler: walk the snake order and skip (tavern, round) slots
 *   named by `state.retained[].costRound`, and subtract them from the total.
 *   Timeouts with `onTimeout: skip` have no event yet either (D-26).
 * - Weeks are checked against `1..config.weeks` everywhere.
 * - `lineup.locked`: a null lineup must have source `none`, and a non-null
 *   one must not.
 * - Trades: `validateTrade` decides legality at proposal and again at
 *   completion (rules §10, D-06), with `week` = the next lineup week, 1 + the
 *   number of locked weeks. So the deadline is "week `deadlineWeek` is
 *   locked", and acceptance checks that alone. Both sides must give at least
 *   one character (`empty_side`); an uneven trade must leave each changed
 *   roster between 1 and `roster.size`; an even one always fits. The veto
 *   window can't be timed without a clock (D-41), so "within the window"
 *   means the trade is still `accepted`, and `trade.completed` itself marks
 *   the window's end.
 * - `trade.completed` on a trade that is no longer legal (pieces moved by an
 *   earlier trade or waiver, a roster filled up, the deadline passed) is
 *   rejected. The Action emits `trade.cancelled` with reason `invalid`
 *   instead.
 * - `waiver.resolved` must be exactly what `resolveWaivers` decides from the
 *   state: the pending claims (in log order, which ranks them as their seqs
 *   would), `waiverPriority(state)` (the stored rolling order, or the
 *   reverse standings, D-05), every roster, and `freeAgents`. `outcomes`
 *   must list the same claims, `awarded` flags and reasons (a `WaiverReason`)
 *   in the same order (decision order: round by round, priority order within
 *   a round), and `priorityAfter` must equal the computed priority. Otherwise
 *   `waiver.outcome_mismatch`, naming the first differing outcome. The
 *   computed awards are what get applied. Unlike a mission run (D-20),
 *   nothing random is involved, so the record is checked rather than
 *   trusted. The cost: replay is tied to today's `resolveWaivers`, so a
 *   change to its rules must be versioned in the season config, or older
 *   logs stop replaying.
 * - `waiver.resolved` runs once per week (`waiver.already_resolved`).
 * - `season.created`: sponsors must pass `validateSponsors` (unique gods and
 *   taverns, every week's sponsor listed, one week per sponsor), and every
 *   sponsor's tavern must be one of `taverns`: unique ids, at most
 *   `MAX_TAVERNS` (D-01). A tavern nobody chooses sits the season out, and
 *   its god's week is still played.
 * - `mission.revealed`: `sha256` must equal the schedule commitment only when
 *   one was made (D-08 made missions open, so commitments are null). The
 *   mission is validated against the season's mission rules and the
 *   schedule's environment. The reducer has no creature snapshot, so the
 *   snapshot-dependent checks (`encounter.ref`, `encounter.budget`) are the
 *   reveal script's.
 * - `mission.resolved`: the counts and the loot (the `loot` of each passed
 *   check node and won battle node) are recomputed from the recorded nodes, and the score must
 *   equal `lootScore(loot, missionHaul(mission))`, DNF or not, to within
 *   1e-9. An `injury` needs a DNF and a starter from the lineup, and that
 *   starter can't start the next week (D-51; `injuredFor`). Everything else
 *   (path, d20s, points, which starter the injury roll picks) is audited by
 *   `verifyResolutions`, which reports instead of throwing.
 * - `lineup.set` and `lineup.locked` reject a starter injured the week
 *   before (`lineup.injured`, `lock.illegal_lineup`).
 * - `week.finalized` needs a result for every tavern whose locked lineup is
 *   non-null. A tavern locked with no lineup needs none and scores 0 (rules
 *   §5; see `weekResults`). Finalizing week `config.weeks` completes the season.
 */
import { REGISTRY_VERSION, TRAITS, validateModifiers } from '../characters';
import { MAX_TAVERNS, validateSponsors, type SeasonConfig } from '../league';
import { missionHaul, validateMission, type Mission } from '../missions';
import { lootScore } from '../resolution';
import { draftOrderSeed, rngFor } from '../rng';
import {
  draftOrder,
  resolveWaivers,
  snakePickOwner,
  validateLineup,
  validateTrade,
  type Lineup,
  type RosterView,
  type WaiverClaim,
} from '../roster';
import type { CrEighths } from '../vocabulary';
import { freeAgents, injuredFor, waiverPriority } from './selectors';
import type { LeagueState, TavernState, TradeState } from './state';
import type { EventOf, EventType, LeagueEvent, PayloadByType } from './types';

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
    schedule: [],
    sponsors: [],
    tavernList: [],
    managers: new Map(),
    pool: new Map(),
    taverns: new Map(),
    owner: new Map(),
    draft: { managerOrder: [], order: [], picks: 0, complete: false },
    retained: [],
    pendingLineups: new Map(),
    lockedLineups: new Map(),
    waivers: { pending: [], priority: [], resolvedWeeks: new Set() },
    trades: new Map(),
    revealed: new Map(),
    results: new Map(),
    injuries: new Map(),
    finalizedWeeks: new Set(),
  };
}

/**
 * Apply one event. Throws `InvalidEventError` if its envelope (seq, season)
 * or its preconditions fail. Pure: `state` is never mutated. Leaves
 * `lastHash` unchanged, since the hash chain is the log reader's to check
 * (see `replayLog`).
 */
export function applyEvent(state: LeagueState, event: LeagueEvent): LeagueState {
  checkEnvelope(state, event);
  const handler = handlers[event.type] as Handler<EventType>;
  const next = handler(state, event as EventOf<EventType>);
  return { ...next, lastSeq: event.seq };
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
    const { config, schedule, sponsors } = event.payload;
    if (event.season !== config.id) {
      fail(event, 'season.id_mismatch', `envelope season "${event.season}" differs from config.id "${config.id}"`);
    }
    const weeks = new Set<number>();
    for (const entry of schedule) {
      if (entry.week > config.weeks) fail(event, 'season.bad_schedule', `schedule week ${entry.week} is past the season's ${config.weeks} weeks`);
      if (weeks.has(entry.week)) fail(event, 'season.bad_schedule', `schedule lists week ${entry.week} twice`);
      weeks.add(entry.week);
    }
    const issues = validateSponsors(sponsors, schedule);
    if (issues.length > 0) fail(event, 'season.bad_sponsors', issues.map((i) => i.message).join('; '));
    const { taverns } = event.payload;
    const ids = new Set(taverns.map((t) => t.id));
    if (ids.size !== taverns.length) fail(event, 'season.bad_taverns', 'a tavern is listed twice');
    if (taverns.length > MAX_TAVERNS) fail(event, 'season.bad_taverns', `${taverns.length} taverns; a league has at most ${MAX_TAVERNS} (D-01)`);
    const stray = sponsors.filter((s) => !ids.has(s.tavern));
    if (stray.length > 0) fail(event, 'season.bad_taverns', `sponsored taverns are not in the season: ${stray.map((s) => `"${s.tavern}" (${s.id})`).join(', ')}`);
    return { ...state, phase: 'preseason', config, schedule, sponsors, tavernList: taverns };
  },

  'character.pooled': (state, event) => {
    const config = configOf(state);
    const { character, base, cr, modifiers } = event.payload;
    if (state.phase !== 'preseason') fail(event, 'pool.wrong_phase', `characters are pooled in preseason, not ${state.phase}`);
    if (state.pool.has(character)) fail(event, 'pool.duplicate', `"${character}" is already pooled`);
    if (config.modifierRegistryVersion !== REGISTRY_VERSION) {
      fail(
        event,
        'pool.registry_version',
        `season pins modifier registry v${config.modifierRegistryVersion}, but this engine prices v${REGISTRY_VERSION}`,
      );
    }
    const issues = validateModifiers({ ref: { id: character, base }, modifiers }, config.budget.modifierPointsPerCharacter, TRAITS);
    if (issues.length > 0) {
      const code = issues.some((i) => i.code === 'over_budget') ? 'pool.over_budget' : 'pool.invalid_modifiers';
      fail(event, code, `"${character}" modifiers: ${issues.map((i) => i.message).join('; ')}`);
    }
    return { ...state, pool: mapSet(state.pool, character, { base, cr, modifiers }) };
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
    if (state.managers.size >= limit) {
      fail(event, 'manager.league_full', `the league is full: ${limit} manager(s) for ${state.tavernList.length} tavern(s), at most ${MAX_TAVERNS} (D-01)`);
    }
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
        fail(event, 'choose.bad_order', errorMessage(error));
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

  'character.retained': (state, event) => {
    const config = configOf(state);
    const { tavern, character, basis } = event.payload;
    if (state.phase !== 'preseason') fail(event, 'retain.wrong_phase', `keepers are placed before the first pick, not in ${state.phase}`);
    const t = tavernOr(state, event, tavern, 'retain.unknown_tavern');
    if (!state.pool.has(character)) fail(event, 'retain.not_pooled', `"${character}" is not in this season's pool`);
    ownedOr(state, event, character, 'retain.already_owned');
    const { mode, keepersPerTavern, championBonusKeepers } = config.carryover;
    const limit = mode === 'none' ? 0 : basis === 'keeper' ? keepersPerTavern : championBonusKeepers;
    const used = state.retained.filter((r) => r.tavern === tavern && r.basis === basis).length;
    if (used >= limit) fail(event, 'retain.over_limit', `"${tavern}" may retain ${limit} character(s) as ${basis}, and has ${used}`);
    if (t.roster.length >= config.roster.size) fail(event, 'retain.roster_full', `"${tavern}" roster is full (${config.roster.size})`);
    return {
      ...state,
      ...acquire(state, tavern, character),
      retained: [...state.retained, event.payload],
    };
  },

  'draft.pick': (state, event) => {
    const config = configOf(state);
    const { pick, tavern, character } = event.payload;
    if (state.draft.complete || (state.phase !== 'preseason' && state.phase !== 'drafting')) {
      fail(event, 'draft.complete', 'the draft is over');
    }
    let order = state.draft.order;
    if (state.draft.picks === 0) {
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
    if (!state.pool.has(character)) fail(event, 'draft.not_pooled', `"${character}" is not in this season's pool`);
    ownedOr(state, event, character, 'draft.already_owned');
    const t = tavernOr(state, event, tavern, 'draft.not_on_clock');
    if (t.roster.length >= config.roster.size) fail(event, 'draft.roster_full', `"${tavern}" roster is full (${config.roster.size})`);

    // D-11 hook (T10.3): subtract keeper-forfeited slots here, and skip them in the order above.
    const total = config.draft.rounds * order.length;
    const picks = state.draft.picks + 1;
    const complete = picks >= total;
    return {
      ...state,
      ...acquire(state, tavern, character),
      phase: complete ? 'regular' : 'drafting',
      draft: { ...state.draft, order, picks, complete },
      waivers: complete ? { ...state.waivers, priority: [...order].reverse() } : state.waivers,
    };
  },

  'lineup.set': (state, event) => {
    const config = configOf(state);
    const { tavern, week, lineup } = event.payload;
    if (!state.draft.complete) fail(event, 'lineup.draft_incomplete', 'lineups open after the draft');
    const t = tavernOr(state, event, tavern, 'lineup.unknown_tavern');
    weekOr(config, event, week, 'lineup.bad_week');
    if (state.lockedLineups.has(week)) fail(event, 'lineup.week_locked', `week ${week} is already locked`);
    const violations = validateLineup(lineup, rosterView(t), crOf(state), config, { unavailable: injuredFor(state, week) });
    const first = violations[0];
    if (first !== undefined) fail(event, `lineup.${first.code}`, violations.map((v) => v.message).join('; '));
    const week_ = state.pendingLineups.get(week) ?? new Map<string, Lineup>();
    return { ...state, pendingLineups: mapSet(state.pendingLineups, week, mapSet(week_, tavern, lineup)) };
  },

  'lineup.locked': (state, event) => {
    const config = configOf(state);
    const { week, lineups } = event.payload;
    if (!state.draft.complete) fail(event, 'lock.draft_incomplete', 'weeks lock after the draft');
    weekOr(config, event, week, 'lock.bad_week');
    if (state.lockedLineups.has(week)) fail(event, 'lock.already_locked', `week ${week} is already locked`);
    if (week > 1 && !state.finalizedWeeks.has(week - 1)) {
      fail(event, 'lock.previous_not_finalized', `week ${week - 1} must be finalized before week ${week} locks`);
    }
    const seen = new Set<string>();
    const unavailable = injuredFor(state, week);
    for (const entry of lineups) {
      const t = tavernOr(state, event, entry.tavern, 'lock.unknown_tavern');
      if (seen.has(entry.tavern)) fail(event, 'lock.duplicate_tavern', `"${entry.tavern}" is listed twice`);
      seen.add(entry.tavern);
      if ((entry.lineup === null) !== (entry.source === 'none')) {
        fail(event, 'lock.source_mismatch', `"${entry.tavern}": source "${entry.source}" with ${entry.lineup === null ? 'no' : 'a'} lineup`);
      }
      if (entry.lineup !== null) {
        const violations = validateLineup(entry.lineup, rosterView(t), crOf(state), config, { unavailable });
        if (violations.length > 0) {
          fail(event, 'lock.illegal_lineup', `"${entry.tavern}": ${violations.map((v) => v.message).join('; ')}`);
        }
      }
    }
    const missing = [...state.taverns.keys()].filter((id) => !seen.has(id));
    if (missing.length > 0) fail(event, 'lock.missing_tavern', `no entry for ${missing.map((m) => `"${m}"`).join(', ')}`);
    return {
      ...state,
      lockedLineups: mapSet(state.lockedLineups, week, lineups),
      pendingLineups: mapDelete(state.pendingLineups, week),
    };
  },

  'waiver.claimed': (state, event) => {
    const { claim, tavern, add, drop } = event.payload;
    if (!state.draft.complete) fail(event, 'waiver.draft_incomplete', 'waivers open after the draft');
    const t = tavernOr(state, event, tavern, 'waiver.unknown_tavern');
    if (state.waivers.pending.some((c) => c.claim === claim)) fail(event, 'waiver.duplicate_claim', `claim "${claim}" is already pending`);
    if (!state.pool.has(add)) fail(event, 'waiver.not_pooled', `"${add}" is not in this season's pool`);
    if (state.owner.has(add)) fail(event, 'waiver.not_free_agent', `"${add}" belongs to "${state.owner.get(add)}"`);
    if (drop !== null && !t.roster.includes(drop)) fail(event, 'waiver.drop_not_owned', `"${drop}" is not on "${tavern}"'s roster`);
    return { ...state, waivers: { ...state.waivers, pending: [...state.waivers.pending, event.payload] } };
  },

  'waiver.resolved': (state, event) => {
    const config = configOf(state);
    const { week, outcomes, priorityAfter } = event.payload;
    weekOr(config, event, week, 'waiver.bad_week');
    if (!state.finalizedWeeks.has(week)) fail(event, 'waiver.week_not_finalized', `waivers resolve after week ${week} is finalized`);
    if (state.waivers.resolvedWeeks.has(week)) fail(event, 'waiver.already_resolved', `week ${week} waivers already resolved`);

    const pending = new Map(state.waivers.pending.map((c) => [c.claim, c]));
    const covered = new Set<string>();
    for (const outcome of outcomes) {
      if (!pending.has(outcome.claim)) fail(event, 'waiver.unknown_claim', `claim "${outcome.claim}" is not pending`);
      if (covered.has(outcome.claim)) fail(event, 'waiver.duplicate_outcome', `claim "${outcome.claim}" has two outcomes`);
      covered.add(outcome.claim);
    }
    const uncovered = [...pending.keys()].filter((id) => !covered.has(id));
    if (uncovered.length > 0) fail(event, 'waiver.missing_outcome', `no outcome for ${uncovered.map((c) => `"${c}"`).join(', ')}`);
    if (!isPermutation(priorityAfter, [...state.taverns.keys()])) {
      fail(event, 'waiver.bad_priority', 'priorityAfter must list every tavern exactly once');
    }

    const computed = computeWaivers(state, config);
    computed.outcomes.forEach((expected, i) => {
      const recorded = outcomes[i]!;
      if (recorded.claim !== expected.claim || recorded.awarded !== expected.awarded || recorded.reason !== expected.reason) {
        fail(
          event,
          'waiver.outcome_mismatch',
          `outcome ${i + 1} records ${describeOutcome(recorded)}, but resolveWaivers decides ${describeOutcome(expected)} at that place`,
        );
      }
    });
    if (!priorityAfter.every((t, i) => t === computed.priority[i])) {
      fail(event, 'waiver.outcome_mismatch', `priorityAfter [${priorityAfter.join(', ')}] should be [${computed.priority.join(', ')}]`);
    }

    let next: Pick<LeagueState, 'owner' | 'taverns'> = state;
    for (const outcome of computed.outcomes) {
      if (!outcome.awarded) continue;
      const claim = pending.get(outcome.claim)!;
      if (claim.drop !== null) next = release(next, claim.tavern, claim.drop);
      next = acquire(next, claim.tavern, claim.add);
    }
    return {
      ...state,
      owner: next.owner,
      taverns: next.taverns,
      waivers: { pending: [], priority: computed.priority, resolvedWeeks: setAdd(state.waivers.resolvedWeeks, week) },
    };
  },

  'trade.proposed': (state, event) => {
    const config = configOf(state);
    const terms = event.payload;
    if (!state.draft.complete) fail(event, 'trade.draft_incomplete', 'trades open after the draft');
    if (state.trades.has(terms.trade)) fail(event, 'trade.duplicate_id', `trade "${terms.trade}" already exists`);
    tavernOr(state, event, terms.from, 'trade.unknown_tavern');
    tavernOr(state, event, terms.to, 'trade.unknown_tavern');
    tradeLegalOr(state, config, event, terms);
    return { ...state, trades: mapSet(state.trades, terms.trade, { terms, status: 'proposed' }) };
  },

  'trade.accepted': (state, event) => {
    const trade = tradeOr(state, event, event.payload.trade);
    if (trade.status !== 'proposed') fail(event, 'trade.not_proposed', `trade "${trade.terms.trade}" is ${trade.status}, not proposed`);
    deadlineOr(state, configOf(state), event);
    return withTradeStatus(state, trade, 'accepted');
  },

  'trade.vetoed': (state, event) => {
    const trade = tradeOr(state, event, event.payload.trade);
    if (trade.status !== 'accepted') fail(event, 'trade.not_accepted', `trade "${trade.terms.trade}" is ${trade.status}, not accepted`);
    return withTradeStatus(state, trade, 'vetoed');
  },

  'trade.completed': (state, event) => {
    const config = configOf(state);
    const trade = tradeOr(state, event, event.payload.trade);
    if (trade.status !== 'accepted') fail(event, 'trade.not_accepted', `trade "${trade.terms.trade}" is ${trade.status}, not accepted`);
    // Still legal now? If not, the Action emits `trade.cancelled` (reason `invalid`) instead.
    tradeLegalOr(state, config, event, trade.terms);
    const { from, to, give, receive } = trade.terms;
    let next: Pick<LeagueState, 'owner' | 'taverns'> = state;
    for (const c of give) next = acquire(release(next, from, c), to, c);
    for (const c of receive) next = acquire(release(next, to, c), from, c);
    return { ...withTradeStatus(state, trade, 'completed'), owner: next.owner, taverns: next.taverns };
  },

  'trade.cancelled': (state, event) => {
    const trade = tradeOr(state, event, event.payload.trade);
    if (trade.status !== 'proposed' && trade.status !== 'accepted') {
      fail(event, 'trade.not_open', `trade "${trade.terms.trade}" is already ${trade.status}`);
    }
    return withTradeStatus(state, trade, 'cancelled');
  },

  'mission.revealed': (state, event) => {
    const config = configOf(state);
    const { week, mission, sha256 } = event.payload;
    weekOr(config, event, week, 'reveal.bad_week');
    if (!state.lockedLineups.has(week)) fail(event, 'reveal.week_not_locked', `week ${week} must be locked before its mission is revealed`);
    if (state.revealed.has(week)) fail(event, 'reveal.already_revealed', `week ${week}'s mission is already revealed`);
    if (mission.season !== config.id) fail(event, 'reveal.wrong_season', `mission "${mission.id}" is for season "${mission.season}"`);
    const entry = state.schedule.find((s) => s.week === week);
    if (entry?.commitment != null && entry.commitment !== sha256) {
      fail(event, 'reveal.commitment_mismatch', `sha256 ${sha256} does not match week ${week}'s commitment ${entry.commitment}`);
    }
    const { battleModel: _battleModel, ...rules } = config.missions;
    // No snapshot here: every creature counts as known with CR 0, so only snapshot-free rules apply.
    const issues = validateMission(
      mission,
      { ...rules, partyCr: config.budget.partyCr },
      () => 0 as CrEighths,
      entry === undefined ? {} : { expectedEnvironment: entry.environment },
    );
    if (issues.length > 0) {
      fail(event, 'reveal.invalid_mission', `mission "${mission.id}": ${issues.map((i) => `${i.code}: ${i.message}`).join('; ')}`);
    }
    return { ...state, revealed: mapSet(state.revealed, week, mission) };
  },

  'mission.resolved': (state, event) => {
    const config = configOf(state);
    const result = event.payload;
    const { week, tavern, run } = result;
    weekOr(config, event, week, 'resolve.bad_week');
    const locked = state.lockedLineups.get(week);
    if (locked === undefined) fail(event, 'resolve.week_not_locked', `week ${week} is not locked`);
    const mission = state.revealed.get(week);
    if (mission === undefined) fail(event, 'resolve.not_revealed', `week ${week}'s mission is not revealed`);
    if (result.mission !== mission.id) fail(event, 'resolve.wrong_mission', `week ${week} runs "${mission.id}", not "${result.mission}"`);
    if (state.finalizedWeeks.has(week)) fail(event, 'resolve.week_finalized', `week ${week} is already finalized`);
    tavernOr(state, event, tavern, 'resolve.unknown_tavern');
    if (state.results.get(week)?.has(tavern)) fail(event, 'resolve.duplicate', `"${tavern}" already has a week ${week} result`);
    const entry = locked.find((l) => l.tavern === tavern);
    if (entry?.lineup == null) fail(event, 'resolve.no_lineup', `"${tavern}" has no locked lineup for week ${week}`);
    if (!sameLineup(entry.lineup, result.lineup)) fail(event, 'resolve.lineup_mismatch', `lineup differs from "${tavern}"'s locked week ${week} lineup`);

    const checks = run.nodes.filter((n) => n.kind === 'check');
    const passed = checks.filter((n) => n.outcome === 'pass').length;
    if (passed !== run.checksPassed || checks.length !== run.checksAttempted) {
      fail(
        event,
        'resolve.counts_mismatch',
        `nodes record ${passed}/${checks.length} checks, run says ${run.checksPassed}/${run.checksAttempted}`,
      );
    }
    const loot = lootOf(mission, run.nodes);
    if (loot !== run.loot) fail(event, 'resolve.score_mismatch', `nodes bank ${loot} loot, run says ${run.loot}`);
    const expected = lootScore(loot, missionHaul(mission));
    if (Math.abs(run.score - expected) > 1e-9) fail(event, 'resolve.score_mismatch', `score ${run.score} should be ${expected}`);
    const { injury } = run;
    if (injury !== null && !run.dnf) fail(event, 'resolve.bad_injury', `"${injury.character}" is injured, but the run is not a DNF`);
    if (injury !== null && !result.lineup.starters.includes(injury.character)) {
      fail(event, 'resolve.bad_injury', `"${injury.character}" is injured, but did not start`);
    }
    const byTavern = state.results.get(week) ?? new Map<string, typeof result>();
    return {
      ...state,
      results: mapSet(state.results, week, mapSet(byTavern, tavern, result)),
      // The injured starter sits out next week; an injury in the last week expires with the season.
      injuries: injury === null || week >= config.weeks ? state.injuries : mapSet(state.injuries, injury.character, week + 1),
    };
  },

  'week.finalized': (state, event) => {
    const config = configOf(state);
    const { week } = event.payload;
    weekOr(config, event, week, 'finalize.bad_week');
    if (state.finalizedWeeks.has(week)) fail(event, 'finalize.already_finalized', `week ${week} is already finalized`);
    const locked = state.lockedLineups.get(week);
    if (locked === undefined) fail(event, 'finalize.week_not_locked', `week ${week} is not locked`);
    const results = state.results.get(week);
    const missing = locked.filter((l) => l.lineup !== null && !results?.has(l.tavern)).map((l) => l.tavern);
    if (missing.length > 0) fail(event, 'finalize.missing_result', `no mission.resolved for ${missing.map((m) => `"${m}"`).join(', ')}`);
    return {
      ...state,
      finalizedWeeks: setAdd(state.finalizedWeeks, week),
      phase: week === config.weeks ? 'complete' : state.phase,
    };
  },
};

// ── helpers ────────────────────────────────────────────────────────────────

function fail(event: LeagueEvent, code: string, message: string): never {
  throw new InvalidEventError(event.seq, code, `${event.type} rejected [${code}]: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function ownedOr(state: LeagueState, event: LeagueEvent, character: string, code: string): void {
  const owner = state.owner.get(character);
  if (owner !== undefined) fail(event, code, `"${character}" already belongs to "${owner}"`);
}

function weekOr(config: SeasonConfig, event: LeagueEvent, week: number, code: string): void {
  if (!Number.isInteger(week) || week < 1 || week > config.weeks) fail(event, code, `week ${week} is not in 1..${config.weeks}`);
}

function tradeOr(state: LeagueState, event: LeagueEvent, id: string): TradeState {
  const trade = state.trades.get(id);
  if (trade === undefined) fail(event, 'trade.unknown', `no trade "${id}"`);
  return trade;
}

/**
 * The first week whose lineups a roster change now would affect: the next
 * week to lock. Weeks lock in order (`lock.previous_not_finalized`), so the
 * locked weeks are exactly 1..n.
 */
function nextLineupWeek(state: LeagueState): number {
  return state.lockedLineups.size + 1;
}

/** No trade is accepted once the next lineup week is past `deadlineWeek`, i.e. once week `deadlineWeek` has locked. */
function deadlineOr(state: LeagueState, config: SeasonConfig, event: LeagueEvent): void {
  const deadline = config.trades.deadlineWeek;
  if (deadline !== null && nextLineupWeek(state) > deadline) {
    fail(event, 'trade.past_deadline', `the trade deadline passed when week ${deadline} locked`);
  }
}

/** `validateTrade` violation code → `InvalidEventError` code. See the table in the header. */
const TRADE_CODES: Readonly<Record<string, string>> = {
  same_tavern: 'trade.self',
  empty_side: 'trade.empty',
  duplicate: 'trade.duplicate_piece',
  give_not_owned: 'trade.not_owned',
  receive_not_owned: 'trade.not_owned',
  roster_size: 'trade.roster_size',
  past_deadline: 'trade.past_deadline',
};

/**
 * `validateTrade` against the current rosters, for the next lineup week. The
 * code is the first violation's (in `validateTrade`'s order), and the message
 * lists every violation.
 */
function tradeLegalOr(state: LeagueState, config: SeasonConfig, event: LeagueEvent, terms: TradeState['terms']): void {
  const rosters = [...state.taverns.values()].map(rosterView);
  const violations = validateTrade(terms, rosters, config, { week: nextLineupWeek(state) });
  const first = violations[0];
  if (first !== undefined) {
    fail(event, TRADE_CODES[first.code] ?? `trade.${first.code}`, `trade "${terms.trade}": ${violations.map((v) => v.message).join('; ')}`);
  }
}

type WaiverOutcome = PayloadByType['waiver.resolved']['outcomes'][number];

/**
 * `resolveWaivers` over the pending claims, as `waiver.resolved` outcomes in
 * decision order. Pending claims are in log order, so their index ranks them
 * exactly as their event seqs would.
 */
function computeWaivers(state: LeagueState, config: SeasonConfig): { readonly outcomes: ReadonlyArray<WaiverOutcome>; readonly priority: ReadonlyArray<string> } {
  const ids = new Map<WaiverClaim, string>();
  const claims = state.waivers.pending.map((c, seq): WaiverClaim => {
    const claim = { tavern: c.tavern, add: c.add, drop: c.drop, seq };
    ids.set(claim, c.claim);
    return claim;
  });
  const rosters = [...state.taverns.values()].map(rosterView);
  const result = resolveWaivers(claims, waiverPriority(state), rosters, new Set(freeAgents(state)), config);
  return {
    outcomes: result.awards.map((a) => ({ claim: ids.get(a.claim)!, awarded: a.awarded, reason: a.reason })),
    priority: result.priority,
  };
}

function describeOutcome(o: WaiverOutcome): string {
  return `"${o.claim}" ${o.awarded ? 'awarded' : 'not awarded'} (${o.reason})`;
}

function withTradeStatus(state: LeagueState, trade: TradeState, status: TradeState['status']): LeagueState {
  return { ...state, trades: mapSet(state.trades, trade.terms.trade, { ...trade, status }) };
}

function rosterView(t: TavernState): RosterView {
  return { tavern: t.id, characters: t.roster };
}

/** CR lookup over the pool, in eighths. Throws for an unpooled id, which `validateLineup` reports as unknown. */
function crOf(state: Pick<LeagueState, 'pool'>): (characterId: string) => CrEighths {
  return (id) => {
    const entry = state.pool.get(id);
    if (entry === undefined) throw new Error(`"${id}" is not pooled`);
    return entry.cr;
  };
}

function sameLineup(a: Lineup, b: Lineup): boolean {
  return a.starters.length === b.starters.length && a.starters.every((id, i) => id === b.starters[i]) && sameRetreat(a.retreat, b.retreat);
}

function sameRetreat(a: Lineup['retreat'], b: Lineup['retreat']): boolean {
  return typeof a === 'string' || typeof b === 'string' ? a === b : a.bank === b.bank;
}

function isPermutation(list: ReadonlyArray<string>, of: ReadonlyArray<string>): boolean {
  return list.length === of.length && new Set(list).size === list.length && of.every((x) => list.includes(x));
}

/** `tavern` gains `character`: owner set, appended to the roster. */
function acquire(state: Pick<LeagueState, 'owner' | 'taverns'>, tavern: string, character: string): Pick<LeagueState, 'owner' | 'taverns'> {
  const t = state.taverns.get(tavern)!;
  return {
    owner: mapSet(state.owner, character, tavern),
    taverns: mapSet(state.taverns, tavern, { ...t, roster: [...t.roster, character] }),
  };
}

/** `tavern` loses `character`: owner cleared, removed from the roster. */
function release(state: Pick<LeagueState, 'owner' | 'taverns'>, tavern: string, character: string): Pick<LeagueState, 'owner' | 'taverns'> {
  const t = state.taverns.get(tavern)!;
  return {
    owner: mapDelete(state.owner, character),
    taverns: mapSet(state.taverns, tavern, { ...t, roster: t.roster.filter((c) => c !== character) }),
  };
}

/** Loot banked by the passed checks and won battles among `records`: each one's node `loot` in `mission` (D-45, D-50). */
function lootOf(mission: Mission, records: ReadonlyArray<{ readonly node: string; readonly outcome: string }>): number {
  let loot = 0;
  for (const record of records) {
    if (record.outcome !== 'pass' && record.outcome !== 'win') continue;
    const node = mission.nodes.find((n) => n.id === record.node);
    if (node?.kind === 'check' && record.outcome === 'pass') loot += node.loot;
    if (node?.kind === 'battle' && record.outcome === 'win') loot += node.loot ?? 0;
  }
  return loot;
}

function mapSet<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

function mapDelete<K, V>(map: ReadonlyMap<K, V>, key: K): ReadonlyMap<K, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function setAdd<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  next.add(value);
  return next;
}
