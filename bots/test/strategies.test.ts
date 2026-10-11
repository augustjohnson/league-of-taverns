import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BATTLE_MODELS,
  TRAITS,
  effectiveStats,
  evTtkV0,
  projectMission,
  rngFor,
  snakePickOwner,
  toBaseStats,
  validateLineup,
  type BaseStats,
  type CrEighths,
  type EffectiveStats,
  type LeagueState,
  type Lineup,
  type Mission,
  type Modifier,
  type SeasonConfig,
} from '@league-of-taverns/engine';
import {
  BOT_IDS,
  DRAFT_STRATEGIES,
  LINEUP_STRATEGIES,
  bestAvailable,
  botManager,
  checkFit,
  coveredSkills,
  crGreedyDraft,
  fitWeights,
  keepsLineupPossible,
  maxCrLineup,
  poolInfo,
  projectionLineup,
  randomDraft,
  type PublicView,
} from '../src';
import { FIXTURE_SLUGS, loadSnapshot } from '../../engine/test/fixtures/open5e';
import { baseOf as fixtureBaseOf, battle, edge, end, missionOf, skillCheck, start, check } from '../../engine/test/support/builders';

// ── fixtures ────────────────────────────────────────────────────────────────

/** Season config as in engine/test/lineup.test.ts, with missions open (D-08). */
function configWith(partyCr: number, size = 7, weeks = 6): SeasonConfig {
  return {
    id: 'season-01',
    snapshot: 'open5e-v1-2026-10',
    modifierRegistryVersion: 1,
    weeks,
    budget: { partyCr: partyCr as CrEighths, modifierPointsPerCharacter: 3 },
    roster: { size, starters: 4, ownership: 'exclusive' },
    draft: { format: 'snake', rounds: size, order: { mode: 'seeded' }, pickWindowHours: 24, onTimeout: 'autopick' },
    matchups: { format: 'head_to_head', playoffs: { enabled: false, teams: 4, weeks: [] } },
    scoring: { pointsScale: 100, tiebreakers: ['projected', 'checks_passed', 'seeded_coin'] },
    waivers: { priority: 'rolling', initialOrder: 'reverse_draft' },
    trades: { vetoWindowHours: 24, vetoBy: 'commissioner', deadlineWeek: 4 },
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
      battleModel: 'ev-ttk-v0',
    },
    carryover: { mode: 'none', keepersPerTavern: 0, keeperCost: 'none', championBonusKeepers: 0, maxModifierChangePoints: 0 },
  };
}

const B12 = configWith(96);

/** Season 1's public schedule (seasons/season-01/schedule.yaml), without titles. */
const SCHEDULE = [
  { week: 1, environment: 'swamp', theme: 'A flooded toll road and a bridge-keeper who wants paying.' },
  { week: 2, environment: 'underground', theme: 'A mine reopened after forty dark years.' },
  { week: 3, environment: 'forest', theme: 'Fruit that rings like bells, and whatever eats it.' },
  { week: 4, environment: 'mountain', theme: 'A caravan stranded below a waking peak.' },
  { week: 5, environment: 'coast', theme: 'False lights on the cliffs and a ship that should not have sunk.' },
  { week: 6, environment: 'urban', theme: 'Every tavern in the city, one night, one prize.' },
];

/** A few authored modifiers, so effective stats differ from bases. */
const MODIFIERS: Readonly<Record<string, ReadonlyArray<Modifier>>> = {
  'c-lizardfolk': [{ kind: 'skill_bonus', skill: 'stealth', value: 2 }],
  'c-ogre': [{ kind: 'battle_bonus', value: 1 }],
  'c-werewolf': [{ kind: 'grant_sense', sense: 'darkvision', feet: 60 }],
};

interface Pool {
  readonly entries: LeagueState['pool'];
  readonly statsOf: (id: string) => EffectiveStats;
  readonly baseOf: (slug: string) => BaseStats;
}

function poolFrom(bases: ReadonlyArray<BaseStats>, encounterBase: (slug: string) => BaseStats): Pool {
  const entries = new Map<string, { base: string; cr: CrEighths; modifiers: ReadonlyArray<Modifier> }>();
  const stats = new Map<string, EffectiveStats>();
  for (const base of bases) {
    const id = `c-${base.slug}`;
    const modifiers = MODIFIERS[id] ?? [];
    entries.set(id, { base: base.slug, cr: base.cr, modifiers });
    stats.set(id, effectiveStats({ ref: { id, base: base.slug }, modifiers }, base, TRAITS));
  }
  return {
    entries,
    statsOf: (id) => {
      const s = stats.get(id);
      if (s === undefined) throw new Error(`not pooled: ${id}`);
      return s;
    },
    baseOf: encounterBase,
  };
}

