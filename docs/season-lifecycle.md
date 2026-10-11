# Season lifecycle

One season from start to finish. Each step names who acts, the files or events
it produces, and the script that does it. Scripts are in `scripts/src/`, and
task ids refer to [TODO.md](../TODO.md).

```
offseason ─▶ candidates ─▶ validate + report ─▶ select ─▶ chrome ─▶ lock ─▶ draft ─▶ weekly ×N ─▶ offseason
  (GM)         (LLM)         (engine)            (GM)     (LLM+GM)   (GM, CI gate)   (all)    (Actions)
```

## 0. Offseason: pool, modifiers, carryover

**Who:** GM and commissioner. **Where:** PRs.

1. **Snapshot.** Run `snapshot` for a new pinned Open5e snapshot, or reuse the
   last one. Set `config.yaml` `snapshot:` to its id. Snapshots are
   immutable.
2. **Characters.** Add `characters/<id>/` for new characters (base +
   chrome). Returning characters keep their folder. Chrome may evolve, and the
   id never changes.
3. **Pool.** Write `pool.yaml` with about 64 character ids and this season's
   modifiers. `validate` checks bases against the snapshot and modifiers against
   the registry and budget.
4. **Carryover.** `offseason --from season-01 --to season-02` lists keeper
   eligibility from last season's replayed final state. Managers declare
   keepers, the commissioner confirms, and kept characters must be in the new
   pool. Modifier changes on a keeper are capped (`carryover.maxModifierChangePoints`).
5. **Config, managers, schedule.** Write `config.yaml`, `managers.yaml`
   (GitHub ids), and `schedule.yaml`: week → title, environment, theme. **The
   schedule is public the moment it merges.**

## 1. Mission candidates

**Who:** GM runs it locally. **Script:** `draft-missions`.

- The LLM drafts about 10 candidates, structure only, from
  `content/prompts/mission-candidates.md`. The inputs are the schedule entries,
  a pool archetype summary, and the allowed encounter slugs.
- Every response goes through the validator, and failures are retried with the
  full issue list. Only valid candidates are written to
  `missions/candidates/`.
- Hand-written candidates are equally welcome.
- Candidates are committed in plaintext. Missions are open (D-08), so D-18 is moot.

## 2. Validation and difficulty report

**Who:** GM. **Scripts:** `validate`, `difficulty-report`.

For each candidate, against the whole season pool:
- spread of expected score across many legal lineups (mean, p10, p50, p90)
- DNF rate
- **archetype dependency**: how much the expected score moves with or without
  each speed, sense, skill tier and creature type. "Only flyers finish" shows
  up here.
- node reach rates (dead branches)

The output goes to `seasons/<id>/reports/`, which is git-ignored because it is
derived output.

## 3. Selection

**Who:** GM.

Pick about 6 candidates, one per scheduled week, guided by the report. Aim for
varied difficulty, no week that one archetype dominates, and environments
that match the schedule. Move them into `missions/selected/`, still
plaintext locally at this point. Unselected candidates stay unpublished,
possibly for reuse later.

## 4. Chrome

**Who:** LLM drafts, GM edits. **Script:** `draft-chrome`.

- Per selected mission: theme, title (it must match the schedule), intro, a
  beat for every outcome of every node, an outro per ending, optional
  through-lines and image prompts.
- Output starts as `status: draft`. The GM edits it by hand, sets `reviewed`,
  and finally `locked`.
- The coverage check and lints run on every save. See
  [schema.md § Mission chrome](schema.md#mission-chrome).

## 5. Lock

**Who:** GM, then CI. **Script:** `lock-check`.

1. `lock-check` must pass: every scheduled week has a selected mission, each
   mission validates, and its chrome is `locked` with complete coverage.
   **CI blocks season start otherwise.**
2. The commissioner creates the season: the Action appends `season.created`
   (config + schedule), `character.pooled` × about 64, `tavern.joined` × N,
   and `character.retained` for keepers.

**From here on, missions are frozen.** Missions are open (D-08), so there's
no sealing step. CI flags any change to a selected mission after
`season.created`.

## 6. Draft

**Who:** managers via the *Draft pick* form. **Actions:** `apply-command`.

- Snake order, frozen at the first pick. Each pick is validated and appended
  as `draft.pick`. Timeouts autopick [D-26].
- After the last pick, the phase becomes `regular` and waiver priority is set
  to reverse draft order.

## 7. Weekly loop (× number of weeks)

| When (Season 1, UTC) | What | Event(s) | Script |
|---|---|---|---|
| Any time before the lock | Managers submit lineups, claims and trades | `lineup.set`, `waiver.claimed`, `trade.*` | `apply-command` |
| Thu 18:00 | **Lock.** Freeze every lineup (submitted, carried, or fallback) | `lineup.locked` | `run-week --lock` |
| Thu 18:15 | **Start the week.** Record which mission runs | `mission.revealed` (kept for the record. Missions are already public) | `run-week` |
| Thu 18:15 | **Run.** For each tavern: one real random run (D-13) plus projection | `mission.resolved` × N | `run-week` |
| Thu 18:15 | **Finalize.** Close the week, then rebuild and deploy published JSON | `week.finalized` | `run-week`, `publish` |
| Fri 12:00 | **Waivers.** Resolve all pending claims in rolling priority | `waiver.resolved` | `run-week --waivers` |
| Hourly | **Trades.** Complete accepted trades whose veto window has passed | `trade.completed` / `trade.cancelled` | `apply-command --sweep` |

Every week runs **once**. `run-week` refuses a week that is already finalized.
All event-writing workflows share one concurrency group per season, so appends
are serialized.

## 8. Season end and back to offseason

- `week.finalized` for the last week sets phase `complete`. The champion is
  the top of the table by total loot (D-04). A tie gives co-champions.
- `offseason` summarizes final rosters, career stats per character id, and
  carryover eligibility. Then go back to step 0 for the next season.
- The finished season's log is frozen. It stays replayable forever against its
  pinned snapshot and the engine version recorded in its events.
