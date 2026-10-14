import { describe, expect, it } from 'vitest';
import { InvalidEventError, applyEvent, initialState } from '../src/events/reducers';
import { lineHash, replay, replayLog } from '../src/events/replay';
import { freeAgents, hexOn, homeTavern, onTheClock, seasonStandings, tavernPickOnTheClock, weekResults } from '../src/events/selectors';
import type { LeagueState } from '../src/events/state';
import type { LeagueEvent, PayloadByType } from '../src/events/types';
import { standings, type SeasonConfig } from '../src/league';
import { draftOrderSeed, rngFor } from '../src/rng';
import { draftOrder, snakePickOwner, type Lineup } from '../src/roster';
import type { CrEighths } from '../src/vocabulary';
import {
  COMMISSIONER,
  LogBuilder,
  MANAGER,
  MANAGERS,
  POOL,
  SEASON,
  TAVERNS,
  candidate,
  miniConfig,
  miniSeason,
  missionFor,
  resolution,
  schedule,
  sponsors,
  tavernList,
  waiverResolution,
} from './support/league-log';

const season = miniSeason();
const { at, log } = season;
const config = miniConfig();
const [A, B, C, D] = TAVERNS;
const expectedManagerOrder = draftOrder([...MANAGERS], config, rngFor(draftOrderSeed(SEASON), 'order'));
/** The snake order: each manager's tavern (manager-i chose TAVERNS[i]), in draft order. */
const expectedOrder = expectedManagerOrder.map((m) => TAVERNS[MANAGERS.indexOf(m as (typeof MANAGERS)[number])]!);
/** Taverns in the order they were chosen: the reverse of the draft order (D-52). */
const chosenOrder = [...expectedOrder].reverse();

function lockedLineup(state: LeagueState, week: number, tavern: string): Lineup {
  return state.lockedLineups.get(week)!.find((l) => l.tavern === tavern)!.lineup!;
}

function roster(state: LeagueState, tavern: string): ReadonlyArray<string> {
  return state.taverns.get(tavern)!.roster;
}

/** `state` with a patched config, for preconditions that are awkward to reach by a real log. */
function withConfig(state: LeagueState, patch: Partial<SeasonConfig>): LeagueState {
  return { ...state, config: { ...state.config!, ...patch } };
}

function rejection(state: LeagueState, event: LeagueEvent): InvalidEventError {
  try {
    applyEvent(state, event);
  } catch (error) {
    if (error instanceof InvalidEventError) return error;
    throw error;
  }
  throw new Error(`expected ${event.type} to be rejected`);
}

function created(patch: Partial<SeasonConfig>): LeagueState {
  const cfg = miniConfig(patch);
  return applyEvent(initialState(), candidate(initialState(), 'season.created', { config: cfg, configSha256: lineHash('c'), engineVersion: '0', schedule: schedule().filter((w) => w.week <= cfg.weeks), sponsors: sponsors(), taverns: tavernList() }, COMMISSIONER));
}

/** The manager id that `joined` seats for `tavern`. */
const managerFor = (tavern: string): string => `m-${tavern}`;

function joined(state: LeagueState, taverns: ReadonlyArray<string>, pool = POOL.slice(0, 8)): LeagueState {
  let s = state;
  for (const { id, cr } of pool) s = applyEvent(s, candidate(s, 'character.pooled', { character: id, base: 'ogre', cr, modifiers: [] }, COMMISSIONER));
  for (const [i, tavern] of taverns.entries()) {
    s = applyEvent(s, candidate(s, 'manager.joined', { manager: managerFor(tavern), account: { githubId: 500 + i, login: `m${i}` } }, COMMISSIONER));
  }
  // The tavern pick: whoever is on the clock takes the tavern named after them.
  for (let m = tavernPickOnTheClock(s); m !== null; m = tavernPickOnTheClock(s)) {
    s = applyEvent(s, candidate(s, 'tavern.chosen', { manager: m, tavern: m.slice(2) }, MANAGER));
  }
  return s;
}

