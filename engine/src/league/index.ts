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
import { notImplemented } from '../internal/not-implemented';

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
  readonly secrecy: 'private_repo' | 'commit_reveal' | 'encrypted';
  readonly seedSalt: 'none' | 'revealed_with_mission';
  readonly missions: Omit<MissionRules, 'partyCr'> & { readonly battleModel: string };
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

/** Round-robin head-to-head pairings for `weeks` weeks. Deterministic for a given tavern order. */
export function headToHeadSchedule(_taverns: ReadonlyArray<string>, _weeks: number): ReadonlyArray<Matchup> {
  return notImplemented('headToHeadSchedule', 'T4.6');
}

/**
 * Standings from finalized results. Each week's matchup winner is decided by
 * points, then the config's tiebreakers in order. `rng` serves the
 * `seeded_coin` tiebreaker, so callers pass a seeded stream and tests pass a fake.
 */
export function standings(
  _matchups: ReadonlyArray<Matchup>,
  _results: ReadonlyArray<WeekResult>,
  _config: SeasonConfig,
  _rng: Rng,
): ReadonlyArray<StandingRow> {
  return notImplemented('standings', 'T4.6');
}
