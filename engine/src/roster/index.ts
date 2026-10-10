/**
 * Roster rules: ownership, the CR budget, lineups, the draft, waivers and trades.
 *
 * Responsibilities:
 * - Validate a lineup: four distinct characters the tavern owns, one marked
 *   captain, with total CR ≤ B in exact eighths.
 * - Produce the snake-draft order and say whose pick it is.
 * - Resolve waiver claims under rolling priority.
 * - Validate trades at proposal time and again at acceptance time.
 * - Apply the missed-lineup rule (carry over, with a fallback when the carried
 *   lineup is no longer legal).
 *
 * Every function is a pure check or transform over state handed in by the
 * event reducers. Nothing here appends events.
 */
import type { SeasonConfig } from '../league';
import type { Rng } from '../rng';
import type { CrEighths } from '../vocabulary';
import { notImplemented } from '../internal/not-implemented';

export interface Lineup {
  readonly captain: string;
  /** Exactly three. Order is significant only as a deterministic tiebreak (docs/decisions.md D-15). */
  readonly allies: readonly [string, string, string];
}

export interface RosterView {
  readonly tavern: string;
  readonly characters: ReadonlyArray<string>;
}

export type RuleViolation = { readonly code: string; readonly message: string };

/** All reasons a lineup is illegal, empty when legal. */
export function validateLineup(
  _lineup: Lineup,
  _roster: RosterView,
  _crOf: (characterId: string) => CrEighths,
  _config: SeasonConfig,
): ReadonlyArray<RuleViolation> {
  return notImplemented('validateLineup', 'T4.2');
}

/**
 * The tavern on the clock for overall pick `pickNumber` (0-based) in a snake
 * draft. Round `floor(p / n)` runs in `order` when even and reversed when odd.
 *
 * Keeper-forfeited picks (docs/rules.md §4, docs/decisions.md D-11, still
 * OPEN) are not modelled. When D-11 lands (T10.3), the hook is a caller-side
 * step: walk overall picks in this order and skip any (tavern, round) slot
 * a keeper has consumed, rather than changing this mapping.
 */
export function snakePickOwner(order: ReadonlyArray<string>, pickNumber: number): string {
  const n = order.length;
  if (n === 0) throw new Error('snakePickOwner: draft order is empty');
  if (!Number.isInteger(pickNumber) || pickNumber < 0) {
    throw new Error(`snakePickOwner: pick number must be a non-negative integer, got ${pickNumber}`);
  }
  const round = Math.floor(pickNumber / n);
  const slot = pickNumber % n;
  return order[round % 2 === 0 ? slot : n - 1 - slot]!;
}

/**
 * Initial draft order from config: a Fisher–Yates shuffle of the taverns
 * driven by `rng`, or the manual list. Callers pass
 * `rngFor(draftOrderSeed(season), 'order')`, and tests pass a fixed fake.
 * Taking `rng` as a parameter keeps this independent of the RNG implementation.
 *
 * Seeded mode draws exactly `taverns.length - 1` values. Manual mode draws
 * none and throws unless the list is a permutation of `taverns`. The input is
 * never mutated.
 */
export function draftOrder(taverns: ReadonlyArray<string>, config: SeasonConfig, rng: Rng): ReadonlyArray<string> {
  const unique = new Set(taverns);
  if (unique.size !== taverns.length) throw new Error('draftOrder: taverns contain duplicates');

  const order = config.draft.order;
  if (order.mode === 'manual') {
    const manual = order.taverns;
    const seen = new Set<string>();
    for (const t of manual) {
      if (!unique.has(t)) throw new Error(`draftOrder: manual order names unknown tavern "${t}"`);
      if (seen.has(t)) throw new Error(`draftOrder: manual order lists tavern "${t}" more than once`);
      seen.add(t);
    }
    const missing = taverns.filter((t) => !seen.has(t));
    if (missing.length > 0) throw new Error(`draftOrder: manual order is missing tavern(s) ${missing.map((t) => `"${t}"`).join(', ')}`);
    return [...manual];
  }

  const shuffled = [...taverns];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = shuffled[i]!;
    shuffled[i] = shuffled[j]!;
    shuffled[j] = tmp;
  }
  return shuffled;
}

export interface WaiverClaim {
  readonly tavern: string;
  readonly add: string;
  readonly drop: string | null;
  /** Event seq of the claim, to break ties among one tavern's own claims. */
  readonly seq: number;
}

export interface WaiverAward {
  readonly claim: WaiverClaim;
  readonly awarded: boolean;
  readonly reason: string;
}

/**
 * Resolve all pending claims at once. Rolling priority: a tavern that wins a
 * claim moves to the back of the order.
 */
export function resolveWaivers(
  _claims: ReadonlyArray<WaiverClaim>,
  _priority: ReadonlyArray<string>,
  _rosters: ReadonlyArray<RosterView>,
  _freeAgents: ReadonlySet<string>,
  _config: SeasonConfig,
): { readonly awards: ReadonlyArray<WaiverAward>; readonly priority: ReadonlyArray<string> } {
  return notImplemented('resolveWaivers', 'T4.5');
}

export interface TradeTerms {
  readonly from: string;
  readonly to: string;
  readonly give: ReadonlyArray<string>;
  readonly receive: ReadonlyArray<string>;
}

/** Violations for a trade against current rosters. Run at proposal and again at acceptance. */
export function validateTrade(_terms: TradeTerms, _rosters: ReadonlyArray<RosterView>, _config: SeasonConfig): ReadonlyArray<RuleViolation> {
  return notImplemented('validateTrade', 'T4.5');
}

/**
 * The lineup a tavern plays in `week` when it submitted none: last week's
 * lineup if still legal, else the fallback in docs/rules.md § Missed lineups.
 */
export function carriedLineup(
  _previous: Lineup | null,
  _roster: RosterView,
  _crOf: (characterId: string) => CrEighths,
  _config: SeasonConfig,
): Lineup | null {
  return notImplemented('carriedLineup', 'T4.4');
}
