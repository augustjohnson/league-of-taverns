/**
 * League structure: season config, the head-to-head schedule, and standings.
 *
 * Responsibilities:
 * - Define `SeasonConfig`, the parsed and normalized form of
 *   seasons/<id>/config.yaml. The YAML loader lives in scripts/; this is the
 *   shape the engine receives (CR values already in eighths).
 * - Generate head-to-head pairings for the regular season.
 * - Compute standings and tiebreaks from finalized weeks.
 *
 * Standings are always derived from events and never stored.
 */
import type { MissionRules } from '../missions';
import type { Rng } from '../rng';
import type { CrEighths } from '../vocabulary';

export interface SeasonConfig {
  readonly id: string;
  readonly snapshot: string;
  readonly modifierRegistryVersion: number;
  readonly weeks: number;
  readonly budget: {
    /** B: total CR of the four starters must be ≤ this. */
    readonly partyCr: CrEighths;
    readonly modifierPointsPerCharacter: number;
  };
  readonly roster: {
    readonly size: number;
    readonly starters: 4;
    readonly ownership: 'exclusive' | 'shared';
  };
  readonly draft: {
    readonly format: 'snake';
    readonly rounds: number;
    readonly order: { readonly mode: 'seeded' } | { readonly mode: 'manual'; readonly taverns: ReadonlyArray<string> };
    readonly pickWindowHours: number;
    readonly onTimeout: 'autopick' | 'skip' | 'wait';
  };
  readonly matchups: {
    readonly format: 'head_to_head';
    readonly playoffs: { readonly enabled: boolean; readonly teams: number; readonly weeks: ReadonlyArray<number> };
  };
  readonly scoring: {
    /** Points = round(score × pointsScale). */
    readonly pointsScale: number;
    readonly tiebreakers: ReadonlyArray<'projected' | 'checks_passed' | 'seeded_coin'>;
  };
  readonly waivers: { readonly priority: 'rolling'; readonly initialOrder: 'reverse_draft' };
  readonly trades: {
    readonly vetoWindowHours: number;
    readonly vetoBy: 'commissioner';
    readonly deadlineWeek: number | null;
  };
  readonly missedLineup: 'carry_over';
  /** Actions cron expressions (UTC). The engine never evaluates them. They ride along for scripts. */
  readonly schedules: { readonly lineupLock: string; readonly weeklyRun: string; readonly waivers: string };
  /** `open` (D-08, decided): missions are public in the repo. The others are kept in case secrecy returns. */
  readonly secrecy: 'open' | 'private_repo' | 'commit_reveal' | 'encrypted';
  readonly seedSalt: 'none' | 'revealed_with_mission';
  /** Mission rules. `haul` is required here: every season has a fixed haul (docs/decisions.md D-45). */
  readonly missions: Omit<MissionRules, 'partyCr' | 'haul'> & { readonly haul: number; readonly battleModel: string };
  readonly carryover: {
    readonly mode: 'none' | 'keeper';
    readonly keepersPerTavern: number;
    readonly keeperCost: 'none' | 'round_of_last_season_pick' | 'fixed_round';
    readonly championBonusKeepers: number;
    readonly maxModifierChangePoints: number;
  };
}

export interface Matchup {
  readonly week: number;
  readonly home: string;
  readonly away: string;
}

/** One finalized week for one tavern, as read from `week.finalized`. */
export interface WeekResult {
  readonly week: number;
  readonly tavern: string;
  readonly points: number;
  readonly projected: number;
  readonly checksPassed: number;
}

export interface StandingRow {
  readonly tavern: string;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  readonly pointsFor: number;
  readonly pointsAgainst: number;
}

/**
 * Round-robin head-to-head pairings for `weeks` weeks (numbered from 1), by
 * the circle method. Deterministic for a given tavern order.
 *
 * - Each tavern plays at most once per week. One cycle is `n − 1` weeks for an
 *   even count and `n` weeks for an odd count, and within a cycle every pair
 *   meets exactly once.
 * - Odd count: a phantom bye slot is added. A tavern on a bye is simply absent
 *   from that week's matchups, and each tavern gets exactly one bye per cycle.
 * - Home/away: the fixed slot alternates by week and the other boards
 *   alternate by board index, so no tavern has more than three home or away
 *   weeks in a row within a cycle.
 * - Weeks past one cycle repeat it with home and away swapped (a double
 *   round-robin), which evens out the home/away count over two cycles.
 */
