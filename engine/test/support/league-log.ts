/**
 * Test-only builders for event logs: a `LogBuilder` that stamps envelopes,
 * chains `prev` hashes and folds each event as it goes, plus a scripted
 * mini-season (4 taverns, 24 pooled characters, 2 weeks) with state
 * checkpoints for precondition tests.
 */
import type { SeasonConfig } from '../../src/league';
import type { Mission } from '../../src/missions';
import { projectMission } from '../../src/projection';
import { runMission, type BattleModel } from '../../src/resolution';
import { applyEvent, initialState } from '../../src/events/reducers';
import { lineHash, serializeEvent } from '../../src/events/replay';
import { freeAgents, onTheClock } from '../../src/events/selectors';
import type { LeagueState } from '../../src/events/state';
import type { Actor, EventOf, EventType, LeagueEvent, PayloadByType } from '../../src/events/types';
import { rngFor, weekSeed } from '../../src/rng';
import { carriedLineup, type Lineup } from '../../src/roster';
import type { CrEighths } from '../../src/vocabulary';
import { baseOf, battle, constantModel, edge, end, member, partyOf, skillCheck, start } from './builders';

export const SEASON = 'season-01';
export const AT = '2026-11-02T18:04:11Z';
export const SYSTEM: Actor = { kind: 'system', workflow: 'weekly-run' };
export const COMMISSIONER: Actor = { kind: 'commissioner', githubId: 1, login: 'gm' };
export const MANAGER: Actor = { kind: 'manager', githubId: 101, login: 'flagon' };

/** Join order. */
export const TAVERNS = ['the-gilded-flagon', 'the-rusty-nail', 'the-salty-dog', 'the-quiet-crow'] as const;

export function miniConfig(overrides: Partial<SeasonConfig> = {}): SeasonConfig {
  return {
    id: SEASON,
    snapshot: 'open5e-v1-2026-10',
    modifierRegistryVersion: 1,
    weeks: 2,
    budget: { partyCr: 40 as CrEighths, modifierPointsPerCharacter: 3 },
    roster: { size: 6, starters: 4, ownership: 'exclusive' },
    draft: { format: 'snake', rounds: 5, order: { mode: 'seeded' }, pickWindowHours: 24, onTimeout: 'autopick' },
    matchups: { format: 'head_to_head', playoffs: { enabled: false, teams: 0, weeks: [] } },
    scoring: { pointsScale: 100, tiebreakers: ['projected', 'checks_passed', 'seeded_coin'] },
    waivers: { priority: 'rolling', initialOrder: 'reverse_draft' },
    trades: { vetoWindowHours: 24, vetoBy: 'commissioner', deadlineWeek: 2 },
    missedLineup: 'carry_over',
    schedules: { lineupLock: '0 18 * * 4', weeklyRun: '15 18 * * 4', waivers: '0 12 * * 5' },
    secrecy: 'open',
    seedSalt: 'none',
    missions: {
      dcBand: { min: 8, max: 20 },
      maxNodes: 14,
      maxRank: 8,
      battlesPerPath: { min: 0, max: 3 },
      encounterCrRatio: 1,
      battleModel: 'constant-0.6',
    },
    carryover: { mode: 'keeper', keepersPerTavern: 1, keeperCost: 'round_of_last_season_pick', championBonusKeepers: 1, maxModifierChangePoints: 1 },
    ...overrides,
  };
}

/**
 * 24 characters, `char-01`…`char-24`, with CRs cycling 1/2, 1, 1 1/2, 2, 1 (in
 * eighths). A five-step cycle against a four-tavern snake gives every roster a
 * legal lineup under B = 5 and none a trivially cheap one.
 */
export const POOL: ReadonlyArray<{ readonly id: string; readonly cr: CrEighths }> = Array.from({ length: 24 }, (_, i) => ({
  id: `char-${String(i + 1).padStart(2, '0')}`,
  cr: ([4, 8, 12, 16, 8] as const)[i % 5]! as CrEighths,
}));

