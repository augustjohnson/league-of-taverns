/**
 * Mock season runner: full seasons played headless by bot managers (T9.2).
 *
 * Usage: pnpm --filter @league-of-taverns/sims mock-season -- [--dir sims/fixtures/mock-season] [--runs 1] [--seed sim-1] [--out sims/output/<run-id>]
 *
 * - `--dir`: the season folder (config, pool, managers, schedule, missions/,
 *   characters/). Relative to the repo root.
 * - `--runs`: seasons to play. Run 1 uses `--seed` itself and run n > 1 uses
 *   `<seed>~<n>` (`runSeed`), so `--runs 1 --seed X` reproduces any run.
 * - `--seed`: the sim seed. It drives bot randomness, the per-week dice salt
 *   the timestamps, and the tavern join order (and so each seat's draft slot).
 * - `--out`: output folder, relative to the repo root. Default
 *   `sims/output/<seed>-x<runs>`. Gets `events-<n>.ndjson` per run and
 *   `summary.json` (per run and aggregate). Output is git-ignored.
 *
 * The season loop is `runMockSeason` in ./season-runner.ts; this file only
 * parses arguments, loads files, writes output and prints a table.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { REPO_ROOT, rootDir } from '@league-of-taverns/scripts/lib/repo';
import { runMain, ValidationFailure } from '@league-of-taverns/scripts/lib/main';
import { DEFAULT_SEASON_DIR, loadMockSeason } from './load';
import { aggregate, runMockSeason, runSeed, type Aggregate, type RunSummary } from './season-runner';

runMain((argv) => {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : [...argv],
    options: {
      dir: { type: 'string', default: DEFAULT_SEASON_DIR },
      runs: { type: 'string', default: '1' },
      seed: { type: 'string', default: 'sim-1' },
      out: { type: 'string' },
    },
    strict: true,
  });
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new ValidationFailure(`--runs must be a positive integer, got ${values.runs}`);
  const seed = values.seed;
  if (seed.length === 0 || seed.includes('/')) throw new ValidationFailure(`--seed must be non-empty with no "/", got ${JSON.stringify(seed)}`);
  const root = rootDir(REPO_ROOT);
  const out = resolve(root, values.out ?? join('sims', 'output', `${seed}-x${runs}`));

  const started = performance.now();
  const input = loadMockSeason(values.dir);
  const loaded = performance.now();
  mkdirSync(out, { recursive: true });
  const summaries: RunSummary[] = [];
  for (let n = 1; n <= runs; n++) {
    const result = runMockSeason(input, { seed: runSeed(seed, n) });
    writeFileSync(join(out, `events-${n}.ndjson`), result.ndjson);
    summaries.push(result.summary);
  }
  const ran = performance.now();
  const totals = aggregate(summaries);
  const summary = { season: input.config.id, dir: values.dir, seed, runs, aggregate: totals, seasons: summaries };
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  print(input.config.id, seed, totals, summaries, { loadMs: loaded - started, runMs: ran - loaded });
  console.log(`wrote ${relative(root, out)}/ (events-1..${runs}.ndjson, summary.json)`);
});

function print(season: string, seed: string, totals: Aggregate, summaries: ReadonlyArray<RunSummary>, timing: { loadMs: number; runMs: number }): void {
  const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
  const { runs } = totals;
  console.log(
    `${season}: ${runs} season${runs === 1 ? '' : 's'} from seed ${seed} in ${(timing.runMs / 1000).toFixed(2)}s ` +
      `(${(timing.runMs / runs).toFixed(1)} ms/season, plus ${timing.loadMs.toFixed(0)} ms loading)`,
  );
  if (runs === 1) {
    const only = summaries[0]!;
    console.log(`champion: ${only.champion.tavern} (${only.champion.bot})`);
    for (const row of only.standings) {
      const weekly = only.weeks.map((w) => w.results.find((r) => r.tavern === row.tavern)?.points ?? 0).join('/');
      console.log(`  ${row.rank}. ${row.tavern.padEnd(20)} ${row.bot.padEnd(15)} ${row.wins}-${row.losses}-${row.ties}  ${String(row.pointsFor).padStart(4)} pts (${weekly})`);
    }
  }
  const header = ['bot', 'seats', 'titles', 'titles/seat', 'win%', 'mean pts', 'mean proj', 'DNF%'];
  const rows = Object.entries(totals.byBot).map(([bot, a]) => [
    bot,
    String(a.seats),
    String(a.titles),
    a.titlesPerSeat.toFixed(3),
    pct(a.winRate),
    a.meanPoints.toFixed(1),
    a.meanProjected.toFixed(1),
    pct(a.dnfRate),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: ReadonlyArray<string>): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  console.log(line(header));
  for (const r of rows) console.log(line(r));
  const hp = totals.higherProjectedWins;
  console.log(`higher-projected tavern won ${hp.wins}/${hp.matchups} matchups (${pct(hp.share)})`);
  console.log(`DNF rate: ${pct(totals.dnfRate)} of mission runs; tavern-weeks with no lineup: ${totals.noLineupWeeks}`);
  if (runs > 1) {
    const seats = Object.entries(totals.titlesByTavern)
      .map(([tavern, titles]) => `${tavern} ${titles}`)
      .join(', ');
    console.log(`titles by seat: ${seats}`);
  }
}