/** Every engine fixture creature, pooled as "c-<slug>". */
const FIXTURE_POOL = poolFrom(FIXTURE_SLUGS.map(fixtureBaseOf), fixtureBaseOf);

function stateOf(
  pool: Pool,
  rosters: Readonly<Record<string, ReadonlyArray<string>>>,
  config: SeasonConfig = B12,
  extra: { readonly locked?: ReadonlyArray<number>; readonly finalized?: ReadonlyArray<number> } = {},
): LeagueState {
  const taverns = new Map(
    Object.entries(rosters).map(([id, roster]) => [id, { id, name: id, manager: { bot: 'test' }, roster }] as const),
  );
  const owner = new Map<string, string>();
  for (const [tavern, roster] of Object.entries(rosters)) for (const id of roster) owner.set(id, tavern);
  return {
    lastSeq: 0,
    lastHash: null,
    phase: 'regular',
    config,
    pool: pool.entries,
    taverns,
    owner,
    draft: { order: Object.keys(rosters), picks: owner.size, complete: false },
    pendingLineups: new Map(),
    lockedLineups: new Map((extra.locked ?? []).map((w) => [w, []] as const)),
    waivers: { pending: [], priority: Object.keys(rosters) },
    trades: new Map(),
    revealed: new Map(),
    results: new Map(),
    finalizedWeeks: new Set(extra.finalized ?? []),
  };
}

function viewOf(
  state: LeagueState,
  tavern: string,
  pool: Pool,
  missions: Readonly<Record<number, Mission>> = {},
  seed = 'test-seed',
  decision = 'decision',
): PublicView {
  return {
    state,
    tavern,
    statsOf: pool.statsOf,
    schedule: SCHEDULE,
    missionFor: (week) => missions[week] ?? null,
    baseOf: pool.baseOf,
    battleModel: BATTLE_MODELS[state.config!.missions.battleModel]!,
    rng: rngFor(seed, `bot:${tavern}:${decision}`),
  };
}

const freeAgents = (state: LeagueState): string[] => [...state.pool.keys()].filter((id) => !state.owner.has(id)).sort();

function isLegal(view: PublicView, lineup: Lineup | null, roster = view.state.taverns.get(view.tavern)!.roster): boolean {
  if (lineup === null) return false;
  const crOf = (id: string): CrEighths => view.state.pool.get(id)!.cr;
  return validateLineup(lineup, { tavern: view.tavern, characters: roster }, crOf, view.state.config!).length === 0;
}

const starterSet = (lineup: Lineup | null): string[] => (lineup === null ? [] : [lineup.captain, ...lineup.allies].sort());

// ── missions ────────────────────────────────────────────────────────────────

/** seasons/season-01/missions/candidates/example-drowned-toll.yaml, by hand. */
const DROWNED_TOLL: Mission = missionOf(
  [
    start(),
    skillCheck('find-path', 1, 'survival', 12),
    skillCheck('slip-past', 2, 'stealth', 14),
    battle('bog-ambush', 2, [
      { ref: 'crocodile', count: 3 },
      { ref: 'giant-frog', count: 4 },
    ]),
    skillCheck('haul-chain', 3, 'athletics', 13),
    battle('toll-fight', 3, [
      { ref: 'lizardfolk', count: 6 },
      { ref: 'giant-crocodile', count: 1 },
    ]),
    check('wade-across', 4, { type: 'save', ability: 'con', dc: 12 }),
    end('crossed-dry', 5),
    end('crossed-wet', 5),
    end('toll-seized', 5),
  ],
  [
    edge('start', 'find-path', 'always'),
    edge('find-path', 'slip-past', 'pass'),
    edge('find-path', 'bog-ambush', 'fail'),
    edge('bog-ambush', 'haul-chain', 'win'),
    edge('slip-past', 'haul-chain', 'pass'),
    edge('slip-past', 'toll-fight', 'fail'),
    edge('haul-chain', 'crossed-dry', 'pass'),
    edge('haul-chain', 'wade-across', 'fail'),
    edge('wade-across', 'crossed-wet', 'pass'),
    edge('wade-across', 'crossed-wet', 'fail'),
    edge('toll-fight', 'toll-seized', 'win'),
  ],
  'example-drowned-toll',
);

