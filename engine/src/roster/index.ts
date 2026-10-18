/**
 * The draft: the snake order and whose pick it is. Each tavern drafts
 * `roster.size` monsters before the contest and keeps them all season:
 * there are no lineups, waivers or trades (docs/lich-contest-plan.md §2).
 */
import type { SeasonConfig } from '../league';
import type { Rng } from '../rng';

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