/** A week-2 commitment, to exercise the `sha256` = commitment rule. */
export const WEEK2_COMMITMENT = lineHash('mission-w2');

export function schedule(): PayloadByType['season.created']['schedule'] {
  return [
    { week: 1, title: 'The Drowned Toll', environment: 'swamp', theme: 'A flooded road.', commitment: null },
    { week: 2, title: 'The Sunken Bell', environment: 'swamp', theme: 'A bell under the bog.', commitment: WEEK2_COMMITMENT },
  ];
}

/** start → survival check; pass → end, fail → battle → end. */
export function missionFor(week: number): Mission {
  return {
    schemaVersion: 1,
    id: `mission-w${week}`,
    season: SEASON,
    environment: 'swamp',
    nodes: [start(), skillCheck('find-path', 1, 'survival', 11), battle('bog', 2), end('crossed', 3)],
    edges: [edge('start', 'find-path', 'always'), edge('find-path', 'crossed', 'pass'), edge('find-path', 'bog', 'fail'), edge('bog', 'crossed', 'win')],
  };
}

export const MODEL: BattleModel = constantModel(0.6);

/** Stamps envelopes, chains `prev`, and folds every appended event through `applyEvent`. */
export class LogBuilder {
  readonly events: LeagueEvent[] = [];
  readonly lines: string[] = [];
  state: LeagueState = initialState();

  append<T extends EventType>(type: T, payload: EventOf<T>['payload'], actor: Actor = SYSTEM): EventOf<T> {
    const event = candidate(this.state, type, payload, actor, this.lines.length === 0 ? null : lineHash(this.lines.at(-1)!));
    this.state = applyEvent(this.state, event);
    this.events.push(event);
    this.lines.push(serializeEvent(event));
    return event;
  }

  get ndjson(): string {
    return `${this.lines.join('\n')}\n`;
  }
}

/** An event that would come next after `state` (seq = lastSeq + 1). `prev` is a placeholder unless given. */
export function candidate<T extends EventType>(
  state: LeagueState,
  type: T,
  payload: EventOf<T>['payload'],
  actor: Actor = SYSTEM,
  prev: string | null = null,
): EventOf<T> {
  return { v: 1, seq: state.lastSeq + 1, type, season: SEASON, at: AT, actor, prev, payload } as unknown as EventOf<T>;
}

export function crOfState(state: LeagueState): (id: string) => CrEighths {
  return (id) => {
    const entry = state.pool.get(id);
    if (entry === undefined) throw new Error(`unknown ${id}`);
    return entry.cr;
  };
}

/** The best-CR legal lineup for `tavern` (the D-27 fallback), as a test's stand-in for a manager's choice. */
export function bestLineup(state: LeagueState, tavern: string, previous: Lineup | null = null): Lineup {
  const roster = state.taverns.get(tavern)!.roster;
  const lineup = carriedLineup(previous, { tavern, characters: roster }, crOfState(state), state.config!);
  if (lineup === null) throw new Error(`${tavern} has no legal lineup`);
  return lineup;
}

/** The recorded `mission.resolved` payload for one tavern's run, built with `runMission` and the week seed. */
export function resolution(state: LeagueState, week: number, tavern: string, lineup: Lineup): PayloadByType['mission.resolved'] {
  const mission = state.revealed.get(week)!;
  const ids = [lineup.captain, ...lineup.allies];
  // Survival modifier from CR, so lineups differ.
  const party = partyOf(ids.map((id) => member(id, { skills: { survival: state.pool.get(id)!.cr / 4 } })));
  const seed = weekSeed({ season: SEASON, week, tavern });
  const run = runMission(party, mission, (node) => rngFor(seed, `roll:${node}`), baseOf, MODEL);
  const projection = projectMission(party, mission, baseOf, MODEL);
  return {
    week,
    tavern,
    mission: mission.id,
    seed,
    engineVersion: '0.0.0',
    battleModel: MODEL.id,
    lineup,
    run,
    projected: { expectedScore: projection.expectedScore, pDnf: projection.pDnf },
    points: Math.round(run.score * 100),
    projectedPoints: projection.expectedScore * 100,
  };
}

