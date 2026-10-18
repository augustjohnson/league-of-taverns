/**
 * Draft strategies. Each is a simple, legible idea, so the balance report
 * can say which idea wins, not which tuned blob:
 *
 * - `random`: a seeded uniform pick. The baseline.
 * - `scout`: the most expected points in simulated contests (value.ts).
 * - `power`: the highest challenge power: win immunity, stay safe.
 * - `social`: the warmest welcome from the rest of the cast: big blocs
 *   protect their own.
 */
import type { DraftStrategy, PublicView } from '../types';
import { expectedPoints, warmth } from '../value';

/** The best of `available` by `score`, ties to the earlier one. Throws if it is empty. */
function best(available: ReadonlyArray<string>, score: (id: string) => number): string {
  let pick: string | undefined;
  let top = -Infinity;
  for (const id of available) {
    const s = score(id);
    if (s > top) {
      top = s;
      pick = id;
    }
  }
  if (pick === undefined) throw new Error('draft: nobody is left to pick');
  return pick;
}

const cardOf = (view: PublicView, id: string) => {
  const c = view.cast.find((x) => x.id === id);
  if (c === undefined) throw new Error(`draft: "${id}" is not in the cast`);
  return c;
};

/** The seed a season's scouting runs under: shared by every scout at the table, so they agree. */
export const scoutSeed = (season: string): string => `${season}/scouting`;

export const randomDraft: DraftStrategy = {
  id: 'random',
  pick(view, available) {
    const id = available[Math.floor(view.rng() * available.length)];
    if (id === undefined) throw new Error('draft: nobody is left to pick');
    return id;
  },
};

export const scoutDraft: DraftStrategy = {
  id: 'scout',
  pick(view, available) {
    const value = expectedPoints(view.cast, view.config, view.model, scoutSeed(view.config.id));
    return best(available, (id) => value.get(id) ?? 0);
  },
};

export const powerDraft: DraftStrategy = {
  id: 'power',
  pick(view, available) {
    return best(available, (id) => cardOf(view, id).power);
  },
};

export const socialDraft: DraftStrategy = {
  id: 'social',
  pick(view, available) {
    return best(available, (id) => warmth(cardOf(view, id), view.cast, view.model));
  },
};

export const DRAFT_STRATEGIES = { random: randomDraft, scout: scoutDraft, power: powerDraft, social: socialDraft } as const;
