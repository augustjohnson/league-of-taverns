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
- `src/reports.ts` is the playground's season reports (drafts): `luckReport`
  (loot above projection, score percentile, checks and battles won above
  their chances, rank vs projected rank), `titleOdds` (Monte Carlo of the
  rest of the season after the draft and each week) and `benchReport` (loot
  left on the bench, by projection and with the same dice), over a shared
  `ReportContext`; `luckSeason` and `aggregateLuck` roll luck up over a batch.
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
(`season.created` → `character.pooled` → `manager.joined` → `tavern.chosen` → draft →
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
needed). The file is git-ignored and just under 2 MB, the build's limit:
most of it is each pooled character's painted portrait, cut at build time
(`playgroundChrome`) to an 88 px thumbnail for the portrait chips and to the
card's face crop. Names, epithets and portraits are chrome: everywhere but
the workshop's event log (which shows ids, as the NDJSON does) shows them, and
they never reach `seasonInput`. The mock season pools 48 of
the real cast (`sims/fixtures/mock-season/pool.yaml`, with mock-season
modifiers), so every character has a face.

The page opens to **the game** (`src/playground/play.ts`): one season
against five bots. Pick a seat and a seed (or none, for a random one) and
start. The bots' managers show as keepers with page-only names (Mags
Thornbury, Old Wendel, ...), so the room reads like a table of people; the
Standings name each one's strategy.

- **The Common Room** is the season's running story, a chat no one types
  into. Its messages (`src/playground/feed.ts` `feedItems`, pure and
  tested) come from the event log: the crier opens the season, each keeper
  takes a tavern, the draft is called round by round (a finished round folds
  to a row of faces when the next one starts; steals and reaches as before,
  `draftCalls`), each week opens with its mission, hexes are announced, the
  lineup lock lists every tavern's four (folded), the scrying ball shows the
  week as a race, the crier posts the table, and the steward reads the
  waivers. Rivals' claims stay sealed until they resolve; yours shows to you
  at once. Folds you open or close stay that way.
