/**
 * Reveal one week's mission and append mission.revealed.
 *
 * Usage: reveal --season season-01 --week 3
 *
 * Runs inside the weekly Action after lineup.locked. It decrypts or fetches the
 * mission per D-08, checks its sha256 against the season.created commitment,
 * and appends mission.revealed (with the salt, if D-13 uses one).
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/reveal', 'T10.2'));
