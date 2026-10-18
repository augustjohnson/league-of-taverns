/**
 * Every content check for one season, as a list of report lines. The
 * validate CLI prints them and exits 1 if there are any.
 *
 * Checks:
 * - config.yaml, the pinned snapshot (manifest sha256), pool.yaml,
 *   managers.yaml, taverns.yaml and challenges/*.yaml, through the loaders
 *   in ./season.ts: shapes, references, one challenge per episode, the
 *   contest's shape against the taverns and roster size.
 * - Loyal strategies name a tag at least one other pool member carries, or
 *   they protect nobody.
 * - Images: pooled characters' portraits are the style's size and palette
 *   (./images/check.ts).
 */
import { cardTags, indexSnapshot, toBaseStats } from '@league-of-taverns/engine';
import { checkSeasonImages } from './images/check';
import { creatureSize } from './images/style';
import { ValidationFailure } from './main';
import { REPO_ROOT, displayPath } from './repo';
import type { RepoRoot } from './repo';
import { abilityMix, loadSeason } from './season';
import type { LoadedSeason, SeasonSource } from './season';

export interface SeasonReport {
  /** One line per problem, each starting with the file it is about. Empty when the season is valid. */
  readonly issues: ReadonlyArray<string>;
  /** What was checked, for the success message. */
  readonly checked: {
    readonly season?: string;
    readonly characters: number;
    readonly taverns: number;
    readonly challenges: number;
    /** Checks per ability across the challenges. */
    readonly abilityMix?: Readonly<Record<string, number>>;
  };
}

/** Run every check for a season. Never throws a `ValidationFailure`: those become report lines. */
export function validateSeason(season: SeasonSource, root: RepoRoot = REPO_ROOT): SeasonReport {
  let loaded: LoadedSeason;
  try {
    loaded = loadSeason(season, root);
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error;
    return { issues: error.message.split('\n'), checked: { characters: 0, taverns: 0, challenges: 0 } };
  }
  const issues: string[] = [];
  const bySlug = indexSnapshot(loaded.snapshot);
  const poolLabel = `${displayPath(loaded.dir, root)}/${loaded.files.pool}`;

  const tagsOf = new Map(
    loaded.pool.characters.flatMap(({ ref }) => {
      const record = bySlug.get(ref.base);
      return record === undefined ? [] : [[ref.id, cardTags(toBaseStats(record).stats)] as const];
    }),
  );
  for (const [id, strategy] of loaded.pool.strategies) {
    if (strategy.kind !== 'loyal') continue;
    const others = [...tagsOf].filter(([other, tags]) => other !== id && tags.includes(strategy.tag)).length;
    if (others === 0) issues.push(`${poolLabel}: ${id}: loyal to "${strategy.tag}", which no other pool member carries`);
  }

  const portraits = loaded.pool.characters.map(({ ref }) => {
    const record = bySlug.get(ref.base);
    return { id: ref.id, size: record === undefined ? undefined : creatureSize(record.size) };
  });
  issues.push(...checkSeasonImages(season, portraits, root));

  return {
    issues,
    checked: {
      season: loaded.config.id,
      characters: loaded.pool.characters.length,
      taverns: loaded.taverns.length,
      challenges: loaded.challenges.length,
      abilityMix: abilityMix(loaded.challenges.map((c) => c.challenge)),
    },
  };
}