export interface MiniSeason {
  readonly log: LogBuilder;
  /** States at named points, for precondition tests. */
  readonly at: {
    readonly created: LeagueState;
    readonly preseason: LeagueState;
    readonly drafting: LeagueState;
    readonly drafted: LeagueState;
    readonly w1Pending: LeagueState;
    readonly w1Locked: LeagueState;
    readonly w1Revealed: LeagueState;
    readonly w1Resolved: LeagueState;
    readonly w1Finalized: LeagueState;
    readonly claimsPending: LeagueState;
    readonly waiversResolved: LeagueState;
    readonly tradeAccepted: LeagueState;
    readonly tradeCompleted: LeagueState;
    readonly w2Locked: LeagueState;
    readonly final: LeagueState;
  };
  /** Character the waiver claim `claim-1` added for the first tavern. */
  readonly claimed: string;
  /** Trade-1 pieces: the first tavern gives `give`, receives `receive` from the second. */
  readonly traded: { readonly give: string; readonly receive: string };
}

/**
 * A whole 2-week season: created → pooled → joined → full snake draft →
 * week 1 (all submitted) → waivers (one award, one loss) → trades (one
 * completed, one cancelled, one vetoed) → week 2 (submitted, carried, and one
 * tavern with no lineup) → complete.
 */
