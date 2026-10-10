/**
 * Reducers: one pure handler per event type, `(state, event) → state`.
 *
 * Every handler checks its own preconditions (whose pick it is, whether a
 * lineup is legal, whether a week is already locked) and throws
 * `InvalidEventError` when they fail. The same handlers serve two callers:
 * - Actions call `applyEvent` on a candidate event before appending it, so an
 *   illegal command is rejected with a reason and never written.
 * - `replay` folds the whole log. An invalid event in a committed log is
 *   corruption, and replay stops on it.
 *
 * Fold rules per event: docs/schema.md § Reducers.
 */
import { notImplemented } from '../internal/not-implemented';
import type { LeagueState } from './state';
import type { LeagueEvent } from './types';

export class InvalidEventError extends Error {
  constructor(
    readonly seq: number,
    readonly code: string,
    message: string,
  ) {
    super(`event ${seq}: ${message}`);
    this.name = 'InvalidEventError';
  }
}

export function initialState(): LeagueState {
  return notImplemented('initialState', 'T2.4');
}

/** Apply one event. Throws `InvalidEventError` if its preconditions fail. */
export function applyEvent(_state: LeagueState, _event: LeagueEvent): LeagueState {
  return notImplemented('applyEvent', 'T2.4');
}
