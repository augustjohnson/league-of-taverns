/**
 * Calling the boot. Each episode a tavern may call who goes home: early
 * (before the challenge, for a bonus) or late (once immunity is known).
 *
 * - `oracle`: works the odds, as well as a sharp regular at the bar can:
 *   it sees each chance blurred by up to ±`ORACLE_BLUR` (people don't run
 *   the numbers exactly). Calls its favourite early; after the challenge
 *   keeps the early call if its chance with the bonus still beats the new
 *   favourite's, else switches.
 * - `hunch`: waits for the challenge, then calls by gut: a pick weighted by
 *   the odds, so usually the favourite and sometimes not.
 * - `gossip`: waits, then calls whoever drew the most votes lately, else
 *   the monster the room likes least. No arithmetic.
 * - `random`: waits, then calls anyone who can go.
 */
import { affinityOf } from '@league-of-taverns/engine';
import type { CallStrategy, PublicView } from '../types';

/** Who can be voted out after the challenge: everyone still in but the immune monster. */
function eligible(view: PublicView, episode: number): ReadonlyArray<string> {
  const immune = view.state.episodes[episode - 1]?.challenge?.result.winner ?? null;
  return view.state.alive.filter((id) => id !== immune);
}

function immuneOf(view: PublicView, episode: number): string | null {
  return view.state.episodes[episode - 1]?.challenge?.result.winner ?? null;
}

/** How far the oracle's read of each chance may be off, as a fraction of it. */
export const ORACLE_BLUR = 0.6;

/** The odds as the oracle reads them: each chance scaled by a factor in [1 − blur/2, 1 + blur/2) from `view.rng`. */
function blurred(view: PublicView, odds: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  return new Map([...odds].map(([id, p]) => [id, p * (1 - ORACLE_BLUR / 2 + ORACLE_BLUR * view.rng())]));
}

function favourite(odds: ReadonlyMap<string, number>): { readonly id: string; readonly p: number } | null {
  let best: { id: string; p: number } | null = null;
  for (const [id, p] of odds) if (best === null || p > best.p) best = { id, p };
  return best;
}

export const oracleCalls: CallStrategy = {
  id: 'oracle',
  early(view) {
    return favourite(blurred(view, view.odds(null).boot))?.id ?? null;
  },
  late(view, episode, current) {
    const odds = blurred(view, view.odds(immuneOf(view, episode)).boot);
    const fav = favourite(odds);
    if (fav === null) return null;
    if (current === undefined) return fav.id;
    if (current.target === fav.id) return null;
    const { call, earlyCallBonus } = view.config.scoring;
    const keep = (odds.get(current.target) ?? 0) * (call + (current.early ? earlyCallBonus : 0));
    return keep >= fav.p * call ? null : fav.id;
  },
};

export const hunchCalls: CallStrategy = {
  id: 'hunch',
  early() {
    return null;
  },
  late(view, episode, current) {
    if (current !== undefined) return null;
    const odds = [...view.odds(immuneOf(view, episode)).boot].filter(([, p]) => p > 0);
    let r = view.rng() * odds.reduce((a, [, p]) => a + p, 0);
    for (const [id, p] of odds) {
      r -= p;
      if (r < 0) return id;
    }
    return odds.at(-1)?.[0] ?? null;
  },
};

export const gossipCalls: CallStrategy = {
  id: 'gossip',
  early() {
    return null;
  },
  late(view, episode, current) {
    if (current !== undefined) return null;
    const options = eligible(view, episode);
    const heat = new Map(options.map((id) => [id, 0]));
    // The last two votes, the latest counting double.
    const recent = view.state.episodes.filter((e) => e.vote !== null).slice(-2);
    recent.forEach((e, i) => {
      for (const b of e.vote!.ballots) if (heat.has(b.target)) heat.set(b.target, heat.get(b.target)! + (i === recent.length - 1 ? 2 : 1));
    });
    const s = view.contest();
    const liked = (id: string): number => view.state.alive.reduce((sum, o) => (o === id ? sum : sum + affinityOf(s, o, id)), 0);
    let pick: string | null = null;
    for (const id of options) {
      if (pick === null || heat.get(id)! > heat.get(pick)! || (heat.get(id) === heat.get(pick) && liked(id) < liked(pick))) pick = id;
    }
    return pick;
  },
};

export const randomCalls: CallStrategy = {
  id: 'random',
  early() {
    return null;
  },
  late(view, episode, current) {
    if (current !== undefined) return null;
    const options = eligible(view, episode);
    return options[Math.floor(view.rng() * options.length)] ?? null;
  },
};

export const CALL_STRATEGIES = { oracle: oracleCalls, hunch: hunchCalls, gossip: gossipCalls, random: randomCalls } as const;
