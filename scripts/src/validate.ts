/**
 * Validate all authored content for a season. CI runs this on every PR.
 *
 * Usage: validate --season season-01
 *
 * Checks, each reporting every violation:
 * - config.yaml, managers.yaml, schedule.yaml, pool.yaml parse and match schema.
 * - Every pooled character exists in characters/, its base slug exists in the
 *   pinned snapshot, and its modifiers fit the vocabulary and budget.
 * - Every mission (candidates and, when decryptable, selected) passes the engine
 *   validator.
 * - Every chrome file covers its mission's branches and passes the token and
 *   mechanical-fact lints.
 * - Snapshot integrity (manifest sha256).
 * Exit 1 on any violation.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/validate', 'T5.3'));
