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
import type { EffectiveStats } from '../characters';
import { contestant } from '../contest/cards';
import { voteModel } from '../contest/model';
import { castMap, playChallenge, playFinale, playVote } from '../contest/run';
import { applyEpisode, initialContest } from '../contest/state';
import type { Contestant } from '../contest/types';
import { formatIssuePath } from '../schema-kit';
import { canonicalJson, lineHash } from './canonical';
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
  return canonicalJson(event, 'serializeEvent');
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

export interface ContestMismatch {
  readonly seq: number;
  /** The episode, or null for the finale. */
  readonly episode: number | null;
  readonly what: 'challenge' | 'vote' | 'finale';
  readonly message: string;
}

/**
 * Recompute every challenge, vote and the finale from the seed recorded in
 * each `challenge.resolved`, the cast's cards (`statsOf` plus the strategy in
 * `character.pooled`) and the season's vote model, and report each result
 * that differs from the log. Never throws on a mismatch. For logs whose dice
 * came from a seed: sims, the playground and tests.
 */
export function verifyContest(events: ReadonlyArray<LeagueEvent>, statsOf: (id: string) => EffectiveStats): ReadonlyArray<ContestMismatch> {
  const out: ContestMismatch[] = [];
  const created = events.find((e) => e.type === 'season.created');
  if (created === undefined) return out;
  const { config } = created.payload;
  const model = voteModel(config.contest.model);
  const cast: Contestant[] = events.flatMap((e) => (e.type === 'character.pooled' ? [contestant(statsOf(e.payload.character), e.payload.strategy)] : []));
  const map = castMap(cast);
  let s = initialContest(cast, model);
  let seed: string | null = null;
  let immune: string | null = null;
  const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
  for (const e of events) {
    if (e.type === 'challenge.resolved') {
      seed = e.payload.seed;
      const expected = playChallenge(s, map, e.payload.challenge, seed, e.payload.episode, config.contest.lapDc);
      immune = e.payload.result.winner;
      if (!same(expected, e.payload.result)) {
        out.push({ seq: e.seq, episode: e.payload.episode, what: 'challenge', message: `the seed gives ${expected.winner} the win in ${expected.rounds.length} rounds; the log has ${e.payload.result.winner} in ${e.payload.result.rounds.length}` });
      }
    } else if (e.type === 'vote.resolved') {
      if (seed === null || immune === null) continue;
      const expected = playVote(s, map, immune, seed, e.payload.episode, model);
      if (!same(expected, e.payload.vote)) {
        out.push({ seq: e.seq, episode: e.payload.episode, what: 'vote', message: `the seed sends ${expected.boot} home; the log has ${e.payload.vote.boot}` });
      }
      s = applyEpisode(s, { episode: e.payload.episode, immune, vote: e.payload.vote }, model);
    } else if (e.type === 'finale.resolved') {
      if (seed === null) continue;
      const expected = playFinale(s, map, seed, model);
      if (!same(expected, e.payload.result)) out.push({ seq: e.seq, episode: null, what: 'finale', message: `the seed crowns ${expected.winner}; the log has ${e.payload.result.winner}` });
    }
  }
  return out;
}
