/**
 * League structure for the Lich's contest: the season config, scoring and
 * standings (docs/lich-contest-plan.md §1).
 *
 * - `SeasonConfig` is the parsed form of seasons/<id>/config.yaml. The YAML
 *   loader lives in scripts/.
 * - A tavern scores for its monsters (surviving votes, immunity, jury votes,
 *   winning) and for its correct calls. Standings rank taverns by their
 *   total points; the most points after the finale wins the season.
 *
 * Everything here is derived from events and never stored.
 */
import type { VoteModel } from '../contest/model';

export interface SeasonConfig {
  readonly id: string;
  readonly snapshot: string;
  readonly modifierRegistryVersion: number;
  readonly budget: {
    readonly modifierPointsPerCharacter: number;
  };
  readonly roster: {
    /** Monsters each tavern drafts. Taverns × size must not exceed the cast. */
    readonly size: number;
  };
  readonly draft: {
    readonly format: 'snake';
    /** Over managers: the seeded shuffle, or a manual list of manager ids. Taverns are then chosen in reverse. */
    readonly order: { readonly mode: 'seeded' } | { readonly mode: 'manual'; readonly managers: ReadonlyArray<string> };
  };
  readonly contest: {
    /** Monsters in the contest, drawn from the pool. */
    readonly castSize: number;
    /** Monsters left to face the jury. Votes = castSize − finalists. */
    readonly finalists: number;
    /** DC added each time a challenge's checks come round again. */
    readonly lapDc: number;
    /** Overrides for the vote model's dials (contest/model.ts `VOTE_MODEL`). */
    readonly model: Partial<VoteModel>;
  };
  readonly scoring: {
    /** Each owned monster still in after a vote. */
    readonly survive: number;
    /** An owned monster wins immunity. */
    readonly immunity: number;
    /** Each jury vote an owned finalist receives. */
    readonly juryVote: number;
    /** An owned monster wins the contest. */
    readonly winner: number;
    /** A correct call. */
    readonly call: number;
    /** Added to a correct call made before the challenge. */
    readonly earlyCallBonus: number;
  };
}

/** The most taverns, and so managers, a league can have. */
export const MAX_TAVERNS = 6;

/** Votes in a season: one per episode, until the finalists are left. */
export function votesIn(config: SeasonConfig): number {
  return config.contest.castSize - config.contest.finalists;
}

/** Problems with a config's contest shape, in words. Empty when it is consistent. */
export function configIssues(config: SeasonConfig, taverns: number): ReadonlyArray<string> {
  const issues: string[] = [];
  const { castSize, finalists } = config.contest;
  if (finalists < 1) issues.push(`contest.finalists must be at least 1, got ${finalists}`);
  if (castSize <= finalists) issues.push(`contest.castSize (${castSize}) must be more than finalists (${finalists})`);
  if (taverns * config.roster.size > castSize) issues.push(`${taverns} taverns × roster ${config.roster.size} is more than the cast of ${castSize}`);
  return issues;
}

// ── standings ─────────────────────────────────────────────────────────────

export interface StandingRow {
  /** 1-based. Taverns on equal points share a rank. */
  readonly rank: number;
  readonly tavern: string;
  /** Total points so far. */
  readonly points: number;
}

/**
 * The table: every tavern in `taverns`, by total points. Equal points share a
 * rank; display order breaks them by `taverns` order.
 */
export function standings(taverns: ReadonlyArray<string>, points: ReadonlyMap<string, number>): ReadonlyArray<StandingRow> {
  const of = (t: string): number => points.get(t) ?? 0;
  const sorted = [...taverns].sort((x, y) => of(y) - of(x) || taverns.indexOf(x) - taverns.indexOf(y));
  return sorted.map((tavern) => ({ rank: 1 + sorted.findIndex((o) => of(o) === of(tavern)), tavern, points: of(tavern) }));
}
