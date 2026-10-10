# events

`events.ndjson`: the append-only event log for this season. **Written only by
GitHub Actions.** Humans never edit it, and PRs that touch it fail CI (T11.5).

Everything else (rosters, standings, results, stats) is rebuilt by replaying
this file through the engine reducers. Schema: docs/schema.md § Events.