describe('mini-season replay', () => {
  it('advances through every phase', () => {
    expect(initialState().phase).toBe('empty');
    expect(at.created.phase).toBe('preseason');
    expect(at.preseason.phase).toBe('preseason');
    expect(at.drafting.phase).toBe('drafting');
    expect(at.drafted.phase).toBe('regular');
    expect(at.w1Finalized.phase).toBe('regular');
    expect(at.final.phase).toBe('complete');
    expect(at.final.lastSeq).toBe(log.events.length);
  });

  it('pools characters, seats managers in join order, and taverns in the order chosen', () => {
    expect([...at.preseason.pool.keys()]).toEqual(POOL.map((p) => p.id));
    expect([...at.preseason.managers.keys()]).toEqual(MANAGERS);
    expect([...at.preseason.taverns.keys()]).toEqual(chosenOrder);
    expect(at.joined.taverns.size).toBe(0);
    expect(roster(at.preseason, A)).toEqual([]);
    expect(at.preseason.schedule).toEqual(schedule());
  });

  it('freezes the seeded order at the first pick and runs the full snake draft', () => {
    expect(at.preseason.draft.order).toEqual([]);
    expect(at.drafting.draft.order).toEqual(expectedOrder);
    expect(at.drafted.draft).toEqual({ managerOrder: expectedManagerOrder, order: expectedOrder, picks: 20, complete: true });
    const picks = log.events.filter((e) => e.type === 'draft.pick');
    expect(picks).toHaveLength(config.draft.rounds * TAVERNS.length);
    for (const pick of picks) expect(pick.payload.tavern).toBe(snakePickOwner(expectedOrder, pick.payload.pick));
    for (const tavern of TAVERNS) {
      const mine = picks.filter((p) => p.payload.tavern === tavern).map((p) => p.payload.character);
      expect(roster(at.drafted, tavern)).toEqual(mine);
      for (const c of mine) expect(at.drafted.owner.get(c)).toBe(tavern);
    }
    expect(at.drafted.waivers.priority).toEqual([...expectedOrder].reverse());
  });

  it('selectors: free agents and the clock', () => {
    expect(freeAgents(at.preseason)).toHaveLength(24);
    expect(freeAgents(at.drafted)).toEqual(['char-21', 'char-22', 'char-23', 'char-24']);
    expect(onTheClock(initialState())).toBeNull();
    expect(onTheClock(at.created)).toBeNull();
    expect(onTheClock(at.preseason)).toBe(expectedOrder[0]);
    expect(onTheClock(at.drafting)).toBe(snakePickOwner(expectedOrder, 1));
    expect(onTheClock(at.drafted)).toBeNull();
  });

  it('locks lineups and clears pending ones', () => {
    expect(at.w1Pending.pendingLineups.get(1)?.size).toBe(4);
    expect(at.w1Locked.pendingLineups.has(1)).toBe(false);
    expect(at.w1Locked.lockedLineups.get(1)).toHaveLength(4);
    expect(at.w1Revealed.revealed.get(1)).toEqual(missionFor(1));
    expect(at.w1Resolved.results.get(1)?.size).toBe(4);
    expect(at.w1Finalized.finalizedWeeks).toEqual(new Set([1]));
  });

  it('replaces an earlier lineup.set for the same week', () => {
    const [first, second] = [roster(at.drafted, A), roster(at.drafted, A)].map((r, i) => ({
      starters: [r[i]!, r[(i + 1) % 5]!, r[(i + 2) % 5]!, r[(i + 3) % 5]!] as const,
      retreat: 'never' as const,
    }));
    let s = at.drafted;
    for (const lineup of [first!, second!]) {
      s = withConfig(s, { budget: { partyCr: 1000 as CrEighths, modifierPointsPerCharacter: 3 } });
      s = applyEvent(s, candidate(s, 'lineup.set', { tavern: A, week: 1, lineup }, MANAGER));
    }
    expect(s.pendingLineups.get(1)?.get(A)).toEqual(second);
  });

  it('applies waiver outcomes from resolveWaivers and rolls priority', () => {
    expect(at.claimsPending.waivers.pending.map((c) => c.claim)).toEqual(['claim-1', 'claim-2']);
    const recorded = log.events.find((e) => e.type === 'waiver.resolved')!.payload;
    expect(recorded).toEqual({
      week: 1,
      outcomes: [
        { claim: 'claim-1', awarded: true, reason: 'awarded' },
        { claim: 'claim-2', awarded: false, reason: 'add_unavailable' },
      ],
      priorityAfter: [...at.claimsPending.waivers.priority.filter((t) => t !== A), A],
    });
    expect(roster(at.waiversResolved, A)).toEqual([...roster(at.w1Finalized, A), season.claimed]);
    expect(roster(at.waiversResolved, C)).toEqual(roster(at.w1Finalized, C));
    expect(at.waiversResolved.owner.get(season.claimed)).toBe(A);
    expect(at.waiversResolved.waivers.pending).toEqual([]);
    expect(at.waiversResolved.waivers.priority.at(-1)).toBe(A);
    expect(at.waiversResolved.waivers.resolvedWeeks).toEqual(new Set([1]));
  });

  it('swaps ownership on trade.completed and tracks every trade status', () => {
    const { give, receive } = season.traded;
    expect(at.tradeAccepted.trades.get('trade-1')?.status).toBe('accepted');
    expect(at.tradeCompleted.owner.get(give)).toBe(B);
    expect(at.tradeCompleted.owner.get(receive)).toBe(A);
    expect(roster(at.tradeCompleted, A)).toContain(receive);
    expect(roster(at.tradeCompleted, A)).not.toContain(give);
    expect(roster(at.tradeCompleted, B).at(-1)).toBe(give);
    expect(roster(at.tradeCompleted, A)).toHaveLength(6);
    expect(roster(at.tradeCompleted, B)).toHaveLength(5);
    expect([...at.final.trades.values()].map((t) => [t.terms.trade, t.status])).toEqual([
      ['trade-1', 'completed'],
      ['trade-2', 'cancelled'],
      ['trade-3', 'vetoed'],
    ]);
  });

  it('scores a tavern with no lineup 0 without needing a result', () => {
    expect(at.final.results.get(2)?.has(D)).toBe(false);
    expect(at.final.finalizedWeeks).toEqual(new Set([1, 2]));
    const week2 = weekResults(at.final, 2);
    expect(week2.map((r) => r.tavern)).toEqual(chosenOrder);
    expect(week2.find((r) => r.tavern === D)).toEqual({ week: 2, tavern: D, points: 0, projected: 0, checksPassed: 0, dnf: false });
    const recorded = at.final.results.get(2)!.get(A)!;
    expect(week2.find((r) => r.tavern === A)).toEqual({ week: 2, tavern: A, points: recorded.points, projected: recorded.projectedPoints, checksPassed: recorded.run.checksPassed, dnf: recorded.run.dnf });
  });

  it('weekResults is empty until the week is finalized', () => {
    expect(weekResults(at.w1Resolved, 1)).toEqual([]);
    expect(weekResults(at.w1Finalized, 1)).toHaveLength(4);
    expect(weekResults(at.final, 3)).toEqual([]);
  });

  it('homeTavern: each week\'s sponsor\'s tavern, whose points carry the home bonus', () => {
    expect(homeTavern(at.final, 1)).toBe(A);
    expect(homeTavern(at.final, 2)).toBe(B);
    expect(homeTavern(at.final, 3)).toBeNull();
    expect(homeTavern(initialState(), 1)).toBeNull();
    for (const week of [1, 2]) {
      for (const [tavern, r] of at.final.results.get(week)!) {
        const factor = tavern === homeTavern(at.final, week) ? 1.25 : 1;
        expect(r.points).toBe(Math.round(r.run.score * 100 * factor));
        expect(r.projectedPoints).toBeCloseTo(r.projected.expectedScore * 100 * factor, 9);
      }
    }
  });

  it('seasonStandings: total points over finalized weeks', () => {
    const rows = seasonStandings(at.final);
    const results = [...weekResults(at.final, 1), ...weekResults(at.final, 2)];
    expect(rows).toEqual(standings([...TAVERNS], results));
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.points).toBe(results.filter((r) => r.tavern === row.tavern).reduce((n, r) => n + r.points, 0));
    expect(seasonStandings(at.w1Resolved).every((r) => r.points === 0 && r.rank === 1)).toBe(true);
    expect(seasonStandings(initialState())).toEqual([]);
  });

  it('never mutates a prior state: every checkpoint equals a fresh replay of its prefix', () => {
    for (const [name, state] of Object.entries(at)) {
      const fresh = replay(log.events.slice(0, state.lastSeq));
      expect({ ...fresh, lastHash: null }, name).toEqual(state);
    }
  });

  it('replays deterministically, from events or from the NDJSON log', () => {
    const once = replay(log.events);
    expect(replay(log.events)).toEqual(once);
    expect(replayLog(log.ndjson)).toEqual(once);
    expect(once.lastHash).toBe(lineHash(log.lines.at(-1)!));
    expect({ ...once, lastHash: null }).toEqual(at.final);
  });
});

describe('keepers', () => {
  it('places a keeper before the draft and records its forfeited round', () => {
    const payload = { tavern: A, character: 'char-24', fromSeason: 'season-00', basis: 'keeper', costRound: 3 } as const;
    const s = applyEvent(at.preseason, candidate(at.preseason, 'character.retained', payload, COMMISSIONER));
    expect(s.owner.get('char-24')).toBe(A);
    expect(roster(s, A)).toEqual(['char-24']);
    expect(s.retained).toEqual([payload]);
    expect(freeAgents(s)).not.toContain('char-24');
    const champ = applyEvent(s, candidate(s, 'character.retained', { ...payload, character: 'char-23', basis: 'champion_reward' }, COMMISSIONER));
    expect(roster(champ, A)).toEqual(['char-24', 'char-23']);
  });
});

