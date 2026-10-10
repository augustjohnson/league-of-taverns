/**
 * Mock season runner: a full season played headless by bot managers.
 *
 * Usage: mock-season --season season-01 --missions <dir> --bots random,cr-greedy,value,... [--runs 200] [--seed sim-1]
 *
 * Builds an in-memory event log with the same events a live season produces
 * (season.created → character.pooled → tavern.joined → draft.pick … →
 * lineup.set/locked → mission.revealed → mission.resolved → week.finalized →
 * waiver.*), applying each through the engine reducers so bots obey every
 * rule. Each run varies the sim seed, which drives draft order, bot
 * randomness, and the per-week salt.
 *
 * Writes sims/output/<run-id>/events-<n>.ndjson and summary.json. Output is
 * git-ignored.
 *
 * The critical-path milestone (TODO.md): a hand-built 3-mission season runs
 * end to end here with bots.
 */
import { notImplemented } from '@league-of-taverns/engine';

notImplemented('sims/mock-season', 'T9.2');
