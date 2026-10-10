/**
 * Season-start gate. CI blocks the draft and season start unless this passes.
 *
 * Usage: lock-check --season season-01
 *
 * - Every scheduled week has a selected mission and a sealed commitment.
 * - Every selected mission's chrome has status: locked and full branch coverage.
 * - Every pooled character's character.yaml exists. Chrome status is not
 *   required for characters.
 * Exit 1 with the full list of gaps.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/lock-check', 'T8.4'));
