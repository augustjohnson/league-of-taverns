/**
 * @league-of-taverns/engine
 *
 * Pure functions only: no I/O, no clock, no ambient randomness, and no chrome.
 * Runs unchanged in Node (scripts, Actions, sims) and in the browser.
 * Callers read files and pass parsed data in.
 */
export * from './vocabulary';
export * from './rng';
export * from './adapters/open5e';
export * from './characters';
export * from './roster';
export * from './league';
export * from './missions';
export * from './resolution';
export * from './projection';
export * from './events';
// Scaffold helper, shared with other packages' stubs. Remove once nothing throws it.
export { NotImplementedError, notImplemented } from './internal/not-implemented';
