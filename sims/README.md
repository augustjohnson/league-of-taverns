# sims

Seasons of the Lich's contest played by bot taverns, for balance testing, and
the browser playground for playing one by hand. Everything here is a consumer
of `engine/` and `bots/`, and sims never use rules the live league doesn't.

- `src/season-runner.ts` is the season loop as pure functions:
  `seasonParts` (a loaded season as plain JSON-safe data), `seasonInput`
  (parts → a run-ready `SeasonInput` with the cards built once),
  `ContestSession` (one season a step at a time, with an optional human
  seat), `runSeason(input, { seed })` (a session with bots in every seat,
  driven straight through and audited) and `aggregate`. It imports nothing
  from Node, so the browser playground bundles it.
- `src/sim.ts` is the CLI. `src/load.ts` reads a season folder through the
  scripts loaders.
- `src/playground/` is the browser playground, and `src/build-playground.ts`
  builds it (see below).
- `fixtures/lich-season/` is the season both play: 48 of the real cast with
  authored voting strategies (12 drawn per season), four taverns with
  banners, four bot managers and 9 challenges.

## Season sims

```
pnpm sim -- [--dir sims/fixtures/lich-season] [--runs 100] [--seed sim-1] [--out sims/output/<run-id>] [--model '{"noise":0.4}']
```

Each run plays a whole season: the cast drawn by the seed, the tavern pick,
the snake draft, then for each of the 9 episodes the bots' early calls, the
challenge, their late calls and the vote, and the finale. Every event goes through the engine's `applyEvent`; at the end the
NDJSON is replayed (`replayLog`) and the whole contest recomputed from its
seed (`verifyContest`), and any disagreement stops the run.

The report prints, per bot, titles, points and calling accuracy, and
for the contest the numbers from docs/survivor-format.md §7: how often the
favourite boot went home, the correlation of challenge power with finishing
place, the spread of winners, win rate by voting strategy, the share of
points from calls and how many titles calls decided (the champion would
change without call points). `--model` overrides
vote-model dials (engine/src/contest/model.ts) for a tuning sweep.

Seeds: run 1 uses `--seed` itself and run n uses `<seed>~<n>`, so
`--runs 1 --seed <that>` reproduces any one season. The seed draws the cast,
salts the contest's dice (`contestSeed`), drives the bots and shuffles the
join order (so each seat's draft slot varies). Output goes to `sims/output/`,
git-ignored: share the command and seed, not the output.

## Playground

A single self-contained HTML page that runs the real engine and bots in the
browser.

```
pnpm --filter @league-of-taverns/sims playground -- [--dir sims/fixtures/lich-season] [--out sims/output/playground/index.html]
```

Then open `sims/output/playground/index.html` (no server needed). The page is
just under 2 MB, the build's limit: most of it is each pooled character's
portrait, cut to a thumbnail and a face crop for the cards. Names, portraits,
tavern banners and challenge stories are chrome, carried for display only.

The page opens to **the game** (`src/playground/play.ts`): one season against
three bots, with keepers' names so the table reads like people.

- **The Common Room** is the season's running story, a chat no one types
  into (`src/playground/feed.ts` `feedItems`, pure and tested): the tavern
  pick, the draft pick by pick (with the scouts' steals and reaches), and
  for each episode the Lich's summons, the calls (rivals' sealed, yours
  shown to you), **the challenge in the scrying ball** round by round, and
  **the vote read one parchment at a time**, stopping once nobody can catch
  the boot, then the calls unsealed with each tavern's points and your share.
  The crier follows each vote with the table as it stands; the finale reads
  the jury's votes, then the final table.
- **The pacing.** The engine and bots decide at once, but the room tells it
  at a person's pace: a rival is on the clock before its pick lands, and
  whispers its call before the challenge. Skip (or Esc), a reload and
  `prefers-reduced-motion` tell everything at once, and every page view shows
  the league folded from what the room has told.
- **The workspace** follows the season: the taverns, the draft (the cast as
  cards: abilities, challenge power, speeds and senses, the voting strategy
  in words, and the scouts' rating as stars; the season's ability mix as a
  hint), then **the cast** during the contest: everyone still in, yours
  first, with immunity wins and last vote's ballots, to call from.
- **Standings:** every tavern by points, and its candidates.
- **The action bar** says what's next: your pick, or in an episode "Run the
  challenge" and "Go to the vote", with your call shown.

Before the first season you give your name and name your tavern, "The
<adjective> <noun>", under one of six banners; both are kept in localStorage
for later seasons. You bring that tavern (`HumanSeat.tavern`): no bot takes
it, and a season tavern flying the same banner sits the season out. Your seat
and the seed are random. The season is saved in localStorage as its seed,
seat, your tavern and your moves, and replayed on reload. When it ends it is audited like any run and loads into
**the workshop** (`src/playground/workshop.ts`): a bot run for any seed (with
the replay and seed-audit checks and the NDJSON hash), standings and points
per episode, an episode inspector (every roll, every ballot, and the public
odds before and after the challenge), the draft board with where each pick
finished, the cast by finish, the event log, and a batch with the sims'
report.

How it is built: `src/playground-build.ts` loads the season with the scripts
loaders, serializes it (`src/playground/data.ts`), bundles
`src/playground/app.ts` with esbuild as a minified browser IIFE, and inlines
both into `src/playground/page.html`. The page calls `seasonInputFromData`,
the same `seasonInput` the CLI uses, so a seed gives the same season byte for
byte. Moments (`src/playground/fx.ts`) use party.js and micron (its CSS
vendored into `page.html` with its MIT notice), and never play under reduced
motion.

The page is written as an Artifact body: it starts with `<title>`, has no
doctype, html, head or body tags, makes no requests beyond Google Fonts, and
is pure ASCII.
