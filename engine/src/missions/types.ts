import type { CheckTarget } from '../characters';
import type { EdgeCondition, SenseKind, SpeedKind } from '../vocabulary';

/**
 * Mission structure: a layered DAG of checks and battles.
 *
 * Structure only. Titles, beats and outros live in the mission's chrome file
 * and are never read by the engine. A mission's `environment` and `theme` are
 * public through schedule.yaml. Everything here is secret until the week runs.
 */
export interface Mission {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly season: string;
  readonly environment: string;
  readonly nodes: ReadonlyArray<MissionNode>;
  readonly edges: ReadonlyArray<MissionEdge>;
}

export type MissionNode = StartNode | CheckNode | BattleNode | EndNode;

interface NodeBase {
  readonly id: string;
  /** Layer index. Edges point only to strictly higher ranks, so every mission terminates. */
  readonly rank: number;
}

export interface StartNode extends NodeBase {
  readonly kind: 'start';
}

export interface CheckNode extends NodeBase {
  readonly kind: 'check';
  readonly check: CheckSpec;
}

export type CheckSpec = CheckTarget & {
  readonly dc: number;
  /** Party-level gate. If no starter meets it, the check auto-fails. OPEN: docs/decisions.md D-39. */
  readonly requires?: Requirement;
};

export type Requirement =
  | { readonly speed: SpeedKind }
  | { readonly sense: SenseKind };

export interface BattleNode extends NodeBase {
  readonly kind: 'battle';
  readonly encounter: Encounter;
}

export interface Encounter {
  /** Each `ref` is an Open5e slug that must exist in the season's pinned snapshot. */
  readonly creatures: ReadonlyArray<{ readonly ref: string; readonly count: number }>;
}

export interface EndNode extends NodeBase {
  readonly kind: 'end';
}

/**
 * `always` for start and pass-through nodes, `pass`/`fail` from checks, and
 * `win` from battles. There is no `lose` edge: losing a battle ends the
 * mission as a DNF.
 */
export interface MissionEdge {
  readonly from: string;
  readonly to: string;
  readonly on: EdgeCondition;
}
