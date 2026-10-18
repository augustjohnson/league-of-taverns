/**
 * The contest as it stands between episodes: who is still in, the jury, the
 * immunity wins, and what every monster thinks of every other (affinity and
 * grudges). Every input is public: the cards and the ballots, which are read
 * out at every vote. Only the noise in the next vote is hidden.
 *
 * Plain records, not Maps, so the state is JSON-safe and deep-equals cleanly
 * on replay.
 */
import { hasTag } from './cards';
import type { VoteModel } from './model';
import type { Contestant, EpisodeResult, VoteResult } from './types';

export type Matrix = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface ContestState {
  /** Still in, in cast order. */
  readonly alive: ReadonlyArray<string>;
  /** Voted out, in the order they left. */
  readonly jury: ReadonlyArray<string>;
  /** Immunity wins by id (absent = 0). */
  readonly wins: Readonly<Record<string, number>>;
  /** `affinity[a][b]`: how much `a` likes `b`. */
  readonly affinity: Matrix;
  /** `grudges[a][b]`: `b`'s votes against `a`, fading each episode. */
  readonly grudges: Matrix;
  /** `votedOut[a]`: who voted for `a` at the vote that sent it to the jury. */
  readonly votedOut: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Episodes played. */
  readonly episodes: number;
}

/** Everyone in, nobody on the jury, affinity from shared tags. */
export function initialContest(cast: ReadonlyArray<Contestant>, model: VoteModel): ContestState {
  const affinity: Record<string, Record<string, number>> = {};
  const mean = cast.reduce((sum, c) => sum + c.power, 0) / Math.max(1, cast.length);
  const sd = Math.sqrt(cast.reduce((sum, c) => sum + (c.power - mean) * (c.power - mean), 0) / Math.max(1, cast.length)) || 1;
  for (const a of cast) {
    const row: Record<string, number> = {};
    for (const b of cast) {
      if (a.id === b.id) continue;
      row[b.id] = startingAffinity(a, b, model, (a.power - mean) / sd);
    }
    affinity[a.id] = row;
  }
  return { alive: cast.map((c) => c.id), jury: [], wins: {}, affinity, grudges: {}, votedOut: {}, episodes: 0 };
}

/**
 * What `a` thinks of `b` before anything happens: shared tags, a loyal
 * voter's tag, and, when `b` rides coattails, flattery that works on `a` as
 * far as `a` is strong (`aPower`: `a`'s challenge power as a z-score in the cast).
 */
export function startingAffinity(a: Contestant, b: Contestant, model: VoteModel, aPower = 0): number {
  const axis = (prefix: string): string | undefined => a.tags.find((t) => t.startsWith(prefix));
  const shares = (prefix: string): boolean => {
    const tag = axis(prefix);
    return tag !== undefined && b.tags.includes(tag);
  };
  let v = 0;
  if (shares('type:')) v += model.shareType;
  if (shares('subtype:')) v += model.shareSubtype;
  if (shares('law:')) v += model.shareLaw;
  if (shares('moral:')) v += model.shareMoral;
  const good = (c: Contestant): boolean => c.tags.includes('moral:good');
  const evil = (c: Contestant): boolean => c.tags.includes('moral:evil');
  if ((good(a) && evil(b)) || (evil(a) && good(b))) v += model.opposeMoral;
  if (a.strategy.kind === 'loyal' && hasTag(b, a.strategy.tag)) v += model.loyalAffinity;
  if (b.strategy.kind === 'coattails' && aPower > 0) v += model.flattery * aPower;
  return v;
}

export const affinityOf = (s: ContestState, a: string, b: string): number => s.affinity[a]?.[b] ?? 0;
export const grudgeOf = (s: ContestState, a: string, b: string): number => s.grudges[a]?.[b] ?? 0;
export const winsOf = (s: ContestState, id: string): number => s.wins[id] ?? 0;

/**
 * How dangerous each monster still in looks: challenge power as a z-score
 * among those still in, plus `winThreat` per immunity win.
 */
export function threats(s: ContestState, cast: ReadonlyMap<string, Contestant>, model: VoteModel): ReadonlyMap<string, number> {
  const power = powerScores(s, cast);
  return new Map(s.alive.map((id) => [id, power.get(id)! + model.winThreat * winsOf(s, id)]));
}

/** Each monster still in, its challenge power as a z-score among those still in. */
export function powerScores(s: ContestState, cast: ReadonlyMap<string, Contestant>): ReadonlyMap<string, number> {
  const powers = s.alive.map((id) => cast.get(id)!.power);
  const mean = powers.reduce((a, b) => a + b, 0) / Math.max(1, powers.length);
  const variance = powers.reduce((a, p) => a + (p - mean) * (p - mean), 0) / Math.max(1, powers.length);
  const sd = Math.sqrt(variance) || 1;
  return new Map(s.alive.map((id) => [id, (cast.get(id)!.power - mean) / sd]));
}

/** Every ballot cast at a vote: the first round, then the revote. */
export function allBallots(vote: VoteResult): ReadonlyArray<{ readonly voter: string; readonly target: string }> {
  return vote.revote === null ? vote.ballots : [...vote.ballots, ...vote.revote.ballots];
}

/**
 * The contest after an episode: the immune monster's win counts, the boot
 * joins the jury, grudges fade, then the ballots move affinity (voting
 * together brings two monsters closer; a vote against someone is resented)
 * and add to grudges.
 */
export function applyEpisode(s: ContestState, result: EpisodeResult, model: VoteModel): ContestState {
  const { immune, vote } = result;
  const boot = vote.boot;
  const affinity: Record<string, Record<string, number>> = {};
  for (const [a, row] of Object.entries(s.affinity)) affinity[a] = { ...row };
  const grudges: Record<string, Record<string, number>> = {};
  for (const [a, row] of Object.entries(s.grudges)) {
    const faded: Record<string, number> = {};
    for (const [b, g] of Object.entries(row)) faded[b] = g * model.grudgeDecay;
    grudges[a] = faded;
  }
  const add = (m: Record<string, Record<string, number>>, a: string, b: string, d: number): void => {
    const row = (m[a] ??= {});
    row[b] = (row[b] ?? 0) + d;
  };

  const first = vote.ballots;
  for (let i = 0; i < first.length; i++) {
    for (let j = i + 1; j < first.length; j++) {
      const x = first[i]!;
      const y = first[j]!;
      if (x.target !== y.target) continue;
      add(affinity, x.voter, y.voter, model.coVote);
      add(affinity, y.voter, x.voter, model.coVote);
    }
  }
  for (const { voter, target } of allBallots(vote)) {
    add(affinity, target, voter, -model.targetResents);
    add(affinity, voter, target, -model.voterCools);
    add(grudges, target, voter, 1);
  }

  const final = vote.revote === null ? vote.ballots : vote.revote.ballots;
  return {
    alive: s.alive.filter((id) => id !== boot),
    jury: [...s.jury, boot],
    wins: { ...s.wins, [immune]: winsOf(s, immune) + 1 },
    affinity,
    grudges,
    votedOut: { ...s.votedOut, [boot]: final.filter((b) => b.target === boot).map((b) => b.voter) },
    episodes: s.episodes + 1,
  };
}
