/**
 * Validate all authored content for a season. CI runs this on every PR.
 *
 * Usage:
 *   validate --season season-01
 *   validate --dir sims/fixtures/lich-season [--characters sims/fixtures/lich-season]
 *
 * `--season` reads seasons/<id>/. `--dir` reads a season directory elsewhere;
 * its characters resolve under `--characters` (default: the directory itself
 * if it has a characters/ folder, else the repo root). Paths are relative to
 * the repo root.
 *
 * Checks, each reporting every violation (see lib/validate-season.ts):
 * - Snapshot integrity (manifest sha256).
 * - config.yaml, managers.yaml, taverns.yaml, pool.yaml and challenges/*.yaml
 *   parse and match schema.
 * - Every pooled character exists in characters/, its base slug exists in the
 *   pinned snapshot, its modifiers fit the vocabulary and budget, and a loyal
 *   strategy names a tag someone else carries.
 * - There is one challenge per episode, and the contest fits the taverns.
 * Exit 1 on any violation.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ValidationFailure, runMain } from './lib/main';
import { REPO_ROOT, rootDir } from './lib/repo';
import type { SeasonSource } from './lib/season';
import { validateSeason } from './lib/validate-season';

function parseValidateArgs(argv: ReadonlyArray<string>): SeasonSource {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: { season: { type: 'string' }, dir: { type: 'string' }, characters: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if ((values.season === undefined) === (values.dir === undefined)) {
    throw new ValidationFailure('Pass exactly one of --season <id> or --dir <path>, e.g. --season season-01.');
  }
  if (values.season !== undefined) {
    if (values.characters !== undefined) throw new ValidationFailure('--characters goes with --dir, not --season.');
    return values.season;
  }
  const dir = values.dir ?? '';
  const ownCharacters = existsSync(join(resolve(rootDir(REPO_ROOT), dir), 'characters'));
  return { dir, charactersRoot: values.characters ?? (ownCharacters ? dir : '.') };
}

runMain((argv) => {
  const season = parseValidateArgs(argv);
  const { issues, checked } = validateSeason(season);
  if (issues.length > 0) {
    throw new ValidationFailure(`${issues.join('\n')}\n\n${issues.length} problem${issues.length === 1 ? '' : 's'} found.`);
  }
  const mix = Object.entries(checked.abilityMix ?? {})
    .map(([ability, n]) => `${ability} ${n}`)
    .join(', ');
  console.log(`${checked.season ?? '?'}: OK. ${checked.characters} pooled characters, ${checked.taverns} taverns, ${checked.challenges} challenges (checks: ${mix}).`);
});
