/**
 * The vote and the jury vote.
 *
 * Each voter scores every legal target ("how much do I want you gone") from
 * its card and the contest so far, in two passes:
 *
 * 1. Its own view: affinity protects a target, so does challenge power a
 *    little (`keepStrong`), and the strategy adds its term (`strategyScore`). The best target is the voter's first choice.
 * 2. Coordination: every voter leans toward the first choices of the
 *    monsters it likes (blocs), and a `floater` toward the room's.
 *
 * Then each voter follows its card, except that with chance `noise` it
 * strays to its second or third choice. The vote is a plurality. A tie
 * goes to a revote among the tied, by everyone else; still tied, the Lich
 * draws a name. Nobody votes for themselves or the immune monster.
 */
import type { Rng } from '../rng';
import { hasTag } from './cards';
import { drawn, topOf as leaders } from './check';
import type { VoteModel } from './model';
import { affinityOf, grudgeOf, powerScores, threats, winsOf, type ContestState } from './state';
import type { Contestant, FinaleResult, VoteResult } from './types';

type Cast = ReadonlyMap<string, Contestant>;

/** True once `coattails` voters have turned: `betrayAt` or fewer are still in. */
export function betraying(s: ContestState, model: VoteModel): boolean {
  return s.alive.length <= model.betrayAt;
}

/** A voter's own reason to want `target` gone, from its strategy alone. */
export function strategyScore(
  s: ContestState,
  voter: Contestant,
  target: Contestant,
  threat: ReadonlyMap<string, number>,
  model: VoteModel,
): number {
  const t = threat.get(target.id) ?? 0;
  const st = voter.strategy;
  switch (st.kind) {
    case 'loyal':
      return hasTag(target, st.tag) ? -model.loyalProtect : model.loyalThreat * t;
    case 'threat':
      return model.threat * t;
    case 'coattails':
      // The late betrayal: ride the strong until the end is in sight, then cut them down.
      return betraying(s, model) ? model.betrayal * t : -model.coattails * t;
    case 'grudge':
      return model.grudge * grudgeOf(s, voter.id, target.id);
    case 'floater':
      return 0;
  }
}

/** Every voter's scores for every legal target, after both passes. Targets in cast order. */
export function voteScores(
  s: ContestState,
  cast: Cast,
  voters: ReadonlyArray<string>,
  targets: (voter: string) => ReadonlyArray<string>,
  model: VoteModel,
): ReadonlyMap<string, ReadonlyArray<{ readonly target: string; readonly score: number }>> {
  const threat = threats(s, cast, model);
  const power = powerScores(s, cast);
  const own = new Map<string, Map<string, number>>();
  const firstChoice = new Map<string, string>();
  for (const v of voters) {
    const voter = cast.get(v)!;
    const row = new Map<string, number>();
    for (const t of targets(v)) {
      const score =
        -model.affinity * affinityOf(s, v, t) + model.grudgeAll * grudgeOf(s, v, t) - model.keepStrong * power.get(t)! + strategyScore(s, voter, cast.get(t)!, threat, model);
      row.set(t, score);
    }
    own.set(v, row);
    const best = argmax(row);
    if (best !== null) firstChoice.set(v, best);
  }
  const out = new Map<string, Array<{ target: string; score: number }>>();
  for (const v of voters) {
    const voter = cast.get(v)!;
    const row = own.get(v)!;
    const scored = [...row].map(([t, base]) => {
      let score = base;
      let room = 0;
      for (const f of voters) {
        if (f === v || f === t || firstChoice.get(f) !== t) continue;
        room++;
        const like = affinityOf(s, v, f);
        if (like > 0) score += model.bloc * like;
      }
      if (voter.strategy.kind === 'floater') score += (model.floater * room) / Math.max(1, voters.length - 1);
      return { target: t, score };
    });
    out.set(v, scored);
  }
  return out;
}

/** The key with the highest value; the first on a tie (insertion order). Null when empty. */
function argmax(row: ReadonlyMap<string, number>): string | null {
  let best: string | null = null;
  let top = -Infinity;
  for (const [k, v] of row) {
    if (v > top) {
      top = v;
      best = k;
    }
  }
  return best;
}

/**
 * Pick from scored options: the best, or with chance `noise` the second or
 * third best (evenly). Draws one number from `rng` per pick, and a second
 * only when it strays. Ties keep the options' order.
 */
