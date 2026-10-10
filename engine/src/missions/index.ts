/**
 * Mission schema and validator. There is no generator in the engine:
 * candidates come from an LLM (scripts/src/draft-missions.ts) or a human, and
 * this module decides whether they are legal.
 *
 * Responsibilities:
 * - Structural DAG rules: exactly one start, at least one end, unique ids,
 *   edges strictly rank-increasing, every node reachable from start, every
 *   non-end node with complete outgoing edges (check: pass + fail, or always;
 *   battle: win), and at least one check on every path that reaches an end
 *   (so score = passed / attempted is always defined).
 * - Content rules: DCs inside the season's DC band, encounter refs present in
 *   the pinned snapshot, and encounters within the difficulty budget.
 * - Return every violation, not just the first. LLM drafting feeds the full
 *   list back into its retry prompt.
 */
import { notImplemented } from '../internal/not-implemented';
import type { CrEighths } from '../vocabulary';
import type { Mission } from './types';

export type * from './types';
export { checkTargetSchema, formatIssuePath, kebabIdSchema, missionSchema, parseMission, toSchemaIssues } from './schema';
export type { AssertTrue, ParseResult, SchemaIssue, SchemaMatches } from './schema';
/**
 * The engine's zod instance, re-exported so scripts/ can build its own file
 * schemas (character chrome, config) on the same instance and compose the
 * engine's schemas. scripts/ has no direct zod dependency (TODO.md T0.2).
 */
export { z } from 'zod';

export interface MissionRules {
  readonly dcBand: { readonly min: number; readonly max: number };
  readonly maxNodes: number;
  readonly maxRank: number;
  readonly battlesPerPath: { readonly min: number; readonly max: number };
  /** Encounter difficulty cap: total encounter CR ≤ ratio × B. */
  readonly encounterCrRatio: number;
  readonly partyCr: CrEighths;
}

export interface MissionIssue {
  readonly missionId: string;
  readonly nodeId?: string;
  readonly code: string;
  readonly message: string;
}

/** Every violation in `mission`. `crOf` returns undefined for slugs missing from the snapshot. */
export function validateMission(
  _mission: Mission,
  _rules: MissionRules,
  _crOf: (slug: string) => CrEighths | undefined,
): ReadonlyArray<MissionIssue> {
  return notImplemented('validateMission', 'T5.2');
}

/** Node ids in rank order, ties broken by id. Shared by resolution, projection and coverage checks. */
export function topologicalOrder(_mission: Mission): ReadonlyArray<string> {
  return notImplemented('topologicalOrder', 'T5.2');
}
