/**
 * The Common Room's messages: the league's event log, read out as the game's
 * one running story. Pure (no DOM), so tests run it in Node; play.ts renders
 * each item as a message and paces their arrival.
 *
 * The room shows the league as an onlooker at the table would see it: every
 * tavern's picks, hexes and results, but no rival's lineup until the lock and
 * no rival's waiver claim until the claims resolve (your own claims show to
 * you at once). Items are keyed, so a re-render keeps a message that hasn't
 * changed.
 */
import type { Ability, LeagueEvent, Lineup, RunResult } from '@league-of-taverns/engine';
import { draftCalls, ranked, tableMoves, type DraftCall } from './view';

export interface FeedRun {
  readonly tavern: string;
  /** Null for a tavern that fielded no legal lineup and ran nothing (D-27). */
  readonly run: RunResult | null;
  readonly points: number;
  readonly projectedPoints: number;
  /** Rank in the week: equal points share a rank (docs/rules.md). */
  readonly rank: number;
}

export interface FeedTableRow {
  readonly tavern: string;
  readonly rank: number;
  readonly points: number;
  /** The row the tavern stood in after the week before (0-based), and the places it rose since. */
  readonly wasRow: number;
  readonly rose: number;
}

export type FeedItem =
  | { readonly kind: 'divider'; readonly key: string; readonly label: string }
  | { readonly kind: 'season'; readonly key: string; readonly managers: ReadonlyArray<string>; readonly pool: number }
  | { readonly kind: 'tavern'; readonly key: string; readonly seq: number; readonly manager: string; readonly tavern: string }
  | {
      readonly kind: 'round';
      readonly key: string;
      readonly round: number;
      readonly calls: ReadonlyArray<DraftCall & { readonly seq: number }>;
      /** Every tavern has picked in this round. */
      readonly complete: boolean;
    }
  | { readonly kind: 'draft-done'; readonly key: string; readonly rounds: number }
  | { readonly kind: 'week-open'; readonly key: string; readonly week: number }
  | { readonly kind: 'ready'; readonly key: string; readonly week: number; readonly tavern: string }
  | { readonly kind: 'hex'; readonly key: string; readonly seq: number; readonly tavern: string; readonly target: string; readonly ability: Ability; readonly week: number }
  | { readonly kind: 'claim'; readonly key: string; readonly seq: number; readonly tavern: string; readonly add: string; readonly drop: string | null }
  | {
      readonly kind: 'lock';
      readonly key: string;
      readonly seq: number;
      readonly week: number;
      readonly lineups: ReadonlyArray<{ readonly tavern: string; readonly lineup: Lineup | null; readonly source: 'submitted' | 'carried' | 'fallback' | 'none' }>;
    }
  | { readonly kind: 'results'; readonly key: string; readonly seq: number; readonly week: number; readonly runs: ReadonlyArray<FeedRun> }
  | { readonly kind: 'table'; readonly key: string; readonly week: number; readonly rows: ReadonlyArray<FeedTableRow>; readonly final: boolean }
  | {
      readonly kind: 'waivers';
      readonly key: string;
      readonly seq: number;
      readonly week: number;
      readonly outcomes: ReadonlyArray<{ readonly tavern: string; readonly add: string; readonly drop: string | null; readonly awarded: boolean; readonly reason: string }>;
    };

export type FeedKind = FeedItem['kind'];

export interface FeedOptions {
  /** Your tavern, or null (before you choose one, or a season of bots). Your own claims show at once; rivals' wait for the resolution. */
  readonly me: string | null;
  /** Taverns in the season (= managers), for the draft's rounds. */
  readonly teams: number;
  /** Rounds in the draft. */
  readonly rounds: number;
  /** Weeks in the season. */
  readonly weeks: number;
  /** Average draft positions, for the crier's steals and reaches (view.ts draftCalls). */
  readonly adp: ReadonlyMap<string, number>;
  /**
   * Taverns that have said they're ready for a week, in the order they said it, each with how many events the log
   * held at the time, so the line sits among your own moves as it happened. Presence: not in the log, so a reload
   * forgets it.
   */
  readonly ready?: ReadonlyArray<{ readonly week: number; readonly tavern: string; readonly at: number }>;
}

