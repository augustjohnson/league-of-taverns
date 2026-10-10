import type { EffectiveStats, LeagueState, Lineup, Rng } from '@league-of-taverns/engine';

/**
 * What a bot is allowed to know: exactly what a human manager could see.
 * That means league state and the public schedule, but never sealed mission
 * structure. A bot that peeks at missions makes the balance report meaningless.
 */
export interface PublicView {
  readonly state: LeagueState;
  readonly tavern: string;
  readonly statsOf: (characterId: string) => EffectiveStats;
  readonly schedule: ReadonlyArray<{ readonly week: number; readonly environment: string; readonly theme: string }>;
  /** Bot-private randomness, from rngFor(simSeed, 'bot:' + tavern + ':' + decision). */
  readonly rng: Rng;
}

export interface DraftStrategy {
  readonly id: string;
  pick(view: PublicView, available: ReadonlyArray<string>): string;
}

export interface LineupStrategy {
  readonly id: string;
  lineup(view: PublicView, week: number): Lineup;
}

export interface WaiverStrategy {
  readonly id: string;
  claims(view: PublicView, freeAgents: ReadonlyArray<string>): ReadonlyArray<{ readonly add: string; readonly drop: string | null }>;
}

/** A full bot manager: one strategy per decision. Named combinations live in ./strategies. */
export interface BotManager {
  readonly id: string;
  readonly draft: DraftStrategy;
  readonly lineup: LineupStrategy;
  readonly waivers: WaiverStrategy;
}
