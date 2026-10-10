/**
 * LLM-draft chrome for selected missions, plus season through-lines.
 *
 * Usage: draft-chrome --season season-01 [--mission <id>]
 *
 * - Render content/prompts/mission-chrome.md with the mission structure, its
 *   public schedule entry (title, environment, theme), the allowed tokens, and
 *   the coverage rules.
 * - Write seasons/<id>/chrome/<mission-id>.yaml with status: draft.
 * - Never overwrite a file whose status is reviewed or locked.
 * - Run the coverage check and lints on the output and print the gaps.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/draft-chrome', 'T8.5'));
