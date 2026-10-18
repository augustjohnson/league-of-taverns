/**
 * What a monster is worth before the season: its expected points over many
 * simulated contests with the real cast and stand-in challenges (the real
 * ones are secret). Public arithmetic: the cards and the vote model are
 * open, so anyone could run it.
 */
import { genericChallenge, rngFor, runContest, startingAffinity } from '@league-of-taverns/engine';
import type { Contestant, SeasonConfig, VoteModel } from '@league-of-taverns/engine';

/** Contests simulated per estimate. */
export const VALUE_RUNS = 25;

const cache = new Map<string, ReadonlyMap<string, number>>();

/**
 * Each cast member's expected fantasy points: `survive` per vote survived,
 * `immunity` per win, `juryVote` per jury vote and `winner` for winning,
 * averaged over `runs` contests (streams `value:<n>` under `seed`). Cached by
 * cast, model, scoring and seed.
 */
export function expectedPoints(
  cast: ReadonlyArray<Contestant>,
  config: SeasonConfig,
  model: VoteModel,
  seed: string,
  runs = VALUE_RUNS,
): ReadonlyMap<string, number> {
  const key = `${seed}|${runs}|${cast.map((c) => `${c.id}:${c.strategy.kind}`).join(',')}|${JSON.stringify(model)}|${JSON.stringify(config.scoring)}|${config.contest.finalists}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const { scoring } = config;
  const votes = cast.length - config.contest.finalists;
  const total = new Map(cast.map((c) => [c.id, 0]));
  for (let n = 0; n < runs; n++) {
    const challenges = Array.from({ length: votes }, (_, i) => genericChallenge(rngFor(seed, `value:${n}:challenge:${i}`)));
    const run = runContest(cast, challenges, `${seed}/value:${n}`, { finalists: config.contest.finalists, lapDc: config.contest.lapDc, model });
    run.episodes.forEach((e, i) => {
      total.set(e.immune, total.get(e.immune)! + scoring.immunity);
      // Everyone still in after this vote survives it.
      const out = new Set(run.episodes.slice(0, i + 1).map((x) => x.vote.boot));
      for (const c of cast) if (!out.has(c.id)) total.set(c.id, total.get(c.id)! + scoring.survive);
    });
    for (const b of run.finale.ballots) total.set(b.finalist, total.get(b.finalist)! + scoring.juryVote);
    total.set(run.finale.winner, total.get(run.finale.winner)! + scoring.winner);
  }
  const out = new Map([...total].map(([id, t]) => [id, t / runs]));
  if (cache.size > 64) cache.clear();
  cache.set(key, out);
  return out;
}

/** How much the rest of the cast likes `c` at the start: the size of its natural bloc. */
export function warmth(c: Contestant, cast: ReadonlyArray<Contestant>, model: VoteModel): number {
  return cast.reduce((sum, o) => (o.id === c.id ? sum : sum + startingAffinity(o, c, model)), 0);
}
