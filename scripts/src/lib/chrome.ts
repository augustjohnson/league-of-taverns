/**
 * Mission chrome: the story layer. Lives in scripts/, not engine/, because
 * the engine never reads chrome.
 *
 * Responsibilities:
 * - Types for seasons/<id>/chrome/<mission-id>.yaml and throughlines.yaml.
 * - Branch coverage: every check node has `pass` and `fail` beats, every
 *   battle has `win` and `lose`, and every end node has an outro.
 * - Token rules: only whitelisted data-bound tokens, each valid at its node
 *   (`{actor}` on checks only, `{battle_creature}` on battles only).
 * - Mechanical-fact lint: no literal DCs, numbers, dice, or outcome claims
 *   that contradict the variant they sit in.
 * - Render: chrome + a resolved run → story text, for publish.
 */
import type { Mission, RunResult } from '@league-of-taverns/engine';
import { notImplemented } from '@league-of-taverns/engine';

export type ChromeStatus = 'draft' | 'reviewed' | 'locked';

/** `{party}` names the four starters (there is no captain, D-12). */
export const STORY_TOKENS = ['actor', 'party', 'tavern', 'battle_creature'] as const;
export type StoryToken = (typeof STORY_TOKENS)[number];

export interface MissionChrome {
  readonly mission: string;
  readonly status: ChromeStatus;
  readonly title: string;
  readonly intro: string;
  readonly beats: Readonly<Record<string, NodeBeats>>;
  readonly outros: Readonly<Record<string, string>>;
  readonly throughlines?: ReadonlyArray<string>;
  readonly imagePrompts?: Readonly<Record<string, string>>;
  readonly reviewedBy?: string;
  readonly lockedAt?: string;
}

export type NodeBeats =
  | { readonly enter?: string; readonly pass: string; readonly fail: string }
  | { readonly enter?: string; readonly win: string; readonly lose: string }
  | { readonly enter?: string };

export interface ChromeIssue {
  readonly mission: string;
  readonly node?: string;
  readonly code: 'missing_beat' | 'missing_outro' | 'unknown_node' | 'bad_token' | 'token_out_of_scope' | 'mechanical_fact' | 'not_locked';
  readonly message: string;
}

export function checkCoverage(_mission: Mission, _chrome: MissionChrome): ReadonlyArray<ChromeIssue> {
  return notImplemented('checkCoverage', 'T8.2');
}

export function lintMechanicalFacts(_chrome: MissionChrome): ReadonlyArray<ChromeIssue> {
  return notImplemented('lintMechanicalFacts', 'T8.3');
}

export function renderStory(_mission: Mission, _chrome: MissionChrome, _run: RunResult, _names: Readonly<Record<string, string>>): string {
  return notImplemented('renderStory', 'T8.6');
}