// ── preconditions ────────────────────────────────────────────────────────────

type Case = readonly [name: string, state: LeagueState, event: LeagueEvent, code: string];

const keeper = { tavern: A, character: 'char-24', fromSeason: 'season-00', basis: 'keeper', costRound: null } as const;
const withKeeper = applyEvent(at.preseason, candidate(at.preseason, 'character.retained', keeper, COMMISSIONER));
const nextPick = (state: LeagueState, patch: Partial<PayloadByType['draft.pick']> = {}) =>
  candidate(state, 'draft.pick', { pick: state.draft.picks, tavern: onTheClock(state)!, character: freeAgents(state)[0]!, auto: false, ...patch }, MANAGER);
const notOnClock = TAVERNS.find((t) => t !== onTheClock(at.drafting))!;
/** The tavern pick from `at.joined`: who chooses first and second, and the state after the first choice. */
const pickOrder = [...draftOrder(MANAGERS, config, rngFor(draftOrderSeed(config.id), 'order'))].reverse();
const [firstToChoose, secondToChoose] = [pickOrder[0]!, pickOrder[1]!];
const firstChoice = A;
const afterFirstChoice = applyEvent(at.joined, candidate(at.joined, 'tavern.chosen', { manager: firstToChoose, tavern: firstChoice }, MANAGER));
/** A hexes B's wisdom in week 2 (D-52). */
const hexedOnce = applyEvent(at.drafted, candidate(at.drafted, 'hex.declared', { tavern: A, target: B, ability: 'wis', week: 2 }, MANAGER));
/** Three managers joined into a fresh season. */
const joinedThree = [0, 1, 2].reduce(
  (s, i) => applyEvent(s, candidate(s, 'manager.joined', { manager: `manager-${i}`, account: { githubId: 101 + i, login: `manager-${i}` } }, COMMISSIONER)),
  at.created,
);

// A one-slot-roster league: the second round's first pick finds a full roster.
const tinyDraft = (() => {
  let s = joined(created({ roster: { size: 1, starters: 4, ownership: 'exclusive' }, draft: { ...config.draft, rounds: 2 } }), [A, B]);
  s = applyEvent(s, nextPick(s));
  return applyEvent(s, nextPick(s));
})();

const lineupA = lockedLineup(at.w1Locked, 1, A);
const bRoster = roster(at.drafted, B);
const foreignLineup: Lineup = { starters: [bRoster[0]!, bRoster[1]!, bRoster[2]!, bRoster[3]!], retreat: 'never' };
const entries = (state: LeagueState, week: number) =>
  TAVERNS.map((tavern) => ({ tavern, lineup: state.pendingLineups.get(week)?.get(tavern) ?? null, source: 'submitted' as const }));
const w1Entries = entries(at.w1Pending, 1);

const claim1 = at.claimsPending.waivers.pending[0]!;
const waiverPriority = at.claimsPending.waivers.priority;
const resolved = (outcomes: PayloadByType['waiver.resolved']['outcomes'], priorityAfter = waiverPriority) =>
  ({ week: 1, outcomes, priorityAfter }) as const;
const awarded = (claim: string) => ({ claim, awarded: true, reason: 'test' });
const expectedW1 = waiverResolution(at.claimsPending, 1);
const edited = (patch: Partial<PayloadByType['waiver.resolved']>): PayloadByType['waiver.resolved'] => ({ ...expectedW1, ...patch });

const aRoster = roster(at.waiversResolved, A);
const bRoster2 = roster(at.waiversResolved, B);
const terms = (patch: Partial<PayloadByType['trade.proposed']> = {}): PayloadByType['trade.proposed'] => ({
  trade: 'trade-x',
  from: C,
  to: D,
  give: [roster(at.waiversResolved, C)[1]!],
  receive: [roster(at.waiversResolved, D)[1]!],
  ...patch,
});
const proposedX = applyEvent(at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms(), MANAGER));
// trade-1's `give` moves to C through another trade first, so trade-1 is no longer legal.
const tradeStale = (() => {
  let s = at.tradeAccepted;
  s = applyEvent(s, candidate(s, 'trade.proposed', { trade: 'trade-y', from: A, to: C, give: [season.traded.give], receive: [roster(s, C)[0]!] }, MANAGER));
  s = applyEvent(s, candidate(s, 'trade.accepted', { trade: 'trade-y' }, MANAGER));
  return applyEvent(s, candidate(s, 'trade.completed', { trade: 'trade-y' }));
})();
const openAfterDeadline: LeagueState = { ...at.w2Locked, trades: new Map([...at.w2Locked.trades, ['trade-x', { terms: terms(), status: 'proposed' }]]) };

const reveal = (week: number, patch: Partial<PayloadByType['mission.revealed']> = {}) =>
  ({ week, mission: missionFor(week), sha256: lineHash(`mission-w${week}`), salt: null, ...patch }) as const;
const w2Revealed = applyEvent(at.w2Locked, candidate(at.w2Locked, 'mission.revealed', reveal(2, { sha256: lineHash('mission-w2') })));
const resultA = resolution(at.w1Revealed, 1, A, lineupA);
const withRun = (patch: Partial<PayloadByType['mission.resolved']['run']>) => ({ ...resultA, run: { ...resultA.run, ...patch } });

