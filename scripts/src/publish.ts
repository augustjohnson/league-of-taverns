/**
 * Build the published JSON that explorer/ and any site read.
 *
 * Usage: publish --season season-01 --out dist/published
 *
 * Replays the log and writes standings, weekly results (actual + projected),
 * rosters, per-character stats, and rendered stories (chrome + resolved runs).
 * This is derived output: a build artifact deployed by CI, never committed
 * (docs/decisions.md D-19).
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/publish', 'T10.4'));
