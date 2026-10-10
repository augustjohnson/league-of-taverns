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

/** Allies per party. With the captain, a party is `config.roster.starters` (4). */
const ALLY_COUNT = 3;

/** Human CR form for eighths: 4 → "1/2", 100 → "12 1/2", 96 → "12", 0 → "0". */
function formatCr(eighths: number): string {
  const whole = Math.floor(eighths / 8);
  const rest = eighths % 8;
  if (rest === 0) return String(whole);
  let num = rest;
  let den = 8;
  while (num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  const fraction = `${num}/${den}`;
  return whole === 0 ? fraction : `${whole} ${fraction}`;
}

/** `crOf(id)` if it returns a non-negative integer, else null (it threw or returned junk). */
function knownCr(crOf: (characterId: string) => CrEighths, id: string): number | null {
  let cr: unknown;
  try {
    cr = crOf(id);
  } catch {
    return null;
  }
  return typeof cr === 'number' && Number.isInteger(cr) && cr >= 0 ? cr : null;
}

/**
 * All reasons a lineup is illegal, empty when legal. Every violation is
 * reported, in this order: `wrong_size`, `duplicate`, `not_owned`,
 * `unknown_character`, `over_budget`.
 *
 * - `wrong_size`: not exactly one captain id plus three ally ids (checked at
 *   runtime, since lineups arrive from parsed input).
 * - `duplicate`: a character listed twice, including the captain as an ally.
 *   One violation per repeated id.
 * - `not_owned`: a starter is not on `roster`. One per id.
 * - `unknown_character`: `crOf` throws or returns anything but a
 *   non-negative integer. One per id.
 * - `over_budget`: the starters' CRs, as listed, sum to more than
 *   `config.budget.partyCr`. Exact integer eighths (docs/decisions.md D-16).
 *   Skipped when any CR is unknown, since the total is then meaningless.
 */
export function validateLineup(
  lineup: Lineup,
  roster: RosterView,
  crOf: (characterId: string) => CrEighths,
  config: SeasonConfig,
): ReadonlyArray<RuleViolation> {
  const violations: RuleViolation[] = [];

  // Runtime shape: tolerate anything, since the type can't be trusted for parsed input.
  const raw = lineup as { readonly captain?: unknown; readonly allies?: unknown };
  const captain = typeof raw.captain === 'string' && raw.captain.length > 0 ? raw.captain : null;
  const rawAllies: ReadonlyArray<unknown> = Array.isArray(raw.allies) ? raw.allies : [];
  const allies = rawAllies.filter((a): a is string => typeof a === 'string' && a.length > 0);
  if (captain === null || !Array.isArray(raw.allies) || rawAllies.length !== ALLY_COUNT || allies.length !== ALLY_COUNT) {
    violations.push({
      code: 'wrong_size',
      message:
        `a lineup is 1 captain + ${ALLY_COUNT} allies; got ${captain === null ? 'no' : '1'} captain ` +
        `and ${allies.length} valid of ${rawAllies.length} allies`,
    });
  }

  const starters = captain === null ? allies : [captain, ...allies];
  const distinct = [...new Set(starters)];

  for (const id of distinct) {
    const count = starters.filter((s) => s === id).length;
    if (count > 1) {
      const asCaptain = id === captain ? ' (captain also listed as an ally)' : '';
      violations.push({ code: 'duplicate', message: `"${id}" appears ${count} times in the lineup${asCaptain}` });
    }
  }

  const owned = new Set(roster.characters);
  for (const id of distinct) {
    if (!owned.has(id)) {
      violations.push({ code: 'not_owned', message: `"${id}" is not on ${roster.tavern}'s roster` });
    }
  }

  const crs = new Map<string, number>();
  for (const id of distinct) {
    const cr = knownCr(crOf, id);
    if (cr === null) violations.push({ code: 'unknown_character', message: `"${id}" has no known CR` });
    else crs.set(id, cr);
  }
  if (crs.size === distinct.length) {
    const total = starters.reduce((sum, id) => sum + (crs.get(id) ?? 0), 0);
    const budget = config.budget.partyCr;
    if (total > budget) {
      violations.push({ code: 'over_budget', message: `party CR ${formatCr(total)} > ${formatCr(budget)} (the budget)` });
    }
  }

  return violations;
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
 * The lineup a tavern plays in a week when it submitted none: `previous`
 * (returned as is) if it is still legal under `validateLineup`, else the
 * fallback in docs/rules.md § Missed lineups and docs/decisions.md D-27.
 *
 * Fallback: among every 4-character subset of the roster that is a legal
 * lineup, take the one with the highest total CR. Ties go to the subset
 * whose roster indices (roster order is draft order) come first
 * lexicographically. The earliest-drafted member is captain, and the other
 * three are allies in roster order. Returns null when no legal lineup exists.
 *
 * Pure and deterministic. Inputs are never mutated.
 */
export function carriedLineup(
  previous: Lineup | null,
  roster: RosterView,
  crOf: (characterId: string) => CrEighths,
  config: SeasonConfig,
): Lineup | null {
  if (previous !== null && validateLineup(previous, roster, crOf, config).length === 0) return previous;

  // Candidates in roster order: first occurrence of each id with a known CR.
  // A character without a known CR can never be in a legal lineup.
  const ids: string[] = [];
  const crs: number[] = [];
  for (const id of new Set(roster.characters)) {
    const cr = knownCr(crOf, id);
    if (cr !== null) {
      ids.push(id);
      crs.push(cr);
    }
  }

  // Lexicographic enumeration of index 4-tuples; strict `>` keeps the first on ties.
  const budget = config.budget.partyCr;
  const n = ids.length;
  let best: readonly [number, number, number, number] | null = null;
  let bestTotal = -1;
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      for (let c = b + 1; c < n; c++) {
        for (let d = c + 1; d < n; d++) {
          const total = crs[a]! + crs[b]! + crs[c]! + crs[d]!;
          if (total <= budget && total > bestTotal) {
            best = [a, b, c, d];
            bestTotal = total;
          }
        }
      }
    }
  }
  if (best === null) return null;

  const [a, b, c, d] = best;
  return { captain: ids[a]!, allies: [ids[b]!, ids[c]!, ids[d]!] };
}