/** No battles: three sneaky checks, one gated on a fly speed. Rewards skill over CR. */
const NIGHT_HEIST: Mission = missionOf(
  [
    start(),
    skillCheck('creep', 1, 'stealth', 15),
    check('rooftop', 2, { type: 'skill', skill: 'acrobatics', dc: 13, requires: { speed: 'fly' } }),
    skillCheck('lift', 3, 'sleight_of_hand', 14),
    end('away', 4),
  ],
  [
    edge('start', 'creep', 'always'),
    edge('creep', 'rooftop', 'always'),
    edge('rooftop', 'lift', 'always'),
    edge('lift', 'away', 'always'),
  ],
  'night-heist',
);

const MISSIONS = { 1: DROWNED_TOLL, 2: NIGHT_HEIST } as const;

// ── a hand-built league ─────────────────────────────────────────────────────

/** CR 8, 2, 3, 2, 1/8, 1/2, 5, in draft order. */
const FLAGON = ['c-hydra', 'c-ogre', 'c-werewolf', 'c-bandit-captain', 'c-flying-snake', 'c-lizardfolk', 'c-vampire-spawn'];
const SKULL = ['c-young-red-dragon', 'c-ghost', 'c-giant-badger'];

const league = stateOf(FIXTURE_POOL, { flagon: FLAGON, skull: SKULL });
const flagonView = (missions: Readonly<Record<number, Mission>> = MISSIONS, seed = 'test-seed'): PublicView =>
  viewOf(league, 'flagon', FIXTURE_POOL, missions, seed);

