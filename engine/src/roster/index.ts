/**
 * Roster rules: ownership, the CR budget, lineups, the draft, waivers and trades.
 *
 * Responsibilities:
 * - Validate a lineup: four distinct characters the tavern owns, with total
 *   CR ≤ B in exact eighths, and a retreat order (D-12, D-49).
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

/**
 * When the party turns back instead of fighting (docs/decisions.md D-49). It
 * is checked just before each battle:
 * - `never`: always fight (the default);
 * - `avoid_battles`: turn back before the first battle;
 * - `{ bank: N }`: turn back before a battle once at least N loot is banked.
 *
 * Turning back ends the mission with the loot banked so far. It is not a DNF.
 */
export type RetreatOrder = 'never' | 'avoid_battles' | { readonly bank: number };

export interface Lineup {
  /**
   * The four starters. There is no captain (D-12). Order is significant only
   * as the deterministic best-fit tiebreak (docs/decisions.md D-15).
   */
  readonly starters: readonly [string, string, string, string];
  readonly retreat: RetreatOrder;
}

/** The default retreat order (D-49): a carried or fallback lineup with none fights every battle. */
export const DEFAULT_RETREAT: RetreatOrder = 'never';

export interface RosterView {
  readonly tavern: string;
  readonly characters: ReadonlyArray<string>;
}

export type RuleViolation = { readonly code: string; readonly message: string };

/** Week-specific limits on who may start. */
export interface LineupOptions {
  /** Characters who can't start this week: injured in last week's DNF (D-51). */
  readonly unavailable?: ReadonlySet<string>;
}

/** Starters per party: `config.roster.starters`, which the config schema fixes at 4. */
const STARTER_COUNT = 4;

/** True when `retreat` is a well-formed retreat order: `never`, `avoid_battles`, or `{ bank: N }` with N a whole number ≥ 0. */
export function isRetreatOrder(retreat: unknown): retreat is RetreatOrder {
  if (retreat === 'never' || retreat === 'avoid_battles') return true;
  if (typeof retreat !== 'object' || retreat === null) return false;
  const bank = (retreat as { readonly bank?: unknown }).bank;
  return Object.keys(retreat).length === 1 && typeof bank === 'number' && Number.isInteger(bank) && bank >= 0;
}

