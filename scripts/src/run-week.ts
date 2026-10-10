/**
 * Run one week. Exactly once per week: refuses if the week is already finalized.
 *
 * Usage (from Actions): run-week --season season-01 --week 3
 *
 * Preconditions: lineup.locked and mission.revealed for the week exist.
 * For each tavern: build the party's effective stats, compute the seed
 * (season, week, tavern[, salt]), run the mission once with seeded dice,
 * compute the projection, and append mission.resolved. Then append
 * week.finalized. Waivers for the week resolve after this (waiver.resolved).
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/run-week', 'T10.1'));