/** Exact projection of a lineup, as the weekly run would compute it. */
function projected(view: PublicView, lineup: Lineup, mission: Mission): number {
  const members = [lineup.captain, ...lineup.allies].map(view.statsOf);
  return projectMission({ captain: lineup.captain, members }, mission, view.baseOf, view.battleModel).expectedScore;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── draft ───────────────────────────────────────────────────────────────────

describe('draft strategies', () => {
  const draftViews = (): ReadonlyArray<{ view: PublicView; available: string[] }> => {
    const empty = stateOf(FIXTURE_POOL, { flagon: [], skull: [] });
    const mid = stateOf(FIXTURE_POOL, { flagon: ['c-hydra', 'c-ogre'], skull: ['c-young-red-dragon', 'c-ghost'] });
    return [
      { view: viewOf(empty, 'flagon', FIXTURE_POOL), available: freeAgents(empty) },
      { view: viewOf(mid, 'flagon', FIXTURE_POOL), available: freeAgents(mid) },
      { view: viewOf(mid, 'skull', FIXTURE_POOL), available: freeAgents(mid) },
    ];
  };

  it.each(Object.values(DRAFT_STRATEGIES))('$id returns an available character', (strategy) => {
    for (const { view, available } of draftViews()) {
      const pick = strategy.pick(view, available);
      expect(available).toContain(pick);
      expect(view.state.owner.has(pick)).toBe(false);
    }
  });

  it.each(Object.values(DRAFT_STRATEGIES))('$id does not depend on the order of `available`', (strategy) => {
    for (const { view, available } of draftViews()) {
      const again = viewOf(view.state, view.tavern, FIXTURE_POOL);
      expect(strategy.pick(again, [...available].reverse())).toBe(strategy.pick(viewOf(view.state, view.tavern, FIXTURE_POOL), available));
    }
  });

  it('cr-greedy takes the highest CR, ties by id', () => {
    const empty = stateOf(FIXTURE_POOL, { flagon: [] });
    expect(crGreedyDraft.pick(viewOf(empty, 'flagon', FIXTURE_POOL), freeAgents(empty))).toBe('c-purple-worm');
  });

  it('skips a pick that would leave no legal lineup', () => {
    // Six drafted, one pick left. The cheapest three already total 2 + 2 + 5 = 9,
    // so the last pick must be CR 3 or less. cr-greedy would like the ghost (4).
    const roster = ['c-purple-worm', 'c-young-red-dragon', 'c-hydra', 'c-earth-elemental', 'c-ogre', 'c-bandit-captain'];
    const state = stateOf(FIXTURE_POOL, { flagon: roster });
    const view = viewOf(state, 'flagon', FIXTURE_POOL);
    const available = freeAgents(state);
    expect(keepsLineupPossible(view, 'c-ghost', available)).toBe(false);
    expect(crGreedyDraft.pick(view, available)).toBe('c-werewolf');
    for (const strategy of Object.values(DRAFT_STRATEGIES)) {
      const pick = strategy.pick(viewOf(state, 'flagon', FIXTURE_POOL), available);
      expect(maxCrLineup.best(view, [...roster, pick], 1)).not.toBeNull();
    }
  });

  it('skill-coverage adds a skill the roster lacks', () => {
    const state = stateOf(FIXTURE_POOL, { flagon: ['c-young-red-dragon'] });
    const view = viewOf(state, 'flagon', FIXTURE_POOL);
    const info = poolInfo(view);
    const before = covered(info, ['c-young-red-dragon'], view);
    const pick = DRAFT_STRATEGIES['skill-coverage'].pick(view, freeAgents(state));
    const after = covered(info, ['c-young-red-dragon', pick], view);
    expect(after).toBeGreaterThan(before);
    for (const other of freeAgents(state)) expect(covered(info, ['c-young-red-dragon', other], view)).toBeLessThanOrEqual(after);
  });

  it('value prefers strength per CR, with fodder priced at the CR floor', () => {
    const empty = stateOf(FIXTURE_POOL, { flagon: [] });
    const view = viewOf(empty, 'flagon', FIXTURE_POOL);
    const pick = DRAFT_STRATEGIES.value.pick(view, freeAgents(empty));
    const { value } = poolInfo(view);
    for (const id of freeAgents(empty)) expect(value.get(pick)!).toBeGreaterThanOrEqual(value.get(id)!);
    // A CR 0 frog never wins on the ratio alone.
    expect(value.get('c-frog')!).toBeLessThan(value.get(pick)!);
  });

  it('random draws from view.rng and varies with the seed', () => {
    const empty = stateOf(FIXTURE_POOL, { flagon: [] });
    const picks = new Set(['a', 'b', 'c', 'd', 'e', 'f'].map((seed) => randomDraft.pick(viewOf(empty, 'flagon', FIXTURE_POOL, {}, seed), freeAgents(empty))));
    expect(picks.size).toBeGreaterThan(1);
  });

  it('a full 8-tavern snake draft from a 64-character snapshot pool leaves every roster a legal lineup', () => {
    for (const seed of ['draft-a', 'draft-b', 'draft-c', 'draft-d']) {
      const { pool, results } = snapshotSeason(seed);
      const state = stateOf(pool, Object.fromEntries(results.map((r) => [r.tavern, r.roster])));
      for (const { tavern, roster } of results) {
        expect(roster).toHaveLength(7);
        expect(maxCrLineup.best(viewOf(state, tavern, pool), roster, 1), `${seed} ${tavern} (${roster.join(', ')})`).not.toBeNull();
      }
    }
  });
});

function covered(info: ReturnType<typeof poolInfo>, roster: ReadonlyArray<string>, view: PublicView): number {
  return coveredSkills(info, roster.map(view.statsOf)).size;
}

// ── lineups ─────────────────────────────────────────────────────────────────

describe('lineup strategies', () => {
  it.each(Object.values(LINEUP_STRATEGIES))('$id returns a legal lineup on a hand-built roster, every week', (strategy) => {
    for (const missions of [MISSIONS, {}]) {
      for (const { week } of SCHEDULE) {
        const view = flagonView(missions);
        expect(isLegal(view, strategy.lineup(view, week)), `week ${week}`).toBe(true);
      }
    }
  });

  it('max-cr spends the most CR under B', () => {
    const lineup = maxCrLineup.lineup(flagonView(), 1);
    // Vampire spawn 5 + werewolf 3 + ogre 2 + bandit captain 2 = 12, the only way to reach B.
    expect(starterSet(lineup)).toEqual(['c-bandit-captain', 'c-ogre', 'c-vampire-spawn', 'c-werewolf']);
    expect(lineup?.captain).toBe('c-vampire-spawn');
  });

  it.each([1, 2])('projection beats or equals max-cr on projected score (week %i)', (week) => {
    const view = flagonView();
    const mission = MISSIONS[week as 1 | 2];
    const mine = projected(view, projectionLineup.lineup(view, week)!, mission);
    const theirs = projected(view, maxCrLineup.lineup(view, week)!, mission);
    expect(mine).toBeGreaterThanOrEqual(theirs);
    if (week === 2) expect(mine).toBeGreaterThan(theirs); // the heist rewards the cheap sneaks
  });

  it('projection finds the best of every legal subset × captain choice', () => {
    const view = flagonView();
    for (const week of [1, 2] as const) {
      const mission = MISSIONS[week];
      let best = -1;
      for (const subset of subsetsOf(FLAGON, 4)) {
        for (const captain of subset) {
          const lineup = { captain, allies: subset.filter((id) => id !== captain) as unknown as Lineup['allies'] };
          if (isLegal(view, lineup)) best = Math.max(best, projected(view, lineup, mission));
        }
      }
      expect(projected(view, projectionLineup.lineup(view, week)!, mission)).toBeCloseTo(best, 12);
      expect(projectionLineup.best(view, FLAGON, week)!.score).toBeCloseTo(best, 12);
    }
  });

  it('projection falls back to max-cr when the mission is unknown', () => {
    const view = flagonView({});
    expect(projectionLineup.lineup(view, 1)).toEqual(maxCrLineup.lineup(view, 1));
  });

  it('a roster with only one legal lineup gets it from every strategy', () => {
    // B = 2: only the four cheapest (1/2 + 1/2 + 1/2 + 1/4 = 1 3/4) fit; any CR 2 busts it.
    const roster = ['c-ogre', 'c-black-bear', 'c-bandit-captain', 'c-crocodile', 'c-hunter-shark', 'c-lizardfolk', 'c-giant-badger'];
    const state = stateOf(FIXTURE_POOL, { flagon: roster }, configWith(16));
    for (const strategy of Object.values(LINEUP_STRATEGIES)) {
      for (const missions of [MISSIONS, {}]) {
        const view = viewOf(state, 'flagon', FIXTURE_POOL, missions);
        const lineup = strategy.lineup(view, 1);
        expect(isLegal(view, lineup)).toBe(true);
        expect(starterSet(lineup)).toEqual(['c-black-bear', 'c-crocodile', 'c-giant-badger', 'c-lizardfolk']);
      }
    }
  });

  it('a roster with no legal lineup gets null', () => {
    const state = stateOf(FIXTURE_POOL, { flagon: ['c-hydra', 'c-young-red-dragon', 'c-purple-worm', 'c-ghost'] });
    for (const strategy of Object.values(LINEUP_STRATEGIES)) expect(strategy.lineup(viewOf(state, 'flagon', FIXTURE_POOL, MISSIONS), 1)).toBeNull();
  });

  it('environment-fit weights skills and gates by the schedule entry', () => {
    const swamp = fitWeights(SCHEDULE[0]);
    expect(swamp.skills.survival).toBeGreaterThan(swamp.skills.arcana);
    expect(swamp.requires.has('speed:swim')).toBe(true);
    const underground = fitWeights(SCHEDULE[1]);
    expect(underground.requires.get('sense:darkvision')!.weight).toBeGreaterThan(0);
    const urban = fitWeights(SCHEDULE[5]);
    expect(urban.skills.persuasion).toBeGreaterThan(urban.skills.athletics);
    expect(fitWeights(undefined).requires.size).toBe(0);
    // The same party fits underground better when it can see in the dark.
    const hydra = flagonView().statsOf('c-hydra');
    expect(checkFit([hydra], underground)).toBeGreaterThan(checkFit([{ ...hydra, senses: {} }], underground));
    expect(checkFit([hydra], swamp)).toBe(checkFit([{ ...hydra, senses: {} }], swamp));
  });
});

function subsetsOf<T>(items: ReadonlyArray<T>, k: number): T[][] {
  if (k === 0) return [[]];
  return items.flatMap((item, i) => subsetsOf(items.slice(i + 1), k - 1).map((rest) => [item, ...rest]));
}

// ── waivers ─────────────────────────────────────────────────────────────────

describe('waivers: best-available', () => {
  it('claims the free agent that most improves next week, dropping the worst bench player', () => {
    // Week 1 is locked, so claims play in week 2: the heist, with a rooftop
    // only a flier can attempt. Swap the flying snake for a frog and nobody flies.
    const roster = FLAGON.map((id) => (id === 'c-flying-snake' ? 'c-frog' : id));
    const state = stateOf(FIXTURE_POOL, { flagon: roster, skull: SKULL }, B12, { locked: [1] });
    const view = viewOf(state, 'flagon', FIXTURE_POOL, MISSIONS);
    const waivers = bestAvailable(projectionLineup);
    const claims = waivers.claims(view, freeAgents(state));
    expect(claims.length).toBeGreaterThan(0);
    const before = projectionLineup.best(view, roster, 2)!;
    const bench = roster.filter((id) => !starterSet(before.lineup).includes(id));
    let previous = Infinity;
    for (const { add, drop } of claims) {
      expect(freeAgents(state)).toContain(add);
      expect(bench).toContain(drop);
      expect(drop).toBe(claims[0]!.drop); // later claims are fallbacks with the same drop
      const after = [...roster.filter((id) => id !== drop), add];
      const scored = projectionLineup.best(view, after, 2)!;
      expect(isLegal(view, scored.lineup, after)).toBe(true);
      expect(scored.score).toBeGreaterThan(before.score);
      expect(scored.score).toBeLessThanOrEqual(previous);
      previous = scored.score;
    }
    expect(['c-bat', 'c-flying-snake']).toContain(claims[0]!.add);
  });

  it('fills open roster slots without dropping anyone', () => {
    const state = stateOf(FIXTURE_POOL, { flagon: FLAGON.slice(0, 5), skull: SKULL }, B12, { finalized: [1], locked: [1] });
    const claims = bestAvailable(projectionLineup).claims(viewOf(state, 'flagon', FIXTURE_POOL, MISSIONS), freeAgents(state));
    expect(claims).toHaveLength(2);
    for (const claim of claims) expect(claim.drop).toBeNull();
    expect(new Set(claims.map((c) => c.add)).size).toBe(2);
  });

  it('claims nothing when nothing helps, or after the last week', () => {
    const view = flagonView();
    expect(bestAvailable(projectionLineup).claims(view, [])).toEqual([]);
    const over = stateOf(FIXTURE_POOL, { flagon: FLAGON }, B12, { locked: [1, 2, 3, 4, 5, 6], finalized: [1, 2, 3, 4, 5, 6] });
    expect(bestAvailable(projectionLineup).claims(viewOf(over, 'flagon', FIXTURE_POOL, MISSIONS), freeAgents(over))).toEqual([]);
    // max-cr already spends all of B, so no free agent can raise it.
    expect(bestAvailable(maxCrLineup).claims(view, freeAgents(league))).toEqual([]);
  });
});

// ── managers, determinism, purity ───────────────────────────────────────────

describe('bot managers', () => {
  it('every BOT_ID has a manager, and projection-off differs from value only in reading missions', () => {
    for (const id of BOT_IDS) {
      const bot = botManager(id);
      expect(bot.id).toBe(id);
      expect(bot.waivers.id).toBe('best-available');
      expect(bot.lineup.id).toBe(id === 'projection-off' ? 'max-cr' : 'projection');
      expect(bot.draft.id).toBe(id === 'projection-off' ? 'value' : id);
    }
  });

  it('every decision is deterministic for a fixed view and rng', () => {
    // Every call gets a fresh view, so a fresh rng stream from the same seed.
    const empty = stateOf(FIXTURE_POOL, { flagon: [] });
    const decide = (seed: string): unknown[] => {
      const out: unknown[] = [];
      for (const id of BOT_IDS) {
        const bot = botManager(id);
        out.push(bot.draft.pick(viewOf(empty, 'flagon', FIXTURE_POOL, {}, seed), freeAgents(empty)));
        for (const week of [1, 2, 3]) out.push(bot.lineup.lineup(flagonView(MISSIONS, seed), week));
        out.push(bot.waivers.claims(flagonView(MISSIONS, seed), freeAgents(league)));
      }
      for (const strategy of Object.values(LINEUP_STRATEGIES)) out.push(strategy.lineup(flagonView(MISSIONS, seed), 4));
      return out;
    };
    expect(decide('seed-1')).toEqual(decide('seed-1'));
    expect(snapshotSeason('seed-1').results).toEqual(snapshotSeason('seed-1').results);
  });

  it('never calls Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random called');
    });
    const empty = stateOf(FIXTURE_POOL, { flagon: [] });
    for (const strategy of Object.values(DRAFT_STRATEGIES)) strategy.pick(viewOf(empty, 'flagon', FIXTURE_POOL), freeAgents(empty));
    for (const strategy of Object.values(LINEUP_STRATEGIES)) strategy.lineup(flagonView(), 1);
    bestAvailable(projectionLineup).claims(flagonView(), freeAgents(league));
    expect(spy).not.toHaveBeenCalled();
  });

  it('the view carries the configured battle model', () => {
    expect(flagonView().battleModel).toBe(evTtkV0);
  });

  it('plays a whole snapshot-pool league: legal lineups and claims for every bot', () => {
    const { pool, results } = snapshotSeason('league');
    const state = stateOf(pool, Object.fromEntries(results.map((r) => [r.tavern, r.roster])));
    for (const { tavern, bot } of results) {
      for (const week of [1, 2, 3]) {
        const view = viewOf(state, tavern, pool, MISSIONS);
        expect(isLegal(view, botManager(bot).lineup.lineup(view, week)), `${tavern} week ${week}`).toBe(true);
      }
      const view = viewOf(state, tavern, pool, MISSIONS);
      const roster = state.taverns.get(tavern)!.roster;
      for (const { add, drop } of botManager(bot).waivers.claims(view, freeAgents(state))) {
        expect(state.owner.has(add)).toBe(false);
        const after = [...roster.filter((id) => id !== drop), add];
        expect(after).toHaveLength(7);
        expect(maxCrLineup.best(view, after, 1)).not.toBeNull();
      }
    }
  });
});

