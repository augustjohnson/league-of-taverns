/**
 * Waiver strategies.
 */
import { valueOf } from '../metrics';
import type { LineupStrategy, PublicView, WaiverStrategy } from '../types';
import { byId, configOf, nextWeek, rosterOf, startersOf } from '../view';

/** A claim must beat the current roster's score by more than this. */
const EPS = 1e-12;
/** Claims returned when the roster is full: the best, plus fallbacks if it goes to a tavern with higher priority. */
export const MAX_FALLBACK_CLAIMS = 3;

type Claim = { readonly add: string; readonly drop: string | null };

/**
 * `best-available`, scored by `lineup`'s own objective for the week the
 * claim would first play in (`nextWeek`; with open missions, that week's
 * projection). Myopic by design: it looks one week ahead.
 *
 * - **Open roster slots:** claim the free agents whose roster scores best,
 *   one per open slot, drop none. An empty slot is worth nothing, so these
 *   are claimed even without a score gain.
 * - **Full roster:** drop the worst bench player (not in this week's best
 *   lineup; lowest `value`, ties by id). Dropping a bench player never breaks
 *   the best lineup. Then claim the free agents that raise the score, best
 *   first, up to `MAX_FALLBACK_CLAIMS`, all with the same drop. Claims resolve
 *   in order and a later one fails once the drop is gone (docs/rules.md §9),
 *   so the extra claims are fallbacks, not extra adds.
 * - **No legal lineup at all:** try every drop and keep the pair that scores best.
 *
 * Ties go to the higher `value`, then id. No claims after the last week.
 */
export function bestAvailable(lineup: LineupStrategy): WaiverStrategy {
  return {
    id: 'best-available',
    claims(view, freeAgents) {
      const config = configOf(view);
      const week = nextWeek(view);
      if (week > config.weeks) return [];
      const roster = rosterOf(view);
      const owned = new Set(roster);
      const agents = [...new Set(freeAgents)].filter((id) => !owned.has(id)).sort(byId);
      if (agents.length === 0) return [];
      const score = (r: ReadonlyArray<string>): number => lineup.best(view, r, week)?.score ?? -Infinity;
      const rank = (a: Scored, b: Scored): number =>
        b.score - a.score || valueOf(view, b.add) - valueOf(view, a.add) || byId(a.add, b.add) || byId(a.drop ?? '', b.drop ?? '');

      const open = config.roster.size - roster.length;
      if (open > 0) {
        const scored = agents.map((add) => ({ add, drop: null, score: score([...roster, add]) }));
        return scored.sort(rank).slice(0, open).map(toClaim);
      }

      const current = lineup.best(view, roster, week);
      const drops =
        current === null ? [...roster] : [worstBench(view, roster, startersOf(current.lineup))].filter((d) => d !== null);
      const baseline = current?.score ?? -Infinity;
      const scored: Scored[] = [];
      for (const drop of drops) {
        const kept = roster.filter((id) => id !== drop);
        for (const add of agents) {
          const s = score([...kept, add]);
          if (s > baseline + EPS) scored.push({ add, drop, score: s });
        }
      }
      scored.sort(rank);
      if (current === null) return scored.slice(0, 1).map(toClaim);
      return scored.slice(0, MAX_FALLBACK_CLAIMS).map(toClaim);
    },
  };
}

interface Scored {
  readonly add: string;
  readonly drop: string | null;
  readonly score: number;
}

function toClaim({ add, drop }: Scored): Claim {
  return { add, drop };
}

/** The bench player (not a starter) with the lowest `value`, ties by id. Null if everyone starts. */
function worstBench(view: PublicView, roster: ReadonlyArray<string>, starters: ReadonlyArray<string>): string | null {
  const bench = roster.filter((id) => !starters.includes(id));
  bench.sort((a, b) => valueOf(view, a) - valueOf(view, b) || byId(a, b));
  return bench[0] ?? null;
}