export function choose(options: ReadonlyArray<{ readonly target: string; readonly score: number }>, rng: Rng, noise: number): string {
  if (options.length === 0) throw new Error('choose: no options');
  const ranked = [...options].map((o, i) => ({ ...o, i })).sort((a, b) => b.score - a.score || a.i - b.i);
  const r = rng();
  if (r < noise && ranked.length > 1) {
    const span = Math.min(2, ranked.length - 1);
    return ranked[1 + Math.floor(rng() * span)]!.target;
  }
  return ranked[0]!.target;
}

/**
 * The vote at the end of an episode, with dice from `rng`. Everyone still in
 * votes; `immune` can't be voted for. Throws if fewer than two could be voted for.
 */
export function castVotes(s: ContestState, cast: Cast, immune: string | null, rng: Rng, model: VoteModel): VoteResult {
  const order = s.alive;
  const eligible = order.filter((id) => id !== immune);
  if (eligible.length < 2) throw new Error(`castVotes: only ${eligible.length} can be voted for`);
  const scores = voteScores(s, cast, order, (v) => eligible.filter((t) => t !== v), model);
  const ballots = order.map((voter) => ({ voter, target: choose(scores.get(voter)!, rng, model.noise) }));
  const tied = leaders(ballots, order);
  if (tied.length === 1) return { ballots, revote: null, draw: null, boot: tied[0]! };

  // The revote: everyone but the tied, among the tied.
  const revoters = order.filter((id) => !tied.includes(id));
  const again = voteScores(s, cast, revoters, () => tied, model);
  const second = revoters.map((voter) => ({ voter, target: choose(again.get(voter)!, rng, model.noise) }));
  const still = second.length === 0 ? tied : leaders(second, order);
  if (still.length === 1) return { ballots, revote: { tied, ballots: second }, draw: null, boot: still[0]! };
  const roll = rng();
  return { ballots, revote: { tied, ballots: second }, draw: { tied: still, roll }, boot: drawn(still, roll) };
}

/**
 * The jury picks the winner among the finalists (everyone still in). Each
 * juror leans to the finalist it likes most, holds a vote against it
 * against the finalist who cast it, and adds its strategy's view:
 * `loyal` favours its tag, `threat` respects immunity wins, `coattails`
 * backs the strongest, `grudge` never forgives, `floater` follows the jury.
 */
export function juryVote(s: ContestState, cast: Cast, rng: Rng, model: VoteModel): FinaleResult {
  const finalists = s.alive;
  if (finalists.length === 0) throw new Error('juryVote: no finalists');
  const threat = threats(s, cast, model);
  const own = (juror: string, f: string): number => {
    const j = cast.get(juror)!;
    const voted = (s.votedOut[juror] ?? []).includes(f);
    let score = affinityOf(s, juror, f) - (voted ? model.juryBitter : 0);
    switch (j.strategy.kind) {
      case 'loyal':
        if (hasTag(cast.get(f)!, j.strategy.tag)) score += model.juryLoyal;
        break;
      case 'threat':
        score += model.juryWins * winsOf(s, f);
        break;
      case 'coattails':
        score += model.juryCoattails * (threat.get(f) ?? 0);
        break;
      case 'grudge':
        score -= model.juryGrudge * grudgeOf(s, juror, f) + (voted ? model.juryGrudge : 0);
        break;
      case 'floater':
        break;
    }
    return score;
  };
  const firstChoice = new Map(s.jury.map((j) => [j, argmax(new Map(finalists.map((f) => [f, own(j, f)])))!]));
  const ballots = s.jury.map((juror) => {
    const options = finalists.map((f) => {
      let score = own(juror, f);
      if (cast.get(juror)!.strategy.kind === 'floater') {
        const room = s.jury.filter((o) => o !== juror && firstChoice.get(o) === f).length;
        score += (model.floater * room) / Math.max(1, s.jury.length - 1);
      }
      return { target: f, score };
    });
    return { juror, finalist: choose(options, rng, model.noise) };
  });
  const tied = leaders(
    ballots.map((b) => ({ voter: b.juror, target: b.finalist })),
    finalists,
  );
  if (tied.length === 1) return { finalists, ballots, draw: null, winner: tied[0]! };
  if (tied.length === 0) {
    // No jury at all (a contest with nobody voted out): the Lich draws among the finalists.
    const roll = rng();
    return { finalists, ballots, draw: { tied: finalists, roll }, winner: drawn(finalists, roll) };
  }
  const roll = rng();
  return { finalists, ballots, draw: { tied, roll }, winner: drawn(tied, roll) };
}
