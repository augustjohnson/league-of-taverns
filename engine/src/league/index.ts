/**
 * League structure: season config and standings.
 *
 * Responsibilities:
 * - Define `SeasonConfig`, the parsed and normalized form of
 *   seasons/<id>/config.yaml. The YAML loader lives in scripts/; this is the
 *   shape the engine receives (CR values already in eighths).
 * - Sponsors and the home bonus (D-47, D-48): which tavern is home in a
 *   week, and the points a run earns there. The GM's season package says
 *   who sponsors whom and the bonus size. The engine only applies it.
 * - Rank taverns by total loot from finalized weeks (a league table, D-04).
 *
 * Standings are always derived from events and never stored.
 */
import type { MissionRules } from '../missions';
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
  readonly scoring: {
    /** Points = round(score × pointsScale × homeBonus at home, else × 1). */
    readonly pointsScale: number;
    /** Loot multiplier for a tavern on its sponsor's mission (D-47). 1 turns the bonus off. */
    readonly homeBonus: number;
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

/** A god from the GM's season package and the tavern it sponsors (D-44). Names and voice are chrome. */
export interface Sponsor {
  readonly id: string;
  readonly tavern: string;
}

/** The part of a schedule entry sponsors care about. */
export interface SponsoredWeek {
  readonly week: number;
  /** The sponsor whose mission this week is, or null for an unsponsored week. */
  readonly sponsor: string | null;
}

export interface SponsorIssue {
  readonly code: 'duplicate_sponsor' | 'duplicate_tavern' | 'unknown_sponsor' | 'sponsor_reused';
  readonly message: string;
}

/**
 * Check the season package's sponsors against its schedule:
 * - sponsor ids are unique, and so are their taverns (one god per tavern);
 * - every week's sponsor is a listed sponsor;
 * - a sponsor sets at most one week's mission (D-48).
 *
 * A week with no sponsor, or a sponsor with no week, is allowed. Whether the
 * taverns exist is checked where taverns are known (managers.yaml, the draft).
 */
export function validateSponsors(sponsors: ReadonlyArray<Sponsor>, schedule: ReadonlyArray<SponsoredWeek>): ReadonlyArray<SponsorIssue> {
  const issues: SponsorIssue[] = [];
  const ids = new Set<string>();
  const taverns = new Map<string, string>();
  for (const { id, tavern } of sponsors) {
    if (ids.has(id)) issues.push({ code: 'duplicate_sponsor', message: `sponsor "${id}" is listed twice` });
    ids.add(id);
    const other = taverns.get(tavern);
    if (other !== undefined) issues.push({ code: 'duplicate_tavern', message: `"${tavern}" is sponsored by both "${other}" and "${id}"` });
    else taverns.set(tavern, id);
  }
  const weekOf = new Map<string, number>();
  for (const { week, sponsor } of schedule) {
    if (sponsor === null) continue;
    if (!ids.has(sponsor)) issues.push({ code: 'unknown_sponsor', message: `week ${week} names sponsor "${sponsor}", which is not listed` });
    const first = weekOf.get(sponsor);
    if (first !== undefined) issues.push({ code: 'sponsor_reused', message: `sponsor "${sponsor}" sets both week ${first} and week ${week}` });
    else weekOf.set(sponsor, week);
  }
  return issues;
}

/** The home tavern for `week`: the tavern its sponsor backs, or null for an unsponsored week. */
export function sponsoredTavern(sponsors: ReadonlyArray<Sponsor>, schedule: ReadonlyArray<SponsoredWeek>, week: number): string | null {
  const sponsor = schedule.find((w) => w.week === week)?.sponsor ?? null;
  if (sponsor === null) return null;
  return sponsors.find((s) => s.id === sponsor)?.tavern ?? null;
}

/** The points multiplier a tavern gets: `homeBonus` at home, else 1. */
export function pointsMultiplier(scoring: SeasonConfig['scoring'], home: boolean): number {
  return home ? scoring.homeBonus : 1;
}

/** A run's points: round(score × pointsScale × the home multiplier). */
export function runPoints(score: number, scoring: SeasonConfig['scoring'], home: boolean): number {
  return Math.round(score * scoring.pointsScale * pointsMultiplier(scoring, home));
}

/** Exact expected points, unrounded like the projection itself: expectedScore × pointsScale × the home multiplier. */
export function projectedPoints(expectedScore: number, scoring: SeasonConfig['scoring'], home: boolean): number {
  return expectedScore * scoring.pointsScale * pointsMultiplier(scoring, home);
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
  /** 1-based. Taverns on equal points share a rank (1, 1, 3). */
  readonly rank: number;
  readonly tavern: string;
  /** Total loot over the given weeks. */
  readonly points: number;
}

/**
 * A league table: every tavern ranked by total points over `results`, with
 * no head-to-head and no tiebreakers (docs/decisions.md D-04, D-14).
 *
 * - Every tavern in `taverns` or `results` gets a row, even with no results.
 * - Equal totals share a rank. A tie for first means co-champions.
 * - Rows sort by points desc, then tavern id, for a stable display order only.
 *
 * Pass one week's results for that week's table.
 */
export function standings(taverns: ReadonlyArray<string>, results: ReadonlyArray<WeekResult>): ReadonlyArray<StandingRow> {
  const seen = new Set<string>();
  const totals = new Map<string, number>(taverns.map((t) => [t, 0]));
  for (const r of results) {
    const k = `${r.week}\u0000${r.tavern}`;
    if (seen.has(k)) throw new Error(`standings: duplicate result for tavern "${r.tavern}" in week ${r.week}`);
    seen.add(k);
    totals.set(r.tavern, (totals.get(r.tavern) ?? 0) + r.points);
  }
  const sorted = [...totals].sort(([a, x], [b, y]) => y - x || cmp(a, b));
  return sorted.map(([tavern, points]) => ({
    rank: sorted.findIndex(([, p]) => p === points) + 1,
    tavern,
    points,
  }));
}

/** Code-unit string order, independent of locale. */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
