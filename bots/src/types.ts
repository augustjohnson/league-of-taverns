import type { BaseStats, BattleModel, CrEighths, EffectiveStats, LeagueState, Lineup, Mission, Rng } from '@league-of-taverns/engine';
import type { HexStrategy } from './strategies/hex';
import type { TavernStrategy } from './strategies/tavern';

/**
 * What a bot is allowed to know: exactly what a human manager could see.
 *
 * Missions are open (docs/decisions.md D-08), so a human can read every
 * week's mission structure in the repo before the lock and work out exact
 * projections with the engine (D-42, whose default embraces this). A bot gets
 * the same: the structure, the stat blocks of the creatures in it, and the
 * season's battle model. Nothing here is private to the commissioner, and
 * nothing describes the dice: the real roll (D-13) is not in the view.
 *
 * Everything is read-only. A bot returns a decision and never mutates the
 * view. Every decision is then validated by the engine like any human command.
 */
export interface PublicView {
  /** League state folded from the public event log: pool, rosters, owners, results. */
  readonly state: LeagueState;
  /** The tavern this bot manages. */
  readonly tavern: string;
  /**
   * Effective stats (base + this season's modifiers) for a pooled character.
   * Public: bases are SRD stat blocks and modifiers are announced with the
   * pool (docs/rules.md §11, "Season announced").
   */
  readonly statsOf: (characterId: string) => EffectiveStats;
  /** The public schedule: week → environment and theme (docs/rules.md §6). */
  readonly schedule: ReadonlyArray<{ readonly week: number; readonly environment: string; readonly theme: string }>;
  /**
   * The mission for `week`, or null if none is known (e.g. not yet selected,
   * or a sim that withholds missions to measure what reading them is worth).
   * Public because missions are open (D-08) and the default for D-42 is to
   * embrace pre-lock projections.
   */
  readonly missionFor: (week: number) => Mission | null;
  /**
   * Base stats for an encounter creature by Open5e slug. Public: the pinned
   * snapshot is in the repo (data/open5e/), and encounter refs are part of
   * the open mission structure.
   */
  readonly baseOf: (slug: string) => BaseStats;
  /**
   * The season's battle model (`config.missions.battleModel`, looked up in
   * `BATTLE_MODELS`). Public: the config and the engine are both in the repo.
   */
  readonly battleModel: BattleModel;
  /**
   * CR of a pooled character, in eighths. Optional: when absent, bots read
   * `state.pool` and then `statsOf(id).cr`. Public: CRs are in the pool.
   */
  readonly crOf?: (characterId: string) => CrEighths;
  /** Bot-private randomness, from rngFor(simSeed, 'bot:' + tavern + ':' + decision). */
  readonly rng: Rng;
}

export interface DraftStrategy {
  readonly id: string;
  /** One of `available`. Never returns a pick that leaves the roster unable to field a legal lineup, if any pick avoids it. */
  pick(view: PublicView, available: ReadonlyArray<string>): string;
}

/** The best lineup a strategy finds for one roster in one week, scored by the strategy's own objective. */
export interface ScoredLineup {
  readonly lineup: Lineup;
  /** Higher is better. Comparable only between calls of one strategy for one week. */
  readonly score: number;
}

export interface LineupStrategy {
  readonly id: string;
  /**
   * The lineup to submit for `week` from the bot's own roster. It always
   * passes `validateLineup`. Null only when the roster has no legal lineup at
   * all, in which case the tavern scores 0 for the week (docs/rules.md §5)
   * and the bot submits nothing.
   */
  lineup(view: PublicView, week: number): Lineup | null;
  /**
   * The best lineup and its score for any roster (a list of character ids in
   * draft order), or null if it has no legal lineup. Waivers use it to score
   * hypothetical rosters with the same objective the lineup uses.
   */
  best(view: PublicView, roster: ReadonlyArray<string>, week: number): ScoredLineup | null;
}

export interface WaiverStrategy {
  readonly id: string;
  /** Claims in preference order. The engine resolves them under rolling priority (docs/rules.md §9). */
  claims(view: PublicView, freeAgents: ReadonlyArray<string>): ReadonlyArray<{ readonly add: string; readonly drop: string | null }>;
}

/** A full bot manager: one strategy per decision. Named combinations live in ./strategies. */
export interface BotManager {
  readonly id: string;
  readonly tavern: TavernStrategy;
  readonly hex: HexStrategy;
  readonly draft: DraftStrategy;
  readonly lineup: LineupStrategy;
  readonly waivers: WaiverStrategy;
}
