/**
 * Mission schema and validator. There is no generator in the engine:
 * candidates come from an LLM (scripts/src/draft-missions.ts) or a human, and
 * this module decides whether they are legal.
 *
 * Responsibilities:
 * - Structural DAG rules: exactly one start, at least one end, unique ids,
 *   edges strictly rank-increasing, every node reachable from start, every
 *   non-end node with complete outgoing edges (check: pass + fail, or always;
 *   battle: win), and at least one check on every path that reaches an end.
 * - Loot (docs/decisions.md D-45): the haul, the most loot any path can bank,
 *   must equal the season's fixed haul. `missionHaul` computes it for
 *   resolution, projection and replay.
 * - Content rules: DCs inside the season's DC band, encounter refs present in
 *   the pinned snapshot, and encounters within the difficulty budget.
 * - Graph and content rules live in ./validator.ts, with the full table of
 *   issue codes.
 * - Return every violation, not just the first. LLM drafting feeds the full
 *   list back into its retry prompt.
 */
export type * from './types';
export { checkTargetSchema, formatIssuePath, kebabIdSchema, missionSchema, parseMission, toSchemaIssues } from './schema';
export type { AssertTrue, ParseResult, SchemaIssue, SchemaMatches } from './schema';
export { lootShape, missionHaul, topologicalOrder, validateMission } from './validator';
export { checkKeyword, dishonestKeywords, missionKeywords } from './keywords';
export type { LootShape, MissionIssue, MissionIssueCode, MissionRules, ValidateMissionOptions } from './validator';
