/**
 * Turn one issue-form submission or comment command into an event.
 *
 * Usage (from Actions): apply-command --season season-01 --issue 42 [--comment 123]
 *
 * - Look up the author's GitHub user id in managers.yaml. Unknown authors are rejected.
 * - Parse the form or comment into a Command (lib/issue-forms.ts).
 * - Build the candidate event, validate it via the engine reducers against the
 *   replayed log, and append it on success.
 * - Print a result the workflow posts back to the issue: accepted (with the new
 *   state summary), or rejected with every reason.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/apply-command', 'T11.2'));
