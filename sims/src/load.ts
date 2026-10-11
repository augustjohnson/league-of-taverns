/**
 * The I/O half of the mock season: read a season folder through the scripts
 * loaders and hand `prepareSeason` plain data.
 *
 * The folder keeps its own characters/ (like sims/fixtures/mock-season/), and
 * every *.yaml directly in its missions/ (or missions/selected/) is a
 * selected mission. Each mission is checked with `validateMission` against
 * the season's rules, the snapshot and its week's environment before any run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateMission } from '@league-of-taverns/engine';
import type { Mission, MissionRules } from '@league-of-taverns/engine';
import { ValidationFailure } from '@league-of-taverns/scripts/lib/main';
import { REPO_ROOT, displayPath, loadMission, rootDir } from '@league-of-taverns/scripts/lib/repo';
import { loadSeason, missionFiles, snapshotCrIndex } from '@league-of-taverns/scripts/lib/season';
import type { SeasonLocation } from '@league-of-taverns/scripts/lib/season';
import { prepareSeason, type SeasonInput } from './season-runner';

export const DEFAULT_SEASON_DIR = 'sims/fixtures/mock-season';

/** Load `dir` (relative to the repo root, or absolute) as a `SeasonInput`. Throws a `ValidationFailure` naming the file on bad input. */
export function loadMockSeason(dir: string = DEFAULT_SEASON_DIR): SeasonInput {
  const location: SeasonLocation = { dir, charactersRoot: dir };
  const season = loadSeason(location);
  const { config } = season;
  const { battleModel: _battleModel, ...missionRules } = config.missions;
  const rules: MissionRules = { ...missionRules, partyCr: config.budget.partyCr };
  const crIndex = snapshotCrIndex(season.snapshot);

  const missions: Mission[] = [];
  const issues: string[] = [];
  for (const { file, status } of missionFiles(location)) {
    if (status !== 'selected') continue;
    const mission = loadMission(file);
    const week = season.schedule.weeks.find((w) => w.environment === mission.environment);
    const found = validateMission(mission, rules, (slug) => crIndex.get(slug), week === undefined ? {} : { expectedEnvironment: week.environment });
    for (const issue of found) issues.push(`${displayPath(file, REPO_ROOT)}: ${issue.nodeId ?? ''}: [${issue.code}] ${issue.message}`);
    missions.push(mission);
  }
  if (issues.length > 0) throw new ValidationFailure(issues.join('\n'));

  const configText = readFileSync(join(season.dir, 'config.yaml'), 'utf8');
  const engine = JSON.parse(readFileSync(join(rootDir(REPO_ROOT), 'engine', 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof engine.version !== 'string') throw new ValidationFailure('engine/package.json: no version');
  return prepareSeason(season, missions, configText, engine.version);
}
