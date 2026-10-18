/**
 * The I/O half of a sim season: read a season folder through the scripts
 * loaders and hand `seasonParts` plain data.
 *
 * The pool resolves against the folder's own characters/ when it has one,
 * else the repo's characters/ (as sims/fixtures/lich-season/ does).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ValidationFailure } from '@league-of-taverns/scripts/lib/main';
import { REPO_ROOT, rootDir } from '@league-of-taverns/scripts/lib/repo';
import { abilityMix, loadSeason, type LoadedSeason, type SeasonLocation } from '@league-of-taverns/scripts/lib/season';
import { seasonInput, seasonParts, type SeasonInput, type SeasonParts } from './season-runner';

export const DEFAULT_SEASON_DIR = 'sims/fixtures/lich-season';

/** The absolute directory whose characters/ `dir`'s pool resolves against: `dir` itself when it has a characters/, else the repo root. */
export function charactersRootOf(dir: string = DEFAULT_SEASON_DIR): string {
  const own = resolve(rootDir(REPO_ROOT), dir);
  return existsSync(join(own, 'characters')) ? own : rootDir(REPO_ROOT);
}

/** Load `dir` (relative to the repo root, or absolute) with every file validated. */
export function loadSimSeason(dir: string = DEFAULT_SEASON_DIR): LoadedSeason {
  const location: SeasonLocation = { dir, charactersRoot: charactersRootOf(dir) };
  return loadSeason(location);
}

/** Load `dir` as plain `SeasonParts` (the full snapshot included). */
export function loadSeasonParts(dir: string = DEFAULT_SEASON_DIR): SeasonParts {
  const season = loadSimSeason(dir);
  const configText = readFileSync(join(season.dir, 'config.yaml'), 'utf8');
  const engine = JSON.parse(readFileSync(join(rootDir(REPO_ROOT), 'engine', 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof engine.version !== 'string') throw new ValidationFailure('engine/package.json: no version');
  return seasonParts(season, abilityMix(season.challenges.map((c) => c.challenge)), configText, engine.version);
}

/** Load `dir` as a run-ready `SeasonInput`. Throws a `ValidationFailure` naming the file on bad input. */
export function loadSeasonInput(dir: string = DEFAULT_SEASON_DIR): SeasonInput {
  return seasonInput(loadSeasonParts(dir));
}