- **The pacing.** The engine and bots decide at once, as they always have, but the
  room tells it at a person's pace: a rival is "on the clock" (a typing line
  in the action bar) for about a second before its pick lands, keepers
  choose taverns a little slower, and when a week opens each rival says it
  is ready a few seconds apart. Lock in plays your week once everyone is
  ready; rivals still setting a lineup hurry. The whole page (free agents,
  standings, your header) shows the league folded from the events the room
  has told (`applyEvent` up to the room's cursor), so nothing runs ahead of
  the story: a free agent a rival takes is stamped with their flag, then
  leaves the list. Skip (or Esc), a reload and `prefers-reduced-motion` tell
  everything at once. Readiness is presence, not an event, so a reload
  forgets it.
- **A week's race** (`fx.ts raceWeek`): every tavern's run as a strip of
  steps, green for a pass or a win and red for a fail or a loss (a battle
  round and wide, a gold foot where loot was banked), ending home, turned
  back or DNF. The lanes start in draft order with yours last, so the order
  gives nothing away; the rivals' strips fill in together, then the scrying
  ball plays your run back line by line (the dice tumble, the loot counter
  climbs, a DNF drains it), then the ranks show and the lanes slide into the
  week's order. Any lane opens into its tale; yours also has the map of the
  run. Watch again replays the latest week.
- **The workspace** beside the room follows the season: **Taverns** (the
  tavern pick), **Draft** (your roster and the free agents as cards or a
  table, sorted by the bots' `valueOf` rating; the draft board, folded),
  **Lineup** (starters and bench as two decks, empty in week 1 and last
  week's after that, with `validateLineup`, the projection, the retreat
  table and the mission map; your hex, once a season; waiver claims) and
  **Roster** at the end. Its buttons only work when the move is yours.
- **Standings:** the table with each tavern's move since last week, keeper
  and strategy, total and weekly loot; every roster; every hex.
- **The action bar** says whose move it is: a rival typing, your turn (it
  glows when the clock comes back to you), the rivals' readiness with Lock in,
  or New season at the end.

On a wide screen the room sits beside the workspace or the standings; on a
narrow one each is a tab, with the action bar always at the bottom. The
season is saved in the browser's localStorage as its seed, seat and your
moves, and replayed on reload; New season asks for a second click before
abandoning one in progress. Your events carry a `manager` actor; nothing
suggests your moves. When the season ends it is audited like any run and
loads into the workshop.

**The workshop** (the Workshop button; `src/playground/workshop.ts`) holds
the tools for checking the league by hand. It runs seed `sim-1` the first
time it opens, not on page load.

- **Bot run bar:** any seed, Run, New seed; event
  count, the replay check (`replayLog` deep-equals the built state), the
  verify check (`verifyResolutions` finds no mismatches), run time, the NDJSON
  sha256 and the champion.
- **Standings:** total loot, weekly loot, each tavern's bot and the
  champion; each week's table with actual and projected points and checks
  passed; waiver outcomes.
- **Reports** (drafts, `src/reports.ts`), for the seeded run or your finished
  season: **title odds** after the draft and after each week (2,000 simulated
  finishes; played weeks count as played, each tavern fields its own
  strategy's lineup from its current roster and draws loot from that lineup's
  exact distribution, home bonus included; future waivers aren't modeled), as
  a chart and a table; a **luck index** per tavern (loot minus projection, the
  mean percentile of each week's loot in its own distribution, checks and
  battles won minus their chances, and the rank it would hold had everyone
  banked exactly their projection); and **loot on the bench** per
  tavern-week. A benched character never rolled, so the bench has two lenses:
  *projected* (the best lineup by exact expected loot: the call you could have
  made) and *same dice* (rerun with the week's seed, where every mission node
  has its own fixed roll: hindsight with the luck held fixed). It shows the
  best one-for-one swap, the best lineups by each lens, and the week and
  season rank the best same-dice lineups would have reached.
- **Weeks:** a week's mission as a layered graph; a tavern's locked lineup,
  its path taken and each node's projected reach; the node-by-node roll log.
- **Lineup lab:** any four characters from the pool or a roster, any retreat
  order, any mission: `validateLineup`, CR vs B, `checkOdds` per check, `battleOdds`
  and the `evTtkBreakdown` per battle, the projection and its score
  distribution; Roll once, and Roll 1,000 against the projection.
- **Draft board, Pool, Event log** (filterable, pretty JSON, Copy
  events.ndjson to the clipboard) and **Batch**: the CLI's aggregate table for 10–200
  seasons, plus luck over the batch. A season's total loot is exactly its
  projected loot (strength) plus its loot above projection (luck), so it
  shows each one's share of the spread of totals within a season, the share
  of titles won by each luck rank and each strength rank against par, the
  champion's mean luck, and each bot's mean luck (it should wash out to about
  0 and 50%; a bot that stays lucky points to a projection bias).

How it is built: `src/build-playground.ts` loads the season with the scripts
loaders (`loadMockSeasonParts`), serializes it with `serializeSeason`
(`src/playground/data.ts`: the config, schedule, taverns, pool, missions,
only the snapshot records used, each pooled character's chrome name, each
sponsoring god's chrome (name, call and banner), and each character's
average draft position over 100 all-bot drafts (`averageDraftPositions`),
for display; none of it reaches the engine), bundles `src/playground/app.ts` with esbuild
as a minified browser IIFE, and inlines both into `src/playground/page.html`.
`app.ts` only boots the page (theme, and the game or the workshop);
`shared.ts` holds what both use: the season data, banners, the character
card (`charCard`), the mission graph and the roll log.
Characters show as cards: name, epithet and CR, the art (the portrait's face
crop over a blurred copy of the portrait; a silhouette for a character
without one), the monster line with its size in words, AC, HP, speed and best
skills. Free agents are neutral; your roster wears your banner, and a drafted
card turns over into it. The lineup builder deals your roster the same way:
starters wear your banner, the bench is neutral (an injured character greyed
out), and Start turns a card over into your colours; the CR meter jellies
when a starter still fits the budget and shakes when one doesn't.

Moments (`src/playground/fx.ts`) give a few moves emotional weight: choosing
your tavern raises its banner over the header with one burst of party.js
sparkles (bundled) and micron's swing (its CSS vendored into `page.html` with
its MIT notice). A week's race ends in a moment sized to your week
(`weekOutcome`): confetti in your banner's colours for topping it, sparkles
for beating the projection, a breath out for turning back, a dimmed strip
after a DNF, and nothing for a quiet week. A hex takes a second click to
declare (it is public and final), then lands in the room in your colours
with a jolt and a few embers; a rival's hex on you opens your tale in the
rival's colours. The table after each week slides from last week's order
into this week's (▲/▼, `tableMoves`). The last week ends the season: if you
won, your banner goes up over the crier's final message and the only
full-screen confetti in the page rises in its colours; if not, the
champion's flag swings in theirs, and the message gives your finish and your
best week. Each message holds its whole result and the telling only holds
pieces back, so Skip, a reload and reduced motion all show the same thing.
The page calls `seasonInputFromData`, which is the same `seasonInput` the CLI
uses, so a seed gives the same season, byte for byte: the engine avoids
`Math.exp`/`Math.log` (not bit-identical across JS engines) in favor of
`engine/src/internal/det-math.ts`, so the page's NDJSON hash matches the CLI's.

The page is written as an Artifact body: it starts with `<title>`, has no
doctype, html, head or body tags, makes no requests beyond Google Fonts, and
is pure ASCII so it reads right without a declared charset.
`src/playground/` is type-checked with DOM types by its own
`tsconfig.json`; pure view helpers live in `src/playground/view.ts` and
`src/playground/feed.ts` and are tested in `test/playground.test.ts`.
