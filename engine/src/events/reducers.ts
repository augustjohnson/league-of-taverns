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
 * | `season.created` | `season.not_created` (any other event first), `season.already_created`, `season.id_mismatch`, `season.bad_schedule` |
 * | `character.pooled` | `pool.wrong_phase`, `pool.duplicate`, `pool.registry_version`, `pool.over_budget`, `pool.invalid_modifiers` |
 * | `tavern.joined` | `tavern.wrong_phase`, `tavern.duplicate`, `tavern.manager_taken` |
 * | `character.retained` | `retain.wrong_phase`, `retain.unknown_tavern`, `retain.not_pooled`, `retain.already_owned`, `retain.over_limit`, `retain.roster_full` |
 * | `draft.pick` | `draft.complete`, `draft.no_taverns`, `draft.bad_order`, `draft.wrong_pick`, `draft.not_on_clock`, `draft.not_pooled`, `draft.already_owned`, `draft.roster_full` |
 * | `lineup.set` | `lineup.draft_incomplete`, `lineup.unknown_tavern`, `lineup.bad_week`, `lineup.week_locked`, and `lineup.<code>` for the first `validateLineup` violation (`wrong_size`, `duplicate`, `not_owned`, `unknown_character`, `over_budget`) |
 * | `lineup.locked` | `lock.draft_incomplete`, `lock.bad_week`, `lock.already_locked`, `lock.previous_not_finalized`, `lock.unknown_tavern`, `lock.duplicate_tavern`, `lock.missing_tavern`, `lock.source_mismatch`, `lock.illegal_lineup` |
 * | `waiver.claimed` | `waiver.draft_incomplete`, `waiver.unknown_tavern`, `waiver.duplicate_claim`, `waiver.not_pooled`, `waiver.not_free_agent`, `waiver.drop_not_owned` |
 * | `waiver.resolved` | `waiver.bad_week`, `waiver.week_not_finalized`, `waiver.already_resolved`, `waiver.unknown_claim`, `waiver.duplicate_outcome`, `waiver.missing_outcome`, `waiver.bad_priority`, `waiver.add_not_free`, `waiver.drop_not_owned`, `waiver.roster_full` |
 * | `trade.*` | `trade.draft_incomplete`, `trade.duplicate_id`, `trade.unknown_tavern`, `trade.self`, `trade.empty`, `trade.duplicate_piece`, `trade.past_deadline`, `trade.not_owned`, `trade.roster_size`, `trade.unknown`, `trade.not_proposed`, `trade.not_accepted`, `trade.not_open` |
 * | `mission.revealed` | `reveal.bad_week`, `reveal.week_not_locked`, `reveal.already_revealed`, `reveal.wrong_season`, `reveal.commitment_mismatch`, `reveal.invalid_mission` |
 * | `mission.resolved` | `resolve.bad_week`, `resolve.week_not_locked`, `resolve.not_revealed`, `resolve.wrong_mission`, `resolve.week_finalized`, `resolve.unknown_tavern`, `resolve.duplicate`, `resolve.no_lineup`, `resolve.lineup_mismatch`, `resolve.counts_mismatch`, `resolve.score_mismatch` |
 * | `week.finalized` | `finalize.bad_week`, `finalize.already_finalized`, `finalize.week_not_locked`, `finalize.missing_result` |
 *
 * ## Interpretations
 *
 * - Ownership is modelled as exclusive (D-01): one owner per character.
 * - `tavern.joined`: "manager not already in a tavern" compares GitHub ids
 *   (D-35). Bot managers are exempt, since sims seat many taverns with the
 *   same strategy.
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
 * - Trades: the deadline is "week `deadlineWeek` is locked", enforced at
 *   proposal, acceptance and completion (rules §10). Roster sizes are
 *   checked against `≤ roster.size` at proposal and completion. The veto
 *   window can't be timed without a clock (D-41), so "within the window"
 *   means the trade is still `accepted`, and `trade.completed` itself marks
 *   the window's end.
 * - `waiver.resolved` and `trade.completed` apply their recorded outcome
 *   (D-20) and check only basic legality. Waiver awards apply in outcome
 *   order. TODO(T4.5): also check the outcomes against `resolveWaivers` and
 *   the trade against `validateTrade` once W4 lands them.
 * - `waiver.resolved` runs once per week (`waiver.already_resolved`).
 * - `mission.revealed`: `sha256` must equal the schedule commitment only when
 *   one was made (D-08 made missions open, so commitments are null). The
 *   mission is validated against the season's mission rules and the
 *   schedule's environment. The reducer has no creature snapshot, so the
 *   snapshot-dependent checks (`encounter.ref`, `encounter.budget`) are the
 *   reveal script's.
 * - `mission.resolved`: the counts are recomputed from the recorded nodes,
 *   and the score must equal `runScore` of them (0 on a DNF), to within
 *   1e-9. Everything else (path, d20s, points) is audited by
 *   `verifyResolutions`, which reports instead of throwing.
 * - `week.finalized` needs a result for every tavern whose locked lineup is
 *   non-null. A tavern locked with no lineup needs none and scores 0 (rules
 *   §5; see `weekResults`). Finalizing week `config.weeks` completes the season.
 */