/** Whether a party with `banked` loot turns back before a battle under `retreat` (D-49). */
export function retreatsBeforeBattle(retreat: RetreatOrder, banked: number): boolean {
  if (retreat === 'never') return false;
  if (retreat === 'avoid_battles') return true;
  return banked >= retreat.bank;
}

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
 * reported, in this order: `wrong_size`, `bad_retreat`, `duplicate`,
 * `not_owned`, `injured`, `unknown_character`, `over_budget`.
 *
 * - `wrong_size`: not exactly four starter ids (checked at runtime, since
 *   lineups arrive from parsed input).
 * - `bad_retreat`: `retreat` is not a retreat order (`isRetreatOrder`).
 * - `duplicate`: a character listed twice. One violation per repeated id.
 * - `not_owned`: a starter is not on `roster`. One per id.
 * - `injured`: a starter is in `options.unavailable`, hurt in last week's DNF
 *   (D-51). One per id.
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
  options: LineupOptions = {},
): ReadonlyArray<RuleViolation> {
  const violations: RuleViolation[] = [];

  // Runtime shape: tolerate anything, since the type can't be trusted for parsed input.
  const raw = lineup as { readonly starters?: unknown; readonly retreat?: unknown };
  const rawStarters: ReadonlyArray<unknown> = Array.isArray(raw.starters) ? raw.starters : [];
  const starters = rawStarters.filter((a): a is string => typeof a === 'string' && a.length > 0);
  if (rawStarters.length !== STARTER_COUNT || starters.length !== STARTER_COUNT) {
    violations.push({
      code: 'wrong_size',
      message: `a lineup is ${STARTER_COUNT} starters; got ${starters.length} valid of ${rawStarters.length}`,
    });
  }
  if (!isRetreatOrder(raw.retreat)) {
    violations.push({
      code: 'bad_retreat',
      message: `retreat must be "never", "avoid_battles" or { bank: N } with N a whole number ≥ 0; got ${JSON.stringify(raw.retreat) ?? 'nothing'}`,
    });
  }

  const distinct = [...new Set(starters)];

  for (const id of distinct) {
    const count = starters.filter((s) => s === id).length;
    if (count > 1) violations.push({ code: 'duplicate', message: `"${id}" appears ${count} times in the lineup` });
  }

  const owned = new Set(roster.characters);
  for (const id of distinct) {
    if (!owned.has(id)) {
      violations.push({ code: 'not_owned', message: `"${id}" is not on ${roster.tavern}'s roster` });
    }
  }

  for (const id of distinct) {
    if (options.unavailable?.has(id) === true) {
      violations.push({ code: 'injured', message: `"${id}" was injured last week and can't start this week` });
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
 * Initial draft order from config: a Fisher–Yates shuffle of the managers
 * driven by `rng`, or the manual list. Callers pass
 * `rngFor(draftOrderSeed(season), 'order')`, and tests pass a fixed fake.
 * Taking `rng` as a parameter keeps this independent of the RNG implementation.
 * Taverns are chosen in the reverse of this order (D-52), and the snake draft
 * runs in it.
 *
 * Seeded mode draws exactly `managers.length - 1` values. Manual mode draws
 * none and throws unless the list is a permutation of `managers`. The input
 * is never mutated.
 */
export function draftOrder(managers: ReadonlyArray<string>, config: SeasonConfig, rng: Rng): ReadonlyArray<string> {
  const unique = new Set(managers);
  if (unique.size !== managers.length) throw new Error('draftOrder: managers contain duplicates');

  const order = config.draft.order;
  if (order.mode === 'manual') {
    const manual = order.managers;
    const seen = new Set<string>();
    for (const m of manual) {
      if (!unique.has(m)) throw new Error(`draftOrder: manual order names unknown manager "${m}"`);
      if (seen.has(m)) throw new Error(`draftOrder: manual order lists manager "${m}" more than once`);
      seen.add(m);
    }
    const missing = managers.filter((m) => !seen.has(m));
    if (missing.length > 0) throw new Error(`draftOrder: manual order is missing manager(s) ${missing.map((m) => `"${m}"`).join(', ')}`);
    return [...manual];
  }

  const shuffled = [...managers];
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

/**
 * Why a claim was or wasn't awarded. Failures are checked in this order and
 * the first that applies is reported:
 * - `add_unavailable`: `add` is not claimable when the claim is tried (it was
 *   never a free agent, another claim already took it this run, or it was
 *   dropped this run).
 * - `drop_not_owned`: `drop` is not on the claiming tavern's roster at that time.
 * - `roster_full`: the roster would end up larger than `config.roster.size`.
 */
export type WaiverReason = 'awarded' | 'add_unavailable' | 'drop_not_owned' | 'roster_full';

export interface WaiverAward {
  readonly claim: WaiverClaim;
  readonly awarded: boolean;
  /** One of `WaiverReason`. Typed as string to match the `waiver.resolved` payload. */
  readonly reason: string;
}

/**
 * Resolve all pending claims at once (docs/rules.md §9, docs/decisions.md D-05).
 *
 * - Each tavern's claims are queued by `seq`. Equal seqs keep input order.
 * - Resolution runs in rounds. A round takes the priority order as it stands
 *   when the round starts, and each tavern in it with a pending claim has its
 *   earliest one tried. So a tavern tries at most one claim per round, and a
 *   failed claim uses up that tavern's turn for the round.
 * - A claim is awarded when `add` is still claimable, `drop` (if given) is
 *   still on the tavern's roster, and the resulting roster is at most
 *   `config.roster.size`. Otherwise it fails with the first `WaiverReason`
 *   that applies. A `drop` is allowed even when the roster has room.
 * - Under `rolling` priority, a tavern that wins moves to the back of the
 *   priority order at once. This doesn't change the rest of the round, since
 *   each tavern gets one turn per round either way. Under
 *   `reverse_standings` (D-05) nobody moves: the caller passes this window's
 *   order (`reverseStandingsPriority`) and gets it back unchanged.
 * - An awarded `drop` becomes a free agent immediately but is **not**
 *   claimable in this run. Rules §9 says dropped characters can be claimed in
 *   the next window, so the caller adds it to the next run's free agents.
 * - Rosters change as claims are awarded, and later claims by any tavern see
 *   the result.
 *
 * Returns one award per claim, in the order the claims were decided (round by
 * round, priority order within a round), plus the final priority order.
 * Taverns in `priority` without winning claims keep their relative places.
 *
 * A tavern missing from `rosters` is treated as having an empty roster.
 * Throws if `priority` has duplicates or a claim's tavern is not in it.
 * Pure: inputs are never mutated.
 */
export function resolveWaivers(
  claims: ReadonlyArray<WaiverClaim>,
  priority: ReadonlyArray<string>,
  rosters: ReadonlyArray<RosterView>,
  freeAgents: ReadonlySet<string>,
  config: SeasonConfig,
): { readonly awards: ReadonlyArray<WaiverAward>; readonly priority: ReadonlyArray<string> } {
  if (new Set(priority).size !== priority.length) throw new Error('resolveWaivers: priority contains duplicates');
  const known = new Set(priority);

  const queues = new Map<string, WaiverClaim[]>();
  for (const claim of claims) {
    if (!known.has(claim.tavern)) throw new Error(`resolveWaivers: claim by "${claim.tavern}", which is not in the priority order`);
    const queue = queues.get(claim.tavern) ?? [];
    queue.push(claim);
    queues.set(claim.tavern, queue);
  }
  // Array.prototype.sort is stable, so equal seqs keep input order.
  for (const queue of queues.values()) queue.sort((a, b) => a.seq - b.seq);

  const owned = new Map<string, Set<string>>();
  for (const tavern of priority) owned.set(tavern, new Set(findRoster(rosters, tavern)?.characters ?? []));

  // Only characters that were free agents when the run started are claimable in it.
  const claimable = new Set(freeAgents);
  const limit = config.roster.size;
  let order = [...priority];
  const awards: WaiverAward[] = [];
  let pending = claims.length;

  while (pending > 0) {
    for (const tavern of [...order]) {
      const claim = queues.get(tavern)?.shift();
      if (claim === undefined) continue;
      pending--;
      const roster = owned.get(tavern)!;
      const reason = waiverFailure(claim, roster, claimable, limit);
      if (reason !== null) {
        awards.push({ claim, awarded: false, reason });
        continue;
      }
      claimable.delete(claim.add);
      if (claim.drop !== null) roster.delete(claim.drop);
      roster.add(claim.add);
      if (config.waivers.priority === 'rolling') order = [...order.filter((t) => t !== tavern), tavern];
      awards.push({ claim, awarded: true, reason: 'awarded' });
    }
  }

  return { awards, priority: order };
}

function findRoster(rosters: ReadonlyArray<RosterView>, tavern: string): RosterView | undefined {
  return rosters.find((r) => r.tavern === tavern);
}

function waiverFailure(
  claim: WaiverClaim,
  roster: ReadonlySet<string>,
  claimable: ReadonlySet<string>,
  limit: number,
): Exclude<WaiverReason, 'awarded'> | null {
  if (!claimable.has(claim.add)) return 'add_unavailable';
  if (claim.drop !== null && !roster.has(claim.drop)) return 'drop_not_owned';
  const after = roster.size + 1 - (claim.drop !== null ? 1 : 0);
  if (after > limit) return 'roster_full';
  return null;
}

export interface TradeTerms {
  readonly from: string;
  readonly to: string;
  readonly give: ReadonlyArray<string>;
  readonly receive: ReadonlyArray<string>;
}

export interface TradeCheckOptions {
  /**
   * The first week whose lineups the trade would affect, i.e. the next lineup
   * to lock. With a week-4 deadline that is 4 before the week-4 lock (allowed)
   * and 5 after it (past the deadline). Omit to skip the deadline check.
   */
  readonly week?: number;
}

/**
 * Violations for a trade against current rosters, empty when legal. Run at
 * proposal and again at completion (docs/rules.md §10). Every violation is
 * reported, in this order: `same_tavern`, `empty_side`, `duplicate`,
 * `give_not_owned`, `receive_not_owned`, `roster_size`, `past_deadline`.
 *
 * - `same_tavern`: `from` and `to` are the same tavern.
 * - `empty_side`: `give` or `receive` is empty. One per empty side.
 * - `duplicate`: a character listed more than once across `give` and
 *   `receive` together. One per repeated id.
 * - `give_not_owned`: a `give` piece is not on `from`'s roster. One per id.
 * - `receive_not_owned`: a `receive` piece is not on `to`'s roster. One per id.
 * - `roster_size`: one per tavern whose roster would change size and not end
 *   up between 1 and `config.roster.size`. So N-for-N always passes, and an
 *   uneven trade passes only when the side taking more pieces has open slots
 *   and the other side keeps at least one character. Between two full rosters
 *   an uneven trade always fails, which keeps D-06's default (rosters stay at
 *   size) for the normal case. Sizes count distinct ids. Skipped for
 *   `same_tavern`.
 * - `past_deadline`: `options.week` is given, the season has a deadline, and
 *   the week is after `config.trades.deadlineWeek`.
 *
 * A tavern missing from `rosters` is treated as having an empty roster.
 * Pure: inputs are never mutated.
 */
export function validateTrade(
  terms: TradeTerms,
  rosters: ReadonlyArray<RosterView>,
  config: SeasonConfig,
  options: TradeCheckOptions = {},
): ReadonlyArray<RuleViolation> {
  const violations: RuleViolation[] = [];
  const { from, to, give, receive } = terms;

  if (from === to) violations.push({ code: 'same_tavern', message: `a tavern cannot trade with itself ("${from}")` });

  if (give.length === 0) violations.push({ code: 'empty_side', message: `${from} gives nothing` });
  if (receive.length === 0) violations.push({ code: 'empty_side', message: `${to} gives nothing` });

  const pieces = [...give, ...receive];
  for (const id of new Set(pieces)) {
    const count = pieces.filter((p) => p === id).length;
    if (count > 1) violations.push({ code: 'duplicate', message: `"${id}" appears ${count} times in the trade` });
  }

  const fromRoster = new Set(findRoster(rosters, from)?.characters ?? []);
  const toRoster = new Set(findRoster(rosters, to)?.characters ?? []);
  const gives = [...new Set(give)];
  const receives = [...new Set(receive)];
  for (const id of gives) {
    if (!fromRoster.has(id)) violations.push({ code: 'give_not_owned', message: `"${id}" is not on ${from}'s roster` });
  }
  for (const id of receives) {
    if (!toRoster.has(id)) violations.push({ code: 'receive_not_owned', message: `"${id}" is not on ${to}'s roster` });
  }

  if (from !== to) {
    const limit = config.roster.size;
    const sides: ReadonlyArray<readonly [string, number, number]> = [
      [from, fromRoster.size, receives.length - gives.length],
      [to, toRoster.size, gives.length - receives.length],
    ];
    for (const [tavern, before, delta] of sides) {
      const after = before + delta;
      if (after !== before && (after < 1 || after > limit)) {
        violations.push({
          code: 'roster_size',
          message: `${tavern}'s roster would go from ${before} to ${after}; an uneven trade must leave it between 1 and ${limit}`,
        });
      }
    }
  }

  const deadline = config.trades.deadlineWeek;
  if (options.week !== undefined && deadline !== null && options.week > deadline) {
    violations.push({ code: 'past_deadline', message: `week ${options.week} is after the week-${deadline} trade deadline` });
  }

  return violations;
}

/**
 * The lineup a tavern plays in a week when it submitted none: `previous`
 * (returned as is) if it is still legal under `validateLineup`, else the
 * fallback in docs/rules.md § Missed lineups and docs/decisions.md D-27.
 *
 * Fallback: among every 4-character subset of the roster that is a legal
 * lineup (so without anyone in `options.unavailable`, D-51), take the one with the highest total CR. Ties go to the subset
 * whose roster indices (roster order is draft order) come first
 * lexicographically. The starters are listed in roster order, and the
 * retreat order is the default, `never` (D-49). Returns null when no legal
 * lineup exists.
 *
 * Pure and deterministic. Inputs are never mutated.
 */
export function carriedLineup(
  previous: Lineup | null,
  roster: RosterView,
  crOf: (characterId: string) => CrEighths,
  config: SeasonConfig,
  options: LineupOptions = {},
): Lineup | null {
  if (previous !== null && validateLineup(previous, roster, crOf, config, options).length === 0) return previous;

  // Candidates in roster order: first occurrence of each id with a known CR.
  // A character without a known CR can never be in a legal lineup.
  const ids: string[] = [];
  const crs: number[] = [];
  for (const id of new Set(roster.characters)) {
    const cr = knownCr(crOf, id);
    if (cr !== null && options.unavailable?.has(id) !== true) {
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
  return { starters: [ids[a]!, ids[b]!, ids[c]!, ids[d]!], retreat: DEFAULT_RETREAT };
}
