/**
 * Package a season's characters for a recruiting page: a manifest with
 * names, stories, pronouns, heights, base stats and stage placement, plus
 * web-sized painted portraits and their pixel views (lib/recruiting.ts).
 *
 * Usage: package-characters --season <id> [--out dist/recruiting/<id>]
 *
 * Derived output, never committed. The page itself is built elsewhere and
 * reads only this bundle.
 */
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { ValidationFailure, runMain } from './lib/main';
import { buildRecruitingBundle } from './lib/recruiting';
import { REPO_ROOT, rootDir } from './lib/repo';

const USAGE = 'Usage: package-characters --season <id> [--out dist/recruiting/<id>]';

runMain((argv) => {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: { season: { type: 'string' }, out: { type: 'string' } },
    strict: true,
  });
  if (values.season === undefined) throw new ValidationFailure(USAGE);
  const root = rootDir(REPO_ROOT);
  const out = values.out === undefined ? join(root, 'dist', 'recruiting', values.season) : resolve(values.out);
  const bundle = buildRecruitingBundle(values.season, out);
  const withPortraits = bundle.characters.filter((c) => c.portrait !== undefined).length;
  const withStories = bundle.characters.filter((c) => c.story !== undefined).length;
  console.log(
    `Packaged ${bundle.characters.length} characters for ${bundle.season} into ${relative(root, out) || '.'}: ` +
      `${withPortraits} with portraits, ${withStories} with stories, ${bundle.characters.filter((c) => c.pooled).length} pooled.`,
  );
});