/** The room's items for `events`, in the order they happened. */
export function feedItems(events: ReadonlyArray<LeagueEvent>, opts: FeedOptions): ReadonlyArray<FeedItem> {
  const items: FeedItem[] = [];
  const managers: string[] = [];
  const taverns: string[] = [];
  let pool = 0;
  let seasonShown = false;
  const picks: Array<{ pick: number; tavern: string; character: string; seq: number }> = [];
  const claims = new Map<string, { tavern: string; add: string; drop: string | null }>();
  const runs = new Map<number, Array<{ tavern: string; run: RunResult; points: number; projectedPoints: number; seq: number }>>();
  const totals = new Map<string, number>();
  let lastTable: ReadonlyArray<{ tavern: string; rank: number }> | null = null;

  const openWeek = (week: number): void => {
    items.push({ kind: 'divider', key: `divider:week:${week}`, label: `Week ${week}` }, { kind: 'week-open', key: `week-open:${week}`, week });
  };
  const ready = [...(opts.ready ?? [])];
  /** The "ready" lines said before the log reached `at` events. */
  const placeReady = (at: number): void => {
    while (ready.length > 0 && ready[0]!.at <= at) {
      const { week, tavern } = ready.shift()!;
      items.push({ kind: 'ready', key: `ready:${week}:${tavern}`, week, tavern });
    }
  };
  const showSeason = (): void => {
    if (seasonShown) return;
    seasonShown = true;
    items.push({ kind: 'divider', key: 'divider:season', label: 'Before the season' }, { kind: 'season', key: 'season', managers: [...managers], pool });
  };
  /** Draft picks so far, as rounds: a round's item grows pick by pick, so it is rebuilt from `picks` each time. */
  const roundItem = (round: number): FeedItem => {
    const inRound = picks.filter((p) => Math.floor(p.pick / opts.teams) === round);
    const seqOf = new Map(inRound.map((p) => [p.pick, p.seq]));
    const calls = draftCalls(picks, opts.adp, opts.teams)
      .filter((c) => Math.floor(c.pick / opts.teams) === round)
      .map((c) => ({ ...c, seq: seqOf.get(c.pick)! }));
    return { kind: 'round', key: `round:${round}`, round: round + 1, calls, complete: calls.length === opts.teams };
  };

  for (const [i, e] of events.entries()) {
    placeReady(i);
    switch (e.type) {
      case 'character.pooled':
        pool++;
        break;
      case 'manager.joined':
        managers.push(e.payload.manager);
        break;
      case 'tavern.chosen':
        showSeason();
        if (taverns.length === 0) items.push({ kind: 'divider', key: 'divider:taverns', label: 'The tavern pick' });
        taverns.push(e.payload.tavern);
        items.push({ kind: 'tavern', key: `tavern:${e.payload.tavern}`, seq: e.seq, manager: e.payload.manager, tavern: e.payload.tavern });
        break;
      case 'draft.pick': {
        const { pick, tavern, character } = e.payload;
        if (picks.length === 0) items.push({ kind: 'divider', key: 'divider:draft', label: 'The draft' });
        picks.push({ pick, tavern, character, seq: e.seq });
        const round = Math.floor(pick / opts.teams);
        const at = items.findIndex((it) => it.key === `round:${round}`);
        if (at < 0) items.push(roundItem(round));
        else items[at] = roundItem(round);
        if (picks.length === opts.teams * opts.rounds) {
          items.push({ kind: 'draft-done', key: 'draft-done', rounds: opts.rounds });
          openWeek(1);
        }
        break;
      }
      case 'hex.declared':
        items.push({ kind: 'hex', key: `hex:${e.seq}`, seq: e.seq, ...e.payload });
        break;
      case 'waiver.claimed':
        claims.set(e.payload.claim, { tavern: e.payload.tavern, add: e.payload.add, drop: e.payload.drop });
        // A claim is sealed until the claims resolve; your own you see at once.
        if (opts.me !== null && e.payload.tavern === opts.me) {
          items.push({ kind: 'claim', key: `claim:${e.payload.claim}`, seq: e.seq, tavern: e.payload.tavern, add: e.payload.add, drop: e.payload.drop });
        }
        break;
      case 'lineup.locked':
        items.push({ kind: 'lock', key: `lock:${e.payload.week}`, seq: e.seq, week: e.payload.week, lineups: e.payload.lineups });
        break;
      case 'mission.resolved': {
        const { week, tavern, run, points, projectedPoints } = e.payload;
        const list = runs.get(week) ?? [];
        list.push({ tavern, run, points, projectedPoints, seq: e.seq });
        runs.set(week, list);
        break;
      }
      case 'week.finalized': {
        const { week } = e.payload;
        // A tavern with no legal lineup ran nothing and scores 0 (D-27); it still has a place in the week.
        const ran = runs.get(week) ?? [];
        const rows = ranked(
          taverns.map((tavern): Omit<FeedRun, 'rank'> => {
            const r = ran.find((x) => x.tavern === tavern);
            return r === undefined ? { tavern, run: null, points: 0, projectedPoints: 0 } : { tavern, run: r.run, points: r.points, projectedPoints: r.projectedPoints };
          }),
        );
        items.push({ kind: 'results', key: `results:${week}`, seq: e.seq, week, runs: rows });
        for (const r of ran) totals.set(r.tavern, (totals.get(r.tavern) ?? 0) + r.points);
        const table = [...ranked(taverns.map((tavern) => ({ tavern, points: totals.get(tavern) ?? 0 })))].sort(
          (a, b) => a.rank - b.rank || taverns.indexOf(a.tavern) - taverns.indexOf(b.tavern),
        );
        const moves = tableMoves(lastTable ?? table, table);
        items.push({
          kind: 'table',
          key: `table:${week}`,
          week,
          final: week === opts.weeks,
          rows: table.map((r) => ({ ...r, wasRow: moves.get(r.tavern)?.wasRow ?? 0, rose: moves.get(r.tavern)?.rose ?? 0 })),
        });
        lastTable = table;
        break;
      }
      case 'waiver.resolved': {
        // Every week but the last ends with a resolution, claims or none, and the next week opens after it.
        const { week } = e.payload;
        const outcomes = e.payload.outcomes.flatMap((o) => {
          const c = claims.get(o.claim);
          return c === undefined ? [] : [{ ...c, awarded: o.awarded, reason: o.reason }];
        });
        items.push({ kind: 'waivers', key: `waivers:${week}`, seq: e.seq, week, outcomes });
        if (week < opts.weeks) openWeek(week + 1);
        break;
      }
      default:
        break;
    }
  }
  if (!seasonShown && managers.length > 0) showSeason();
  placeReady(events.length);
  return items;
}

/** The round of the latest pick in `items`, or 0 before the draft: earlier rounds collapse once the next one starts. */
export function currentRound(items: ReadonlyArray<FeedItem>): number {
  let round = 0;
  for (const it of items) if (it.kind === 'round') round = it.round;
  return round;
}

/** The latest week with results in `items`, or 0: its results stay open, earlier weeks fold away. */
export function latestResults(items: ReadonlyArray<FeedItem>): number {
  let week = 0;
  for (const it of items) if (it.kind === 'results') week = it.week;
  return week;
}
