/**
 * Consistency checks for recorded contest results. They need no stats and
 * no seed: a recorded challenge must eliminate down to its winner, a vote's
 * ballots must be legal and its boot must follow from them, and so on. The
 * reducers run them on every event; recomputing the dice from the seed is
 * `verifyContest`'s job (events/replay.ts).
 *
 * Each returns null when the record holds together, else what is wrong.
 */
import type { Ballot, ChallengeResult, FinaleResult, VoteResult } from './types';

/** The challenge ran among exactly `alive`, each round among those still in, down to the winner. */
export function challengeProblem(alive: ReadonlyArray<string>, result: ChallengeResult): string | null {
  let left = [...alive];
  for (const [i, round] of result.rounds.entries()) {
    const rolled = round.rolls.map((r) => r.id);
    if (rolled.length !== left.length || !left.every((id) => rolled.includes(id))) {
      return `round ${i + 1} rolled for ${rolled.join(', ')}, but ${left.join(', ')} were still in`;
    }
    for (const r of round.rolls) {
      const expected = r.eligible && r.d20 + r.modifier >= round.dc;
      if (r.pass !== expected) return `round ${i + 1}: ${r.id}'s ${r.d20}${r.modifier >= 0 ? '+' : ''}${r.modifier} vs DC ${round.dc} is recorded as ${r.pass ? 'a pass' : 'a fail'}`;
      if (r.d20 < 1 || r.d20 > 20 || !Number.isInteger(r.d20)) return `round ${i + 1}: ${r.id} rolled ${r.d20}`;
    }
    if (round.out.some((id) => !left.includes(id))) return `round ${i + 1} puts out someone not in it`;
    left = left.filter((id) => !round.out.includes(id));
    if (left.length === 0) return `round ${i + 1} puts everyone out`;
  }
  if (left.length !== 1 || left[0] !== result.winner) return `the rounds leave ${left.join(', ') || 'nobody'}, but the winner is ${result.winner}`;
  return null;
}

function counts(ballots: ReadonlyArray<Ballot>): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of ballots) m.set(b.target, (m.get(b.target) ?? 0) + 1);
  return m;
}

/** The most-voted targets, in `order`. */
export function topOf(ballots: ReadonlyArray<Ballot>, order: ReadonlyArray<string>): ReadonlyArray<string> {
  const c = counts(ballots);
  const top = Math.max(0, ...c.values());
  return top === 0 ? [] : order.filter((id) => c.get(id) === top);
}

function sameSet(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
}

/** Pick from a draw: `tied[floor(roll × n)]`. */
export function drawn(tied: ReadonlyArray<string>, roll: number): string {
  return tied[Math.min(tied.length - 1, Math.floor(roll * tied.length))]!;
}

/** Every one of `alive` voted once, for someone else still in and not `immune`; the boot follows from the ballots. */
export function voteProblem(alive: ReadonlyArray<string>, immune: string, vote: VoteResult): string | null {
  const voters = vote.ballots.map((b) => b.voter);
  if (!sameSet(voters, alive)) return `the voters (${voters.join(', ')}) are not exactly those still in`;
  for (const b of vote.ballots) {
    if (!alive.includes(b.target)) return `${b.voter} voted for ${b.target}, who is not in the contest`;
    if (b.target === b.voter) return `${b.voter} voted for themselves`;
    if (b.target === immune) return `${b.voter} voted for ${immune}, who is immune`;
  }
  const tied = topOf(vote.ballots, alive);
  if (tied.length === 1) {
    if (vote.revote !== null || vote.draw !== null) return 'a revote or a draw without a tie';
    return vote.boot === tied[0] ? null : `the ballots send ${tied[0]} home, not ${vote.boot}`;
  }
  if (vote.revote === null) return `a tie between ${tied.join(', ')} with no revote`;
  if (!sameSet(vote.revote.tied, tied)) return `the revote is among ${vote.revote.tied.join(', ')}, but ${tied.join(', ')} tied`;
  const revoters = alive.filter((id) => !tied.includes(id));
  if (!sameSet(vote.revote.ballots.map((b) => b.voter), revoters)) return 'the revote is not by everyone but the tied';
  if (vote.revote.ballots.some((b) => !tied.includes(b.target))) return 'a revote ballot is for someone not tied';
  const still = revoters.length === 0 ? tied : topOf(vote.revote.ballots, alive);
  if (still.length === 1) {
    if (vote.draw !== null) return 'a draw after a decisive revote';
    return vote.boot === still[0] ? null : `the revote sends ${still[0]} home, not ${vote.boot}`;
  }
  if (vote.draw === null) return `still tied after the revote (${still.join(', ')}) with no draw`;
  if (!sameSet(vote.draw.tied, still)) return `the draw is among ${vote.draw.tied.join(', ')}, but ${still.join(', ')} are tied`;
  if (!(vote.draw.roll >= 0 && vote.draw.roll < 1)) return `the draw's roll ${vote.draw.roll} is outside [0, 1)`;
  const pick = drawn(vote.draw.tied, vote.draw.roll);
  return vote.boot === pick ? null : `the draw picks ${pick}, not ${vote.boot}`;
}

/** The finalists are those still in, every juror voted once for a finalist, and the winner follows. */
export function finaleProblem(alive: ReadonlyArray<string>, jury: ReadonlyArray<string>, result: FinaleResult): string | null {
  if (!sameSet([...result.finalists], [...alive])) return `the finalists (${result.finalists.join(', ')}) are not those still in`;
  if (!sameSet(result.ballots.map((b) => b.juror), jury)) return 'the jurors are not exactly the voted-out';
  if (result.ballots.some((b) => !result.finalists.includes(b.finalist))) return 'a juror voted for someone who is not a finalist';
  const ballots = result.ballots.map((b) => ({ voter: b.juror, target: b.finalist }));
  const tied = topOf(ballots, result.finalists);
  const field = tied.length === 0 ? result.finalists : tied;
  if (field.length === 1) {
    if (result.draw !== null) return 'a draw without a tie';
    return result.winner === field[0] ? null : `the jury chose ${field[0]}, not ${result.winner}`;
  }
  if (result.draw === null) return `a tie between ${field.join(', ')} with no draw`;
  if (!sameSet(result.draw.tied, field)) return `the draw is among ${result.draw.tied.join(', ')}, but ${field.join(', ')} are tied`;
  const pick = drawn(result.draw.tied, result.draw.roll);
  return result.winner === pick ? null : `the draw picks ${pick}, not ${result.winner}`;
}
