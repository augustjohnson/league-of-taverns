/**
 * Season sims: whole seasons of the Lich's contest played by bot taverns,
 * and the balance numbers from docs/survivor-format.md §7.
 *
 * Usage: pnpm sim -- [--dir sims/fixtures/lich-season] [--runs 100] [--seed sim-1] [--out sims/output/<run-id>] [--model '{"noise":0.4}']
 *
 * - `--dir`: the season folder. Relative to the repo root.
 * - `--runs`: seasons to play. Run 1 uses `--seed` itself and run n > 1 uses
 *   `<seed>~<n>` (`runSeed`), so `--runs 1 --seed X` reproduces any run.
 * - `--seed`: the sim seed. It draws the cast, salts the contest's dice,
 *   drives the bots and shuffles the join order (and so each seat's slot).
 * - `--model`: JSON overrides for the vote model, on top of the season's.
 * - `--out`: output folder, relative to the repo root. Default
 *   `sims/output/<seed>-x<runs>`. Gets `events-<n>.ndjson` per run (the
 *   first 20) and `summary.json`. Output is git-ignored.
 *
 * The season loop is `ContestSession` in ./season-runner.ts; this file only
 * parses arguments, loads files, writes output and prints the report.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { voteModel, type VoteModel } from '@league-of-taverns/engine';
import { REPO_ROOT, rootDir } from '@league-of-taverns/scripts/lib/repo';
import { runMain, ValidationFailure } from '@league-of-taverns/scripts/lib/main';
import { DEFAULT_SEASON_DIR, loadSeasonInput } from './load';
import { aggregate, runSeason, runSeed, type Aggregate, type RunSummary, type SeasonInput } from './season-runner';

runMain((argv) => {
  const { values } = parseArgs({
    args: argv[0] === '--' ? argv.slice(1) : [...argv],
    options: {
      dir: { type: 'string', default: DEFAULT_SEASON_DIR },
      runs: { type: 'string', default: '1' },
      seed: { type: 'string', default: 'sim-1' },
      out: { type: 'string' },
      model: { type: 'string' },
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
  let input: SeasonInput = loadSeasonInput(values.dir);
  if (values.model !== undefined) {
    const overrides = JSON.parse(values.model) as Partial<VoteModel>;
    const model = { ...input.config.contest.model, ...overrides };
    input = { ...input, config: { ...input.config, contest: { ...input.config.contest, model } }, model: voteModel(model) };
  }
  const loaded = performance.now();
  mkdirSync(out, { recursive: true });
  const summaries: RunSummary[] = [];
  for (let n = 1; n <= runs; n++) {
    const result = runSeason(input, { seed: runSeed(seed, n) });
    if (n <= 20) writeFileSync(join(out, `events-${n}.ndjson`), result.ndjson);
    summaries.push(result.summary);
  }
  const ran = performance.now();
  const totals = aggregate(summaries);
  writeFileSync(join(out, 'summary.json'), `${JSON.stringify({ season: input.config.id, dir: values.dir, seed, runs, aggregate: totals, seasons: summaries }, null, 2)}\n`);
  print(input.config.id, seed, totals, summaries, { loadMs: loaded - started, runMs: ran - loaded });
  console.log(`wrote ${relative(root, out)}/ (events-1..${Math.min(runs, 20)}.ndjson, summary.json)`);
});

function print(season: string, seed: string, totals: Aggregate, summaries: ReadonlyArray<RunSummary>, timing: { loadMs: number; runMs: number }): void {
  const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
  const { runs } = totals;
  console.log(
    `${season}: ${runs} season${runs === 1 ? '' : 's'} from seed ${seed} in ${(timing.runMs / 1000).toFixed(2)}s ` +
      `(${(timing.runMs / runs).toFixed(0)} ms/season, plus ${timing.loadMs.toFixed(0)} ms loading)`,
  );
  if (runs === 1) {
    const only = summaries[0]!;
    console.log(`winner of the contest: ${only.winner}; champion tavern: ${only.champions.map((c) => `${c.tavern} (${c.bot})`).join(' and ')}`);
    for (const row of only.standings) {
      console.log(`  ${row.rank}. ${row.tavern.padEnd(20)} ${row.bot.padEnd(10)} ${String(row.points).padStart(4)} pts (${row.callPoints} from calls)`);
    }
  }
  const header = ['bot', 'seats', 'titles', 'titles/seat', 'mean pts', 'calls right', 'early'];
  const rows = Object.entries(totals.byBot).map(([bot, a]) => [
    bot,
    String(a.seats),
    Number.isInteger(a.titles) ? String(a.titles) : a.titles.toFixed(1),
    a.titlesPerSeat.toFixed(3),
    a.meanPoints.toFixed(1),
    pct(a.callRate),
    pct(a.earlyShare),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (cells: ReadonlyArray<string>): string => cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join('  ');
  console.log(line(header));
  for (const r of rows) console.log(line(r));
  console.log('\nThe contest (docs/survivor-format.md §7):');
  console.log(`  favourite boot went home  ${pct(totals.favouriteRate)} (its mean chance ${pct(totals.favouriteChance)}; target 60-70%)`);
  console.log(`  power vs placement        r = ${totals.powerPlacement.toFixed(3)} (positive: stronger lasts longer)`);
  console.log(`  winners                   ${totals.distinctWinners} different; most: ${totals.topWinners.map((w) => `${w.id} ${w.wins}`).join(', ')}`);
  console.log(`  win rate by strategy      ${Object.entries(totals.strategyWins).map(([k, s]) => `${k} ${(100 * s.rate).toFixed(1)}%`).join(', ')} (par ${(100 / (summaries[0]?.cast.length ?? 20)).toFixed(1)}%)`);
  console.log(`  calls                     ${pct(totals.callPointShare)} of all points; decided ${pct(totals.callDecidedShare)} of titles`);
  console.log(`  revotes / draws           ${totals.revotesPerSeason.toFixed(2)} / ${totals.drawsPerSeason.toFixed(2)} per season`);
}