const cases: ReadonlyArray<Case> = [
  // envelope
  ['seq gap', at.created, { ...candidate(at.created, 'week.finalized', { week: 1 }), seq: at.created.lastSeq + 2 }, 'envelope.seq'],
  ['seq replayed', at.created, { ...candidate(at.created, 'week.finalized', { week: 1 }), seq: at.created.lastSeq }, 'envelope.seq'],
  ['wrong season', at.created, { ...candidate(at.created, 'manager.joined', { manager: 'new-manager', account: { bot: 'v' } }), season: 'season-02' }, 'envelope.season'],

  // season.created
  ['event before season.created', initialState(), candidate(initialState(), 'manager.joined', { manager: 'early', account: { bot: 'v' } }), 'season.not_created'],
  ['season.created twice', at.created, candidate(at.created, 'season.created', log.events[0]!.payload as PayloadByType['season.created'], COMMISSIONER), 'season.already_created'],
  ['config id differs from envelope season', initialState(), candidate(initialState(), 'season.created', { config: miniConfig({ id: 'season-02' }), configSha256: lineHash('c'), engineVersion: '0', schedule: [], sponsors: [], taverns: [] }), 'season.id_mismatch'],
  ['schedule lists a week twice', initialState(), candidate(initialState(), 'season.created', { config, configSha256: lineHash('c'), engineVersion: '0', schedule: [schedule()[0]!, schedule()[0]!], sponsors: sponsors(), taverns: tavernList() }), 'season.bad_schedule'],
  ['a sponsor sets two weeks', initialState(), candidate(initialState(), 'season.created', { config, configSha256: lineHash('c'), engineVersion: '0', schedule: schedule().map((w) => ({ ...w, sponsor: 'the-bog-king' })), sponsors: sponsors(), taverns: tavernList() }), 'season.bad_sponsors'],
  ['a week names an unlisted sponsor', initialState(), candidate(initialState(), 'season.created', { config, configSha256: lineHash('c'), engineVersion: '0', schedule: schedule(), sponsors: [], taverns: tavernList() }), 'season.bad_sponsors'],

  // character.pooled
  ['pooled after the first pick', at.drafting, candidate(at.drafting, 'character.pooled', { character: 'late', base: 'ogre', cr: 8 as CrEighths, modifiers: [] }), 'pool.wrong_phase'],
  ['pooled twice', at.preseason, candidate(at.preseason, 'character.pooled', { character: 'char-01', base: 'ogre', cr: 8 as CrEighths, modifiers: [] }), 'pool.duplicate'],
  [
    'modifiers over budget',
    at.preseason,
    candidate(at.preseason, 'character.pooled', {
      character: 'pricey',
      base: 'ogre',
      cr: 8 as CrEighths,
      modifiers: [{ kind: 'skill_bonus', skill: 'survival', value: 3 }, { kind: 'advantage', on: { type: 'skill', skill: 'stealth' } }],
    }),
    'pool.over_budget',
  ],
  ['unknown trait', at.preseason, candidate(at.preseason, 'character.pooled', { character: 'odd', base: 'ogre', cr: 8 as CrEighths, modifiers: [{ kind: 'trait', trait: 'no-such-trait' }] }), 'pool.invalid_modifiers'],
  ['registry version the engine cannot price', created({ modifierRegistryVersion: 2 }), candidate(created({ modifierRegistryVersion: 2 }), 'character.pooled', { character: 'odd', base: 'ogre', cr: 8 as CrEighths, modifiers: [] }), 'pool.registry_version'],

  // manager.joined
  ['joining after the tavern pick starts', at.preseason, candidate(at.preseason, 'manager.joined', { manager: 'late', account: { githubId: 999, login: 'late' } }), 'manager.wrong_phase'],
  ['joining after the first pick', at.drafting, candidate(at.drafting, 'manager.joined', { manager: 'late', account: { githubId: 999, login: 'late' } }), 'manager.wrong_phase'],
  ['manager id taken', joinedThree, candidate(joinedThree, 'manager.joined', { manager: 'manager-0', account: { githubId: 999, login: 'x' } }), 'manager.duplicate'],
  ['account already in the league', joinedThree, candidate(joinedThree, 'manager.joined', { manager: 'second', account: { githubId: 101, login: 'manager-0' } }), 'manager.account_taken'],
  ['more managers than taverns', at.joined, candidate(at.joined, 'manager.joined', { manager: 'fifth', account: { bot: 'value' } }), 'manager.league_full'],
  // tavern.chosen
  ['choosing out of turn', at.joined, candidate(at.joined, 'tavern.chosen', { manager: secondToChoose, tavern: A }), 'choose.not_on_clock'],
  ['an unknown manager', at.joined, candidate(at.joined, 'tavern.chosen', { manager: 'nobody', tavern: A }), 'choose.unknown_manager'],
  ['a tavern not in the season', at.joined, candidate(at.joined, 'tavern.chosen', { manager: firstToChoose, tavern: 'the-lost-inn' }), 'choose.unknown_tavern'],
  ['a tavern already taken', afterFirstChoice, candidate(afterFirstChoice, 'tavern.chosen', { manager: secondToChoose, tavern: firstChoice }), 'choose.taken'],
  ['choosing twice', afterFirstChoice, candidate(afterFirstChoice, 'tavern.chosen', { manager: firstToChoose, tavern: D }), 'choose.already_chose'],
  ['choosing after the draft starts', at.drafting, candidate(at.drafting, 'tavern.chosen', { manager: firstToChoose, tavern: D }), 'choose.wrong_phase'],
  ['a manual order that misses a manager', withConfig(at.joined, { draft: { ...config.draft, order: { mode: 'manual', managers: ['manager-0'] } } }), candidate(at.joined, 'tavern.chosen', { manager: 'manager-0', tavern: A }), 'choose.bad_order'],

  // character.retained
  ['keeper after the first pick', at.drafting, candidate(at.drafting, 'character.retained', keeper), 'retain.wrong_phase'],
  ['keeper for an unknown tavern', at.preseason, candidate(at.preseason, 'character.retained', { ...keeper, tavern: 'nowhere' }), 'retain.unknown_tavern'],
  ['keeper not pooled', at.preseason, candidate(at.preseason, 'character.retained', { ...keeper, character: 'ghost' }), 'retain.not_pooled'],
  ['keeper already owned', withKeeper, candidate(withKeeper, 'character.retained', { ...keeper, tavern: B }), 'retain.already_owned'],
  ['second keeper over the limit', withKeeper, candidate(withKeeper, 'character.retained', { ...keeper, character: 'char-23' }), 'retain.over_limit'],
  ['keepers when carryover is off', withConfig(at.preseason, { carryover: { ...config.carryover, mode: 'none' } }), candidate(at.preseason, 'character.retained', keeper), 'retain.over_limit'],
  ['keeper into a full roster', withConfig(withKeeper, { roster: { ...config.roster, size: 1 } }), candidate(withKeeper, 'character.retained', { ...keeper, character: 'char-23', basis: 'champion_reward' }), 'retain.roster_full'],

  // draft.pick
  ['first pick before every manager has a tavern', afterFirstChoice, candidate(afterFirstChoice, 'draft.pick', { pick: 0, tavern: firstChoice, character: 'char-01', auto: false }), 'draft.tavern_pick_incomplete'],
  ['first pick with no managers', at.created, candidate(at.created, 'draft.pick', { pick: 0, tavern: A, character: 'char-01', auto: false }), 'draft.tavern_pick_incomplete'],
  ['a season with seven taverns', initialState(), candidate(initialState(), 'season.created', { config, configSha256: lineHash('c'), engineVersion: '0', schedule: schedule(), sponsors: sponsors(), taverns: [...tavernList(), ...['e', 'f', 'g'].map((id) => ({ id: `inn-${id}`, name: id }))] }, COMMISSIONER), 'season.bad_taverns'],
  ['a sponsor of a tavern not in the season', initialState(), candidate(initialState(), 'season.created', { config, configSha256: lineHash('c'), engineVersion: '0', schedule: schedule(), sponsors: sponsors(), taverns: tavernList().slice(1) }, COMMISSIONER), 'season.bad_taverns'],
  ['pick number is not the count of prior picks', at.drafting, nextPick(at.drafting, { pick: 0 }), 'draft.wrong_pick'],
  ['tavern not on the clock', at.drafting, nextPick(at.drafting, { tavern: notOnClock }), 'draft.not_on_clock'],
  ['pick not pooled', at.drafting, nextPick(at.drafting, { character: 'ghost' }), 'draft.not_pooled'],
  ['pick already owned', at.drafting, nextPick(at.drafting, { character: roster(at.drafting, expectedOrder[0]!)[0]! }), 'draft.already_owned'],
  ['pick into a full roster', tinyDraft, nextPick(tinyDraft), 'draft.roster_full'],
  ['pick after the draft', at.drafted, candidate(at.drafted, 'draft.pick', { pick: 20, tavern: A, character: 'char-21', auto: true }), 'draft.complete'],

  // lineup.set
  ['lineup before the draft completes', at.drafting, candidate(at.drafting, 'lineup.set', { tavern: A, week: 1, lineup: foreignLineup }, MANAGER), 'lineup.draft_incomplete'],
  ['lineup for an unknown tavern', at.drafted, candidate(at.drafted, 'lineup.set', { tavern: 'nowhere', week: 1, lineup: foreignLineup }), 'lineup.unknown_tavern'],
  ['lineup past the last week', at.drafted, candidate(at.drafted, 'lineup.set', { tavern: B, week: 3, lineup: foreignLineup }), 'lineup.bad_week'],
  ['lineup for a locked week', at.w1Locked, candidate(at.w1Locked, 'lineup.set', { tavern: A, week: 1, lineup: lineupA }), 'lineup.week_locked'],
  ['lineup with characters not owned', at.drafted, candidate(at.drafted, 'lineup.set', { tavern: A, week: 1, lineup: foreignLineup }), 'lineup.not_owned'],
  ['lineup over budget', withConfig(at.drafted, { budget: { partyCr: 8 as CrEighths, modifierPointsPerCharacter: 3 } }), candidate(at.drafted, 'lineup.set', { tavern: B, week: 1, lineup: foreignLineup }), 'lineup.over_budget'],
  ['a starter listed twice', at.drafted, candidate(at.drafted, 'lineup.set', { tavern: B, week: 1, lineup: { starters: [bRoster[0]!, bRoster[0]!, bRoster[1]!, bRoster[2]!], retreat: 'never' } }), 'lineup.duplicate'],

  // lineup.locked
  ['lock before the draft completes', at.drafting, candidate(at.drafting, 'lineup.locked', { week: 1, lineups: [] }), 'lock.draft_incomplete'],
  ['lock past the last week', at.drafted, candidate(at.drafted, 'lineup.locked', { week: 3, lineups: w1Entries }), 'lock.bad_week'],
  ['week locked twice', at.w1Locked, candidate(at.w1Locked, 'lineup.locked', { week: 1, lineups: w1Entries }), 'lock.already_locked'],
  ['lock before the previous week is finalized', at.w1Locked, candidate(at.w1Locked, 'lineup.locked', { week: 2, lineups: w1Entries }), 'lock.previous_not_finalized'],
  ['lock missing a tavern', at.w1Pending, candidate(at.w1Pending, 'lineup.locked', { week: 1, lineups: w1Entries.slice(1) }), 'lock.missing_tavern'],
  ['lock lists a tavern twice', at.w1Pending, candidate(at.w1Pending, 'lineup.locked', { week: 1, lineups: [...w1Entries, w1Entries[0]!] }), 'lock.duplicate_tavern'],
  ['lock names an unknown tavern', at.w1Pending, candidate(at.w1Pending, 'lineup.locked', { week: 1, lineups: [...w1Entries, { tavern: 'nowhere', lineup: null, source: 'none' }] }), 'lock.unknown_tavern'],
  ['lock with a null lineup marked submitted', at.w1Pending, candidate(at.w1Pending, 'lineup.locked', { week: 1, lineups: [{ ...w1Entries[0]!, lineup: null }, ...w1Entries.slice(1)] }), 'lock.source_mismatch'],
  ['lock with an illegal lineup', at.w1Pending, candidate(at.w1Pending, 'lineup.locked', { week: 1, lineups: [{ ...w1Entries[0]!, lineup: foreignLineup }, ...w1Entries.slice(1)] }), 'lock.illegal_lineup'],

  ['a week whose keywords name nothing in its mission', at.w1Locked, candidate(at.w1Locked, 'mission.revealed', { week: 1, mission: { ...missionFor(1), nodes: missionFor(1).nodes.filter((n) => n.kind !== 'check' || n.id !== 'find-path').concat([{ id: 'find-path', rank: 1, kind: 'check', check: { type: 'skill', skill: 'stealth', dc: 11 }, loot: 100 }]) }, sha256: lineHash('mission-w1'), salt: null }), 'reveal.dishonest_keywords'],
  // hex.declared
  ['a hex by an unknown tavern', at.drafted, candidate(at.drafted, 'hex.declared', { tavern: 'nobody', target: B, ability: 'wis', week: 2 }, MANAGER), 'hex.unknown_tavern'],
  ['a hex on itself', at.drafted, candidate(at.drafted, 'hex.declared', { tavern: A, target: A, ability: 'wis', week: 2 }, MANAGER), 'hex.self'],
  ['a hex past the season', at.drafted, candidate(at.drafted, 'hex.declared', { tavern: A, target: B, ability: 'wis', week: 3 }, MANAGER), 'hex.bad_week'],
  ['a hex on a locked week', at.w1Locked, candidate(at.w1Locked, 'hex.declared', { tavern: A, target: B, ability: 'wis', week: 1 }, MANAGER), 'hex.week_locked'],
  ['a second hex in a season', hexedOnce, candidate(hexedOnce, 'hex.declared', { tavern: A, target: C, ability: 'str', week: 1 }, MANAGER), 'hex.used'],
  ['a second hex on one target in one week', hexedOnce, candidate(hexedOnce, 'hex.declared', { tavern: C, target: B, ability: 'str', week: 2 }, MANAGER), 'hex.target_taken'],
  // waiver.claimed
  ['claim before the draft completes', at.drafting, candidate(at.drafting, 'waiver.claimed', { claim: 'c', tavern: A, add: 'char-24', drop: null }), 'waiver.draft_incomplete'],
  ['claim by an unknown tavern', at.w1Finalized, candidate(at.w1Finalized, 'waiver.claimed', { claim: 'c', tavern: 'nowhere', add: 'char-24', drop: null }), 'waiver.unknown_tavern'],
  ['claim id already pending', at.claimsPending, candidate(at.claimsPending, 'waiver.claimed', { ...claim1, add: 'char-24' }), 'waiver.duplicate_claim'],
  ['claim for an unpooled character', at.w1Finalized, candidate(at.w1Finalized, 'waiver.claimed', { claim: 'c', tavern: A, add: 'ghost', drop: null }), 'waiver.not_pooled'],
  ['claim for an owned character', at.w1Finalized, candidate(at.w1Finalized, 'waiver.claimed', { claim: 'c', tavern: A, add: bRoster[0]!, drop: null }), 'waiver.not_free_agent'],
  ['claim dropping someone else’s character', at.w1Finalized, candidate(at.w1Finalized, 'waiver.claimed', { claim: 'c', tavern: A, add: 'char-24', drop: bRoster[0]! }), 'waiver.drop_not_owned'],

  // waiver.resolved
  ['waivers past the last week', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', { ...resolved([]), week: 3 }), 'waiver.bad_week'],
  ['waivers before the week is finalized', at.w1Resolved, candidate(at.w1Resolved, 'waiver.resolved', resolved([])), 'waiver.week_not_finalized'],
  ['waivers resolved twice', at.waiversResolved, candidate(at.waiversResolved, 'waiver.resolved', resolved([])), 'waiver.already_resolved'],
  ['outcomes miss a pending claim', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', resolved([awarded('claim-1')])), 'waiver.missing_outcome'],
  ['outcome for an unknown claim', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', resolved([awarded('claim-1'), awarded('claim-2'), awarded('claim-9')])), 'waiver.unknown_claim'],
  ['two outcomes for one claim', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', resolved([awarded('claim-1'), awarded('claim-1'), awarded('claim-2')])), 'waiver.duplicate_outcome'],
  ['priority missing a tavern', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', resolved([awarded('claim-1'), { ...awarded('claim-2'), awarded: false }], waiverPriority.slice(1))), 'waiver.bad_priority'],
  // A hand-edited log: each outcome or priority differs from what resolveWaivers decides.
  ['an award to the wrong tavern', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', edited({ outcomes: [{ ...expectedW1.outcomes[0]!, awarded: false, reason: 'add_unavailable' }, { ...expectedW1.outcomes[1]!, awarded: true, reason: 'awarded' }] })), 'waiver.outcome_mismatch'],
  ['two awards of one character', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', edited({ outcomes: [expectedW1.outcomes[0]!, { ...expectedW1.outcomes[1]!, awarded: true, reason: 'awarded' }] })), 'waiver.outcome_mismatch'],
  ['outcomes out of decision order', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', edited({ outcomes: [...expectedW1.outcomes].reverse() })), 'waiver.outcome_mismatch'],
  ['an outcome with another reason', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', edited({ outcomes: [expectedW1.outcomes[0]!, { ...expectedW1.outcomes[1]!, reason: 'already claimed' }] })), 'waiver.outcome_mismatch'],
  ['an award into a full roster', withConfig(at.claimsPending, { roster: { ...config.roster, size: 5 } }), candidate(at.claimsPending, 'waiver.resolved', expectedW1), 'waiver.outcome_mismatch'],
  ['priority not rolled after an award', at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', edited({ priorityAfter: waiverPriority })), 'waiver.outcome_mismatch'],

  // trade.proposed
  ['trade before the draft completes', at.drafting, candidate(at.drafting, 'trade.proposed', terms({ give: [], receive: [] })), 'trade.draft_incomplete'],
  ['trade id reused', at.tradeCompleted, candidate(at.tradeCompleted, 'trade.proposed', terms({ trade: 'trade-1' })), 'trade.duplicate_id'],
  ['trade with an unknown tavern', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ to: 'nowhere' })), 'trade.unknown_tavern'],
  ['trade with itself', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ to: C, receive: [] })), 'trade.self'],
  ['trade moving nobody', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ give: [], receive: [] })), 'trade.empty'],
  ['trade listing a piece twice', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ give: [roster(at.waiversResolved, C)[1]!, roster(at.waiversResolved, C)[1]!] })), 'trade.duplicate_piece'],
  ['trade giving what the proposer does not own', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ give: [aRoster[0]!] })), 'trade.not_owned'],
  ['trade asking for what the other side does not own', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ receive: [bRoster2[0]!] })), 'trade.not_owned'],
  ['trade where one side gives nothing', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ receive: [] })), 'trade.empty'],
  ['uneven trade overfilling a roster', at.waiversResolved, candidate(at.waiversResolved, 'trade.proposed', terms({ from: A, to: B, give: [aRoster[0]!], receive: [bRoster2[0]!, bRoster2[1]!] })), 'trade.roster_size'],
  ['trade proposed after the deadline lock', at.w2Locked, candidate(at.w2Locked, 'trade.proposed', terms()), 'trade.past_deadline'],

  // trade.accepted / vetoed / completed / cancelled
  ['accepting an unknown trade', at.waiversResolved, candidate(at.waiversResolved, 'trade.accepted', { trade: 'trade-9' }), 'trade.unknown'],
  ['accepting a completed trade', at.tradeCompleted, candidate(at.tradeCompleted, 'trade.accepted', { trade: 'trade-1' }), 'trade.not_proposed'],
  ['accepting after the deadline lock', openAfterDeadline, candidate(openAfterDeadline, 'trade.accepted', { trade: 'trade-x' }), 'trade.past_deadline'],
  ['vetoing a trade not yet accepted', proposedX, candidate(proposedX, 'trade.vetoed', { trade: 'trade-x', reason: 'no' }, COMMISSIONER), 'trade.not_accepted'],
  ['vetoing a completed trade', at.tradeCompleted, candidate(at.tradeCompleted, 'trade.vetoed', { trade: 'trade-1', reason: 'late' }, COMMISSIONER), 'trade.not_accepted'],
  ['completing a trade not yet accepted', proposedX, candidate(proposedX, 'trade.completed', { trade: 'trade-x' }), 'trade.not_accepted'],
  ['completing a trade whose pieces moved', tradeStale, candidate(tradeStale, 'trade.completed', { trade: 'trade-1' }), 'trade.not_owned'],
  ['completing after the deadline lock', withConfig(at.tradeAccepted, { trades: { ...config.trades, deadlineWeek: 1 } }), candidate(at.tradeAccepted, 'trade.completed', { trade: 'trade-1' }), 'trade.past_deadline'],
  ['cancelling a completed trade', at.tradeCompleted, candidate(at.tradeCompleted, 'trade.cancelled', { trade: 'trade-1', reason: 'withdrawn' }), 'trade.not_open'],

  // mission.revealed
  ['reveal past the last week', at.w1Locked, candidate(at.w1Locked, 'mission.revealed', { ...reveal(1), week: 3 }), 'reveal.bad_week'],
  ['reveal before the lock', at.drafted, candidate(at.drafted, 'mission.revealed', reveal(1)), 'reveal.week_not_locked'],
  ['reveal twice', at.w1Revealed, candidate(at.w1Revealed, 'mission.revealed', reveal(1)), 'reveal.already_revealed'],
  ['reveal a mission from another season', at.w1Locked, candidate(at.w1Locked, 'mission.revealed', reveal(1, { mission: { ...missionFor(1), season: 'season-02' } })), 'reveal.wrong_season'],
  ['reveal that breaks the commitment', at.w2Locked, candidate(at.w2Locked, 'mission.revealed', reveal(2, { sha256: lineHash('something else') })), 'reveal.commitment_mismatch'],
  ['reveal a mission with a DC outside the band', at.w1Locked, candidate(at.w1Locked, 'mission.revealed', reveal(1, { mission: { ...missionFor(1), nodes: missionFor(1).nodes.map((n) => (n.kind === 'check' ? { ...n, check: { ...n.check, dc: 30 } } : n)) } })), 'reveal.invalid_mission'],
  ['reveal a mission for another environment', at.w1Locked, candidate(at.w1Locked, 'mission.revealed', reveal(1, { mission: { ...missionFor(1), environment: 'desert' } })), 'reveal.invalid_mission'],

  // mission.resolved
  ['result past the last week', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', { ...resultA, week: 3 }), 'resolve.bad_week'],
  ['result before the lock', at.drafted, candidate(at.drafted, 'mission.resolved', resultA), 'resolve.week_not_locked'],
  ['result before the reveal', at.w1Locked, candidate(at.w1Locked, 'mission.resolved', resultA), 'resolve.not_revealed'],
  ['result for another mission', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', { ...resultA, mission: 'other-mission' }), 'resolve.wrong_mission'],
  ['result after the week is finalized', at.w1Finalized, candidate(at.w1Finalized, 'mission.resolved', resultA), 'resolve.week_finalized'],
  ['result for an unknown tavern', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', { ...resultA, tavern: 'nowhere' }), 'resolve.unknown_tavern'],
  ['second result for one tavern', at.w1Resolved, candidate(at.w1Resolved, 'mission.resolved', resultA), 'resolve.duplicate'],
  ['result for a tavern with no lineup', w2Revealed, candidate(w2Revealed, 'mission.resolved', { ...resultA, week: 2, tavern: D, mission: 'mission-w2' }), 'resolve.no_lineup'],
  ['result with a different lineup', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', { ...resultA, lineup: { ...lineupA, starters: [lineupA.starters[1], lineupA.starters[0], lineupA.starters[2], lineupA.starters[3]] } }), 'resolve.lineup_mismatch'],
  ['result with a different retreat order', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', { ...resultA, lineup: { ...lineupA, retreat: { bank: 40 } } }), 'resolve.lineup_mismatch'],
  ['result whose counts disagree with its nodes', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', withRun({ checksAttempted: resultA.run.checksAttempted + 1 })), 'resolve.counts_mismatch'],
  ['result whose score disagrees with its loot', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', withRun({ score: resultA.run.score === 0.5 ? 0.25 : 0.5 })), 'resolve.score_mismatch'],
  ['result whose loot disagrees with its nodes', at.w1Revealed, candidate(at.w1Revealed, 'mission.resolved', withRun({ loot: resultA.run.loot + 1 })), 'resolve.score_mismatch'],

  // week.finalized
  ['finalize past the last week', at.w1Resolved, candidate(at.w1Resolved, 'week.finalized', { week: 3 }), 'finalize.bad_week'],
  ['finalize before the lock', at.drafted, candidate(at.drafted, 'week.finalized', { week: 1 }), 'finalize.week_not_locked'],
  ['finalize with a result missing', at.w1Revealed, candidate(at.w1Revealed, 'week.finalized', { week: 1 }), 'finalize.missing_result'],
  ['finalize twice', at.w1Finalized, candidate(at.w1Finalized, 'week.finalized', { week: 1 }), 'finalize.already_finalized'],
];

describe('preconditions', () => {
  it.each(cases)('rejects %s', (_name, state, event, code) => {
    const error = rejection(state, event);
    expect(error.code).toBe(code);
    expect(error.seq).toBe(event.seq);
    expect(error.message).toContain(`[${code}]`);
  });

  it('records a hex for its target and week only (D-52)', () => {
    expect(hexOn(hexedOnce, B, 2)).toBe('wis');
    expect([hexOn(hexedOnce, B, 1), hexOn(hexedOnce, A, 2)]).toEqual([undefined, undefined]);
    // Another tavern may hex the same target in another week.
    const two = applyEvent(hexedOnce, candidate(hexedOnce, 'hex.declared', { tavern: C, target: B, ability: 'str', week: 1 }, MANAGER));
    expect(hexOn(two, B, 1)).toBe('str');
  });

  it('accepts bot managers that share a strategy', () => {
    let s = applyEvent(at.created, candidate(at.created, 'manager.joined', { manager: 'bot-1', account: { bot: 'value' } }));
    s = applyEvent(s, candidate(s, 'manager.joined', { manager: 'bot-2', account: { bot: 'value' } }));
    expect([...s.managers.values()].map((m) => m.account)).toEqual([{ bot: 'value' }, { bot: 'value' }]);
  });

  it('runs the tavern pick in reverse draft order, and drafts in draft order (D-52)', () => {
    const order = at.preseason.draft.managerOrder;
    const chosen = [...at.preseason.taverns.values()].map((t) => t.managerId);
    expect(chosen).toEqual([...order].reverse());
    expect(at.preseason.draft.order).toEqual([]);
    expect(at.drafting.draft.order).toEqual(order.map((m) => at.preseason.managers.get(m)!.tavern));
    // The manager who drafts last chose first.
    expect(onTheClock(at.preseason)).toBe(at.preseason.managers.get(order[0]!)!.tavern);
  });

  it('a rejected event leaves the state untouched', () => {
    const before = replay(log.events.slice(0, at.drafting.lastSeq));
    rejection(at.drafting, nextPick(at.drafting, { tavern: notOnClock }));
    expect({ ...before, lastHash: null }).toEqual(at.drafting);
  });

  it('a log built by hand replays only in order', () => {
    const b = new LogBuilder();
    b.append('season.created', { config, configSha256: lineHash('c'), engineVersion: '0', schedule: schedule(), sponsors: sponsors(), taverns: tavernList() }, COMMISSIONER);
    b.append('manager.joined', { manager: 'manager-a', account: { bot: 'v' } }, COMMISSIONER);
    const swapped = [b.events[1]!, b.events[0]!];
    expect(() => replay(swapped)).toThrow(InvalidEventError);
  });
});

describe('waiver.resolved is checked against resolveWaivers', () => {
  it('rejects a hand-edited log that awards the claimed character to the wrong tavern', () => {
    // claim-1 (A) is ahead of claim-2 (C) in priority; the edit hands the character to C.
    const tampered = log.events.map((e) =>
      e.type === 'waiver.resolved' && e.payload.week === 1
        ? {
            ...e,
            payload: {
              ...e.payload,
              outcomes: [
                { claim: 'claim-1', awarded: false, reason: 'add_unavailable' },
                { claim: 'claim-2', awarded: true, reason: 'awarded' },
              ],
              priorityAfter: [...waiverPriority.filter((t) => t !== C), C],
            },
          }
        : e,
    );
    const seq = log.events.find((e) => e.type === 'waiver.resolved')!.seq;
    let error: unknown;
    try {
      replay(tampered);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(InvalidEventError);
    const invalid = error as InvalidEventError;
    expect(invalid.code).toBe('waiver.outcome_mismatch');
    expect(invalid.seq).toBe(seq);
    expect(invalid.message).toMatch(/outcome 1 records "claim-1" not awarded .*resolveWaivers decides "claim-1" awarded \(awarded\)/);
  });

  it('names a priorityAfter that differs', () => {
    const error = rejection(at.claimsPending, candidate(at.claimsPending, 'waiver.resolved', { ...expectedW1, priorityAfter: waiverPriority }));
    expect(error.message).toContain(`should be [${expectedW1.priorityAfter.join(', ')}]`);
  });

  it('applies the computed awards: an awarded drop becomes a free agent', () => {
    // B is first in priority.
    const free = freeAgents(at.w1Finalized)[1]!;
    const dropped = roster(at.w1Finalized, B)[0]!;
    let s = applyEvent(at.w1Finalized, candidate(at.w1Finalized, 'waiver.claimed', { claim: 'claim-b', tavern: B, add: free, drop: dropped }, MANAGER));
    s = applyEvent(s, candidate(s, 'waiver.resolved', waiverResolution(s, 1)));
    expect(s.owner.get(free)).toBe(B);
    expect(s.owner.has(dropped)).toBe(false);
    expect(freeAgents(s)).toContain(dropped);
    expect(s.waivers.priority.at(-1)).toBe(B);
  });
});

describe('trades are re-checked at completion', () => {
  /** Propose and accept `trade` from `state`. */
  function accepted(state: LeagueState, trade: PayloadByType['trade.proposed']): LeagueState {
    const s = applyEvent(state, candidate(state, 'trade.proposed', trade, MANAGER));
    return applyEvent(s, candidate(s, 'trade.accepted', { trade: trade.trade }, MANAGER));
  }

  it('rejects a trade an earlier waiver award made illegal (roster now full), and takes trade.cancelled instead', () => {
    // An uneven 2-for-1 into A's open sixth slot, legal when proposed...
    const bR = roster(at.claimsPending, B);
    const trade = { trade: 'trade-w', from: B, to: A, give: [bR[0]!, bR[1]!], receive: [roster(at.claimsPending, A)[0]!] };
    let s = accepted(at.claimsPending, trade);
    // ...until the week-1 waivers award claim-1 and fill that slot.
    s = applyEvent(s, candidate(s, 'waiver.resolved', waiverResolution(s, 1)));
    expect(roster(s, A)).toHaveLength(config.roster.size);
    const error = rejection(s, candidate(s, 'trade.completed', { trade: 'trade-w' }));
    expect(error.code).toBe('trade.roster_size');
    expect(error.message).toContain('"trade-w"');
    const cancelled = applyEvent(s, candidate(s, 'trade.cancelled', { trade: 'trade-w', reason: 'invalid' }));
    expect(cancelled.trades.get('trade-w')?.status).toBe('cancelled');
    expect(cancelled.taverns).toBe(s.taverns);
  });

  it('rejects a trade whose piece an earlier waiver award dropped', () => {
    const piece = roster(at.w1Finalized, B)[0]!;
    let s = accepted(at.w1Finalized, { trade: 'trade-d', from: B, to: D, give: [piece], receive: [roster(at.w1Finalized, D)[0]!] });
    s = applyEvent(s, candidate(s, 'waiver.claimed', { claim: 'claim-b', tavern: B, add: freeAgents(s)[0]!, drop: piece }, MANAGER));
    s = applyEvent(s, candidate(s, 'waiver.resolved', waiverResolution(s, 1)));
    expect(s.owner.has(piece)).toBe(false);
    expect(rejection(s, candidate(s, 'trade.completed', { trade: 'trade-d' })).code).toBe('trade.not_owned');
  });

  it('completes an uneven trade into an open slot (D-06)', () => {
    const cR = roster(at.waiversResolved, C);
    const open = accepted(at.waiversResolved, terms({ trade: 'trade-u', give: [cR[1]!, cR[2]!] }));
    const s = applyEvent(open, candidate(open, 'trade.completed', { trade: 'trade-u' }));
    expect(roster(s, C)).toHaveLength(4);
    expect(roster(s, D)).toHaveLength(6);
  });
});

describe('tiny leagues', () => {
  it('a two-tavern draft completes after rounds × taverns picks and seeds reverse priority', () => {
    let s = joined(created({ draft: { ...config.draft, rounds: 2 } }), [A, B]);
    while (!s.draft.complete) s = applyEvent(s, nextPick(s));
    expect(s.draft.picks).toBe(4);
    expect(s.phase).toBe('regular');
    expect(s.waivers.priority).toEqual([...s.draft.order].reverse());
    expect(freeAgents(s)).toEqual(POOL.slice(4, 8).map((p) => p.id));
  });

  it('a manual order is used as given', () => {
    let s = joined(created({ draft: { ...config.draft, rounds: 1, order: { mode: 'manual', managers: [C, A, B].map(managerFor) } } }), [A, B, C]);
    s = applyEvent(s, nextPick(s));
    expect(s.draft.order).toEqual([C, A, B]);
    expect(roster(s, C)).toEqual(['char-01']);
  });

  it('finalizing a week where nobody fielded a lineup needs no results', () => {
    let s = joined(created({ weeks: 1, draft: { ...config.draft, rounds: 1 } }), [A, B]);
    while (!s.draft.complete) s = applyEvent(s, nextPick(s));
    s = applyEvent(s, candidate(s, 'lineup.locked', { week: 1, lineups: [A, B].map((tavern) => ({ tavern, lineup: null, source: 'none' as const })) }));
    s = applyEvent(s, candidate(s, 'week.finalized', { week: 1 }));
    expect(s.phase).toBe('complete');
    expect(weekResults(s, 1).map((r) => r.points)).toEqual([0, 0]);
    // 0–0 with no tiebreak: both share first.
    expect(seasonStandings(s).map((r) => r.rank)).toEqual([1, 1]);
  });
});