describe('performance', () => {
  it('picks a projection lineup quickly', () => {
    const view = flagonView();
    projectionLineup.lineup(view, 1); // warm up
    const runs = 50;
    const t0 = performance.now();
    for (let i = 0; i < runs; i++) projectionLineup.lineup(view, 1);
    const ms = (performance.now() - t0) / runs;
    process.stderr.write(`projection lineup (7-character roster, 35 subsets, drowned toll): ${ms.toFixed(3)} ms\n`);
    expect(ms).toBeLessThan(50);
  });
});

// ── a snapshot-pool league ──────────────────────────────────────────────────

let SNAPSHOT_POOL: Pool | undefined;

/** 64 creatures from the pinned snapshot, CR 1/8 to 8, evenly spaced by slug. */
function snapshotPool(): Pool {
  if (SNAPSHOT_POOL !== undefined) return SNAPSHOT_POOL;
  const bySlug = new Map(loadSnapshot().map((r) => [r.slug, toBaseStats(r).stats] as const));
  const bases = [...bySlug.values()].filter((b) => b.cr > 0 && b.cr <= 64).sort((a, b) => (a.slug < b.slug ? -1 : 1));
  const step = bases.length / 64;
  const pooled = Array.from({ length: 64 }, (_, i) => bases[Math.floor(i * step)]!);
  SNAPSHOT_POOL = poolFrom(pooled, (slug) => bySlug.get(slug)!);
  return SNAPSHOT_POOL;
}

/**
 * The snapshot pool drafted by 8 taverns in a snake draft, one bot each (the five presets,
 * then repeats). Returns each tavern's roster in draft order.
 */
function snapshotSeason(seed: string): {
  pool: Pool;
  results: ReadonlyArray<{ tavern: string; bot: (typeof BOT_IDS)[number]; roster: string[] }>;
} {
  const pool = snapshotPool();

  const taverns = Array.from({ length: 8 }, (_, i) => `t${i}`);
  const bots = taverns.map((_, i) => BOT_IDS[i % BOT_IDS.length]!);
  const rosters: Record<string, string[]> = Object.fromEntries(taverns.map((t) => [t, []]));
  for (let pick = 0; pick < 8 * 7; pick++) {
    const tavern = snakePickOwner(taverns, pick);
    const state = stateOf(pool, rosters);
    const view = viewOf(state, tavern, pool, {}, seed, `draft:${pick}`);
    const choice = botManager(bots[taverns.indexOf(tavern)]!).draft.pick(view, freeAgents(state));
    rosters[tavern] = [...rosters[tavern]!, choice];
  }
  return { pool, results: taverns.map((tavern, i) => ({ tavern, bot: bots[i]!, roster: rosters[tavern]! })) };
}

