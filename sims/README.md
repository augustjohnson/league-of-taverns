# sims

Headless mock seasons with bot managers, for balance testing. Everything here
is a consumer of `engine/` and `bots/`. Sims never use rules that the live
league doesn't use.

- `src/mock-season.ts` plays seasons and writes event logs (the CLI).
- `src/season-runner.ts` is the season loop as pure functions:
  `prepareSeason`, `runMockSeason(input, { seed }) → { events, ndjson, state, summary }`
  and `aggregate`. Tests call it directly.
- `src/load.ts` reads a season folder through the scripts loaders
  (`@league-of-taverns/scripts/lib/*`, a workspace dependency).
- `src/balance-report.ts` aggregates the output (T9.3).

## Mock seasons

```
pnpm --filter @league-of-taverns/sims mock-season -- [--dir sims/fixtures/mock-season] [--runs 1] [--seed sim-1] [--out sims/output/<run-id>]
```

Paths are relative to the repo root. The default `--out` is
`sims/output/<seed>-x<runs>`. Each run writes `events-<n>.ndjson`, and the
batch writes `summary.json` (per season: standings, champion, each tavern's
bot, weekly points and lineups, draft picks, waiver outcomes; aggregate:
titles, mean points, win and DNF rates per bot, and how often the
higher-projected tavern won its matchup), plus a table on the console.

Each season is built event by event through the engine's `applyEvent`
(`season.created` → `character.pooled` → `tavern.joined` → draft →
per week `lineup.set` / `lineup.locked` / `mission.revealed` /
`mission.resolved` / `week.finalized` → waivers between weeks), then replayed
from its NDJSON with `replayLog` and audited with `verifyResolutions`. Any
disagreement, or any event the engine rejects, stops the run.

Seeds: run 1 uses `--seed` itself and run n uses `<seed>~<n>`, so
`--runs 1 --seed <that>` reproduces any one season. The seed drives bot
randomness, the dice (`weekSeed` salted with the sim seed, D-13) and the event
timestamps. The draft order is the engine's seeded order, fixed by the season
id, so each seat drafts from the same slot in every run.

Output goes to `sims/output/` and is git-ignored. To share a result, commit the
command and seed, not the output, because the output is reproducible from them.
