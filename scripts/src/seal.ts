/**
 * Seal the selected missions so they stay secret until their week runs.
 *
 * Usage: seal --season season-01
 *
 * Method is OPEN (docs/decisions.md D-08): private repo, commit-reveal hash, or
 * encrypted file decrypted by the weekly Action. In every method, write the
 * sha256 commitment of each canonical mission into the season.created schedule
 * so a reveal can be checked against what was locked before the draft.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/seal', 'T10.2'));
