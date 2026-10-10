/**
 * Balance report over a batch of mock seasons (T9.3).
 *
 * Answers:
 * - Does one strategy dominate? Win rate and title rate per bot strategy,
 *   with confidence intervals and the random-bot baseline.
 * - How often does the best-projected tavern win? Per week (H2H) and per season.
 *   Too often means luck is irrelevant, too rarely means skill is.
 * - Which characters are auto-picks (high ADP, near-100% rostered) and which
 *   are never picked? Pick rate, mean draft position, lineup share, and points
 *   contributed per character.
 * - Which modifiers and traits move outcomes most per budget point?
 *
 * Reads sims/output/<run-id>/ and writes a Markdown + JSON report beside it.
 */
import { notImplemented } from '@league-of-taverns/engine';

notImplemented('sims/balance-report', 'T9.3');