export function headToHeadSchedule(taverns: ReadonlyArray<string>, weeks: number): ReadonlyArray<Matchup> {
  if (!Number.isInteger(weeks) || weeks < 0) throw new Error(`headToHeadSchedule: weeks must be a non-negative integer, got ${weeks}`);
  if (new Set(taverns).size !== taverns.length) throw new Error('headToHeadSchedule: taverns contain duplicates');
  if (taverns.length < 2) return [];

  const slots: ReadonlyArray<string | null> = taverns.length % 2 === 0 ? taverns : [...taverns, null];
  const m = slots.length;
  const cycleLength = m - 1;
  const matchups: Matchup[] = [];

  for (let w = 0; w < weeks; w++) {
    const round = w % cycleLength;
    const mirrored = Math.floor(w / cycleLength) % 2 === 1;
    // Circle method: slot 0 stays put and the other m − 1 slots rotate one step per round.
    const at = (i: number): string | null => (i === 0 ? slots[0]! : slots[1 + ((i - 1 - round + cycleLength) % cycleLength)]!);
    for (let board = 0; board < m / 2; board++) {
      const a = at(board);
      const b = at(m - 1 - board);
      if (a === null || b === null) continue; // bye
      const swap = (board === 0 ? round % 2 === 1 : board % 2 === 1) !== mirrored;
      matchups.push(swap ? { week: w + 1, home: b, away: a } : { week: w + 1, home: a, away: b });
    }
  }
  return matchups;
}

export type MatchupOutcome = 'home' | 'away' | 'tie';

/**
 * Decide one matchup: higher points wins, then each tiebreaker in order.
 * `projected` and `checks_passed` favour the higher value. `seeded_coin` draws
 * once from `rng` (home wins on `< 0.5`) and is only reached, and only draws,
 * when everything before it is level. If nothing separates them it's a tie.
 */
export function matchupWinner(
  home: WeekResult,
  away: WeekResult,
  tiebreakers: SeasonConfig['scoring']['tiebreakers'],
  rng: Rng,
): MatchupOutcome {
  const compare = (h: number, a: number): MatchupOutcome | null => (h > a ? 'home' : h < a ? 'away' : null);
  const byPoints = compare(home.points, away.points);
  if (byPoints) return byPoints;
  for (const tb of tiebreakers) {
    const decided =
      tb === 'projected'
        ? compare(home.projected, away.projected)
        : tb === 'checks_passed'
          ? compare(home.checksPassed, away.checksPassed)
          : rng() < 0.5
            ? 'home'
            : 'away';
    if (decided) return decided;
  }
  return 'tie';
}

/**
 * Standings from finalized results. Each week's matchup winner is decided by
 * points, then the config's tiebreakers in order. `rng` serves the
 * `seeded_coin` tiebreaker, so callers pass a seeded stream and tests pass a fake.
 *
 * - Matchups are processed in (week, home, away) order regardless of input
 *   order, so the coin flips consumed from `rng` are reproducible.
 * - A matchup is skipped (counted for nobody) unless both taverns have a
 *   result for that week, e.g. a week not yet finalized.
 * - Every tavern named in a matchup or a result gets a row, even with no games.
 * - Rows sort by wins desc, pointsFor desc, pointsAgainst asc, then tavern id.
 */
export function standings(
  matchups: ReadonlyArray<Matchup>,
  results: ReadonlyArray<WeekResult>,
  config: SeasonConfig,
  rng: Rng,
): ReadonlyArray<StandingRow> {
  const key = (week: number, tavern: string): string => `${week}\u0000${tavern}`;
  const byKey = new Map<string, WeekResult>();
  for (const r of results) {
    const k = key(r.week, r.tavern);
    if (byKey.has(k)) throw new Error(`standings: duplicate result for tavern "${r.tavern}" in week ${r.week}`);
    byKey.set(k, r);
  }

  type Row = { -readonly [K in keyof StandingRow]: StandingRow[K] };
  const rows = new Map<string, Row>();
  const row = (tavern: string): Row => {
    let r = rows.get(tavern);
    if (!r) {
      r = { tavern, wins: 0, losses: 0, ties: 0, pointsFor: 0, pointsAgainst: 0 };
      rows.set(tavern, r);
    }
    return r;
  };
  for (const m of matchups) {
    row(m.home);
    row(m.away);
  }
  for (const r of results) row(r.tavern);

  const ordered = [...matchups].sort((a, b) => a.week - b.week || cmp(a.home, b.home) || cmp(a.away, b.away));
  for (const m of ordered) {
    const home = byKey.get(key(m.week, m.home));
    const away = byKey.get(key(m.week, m.away));
    if (!home || !away) continue;
    const h = row(m.home);
    const a = row(m.away);
    h.pointsFor += home.points;
    h.pointsAgainst += away.points;
    a.pointsFor += away.points;
    a.pointsAgainst += home.points;
    const outcome = matchupWinner(home, away, config.scoring.tiebreakers, rng);
    if (outcome === 'home') {
      h.wins++;
      a.losses++;
    } else if (outcome === 'away') {
      a.wins++;
      h.losses++;
    } else {
      h.ties++;
      a.ties++;
    }
  }

  return [...rows.values()].sort(
    (x, y) => y.wins - x.wins || y.pointsFor - x.pointsFor || x.pointsAgainst - y.pointsAgainst || cmp(x.tavern, y.tavern),
  );
}

/** Code-unit string order, independent of locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