import { REGISTRY_VERSION, TRAITS, validateModifiers } from '../characters';
import type { SeasonConfig } from '../league';
import { validateMission } from '../missions';
import { runScore } from '../resolution';
import { draftOrderSeed, rngFor } from '../rng';
import { draftOrder, snakePickOwner, validateLineup, type Lineup, type RosterView } from '../roster';
import type { CrEighths } from '../vocabulary';
import type { LeagueState, TavernState, TradeState } from './state';
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
    schedule: [],
    pool: new Map(),
    taverns: new Map(),
    owner: new Map(),
    draft: { order: [], picks: 0, complete: false },
    retained: [],
    pendingLineups: new Map(),
    lockedLineups: new Map(),
    waivers: { pending: [], priority: [], resolvedWeeks: new Set() },
    trades: new Map(),
    revealed: new Map(),
    results: new Map(),
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
    const { config, schedule } = event.payload;
    if (event.season !== config.id) {
      fail(event, 'season.id_mismatch', `envelope season "${event.season}" differs from config.id "${config.id}"`);
    }
    const weeks = new Set<number>();
    for (const entry of schedule) {
      if (entry.week > config.weeks) fail(event, 'season.bad_schedule', `schedule week ${entry.week} is past the season's ${config.weeks} weeks`);
      if (weeks.has(entry.week)) fail(event, 'season.bad_schedule', `schedule lists week ${entry.week} twice`);
      weeks.add(entry.week);
    }
    return { ...state, phase: 'preseason', config, schedule };
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

  'tavern.joined': (state, event) => {
    const { tavern, name, manager } = event.payload;
    if (state.phase !== 'preseason') fail(event, 'tavern.wrong_phase', `taverns join in preseason, not ${state.phase} (no joining after the first pick)`);
    if (state.taverns.has(tavern)) fail(event, 'tavern.duplicate', `tavern "${tavern}" has already joined`);
    if ('githubId' in manager) {
      for (const other of state.taverns.values()) {
        if ('githubId' in other.manager && other.manager.githubId === manager.githubId) {
          fail(event, 'tavern.manager_taken', `manager ${manager.login} (${manager.githubId}) already runs "${other.id}"`);
        }
      }
    }
    return { ...state, taverns: mapSet(state.taverns, tavern, { id: tavern, name, manager, roster: [] }) };
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
      // The first pick freezes the tavern list (join order) and the snake order.
      const joined = [...state.taverns.keys()];
      if (joined.length === 0) fail(event, 'draft.no_taverns', 'no taverns have joined');
      try {
        order = draftOrder(joined, config, rngFor(draftOrderSeed(config.id), 'order'));
      } catch (error) {
        fail(event, 'draft.bad_order', errorMessage(error));
      }
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
      draft: { order, picks, complete },
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
    const violations = validateLineup(lineup, rosterView(t), crOf(state), config);
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
    for (const entry of lineups) {
      const t = tavernOr(state, event, entry.tavern, 'lock.unknown_tavern');
      if (seen.has(entry.tavern)) fail(event, 'lock.duplicate_tavern', `"${entry.tavern}" is listed twice`);
      seen.add(entry.tavern);
      if ((entry.lineup === null) !== (entry.source === 'none')) {
        fail(event, 'lock.source_mismatch', `"${entry.tavern}": source "${entry.source}" with ${entry.lineup === null ? 'no' : 'a'} lineup`);
      }
      if (entry.lineup !== null) {
        const violations = validateLineup(entry.lineup, rosterView(t), crOf(state), config);
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

    // TODO(T4.5): check `outcomes` and `priorityAfter` against `resolveWaivers`.
    let next: Pick<LeagueState, 'owner' | 'taverns'> = state;
    for (const outcome of outcomes) {
      if (!outcome.awarded) continue;
      const claim = pending.get(outcome.claim)!;
      const t = next.taverns.get(claim.tavern)!;
      if (next.owner.has(claim.add)) fail(event, 'waiver.add_not_free', `claim "${claim.claim}": "${claim.add}" is no longer a free agent`);
      if (claim.drop !== null && !t.roster.includes(claim.drop)) {
        fail(event, 'waiver.drop_not_owned', `claim "${claim.claim}": "${claim.drop}" is no longer on "${claim.tavern}"'s roster`);
      }
      const size = t.roster.length + 1 - (claim.drop === null ? 0 : 1);
      if (size > config.roster.size) fail(event, 'waiver.roster_full', `claim "${claim.claim}": "${claim.tavern}" would hold ${size} > ${config.roster.size}`);
      if (claim.drop !== null) next = release(next, claim.tavern, claim.drop);
      next = acquire(next, claim.tavern, claim.add);
    }
    return {
      ...state,
      owner: next.owner,
      taverns: next.taverns,
      waivers: { pending: [], priority: priorityAfter, resolvedWeeks: setAdd(state.waivers.resolvedWeeks, week) },
    };
  },

  'trade.proposed': (state, event) => {
    const config = configOf(state);
    const terms = event.payload;
    if (!state.draft.complete) fail(event, 'trade.draft_incomplete', 'trades open after the draft');
    if (state.trades.has(terms.trade)) fail(event, 'trade.duplicate_id', `trade "${terms.trade}" already exists`);
    tavernOr(state, event, terms.from, 'trade.unknown_tavern');
    tavernOr(state, event, terms.to, 'trade.unknown_tavern');
    if (terms.from === terms.to) fail(event, 'trade.self', 'a tavern cannot trade with itself');
    if (terms.give.length + terms.receive.length === 0) fail(event, 'trade.empty', 'a trade must move at least one character');
    const pieces = [...terms.give, ...terms.receive];
    if (new Set(pieces).size !== pieces.length) fail(event, 'trade.duplicate_piece', 'a character is listed twice');
    deadlineOr(state, config, event);
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
    deadlineOr(state, config, event);
    // TODO(T4.5): re-check with `validateTrade` once W4 lands it.
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
    const expected = run.dnf ? 0 : runScore(passed, checks.length);
    if (Math.abs(run.score - expected) > 1e-9) fail(event, 'resolve.score_mismatch', `score ${run.score} should be ${expected}`);
    const byTavern = state.results.get(week) ?? new Map<string, typeof result>();
    return { ...state, results: mapSet(state.results, week, mapSet(byTavern, tavern, result)) };
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

/** No trade is proposed, accepted or completed once week `deadlineWeek` has locked. */
function deadlineOr(state: LeagueState, config: SeasonConfig, event: LeagueEvent): void {
  const deadline = config.trades.deadlineWeek;
  if (deadline !== null && state.lockedLineups.has(deadline)) {
    fail(event, 'trade.past_deadline', `the trade deadline passed when week ${deadline} locked`);
  }
}

/** Both sides still own their pieces, and both rosters stay within `roster.size` afterwards. */
function tradeLegalOr(state: LeagueState, config: SeasonConfig, event: LeagueEvent, terms: TradeState['terms']): void {
  for (const [tavern, pieces] of [
    [terms.from, terms.give],
    [terms.to, terms.receive],
  ] as const) {
    for (const c of pieces) {
      if (state.owner.get(c) !== tavern) fail(event, 'trade.not_owned', `"${c}" is not on "${tavern}"'s roster`);
    }
  }
  const delta = terms.receive.length - terms.give.length;
  for (const [tavern, change] of [
    [terms.from, delta],
    [terms.to, -delta],
  ] as const) {
    const size = state.taverns.get(tavern)!.roster.length + change;
    if (size > config.roster.size) fail(event, 'trade.roster_size', `"${tavern}" would hold ${size} > ${config.roster.size}`);
  }
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
  return a.captain === b.captain && a.allies.length === b.allies.length && a.allies.every((ally, i) => ally === b.allies[i]);
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
