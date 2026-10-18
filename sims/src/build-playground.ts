/**
 * Build the browser playground into one self-contained HTML file.
 *
 * Usage: pnpm --filter @league-of-taverns/sims playground -- [--dir sims/fixtures/lich-season] [--out sims/output/playground/index.html]
 *
 * Paths are relative to the repo root. The page runs the real engine and bots
 * in the browser: open the file directly, or publish it as an Artifact. See
 * ./playground-build.ts for the steps and ./playground/ for the page.
 */
import { relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT, rootDir } from '@league-of-taverns/scripts/lib/repo';
import { runMain, ValidationFailure } from '@league-of-taverns/scripts/lib/main';
import { DEFAULT_SEASON_DIR } from './load';
import { writePlayground } from './playground-build';

/** The page must stay small enough to publish comfortably. */
const MAX_BYTES = 2 * 1024 * 1024;

runMain(async (argv) => {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : [...argv],
    options: {
      dir: { type: 'string', default: DEFAULT_SEASON_DIR },
      out: { type: 'string', default: 'sims/output/playground/index.html' },
    },
    strict: true,
  });
  const root = rootDir(REPO_ROOT);
  const out = resolve(root, values.out);
  const started = performance.now();
  const { bytes, data } = await writePlayground(out, values.dir);
  const kib = (bytes / 1024).toFixed(1);
  console.log(
    `wrote ${relative(root, out)} (${kib} KiB: ${data.pool.length} pooled, ${data.challenges.length} challenges, ` +
      `${data.snapshot.length} snapshot records) in ${(performance.now() - started).toFixed(0)} ms`,
  );
  if (bytes > MAX_BYTES) throw new ValidationFailure(`the page is ${kib} KiB, over the ${MAX_BYTES / 1024} KiB limit`);
});
