/**
 * Every content check for one season, as a list of report lines (T3.4, T5.3).
 * The validate CLI prints them and exits 1 if there are any.
 *
 * Checks:
 * - config.yaml, the pinned snapshot (manifest sha256), pool.yaml,
 *   managers.yaml and schedule.yaml, through the loaders in ./season.ts.
 * - Every mission file (see `missionFiles`): shape (`parseMission`), the
 *   engine's `validateMission` under the season's rules, plus three checks the
 *   engine doesn't make: `season` matches config.yaml, the file is named
 *   `<id>.yaml`, and no encounter has more spellcasters than
 *   `spellcasters.maxPerEncounter` (D-43; moves into the engine with T5.6).
 *   A selected mission's environment must be one the schedule uses. Which
 *   week it runs is lock-check's business (T8.4).
 * - Keywords (D-42): where exactly one selected mission has a week's
 *   environment, every keyword of that week must name something in it
 *   (`dishonestKeywords`). lock-check (T8.4) will make the same check
 *   against the mission actually selected for each week.
 * - Images (D-10): pooled characters' portraits and the season's mission
 *   covers are the style's size and palette (./images/check.ts).
 *
 * Not yet: chrome coverage and lints (T8.x).
 */
import { basename, extname } from 'node:path';
import { dishonestKeywords, indexSnapshot, validateMission } from '@league-of-taverns/engine';
import type { Mission, MissionRules } from '@league-of-taverns/engine';
import { checkSeasonImages } from './images/check';
import { creatureSize } from './images/style';
import { ValidationFailure } from './main';
import { REPO_ROOT, displayPath, loadMission } from './repo';
import type { RepoRoot } from './repo';
import { isSpellcaster, loadSeason, missionFiles, snapshotCrIndex } from './season';
import type { LoadedSeason, MissionStatus, SeasonSource } from './season';

export interface SeasonReport {
  /** One line per problem, each starting with the file it is about. Empty when the season is valid. */
  readonly issues: ReadonlyArray<string>;
  /** What was checked, for the success message. */
  readonly checked: {
    readonly season?: string;
    readonly characters: number;
    readonly taverns: number;
    readonly weeks: number;
    readonly missions: ReadonlyArray<{ readonly file: string; readonly id: string; readonly status: MissionStatus }>;
  };
}

/** Run every check for a season. Never throws a `ValidationFailure`: those become report lines. */
export function validateSeason(season: SeasonSource, root: RepoRoot = REPO_ROOT): SeasonReport {
  let loaded: LoadedSeason;
  try {
    loaded = loadSeason(season, root);
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error;
    // Without a valid season the missions can still be shape-checked, but not
    // against rules, so report the season's problems alone.
    return { issues: error.message.split('\n'), checked: { characters: 0, taverns: 0, weeks: 0, missions: [] } };
  }

  const issues: string[] = [];
  const missions: Array<{ file: string; id: string; status: MissionStatus }> = [];
  const selected: Mission[] = [];
  const { config, spellcasters, schedule } = loaded;
  const { battleModel: _battleModel, ...missionRules } = config.missions;
  const rules: MissionRules = { ...missionRules, partyCr: config.budget.partyCr };
  const crIndex = snapshotCrIndex(loaded.snapshot);
  const bySlug = indexSnapshot(loaded.snapshot);
  const environments = new Set(schedule.weeks.map((week) => week.environment));

  for (const { file, status } of missionFiles(season, root)) {
    const label = displayPath(file, root);
    let mission: Mission;
    try {
      mission = loadMission(file, root);
    } catch (error) {
      if (!(error instanceof ValidationFailure)) throw error;
      issues.push(...error.message.split('\n'));
      continue;
    }
    missions.push({ file: label, id: mission.id, status });
    if (status === 'selected') selected.push(mission);
    const report = (message: string, nodeId?: string): void => {
      issues.push(`${label}: ${nodeId === undefined ? '' : `${nodeId}: `}${message}`);
    };

    for (const issue of validateMission(mission, rules, (slug) => crIndex.get(slug))) {
      report(`[${issue.code}] ${issue.message}`, issue.nodeId);
    }
    if (mission.season !== config.id) {
      report(`[season] season is ${JSON.stringify(mission.season)}, but this is season ${JSON.stringify(config.id)}`);
    }
    const stem = basename(file, extname(file));
    if (stem !== mission.id) report(`[file] id is ${JSON.stringify(mission.id)}, but the file is named ${JSON.stringify(stem)}: name it ${mission.id}.yaml`);
    if (status === 'selected' && !environments.has(mission.environment)) {
      report(
        `[environment] environment ${JSON.stringify(mission.environment)} is not used by any week in the schedule ` +
          `(${[...environments].join(', ')})`,
      );
    }
    for (const node of mission.nodes) {
      if (node.kind !== 'battle') continue;
      const casters = node.encounter.creatures.filter((c) => {
        const record = bySlug.get(c.ref);
        return record !== undefined && isSpellcaster(record);
      });
      const total = casters.reduce((sum, c) => sum + c.count, 0);
      if (total > spellcasters.maxPerEncounter) {
        report(
          `[encounter.caster] ${total} spellcaster${total === 1 ? '' : 's'} (${casters.map((c) => `${c.count} × ${c.ref}`).join(', ')}), ` +
            `over config.yaml spellcasters.maxPerEncounter of ${spellcasters.maxPerEncounter}. The battle model ` +
            "can't see spells yet (D-43), so casters look far weaker than their CR; use non-casters.",
          node.id,
        );
      }
    }
  }

  const scheduleLabel = `${displayPath(loaded.dir, root)}/${loaded.files.schedule}`;
  schedule.weeks.forEach((week, i) => {
    const matching = selected.filter((m) => m.environment === week.environment);
    if (matching.length !== 1) return;
    const mission = matching[0]!;
    for (const keyword of dishonestKeywords(mission, week.keywords)) {
      issues.push(`${scheduleLabel}: weeks[${i}].keywords: ${JSON.stringify(keyword)} names nothing in mission "${mission.id}" (D-42)`);
    }
  });

  const portraits = loaded.pool.characters.map(({ ref }) => {
    const record = bySlug.get(ref.base);
    return { id: ref.id, size: record === undefined ? undefined : creatureSize(record.size) };
  });
  issues.push(...checkSeasonImages(season, portraits, root));

  return {
    issues,
    checked: {
      season: config.id,
      characters: loaded.pool.characters.length,
      taverns: schedule.taverns.length,
      weeks: schedule.weeks.length,
      missions,
    },
  };
}
