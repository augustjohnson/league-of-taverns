# sims

Headless mock seasons with bot managers, for balance testing. Everything here
is a consumer of `engine/` and `bots/`. Sims never use rules that the live
league doesn't use.

- `src/mock-season.ts` plays seasons and writes event logs (the CLI).
- `src/season-runner.ts` is the season loop as pure functions:
  `seasonParts` (a loaded season as plain JSON-safe data), `seasonInput`
  (parts → a run-ready `SeasonInput`), `prepareSeason` (both),
  `runMockSeason(input, { seed }) → { events, ndjson, state, summary, audit }`
  and `aggregate`. `SeasonSession` is the same loop a step at a time, with
  an optional human seat (player vs bots); `runMockSeason` is a session with
  no human, driven straight through. Tests call it directly. It imports nothing from Node, so
  the browser playground bundles it.
- `src/load.ts` reads a season folder through the scripts loaders
  (`@league-of-taverns/scripts/lib/*`, a workspace dependency).
- `src/balance-report.ts` aggregates the output (T9.3).
- `src/playground/` is the browser playground, and `src/build-playground.ts`
  builds it (see below).

## Mock seasons

```
pnpm --filter @league-of-taverns/sims mock-season -- [--dir sims/fixtures/mock-season] [--runs 1] [--seed sim-1] [--out sims/output/<run-id>]
```

Paths are relative to the repo root. The default `--out` is
`sims/output/<seed>-x<runs>`. Each run writes `events-<n>.ndjson`, and the
batch writes `summary.json` (per season: standings, champion, each tavern's
bot, weekly points and lineups, draft picks, waiver outcomes; aggregate:
titles, mean points, week-top and DNF rates per bot, and how often the
best-projected tavern topped its week), plus a table on the console.

Each season is built event by event through the engine's `applyEvent`
(`season.created` → `character.pooled` → `tavern.joined` → draft →
per week `lineup.set` / `lineup.locked` / `mission.revealed` /
`mission.resolved` / `week.finalized` → waivers between weeks), then replayed
from its NDJSON with `replayLog` and audited with `verifyResolutions`. Any
disagreement, or any event the engine rejects, stops the run.

Seeds: run 1 uses `--seed` itself and run n uses `<seed>~<n>`, so
`--runs 1 --seed <that>` reproduces any one season. The seed drives bot
randomness, the dice (`weekSeed` salted with the sim seed, D-13) and the event
timestamps. The draft order is the engine's seeded shuffle of the join order,
and the runner shuffles the join order per sim seed, so each seat's draft slot
varies across runs.

Output goes to `sims/output/` and is git-ignored. To share a result, commit the
command and seed, not the output, because the output is reproducible from them.

## Playground

A single self-contained HTML page that runs the real engine and bots in the
browser, for testing by hand that the league behaves as you expect.

```
pnpm --filter @league-of-taverns/sims playground -- [--dir sims/fixtures/mock-season] [--out sims/output/playground/index.html]
```

Then open `sims/output/playground/index.html` directly in a browser (no server
needed). The file is git-ignored and about 0.7 MB. It loads seed `sim-1` on
open. The tabs:

- **Play vs bots:** manage one tavern yourself against the bots. Pick a
  tavern and a seed and start; draft when you are on the clock, then before
  each week set a lineup (with `validateLineup`, the projection and the
  mission graph live) and make waiver claims, and press Play week. The bots
  draft, set lineups and claim through the same `SeasonSession`. Your tavern's
  bot stays on as an advisor that can suggest a pick, a lineup or claims.
  Your events carry a `manager` actor. When the season ends it is audited
  like any run and loads into the other tabs.
- **Run bar:** any seed, Run, New seed; event count, the replay check
  (`replayLog` deep-equals the built state), the verify check
  (`verifyResolutions` finds no mismatches), run time, the NDJSON sha256 and
  the champion.
- **Standings:** total loot, weekly loot, each tavern's bot and the
  champion; each week's table with actual and projected points and checks
  passed; waiver outcomes.
- **Weeks:** a week's mission as a layered graph; a tavern's locked lineup,
  its path taken and each node's projected reach; the node-by-node roll log.
- **Lineup lab:** any four characters from the pool or a roster, any captain,
  any mission: `validateLineup`, CR vs B, `checkOdds` per check, `battleOdds`
  and the `evTtkBreakdown` per battle, the projection and its score
  distribution; Roll once, and Roll 1,000 against the projection.
- **Draft board, Pool, Event log** (filterable, pretty JSON, copy the NDJSON
  to the clipboard) and **Batch** (the CLI's aggregate table for 10–200
  seasons).

How it is built: `src/build-playground.ts` loads the season with the scripts
loaders (`loadMockSeasonParts`), serializes it with `serializeSeason`
(`src/playground/data.ts`: the config, schedule, taverns, pool, missions and
only the snapshot records used), bundles `src/playground/app.ts` with esbuild
as a minified browser IIFE, and inlines both into `src/playground/page.html`.
The page calls `seasonInputFromData`, which is the same `seasonInput` the CLI
uses, so a seed gives the same season, byte for byte: the engine avoids
`Math.exp`/`Math.log` (not bit-identical across JS engines) in favor of
`engine/src/internal/det-math.ts`, so the page's NDJSON hash matches the CLI's.

The page is written as an Artifact body: it starts with `<title>`, has no
doctype, html, head or body tags, makes no requests beyond Google Fonts, and
is pure ASCII so it reads right without a declared charset.
`src/playground/` is type-checked with DOM types by its own
`tsconfig.json`; pure view helpers live in `src/playground/view.ts` and are
tested in `test/playground.test.ts`.
