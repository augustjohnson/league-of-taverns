/**
 * GitHub issue form parsing. A pure function from issue body markdown to a
 * typed command. GitHub renders form answers as `### <label>\n\n<value>`
 * sections, with `_No response_` for empty optional fields.
 *
 * The tavern is never read from the form. It comes from the issue author's
 * GitHub user id via managers.yaml, so one manager cannot act for another.
 */
import type { Lineup } from '@league-of-taverns/engine';
import { notImplemented } from '@league-of-taverns/engine';

export type Command =
  | { readonly kind: 'draft_pick'; readonly character: string }
  | { readonly kind: 'set_lineup'; readonly week: number; readonly lineup: Lineup }
  | { readonly kind: 'waiver_claim'; readonly add: string; readonly drop: string | null }
  | { readonly kind: 'trade_offer'; readonly to: string; readonly give: ReadonlyArray<string>; readonly receive: ReadonlyArray<string> }
  | { readonly kind: 'trade_accept'; readonly issue: number }
  | { readonly kind: 'trade_decline'; readonly issue: number }
  | { readonly kind: 'trade_veto'; readonly issue: number; readonly reason: string };

export interface ParseError {
  readonly field: string;
  readonly message: string;
}

/** `label` is the form's routing label (draft-pick, set-lineup, waiver-claim, trade-offer). */
export function parseIssueForm(_label: string, _body: string): Command | { readonly errors: ReadonlyArray<ParseError> } {
  return notImplemented('parseIssueForm', 'T11.1');
}

/** `/accept`, `/decline` and `/veto <reason>` comments on a trade issue. */
export function parseComment(_issue: number, _body: string): Command | null {
  return notImplemented('parseComment', 'T11.1');
}
