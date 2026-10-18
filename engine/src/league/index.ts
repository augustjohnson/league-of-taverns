/**
 * League structure for the Lich's contest: the season config, the
 * head-to-head schedule, scoring and standings
 * (docs/lich-contest-plan.md §1).
 *
 * - `SeasonConfig` is the parsed form of seasons/<id>/config.yaml. The YAML
 *   loader lives in scripts/.
 * - Taverns meet in a round-robin. Each round covers a stretch of episodes
 *   (`schedule.rounds`), and the finale falls in the last round.
 * - A tavern scores for its monsters (surviving votes, immunity, jury votes,
 *   winning) and for its correct calls. A matchup compares two taverns'
 *   points over the round's episodes; standings rank by wins, then points.
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
  readonly schedule: {
    /**
     * Episodes per head-to-head round, in order. They must add up to the
     * number of votes; the finale belongs to the last round.
     */
    readonly rounds: ReadonlyArray<number>;
  };
}

/** The most taverns, and so managers, a league can have. */
export const MAX_TAVERNS = 6;

/** Votes in a season: one per episode, until the finalists are left. */
export function votesIn(config: SeasonConfig): number {
  return config.contest.castSize - config.contest.finalists;
}

/** The round an episode belongs to (1-based), or throws if it is outside the schedule. */
export function roundOf(config: SeasonConfig, episode: number): number {
  let end = 0;
  for (const [i, n] of config.schedule.rounds.entries()) {
    end += n;
    if (episode <= end) return i + 1;
  }
  throw new Error(`episode ${episode} is past the schedule's ${end} episodes`);
}

/** The episodes in round `round` (1-based), in order. */
export function episodesOf(config: SeasonConfig, round: number): ReadonlyArray<number> {
  const before = config.schedule.rounds.slice(0, round - 1).reduce((a, b) => a + b, 0);
  const n = config.schedule.rounds[round - 1] ?? 0;
  return Array.from({ length: n }, (_, i) => before + i + 1);
}

/** Problems with a config's contest shape, in words. Empty when it is consistent. */
export function configIssues(config: SeasonConfig, taverns: number): ReadonlyArray<string> {
  const issues: string[] = [];
  const { castSize, finalists } = config.contest;
  if (finalists < 1) issues.push(`contest.finalists must be at least 1, got ${finalists}`);
  if (castSize <= finalists) issues.push(`contest.castSize (${castSize}) must be more than finalists (${finalists})`);
  if (taverns * config.roster.size > castSize) issues.push(`${taverns} taverns × roster ${config.roster.size} is more than the cast of ${castSize}`);
  const scheduled = config.schedule.rounds.reduce((a, b) => a + b, 0);
  if (scheduled !== votesIn(config)) issues.push(`schedule.rounds cover ${scheduled} episodes, but the season has ${votesIn(config)} votes`);
  if (config.schedule.rounds.some((n) => !Number.isInteger(n) || n < 1)) issues.push('schedule.rounds must be positive integers');
  return issues;
}

// ── head-to-head ──────────────────────────────────────────────────────────

/**
 * A round-robin by the circle method: `taverns` in their given order (the
 * draft order), the first fixed and the rest rotating. Gives n − 1 rounds of
 * n / 2 matchups for an even n; for an odd n, one tavern sits out each round
 * (a bye: it is left out of that round's pairs). Each pair meets once.
 * `rounds` > n − 1 repeats the cycle.
 */
export function roundRobin(taverns: ReadonlyArray<string>, rounds: number): ReadonlyArray<ReadonlyArray<readonly [string, string]>> {
  const ring: Array<string | null> = [...taverns];
  if (ring.length % 2 === 1) ring.push(null);
  const n = ring.length;
  const out: Array<Array<readonly [string, string]>> = [];
  if (n < 2) return Array.from({ length: rounds }, () => []);
  let order = [...ring];
  for (let r = 0; r < rounds; r++) {
    const pairs: Array<readonly [string, string]> = [];
    for (let i = 0; i < n / 2; i++) {
      const a = order[i]!;
      const b = order[n - 1 - i]!;
      if (a !== null && b !== null) pairs.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    out.push(pairs);
    order = [order[0]!, order[n - 1]!, ...order.slice(1, n - 1)];
  }
  return out;
}

/** One matchup's result. Equal points are a tie. */
export interface MatchupResult {
  readonly round: number;
  readonly home: string;
  readonly away: string;
  readonly homePoints: number;
  readonly awayPoints: number;
  /** The winner, or null on a tie. */
  readonly winner: string | null;
}

export interface StandingRow {
  /** 1-based. Rows equal on wins, ties and points share a rank. */
  readonly rank: number;
  readonly tavern: string;
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** Total points over the rounds counted. */
  readonly points: number;
}

/**
 * The table from finished matchups and every tavern's points: by record
 * (a win 1, a tie ½), then by total points. Every tavern in `taverns` gets a
 * row. Display order breaks remaining ties by `taverns` order.
 */
export function standings(
  taverns: ReadonlyArray<string>,
  matchups: ReadonlyArray<MatchupResult>,
  points: ReadonlyMap<string, number>,
): ReadonlyArray<StandingRow> {
  const rec = new Map(taverns.map((t) => [t, { wins: 0, losses: 0, ties: 0 }]));
  for (const m of matchups) {
    const h = rec.get(m.home) ?? { wins: 0, losses: 0, ties: 0 };
    const a = rec.get(m.away) ?? { wins: 0, losses: 0, ties: 0 };
    if (m.winner === null) {
      h.ties++;
      a.ties++;
    } else if (m.winner === m.home) {
      h.wins++;
      a.losses++;
    } else {
      a.wins++;
      h.losses++;
    }
    rec.set(m.home, h);
    rec.set(m.away, a);
  }
  const score = (t: string): number => {
    const r = rec.get(t)!;
    return r.wins + r.ties / 2;
  };
  const sorted = [...rec.keys()].sort((x, y) => score(y) - score(x) || (points.get(y) ?? 0) - (points.get(x) ?? 0) || taverns.indexOf(x) - taverns.indexOf(y));
  return sorted.map((tavern) => {
    const r = rec.get(tavern)!;
    const rank = 1 + sorted.findIndex((o) => score(o) === score(tavern) && (points.get(o) ?? 0) === (points.get(tavern) ?? 0));
    return { rank, tavern, wins: r.wins, losses: r.losses, ties: r.ties, points: points.get(tavern) ?? 0 };
  });
}
