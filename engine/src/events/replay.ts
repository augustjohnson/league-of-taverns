/**
 * Replay: NDJSON text → validated events → folded state.
 *
 * Responsibilities:
 * - Parse NDJSON without I/O. The caller reads the file and passes a string.
 * - Check the envelope: contiguous seq and matching season (in `applyEvent`),
 *   and the `prev` hash chain, where each line commits to the sha256 of the
 *   previous line's exact bytes (here, in `replayLog`, since only the reader
 *   sees raw lines) [D-34].
 * - Fold through `applyEvent`.
 * - `verifyResolutions` audits every `mission.resolved` for internal
 *   consistency. Live weeks use one real random roll (D-13), so rolls can't be
 *   re-derived from a seed: the recorded run is the historical fact (D-20),
 *   and verification proves it hangs together.
 *
 * Hashing must be pure JS so it runs in the browser (T2.3).
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { missionHaul, type Mission, type MissionNode } from '../missions';
import { formatIssuePath } from '../missions/schema';
import { lootScore, missionGraph } from '../resolution';
import { InvalidEventError, applyEvent, initialState } from './reducers';
import { eventSchema } from './schema';
import type { LeagueState } from './state';
import type { LeagueEvent } from './types';

/** A log line that is not valid JSON or does not match the event schema. */
export class LogParseError extends Error {
  constructor(
    /** 1-based line number in the NDJSON text. */
    readonly line: number,
    /** Field path of the first schema issue, e.g. `payload.lineup.allies[1]`, or null for bad JSON. */
    readonly path: string | null,
    message: string,
  ) {
    super(`events line ${line}: ${path === null ? '' : `${path}: `}${message}`);
    this.name = 'LogParseError';
  }
}

/**
 * NDJSON text → schema-checked events, in file order. One trailing empty line
 * (the final newline) is ignored; any other blank line is an error. Throws
 * `LogParseError` naming the line and field. Envelope sequencing and the
 * `prev` chain are checked by `replay`, not here.
 */