export function miniSeason(): MiniSeason {
  const log = new LogBuilder();
  const config = miniConfig();
  const [a, b, c, d] = TAVERNS;

  log.append('season.created', { config, configSha256: lineHash('config'), engineVersion: '0.0.0', schedule: schedule() }, COMMISSIONER);
  const created = log.state;
  for (const [i, { id, cr }] of POOL.entries()) {
    const modifiers = i % 5 === 0 ? [{ kind: 'skill_bonus', skill: 'survival', value: 2 } as const] : [];
    log.append('character.pooled', { character: id, base: 'ogre', cr, modifiers }, COMMISSIONER);
  }
  for (const [i, tavern] of TAVERNS.entries()) {
    const manager = i === 3 ? { bot: 'value' } : { githubId: 101 + i, login: `manager-${i}` };
    log.append('tavern.joined', { tavern, name: tavern, manager }, COMMISSIONER);
  }
  const preseason = log.state;

  let drafting: LeagueState | undefined;
  while (!log.state.draft.complete) {
    const tavern = onTheClock(log.state)!;
    log.append('draft.pick', { pick: log.state.draft.picks, tavern, character: freeAgents(log.state)[0]!, auto: false }, MANAGER);
    drafting ??= log.state;
  }
  const drafted = log.state;

  // Week 1: everyone submits.
  for (const tavern of TAVERNS) log.append('lineup.set', { tavern, week: 1, lineup: bestLineup(log.state, tavern) }, MANAGER);
  const w1Pending = log.state;
  const pending1 = log.state.pendingLineups.get(1)!;
  log.append('lineup.locked', { week: 1, lineups: TAVERNS.map((tavern) => ({ tavern, lineup: pending1.get(tavern)!, source: 'submitted' as const })) });
  const w1Locked = log.state;
  log.append('mission.revealed', { week: 1, mission: missionFor(1), sha256: lineHash('mission-w1'), salt: null });
  const w1Revealed = log.state;
  for (const tavern of TAVERNS) log.append('mission.resolved', resolution(log.state, 1, tavern, pending1.get(tavern)!));
  const w1Resolved = log.state;
  log.append('week.finalized', { week: 1 });
  const w1Finalized = log.state;

  // Waivers: a claims a free agent outright; b claims the same one (dropping) and loses.
  const claimed = freeAgents(log.state)[0]!;
  log.append('waiver.claimed', { claim: 'claim-1', tavern: a, add: claimed, drop: null }, MANAGER);
  log.append('waiver.claimed', { claim: 'claim-2', tavern: b, add: claimed, drop: log.state.taverns.get(b)!.roster.at(-1)! }, MANAGER);
  const claimsPending = log.state;
  const priority = log.state.waivers.priority;
  log.append('waiver.resolved', {
    week: 1,
    outcomes: [
      { claim: 'claim-1', awarded: true, reason: 'free agent' },
      { claim: 'claim-2', awarded: false, reason: 'already claimed' },
    ],
    priorityAfter: [...priority.filter((t) => t !== a), a],
  });
  const waiversResolved = log.state;

  // Trades: trade-1 completes, trade-2 is withdrawn, trade-3 is vetoed.
  const give = log.state.taverns.get(a)!.roster[0]!;
  const receive = log.state.taverns.get(b)!.roster[0]!;
  log.append('trade.proposed', { trade: 'trade-1', from: a, to: b, give: [give], receive: [receive] }, MANAGER);
  log.append('trade.accepted', { trade: 'trade-1' }, MANAGER);
  const tradeAccepted = log.state;
  log.append('trade.completed', { trade: 'trade-1' });
  const tradeCompleted = log.state;
  const cPiece = log.state.taverns.get(c)!.roster[0]!;
  const dPiece = log.state.taverns.get(d)!.roster[0]!;
  log.append('trade.proposed', { trade: 'trade-2', from: c, to: d, give: [cPiece], receive: [dPiece] }, MANAGER);
  log.append('trade.cancelled', { trade: 'trade-2', reason: 'withdrawn' }, MANAGER);
  log.append('trade.proposed', { trade: 'trade-3', from: c, to: d, give: [cPiece], receive: [] }, MANAGER);
  log.append('trade.accepted', { trade: 'trade-3' }, MANAGER);
  log.append('trade.vetoed', { trade: 'trade-3', reason: 'lopsided' }, COMMISSIONER);

  // Week 2: a and c submit, b carries over (or falls back), d plays nobody.
  log.append('lineup.set', { tavern: a, week: 2, lineup: bestLineup(log.state, a) }, MANAGER);
  log.append('lineup.set', { tavern: c, week: 2, lineup: bestLineup(log.state, c) }, MANAGER);
  const pending2 = log.state.pendingLineups.get(2)!;
  const carried = bestLineup(log.state, b, pending1.get(b)!);
  log.append('lineup.locked', {
    week: 2,
    lineups: [
      { tavern: a, lineup: pending2.get(a)!, source: 'submitted' },
      { tavern: b, lineup: carried, source: 'carried' },
      { tavern: c, lineup: pending2.get(c)!, source: 'submitted' },
      { tavern: d, lineup: null, source: 'none' },
    ],
  });
  const w2Locked = log.state;
  log.append('mission.revealed', { week: 2, mission: missionFor(2), sha256: WEEK2_COMMITMENT, salt: null });
  for (const entry of log.state.lockedLineups.get(2)!) {
    if (entry.lineup !== null) log.append('mission.resolved', resolution(log.state, 2, entry.tavern, entry.lineup));
  }
  log.append('week.finalized', { week: 2 });
  log.append('waiver.resolved', { week: 2, outcomes: [], priorityAfter: log.state.waivers.priority });
  const final = log.state;

  return {
    log,
    at: {
      created,
      preseason,
      drafting: drafting!,
      drafted,
      w1Pending,
      w1Locked,
      w1Revealed,
      w1Resolved,
      w1Finalized,
      claimsPending,
      waiversResolved,
      tradeAccepted,
      tradeCompleted,
      w2Locked,
      final,
    },
    claimed,
    traded: { give, receive },
  };
}

/**
 * Serialize `events` as a log with a valid `prev` chain, whatever their own
 * `prev` says: for building tampered logs whose chain is intact, so the
 * reducers (not the chain check) must catch the problem.
 */
export function chained(events: ReadonlyArray<LeagueEvent>): string {
  const lines: string[] = [];
  for (const event of events) {
    lines.push(serializeEvent({ ...event, prev: lines.length === 0 ? null : lineHash(lines.at(-1)!) }));
  }
  return `${lines.join('\n')}\n`;
}
