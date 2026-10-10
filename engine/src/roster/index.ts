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

/** The tavern on the clock for overall pick `pickNumber` (0-based) in a snake draft. */
export function snakePickOwner(_order: ReadonlyArray<string>, _pickNumber: number): string {
  return notImplemented('snakePickOwner', 'T4.3');
}

/**
 * Initial draft order from config: a Fisher–Yates shuffle of the taverns
 * driven by `rng`, or the manual list. Callers pass
 * `rngFor(draftOrderSeed(season), 'order')`, and tests pass a fixed fake.
 * Taking `rng` as a parameter keeps this independent of the RNG implementation.
 */
export function draftOrder(_taverns: ReadonlyArray<string>, _config: SeasonConfig, _rng: Rng): ReadonlyArray<string> {
  return notImplemented('draftOrder', 'T4.3');
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
