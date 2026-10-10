/**
 * Offseason tooling: close a season and prepare the next.
 *
 * Usage: offseason --from season-01 --to season-02
 *
 * - Summarize the closed season's final rosters and the champion.
 * - Emit carryover candidates per the carryover rules (OPEN, docs/decisions.md D-11).
 * - After the commissioner confirms, append character.retained events to the new
 *   season's log.
 * - Report career history per character id across all seasons.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/offseason', 'T10.3'));
