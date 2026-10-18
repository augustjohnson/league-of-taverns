/**
 * The vote model's dials, in one place so sims can tune them
 * (docs/lich-contest-plan.md §1). A season may override any of them in its
 * config (`contest.model`); everything else uses `VOTE_MODEL`.
 *
 * Scores are "how much a voter wants a target gone": higher is likelier.
 */
export interface VoteModel {
  /** Chance a vote strays from the card: a seeded pick among the voter's next two choices. */
  readonly noise: number;
  /** Weight of affinity (liking a target protects it). */
  readonly affinity: number;
  /** How far `loyal` voters protect monsters with their tag. */
  readonly loyalProtect: number;
  /** How hard `loyal` voters go after dangerous outsiders. */
  readonly loyalThreat: number;
  /** How hard `threat` voters go after threats. */
  readonly threat: number;
  /** How hard `coattails` voters protect threats (and so target the weak). */
  readonly coattails: number;
  /**
   * The late betrayal: once this many or fewer are still in, `coattails`
   * voters turn on the strongest instead of protecting them.
   */
  readonly betrayAt: number;
  /** How hard `coattails` voters go after threats once they turn. */
  readonly betrayal: number;
  /**
   * Flattery: a strong monster's starting affinity for each `coattails`
   * rider, per standard deviation of its own challenge power above the
   * cast's mean. The strong carry the riders who flatter them, until the
   * riders turn.
   */
  readonly flattery: number;
  /** How hard `grudge` voters go after whoever voted against them. */
  readonly grudge: number;
  /** What everyone else holds against someone who voted for them. */
  readonly grudgeAll: number;
  /** How much a voter follows its friends' first choices (affinity-weighted). */
  readonly bloc: number;
  /** How much `floater` voters follow the room's first choices. */
  readonly floater: number;
  /** Threat added per immunity win, on top of challenge power (in standard deviations). */
  readonly winThreat: number;
  /** How much every voter keeps the useful: a target's challenge power (as a z-score) protects it. */
  readonly keepStrong: number;
  /** Starting affinity for each shared tag axis. */
  readonly shareType: number;
  readonly shareSubtype: number;
  readonly shareLaw: number;
  readonly shareMoral: number;
  /** Good against evil: added (it is negative) when one is good and the other evil. */
  readonly opposeMoral: number;
  /** A `loyal` voter's extra affinity for monsters with its tag. */
  readonly loyalAffinity: number;
  /** Affinity gained by two voters who vote for the same target. */
  readonly coVote: number;
  /** Affinity a target loses for a voter who voted for it (the target remembers). */
  readonly targetResents: number;
  /** Affinity a voter loses for its target. */
  readonly voterCools: number;
  /** How much of a grudge carries into the next episode. */
  readonly grudgeDecay: number;
  /** Jury: how much `loyal` jurors favour a finalist with their tag. */
  readonly juryLoyal: number;
  /** Jury: how much `threat` jurors respect immunity wins. */
  readonly juryWins: number;
  /** Jury: how much `coattails` jurors favour the strongest finalist. */
  readonly juryCoattails: number;
  /** Jury: how much any juror holds it against a finalist who voted them out. */
  readonly juryBitter: number;
  /** Jury: `grudge` jurors' extra bitterness. */
  readonly juryGrudge: number;
}

/**
 * Defaults tuned by sims (`pnpm sim`) to survivor-format.md §7: the favourite boot goes home about two times in three,
 * challenge power helps (correlation with placement about +0.35) but the very strongest are targets, no strategy wins
 * much above par, and alignment is a lean, not a bloc that decides the season.
 */
export const VOTE_MODEL: VoteModel = {
  noise: 0.45,
  affinity: 1,
  loyalProtect: 4,
  loyalThreat: 0.05,
  threat: 0.25,
  coattails: 1.4,
  betrayAt: 5,
  betrayal: 1.5,
  flattery: 1.2,
  grudge: 2,
  grudgeAll: 0.6,
  bloc: 0.5,
  floater: 3,
  winThreat: 0.6,
  keepStrong: 0.1,
  shareType: 1,
  shareSubtype: 1,
  shareLaw: 0.25,
  shareMoral: 0.25,
  opposeMoral: -0.25,
  loyalAffinity: 1.5,
  coVote: 0.5,
  targetResents: 1.2,
  voterCools: 0.4,
  grudgeDecay: 0.85,
  juryLoyal: 3,
  juryWins: 0.8,
  juryCoattails: 1,
  juryBitter: 1.5,
  juryGrudge: 2,
};

/** `VOTE_MODEL` with `overrides` applied. */
export function voteModel(overrides: Partial<VoteModel> = {}): VoteModel {
  return { ...VOTE_MODEL, ...overrides };
}
