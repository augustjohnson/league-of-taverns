/**
 * Difficulty report: every candidate mission vs the season pool.
 *
 * Usage: difficulty-report --season season-01 [--lineups 5000]
 *
 * For each candidate, propagate (no dice) across a sample of legal lineups
 * (uniform legal lineups plus bot-drafted ones) and report:
 * - spread of expected score (mean, p10, p50, p90)
 * - DNF rate, and the share of lineups with P(DNF) > 0.5
 * - archetype dependency: how much the expected score moves when a lineup has
 *   vs lacks a speed, sense, skill tier, or creature type ("only flyers finish")
 * - node reach rates, so the GM can see branches nobody travels
 * Writes seasons/<id>/reports/difficulty.{md,json}. Git-ignored, because it
 * describes sealed missions.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/difficulty-report', 'T7.1'));