export function parseLog(ndjson: string): ReadonlyArray<LeagueEvent> {
  return splitLines(ndjson).map((line, index) => {
    const lineNumber = index + 1;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new LogParseError(lineNumber, null, `invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    }
    const result = eventSchema.safeParse(json);
    if (!result.success) {
      const issue = result.error.issues[0];
      const more = result.error.issues.length > 1 ? ` (+${result.error.issues.length - 1} more)` : '';
      throw new LogParseError(lineNumber, formatIssuePath(issue?.path ?? []), `${issue?.message ?? 'invalid event'}${more}`);
    }
    return result.data;
  });
}

/**
 * Serialize one event as a canonical NDJSON line: object keys sorted
 * recursively (UTF-16 code unit order), array order preserved, no whitespace,
 * no trailing newline. Equal events always give identical bytes, so `prev`
 * hashes are reproducible. Throws if the event does not match the schema, so
 * a line `parseLog` would reject is never produced.
 */
export function serializeEvent(event: LeagueEvent): string {
  const result = eventSchema.safeParse(event);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`serializeEvent: ${formatIssuePath(issue?.path ?? [])}: ${issue?.message ?? 'invalid event'}`);
  }
  return canonicalJson(event, '');
}

/** sha256 hex of one line's UTF-8 bytes. Used for `prev`. Pure JS, so it runs in the browser. */
export function lineHash(line: string): string {
  return bytesToHex(sha256(utf8ToBytes(line)));
}

function canonicalJson(value: unknown, at: string): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`serializeEvent: ${at || '(root)'}: non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => canonicalJson(item, `${at}[${i}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Readonly<Record<string, unknown>>;
    const fields = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], at ? `${at}.${key}` : key)}`);
    return `{${fields.join(',')}}`;
  }
  throw new Error(`serializeEvent: ${at || '(root)'}: cannot serialize a ${typeof value}`);
}

/** NDJSON text → lines, dropping the one trailing empty line a final newline leaves. */
function splitLines(ndjson: string): string[] {
  const lines = ndjson.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/**
 * A log that parses but does not replay: a broken `prev` chain
 * (`chain.first_prev`, `chain.prev_mismatch`) or an event the reducers
 * reject (the `InvalidEventError` code, kept as `cause`). Names the line.
 */
export class ReplayError extends Error {
  constructor(
    /** 1-based line number in the NDJSON text. */
    readonly line: number,
    readonly code: string,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(`events line ${line}: ${message}`, options);
    this.name = 'ReplayError';
  }
}

/**
 * Fold `events` through `applyEvent` from `initialState()`. Seq contiguity
 * and the season are checked by `applyEvent`; a rejected event throws its
 * `InvalidEventError`. The `prev` chain is not checked here, since these are
 * parsed events, not lines: use `replayLog` for a log file.
 *
 * `lastHash` is the hash of the last event's canonical line
 * (`serializeEvent`), which is what Actions append, so it equals
 * `replayLog`'s for a canonically written log.
 */
export function replay(events: ReadonlyArray<LeagueEvent>): LeagueState {
  const state = events.reduce(applyEvent, initialState());
  const last = events.at(-1);
  return last === undefined ? state : { ...state, lastHash: lineHash(serializeEvent(last)) };
}

/**
 * Parse, chain-check and fold a whole NDJSON log.
 *
 * - Every line must parse (`LogParseError` otherwise, naming the line).
 * - Line 1's `prev` is null, and each later line's `prev` is `lineHash` of
 *   the previous **raw line**, byte for byte. A break, a deleted or
 *   reordered line, or any edit to a line is caught at the line after it.
 * - Each event folds through `applyEvent`. A rejection, including a seq gap,
 *   becomes a `ReplayError` naming the line.
 *
 * `lastHash` is the last raw line's hash: the `prev` for the next append.
 */
export function replayLog(ndjson: string): LeagueState {
  const lines = splitLines(ndjson);
  const events = parseLog(ndjson);
  let state = initialState();
  let prev: string | null = null;
  events.forEach((event, index) => {
    const line = index + 1;
    if (event.prev !== prev) {
      throw prev === null
        ? new ReplayError(line, 'chain.first_prev', `prev must be null on the first line, got ${event.prev}`)
        : new ReplayError(line, 'chain.prev_mismatch', `prev ${event.prev ?? 'null'} is not the hash of line ${line - 1} (${prev})`);
    }
    try {
      state = applyEvent(state, event);
    } catch (error) {
      if (error instanceof InvalidEventError) throw new ReplayError(line, error.code, error.message, { cause: error });
      throw error;
    }
    prev = lineHash(lines[index]!);
  });
  return { ...state, lastHash: prev };
}

export interface ResolutionMismatch {
  readonly seq: number;
  readonly week: number;
  readonly tavern: string;
  /** What disagrees, as a payload path: `run.path`, `run.nodes[2].outcome`, `run.score`, `points`, `mission`. */
  readonly field: string;
  readonly message: string;
}

/**
 * Audit every `mission.resolved` for internal consistency, without throwing.
 * Rolls come from one real random draw (D-13), so they can't be recomputed;
 * instead each record must agree with itself and with the mission revealed
 * for its week (the latest `mission.revealed` before it):
 *
 * - The mission id matches, and walking the mission's edges (`missionGraph`)
 *   from start, following each recorded outcome, visits exactly `run.path`
 *   with one node record per check or battle, in order.
 * - Each check record names a starter from the lineup, uses the node's DC,
 *   and its outcome is `d20 + modifier ≥ dc`. One exception: a gated check
 *   (`requires`) may fail on a high roll, since nobody may have met the gate
 *   (D-39), and that needs stats this audit doesn't have.
 * - Each battle's outcome is `roll < pWin`, and a lost battle ends the path.
 * - `dnf`, `checksPassed`, `checksAttempted`, `loot` (the `loot` of each
 *   passed check) and `score` (`lootScore(loot, missionHaul(mission))`, DNF
 *   or not) match the walk.
 * - `points` = round(score × `scoring.pointsScale`) from `season.created`.
 *
 * Returns one entry per mismatch, in log order. If the walk itself breaks (a
 * record for the wrong node, or an outcome with no edge), that is reported
 * and the run's summary checks are skipped.
 */
export function verifyResolutions(events: ReadonlyArray<LeagueEvent>): ReadonlyArray<ResolutionMismatch> {
  const mismatches: ResolutionMismatch[] = [];
  const revealed = new Map<number, Mission>();
  let pointsScale: number | null = null;
  for (const event of events) {
    if (event.type === 'season.created') pointsScale = event.payload.config.scoring.pointsScale;
    if (event.type === 'mission.revealed') revealed.set(event.payload.week, event.payload.mission);
    if (event.type !== 'mission.resolved') continue;
    const { week, tavern, run, lineup } = event.payload;
    const report = (field: string, message: string): void => {
      mismatches.push({ seq: event.seq, week, tavern, field, message });
    };

    if (pointsScale !== null) {
      const points = Math.round(run.score * pointsScale);
      if (event.payload.points !== points) report('points', `points ${event.payload.points} should be round(${run.score} × ${pointsScale}) = ${points}`);
    }
    const mission = revealed.get(week);
    if (mission === undefined) {
      report('mission', `no mission was revealed for week ${week}`);
      continue;
    }
    if (mission.id !== event.payload.mission) {
      report('mission', `week ${week} revealed "${mission.id}", but the run names "${event.payload.mission}"`);
      continue;
    }

    const starters = new Set([lineup.captain, ...lineup.allies]);
    const path: string[] = [];
    let index = 0;
    let passed = 0;
    let attempted = 0;
    let loot = 0;
    let dnf = false;
    let walked = true;
    try {
      const graph = missionGraph(mission, 'verifyResolutions');
      let node: MissionNode | undefined = graph.start;
      while (node !== undefined) {
        path.push(node.id);
        if (node.kind === 'start') {
          node = graph.next(node, 'always');
          continue;
        }
        if (node.kind === 'end') break;
        const at = `run.nodes[${index}]`;
        const record = run.nodes[index];
        index++;
        if (record === undefined || record.node !== node.id || record.kind !== node.kind) {
          const got = record === undefined ? 'nothing' : `a ${record.kind} record for "${record.node}"`;
          report(at, `the walk reaches ${node.kind} "${node.id}", but the run records ${got}`);
          walked = false;
          break;
        }
        if (record.kind === 'check' && node.kind === 'check') {
          attempted++;
          if (record.outcome === 'pass') {
            passed++;
            loot += node.loot;
          }
          if (!starters.has(record.actor)) report(`${at}.actor`, `"${record.actor}" is not in the lineup`);
          if (record.dc !== node.check.dc) report(`${at}.dc`, `dc ${record.dc} but the mission says ${node.check.dc}`);
          const total = record.d20 + record.modifier;
          const meets = total >= record.dc;
          if (record.outcome === 'pass' && !meets) {
            report(`${at}.outcome`, `pass, but d20 ${record.d20} + modifier ${record.modifier} = ${total} < dc ${record.dc}`);
          } else if (record.outcome === 'fail' && meets && node.check.requires === undefined) {
            report(`${at}.outcome`, `fail, but d20 ${record.d20} + modifier ${record.modifier} = ${total} ≥ dc ${record.dc}`);
          }
          node = graph.next(node, record.outcome);
        } else if (record.kind === 'battle') {
          const won = record.roll < record.pWin;
          if ((record.outcome === 'win') !== won) {
            report(`${at}.outcome`, `${record.outcome}, but roll ${record.roll} ${won ? '<' : '≥'} pWin ${record.pWin}`);
          }
          if (record.outcome === 'lose') {
            dnf = true;
            break;
          }
          node = graph.next(node, 'win');
        }
      }
    } catch (error) {
      report('run.path', `the recorded outcomes leave the mission graph: ${error instanceof Error ? error.message : String(error)}`);
      walked = false;
    }
    if (!walked) continue;

    if (index < run.nodes.length) report('run.nodes', `${run.nodes.length - index} record(s) past the end of the walk`);
    if (path.length !== run.path.length || path.some((id, i) => id !== run.path[i])) {
      report('run.path', `the walk visits ${path.join(' → ')}, but the run records ${run.path.join(' → ')}`);
    }
    if (run.dnf !== dnf) report('run.dnf', `dnf is ${run.dnf}, but the walk ${dnf ? 'loses a battle' : 'reaches an end'}`);
    if (run.checksPassed !== passed) report('run.checksPassed', `${run.checksPassed}, but ${passed} check(s) passed`);
    if (run.checksAttempted !== attempted) report('run.checksAttempted', `${run.checksAttempted}, but ${attempted} check(s) attempted`);
    if (run.loot !== loot) report('run.loot', `${run.loot}, but the passed checks bank ${loot}`);
    const score = lootScore(loot, missionHaul(mission));
    if (Math.abs(run.score - score) > 1e-9) report('run.score', `score ${run.score} should be ${score}`);
  }
  return mismatches;
}
