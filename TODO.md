# TODO

Work is split into **workstreams** (W1–W11). Each one can go to a single
subagent with minimal overlap. A workstream owns its files. When it needs
something from another, it depends on a task id and doesn't edit that file.

**How to use this file:** give a subagent one workstream, plus README.md,
docs/rules.md, docs/schema.md, docs/decisions.md, and the module stubs it
owns. Every stub throws `NotImplementedError` naming its task id, so
`grep -rn "T6.3" engine scripts bots sims` finds the exact entry points.

**Conventions for every task:**
- Engine code is pure: no I/O, no `Date`, no `Math.random`. Lint and
  `engine/test/boundaries.test.ts` enforce this.
- Replace `it.todo` stubs with real tests and add more as needed.
  `pnpm check` must pass.
- When a task hits an OPEN decision, implement the documented default behind
  config and note it in the PR. Don't decide it silently.

**Legend:** ★ = on the critical path · Size **S** ≤ half a day ·
**M** ≈ 1–2 days · **L** ≈ 3+ days.

## Critical path

Milestone: **a hand-built 3-mission mock season runs end to end with bots**
(in memory, in `sims/`, no GitHub).

```
T0.1 ─▶ T2.1 ─▶ T2.2 ─────────────────────────────────────────────┐
T1.1 ─▶ T1.2 ─▶ T1.3 ─▶ T3.3 ─▶ T6.1 ─┬─▶ T6.3 ─┐                  │
        T3.2 ─────────▶ T3.3   T6.2 ──┴─▶ T6.4 ─┤                  ├─▶ T9.2 ─▶ milestone
T2.3 ─▶ T2.4 ──────────────────────────────────┤                  │
T4.2, T4.3, T4.4, T4.6 ────────────────────────┤                  │
T5.1 ─▶ T5.2 ─▶ T5.5 ──────────────────────────┘    T9.1 ─────────┘
T3.1 ─▶ T3.4 (pool + config loading for the sim)
```

★ tasks: T0.1, T1.1, T1.2, T1.3, T2.1, T2.2, T2.3, T2.4, T3.1, T3.2, T3.3,
T3.4, T4.2, T4.3, T4.4, T4.6, T5.1, T5.2, T5.5, T6.1, T6.2, T6.3, T6.4, T9.1,
T9.2.

## Status

- **Phase 1 merged** (2026-10-10): T0.1, T0.2, T1.1, T2.1, T2.3, T3.1, T3.2, T4.3, T4.6, T5.1.
- **Phase 2 in progress:** T1.2 → T1.3 → T3.3, T2.2, T4.2 → T4.4, T5.2.

## Phase 1 starting set (historical)

No dependencies beyond T0.1: **T1.1** (snapshot), **T2.1** (RNG),
**T2.3** (event codec), **T3.1** (character files), **T3.2** (modifier
registry), **T4.3** and **T4.6** (draft order, H2H schedule), **T5.1**
(mission schema), **T8.1** (chrome schema), **T11.1** (issue-form parser).
**T6.1** can also start against hand-built `EffectiveStats` fixtures.

---

## W0: Bootstrap

#### T0.1 ★ Install and get CI green · S (local half done)
- **Goal:** the scaffold installs, lints, typechecks and tests cleanly.
- **Inputs:** root `package.json`, workspace packages.
- **Outputs:** `pnpm-lock.yaml` (generated); `.github/workflows/ci.yml` uses
  `pnpm install --frozen-lockfile`.
- **Acceptance:** `pnpm check` passes locally (done at scaffold: lint and
  typecheck clean, 22 passed, 34 todo) **and on the first CI run** (not yet pushed).
- **Depends:** none.

#### T0.2 ★ Shared engine dependencies · S (done at scaffold)
- **Goal:** add zod and @noble/hashes to `engine/` once, so the schema tasks
  (T2.3, T3.1, T3.2, T5.1) don't race on `package.json` and the lockfile.
- **Acceptance:** both are installed and allowlisted in `engine/test/boundaries.test.ts`.
- **Depends:** T0.1.

---

## W1: Open5e snapshot + adapter

Owns `scripts/src/snapshot.ts`, `data/open5e/`, `engine/src/adapters/open5e/`.

#### T1.1 ★ Pull a pinned raw snapshot · M
- **Goal:** fetch the Open5e monsters once, verbatim, into an immutable, pinned snapshot.
- **Inputs:** Open5e v1 `/monsters/` API; document filter (default SRD 5.1 only, D-17).
- **Outputs:** `scripts/src/snapshot.ts`; `data/open5e/open5e-v1-2026-10/monsters.json`;
  entry in `data/open5e/manifest.json` (id, fetchedAt, sourceUrl, apiVersion,
  documents + license URLs, count, sha256, file).
- **Acceptance:** records are value-identical to the API, with the same keys,
  key order and values (only sorted by slug; `10.0` is written as `10`);
  re-running with an existing id refuses; the manifest sha256 matches the file;
  every record's `document__slug` is in the allowed list; README attribution
  matches the documents included.
- **Depends:** T0.1.

#### T1.2 ★ Raw record types + test fixtures · S
- **Goal:** make `Open5eMonster` match reality, and give other workstreams small fixtures.
- **Inputs:** T1.1 snapshot.
- **Outputs:** `engine/src/adapters/open5e/types.ts` corrected;
  `engine/test/fixtures/open5e/*.json` (about 20 records spanning CR 1/8–10,
  fly/swim/burrow, darkvision, resistances, multiattack. Must include `ogre`,
  `crocodile`, `giant-frog`, `lizardfolk`, `giant-crocodile`).
- **Acceptance:** every snapshot record type-checks against `Open5eMonster`
  (script-level check); the fixtures are verbatim copies.
- **Depends:** T1.1.

#### T1.3 ★ Adapter: record → BaseStats · M
- **Goal:** `toBaseStats`, `parseCr`, `indexSnapshot`.
- **Inputs:** fixtures (T1.2); `engine/src/vocabulary.ts`.
- **Outputs:** `engine/src/adapters/open5e/index.ts`; `engine/test/adapter.test.ts`.
- **Acceptance:** CR exact in eighths for every snapshot value; every skill
  and save populated (ability-mod fallback); senses and damage text parsed or
  reported in `warnings`, never guessed; attack profiles have attack bonus,
  average damage and per-turn counts from Multiattack where parseable; a
  snapshot-wide run reports the warning count by field.
- **Depends:** T1.2.

#### T1.5 Flag spellcasters · S
- **Goal:** `BaseStats.spellcaster: boolean`, true when the record has a
  "Spellcasting" or "Innate Spellcasting" special ability or action (D-43).
- **Acceptance:** 37 of 322 snapshot records flagged; mage, archmage, druid,
  priest and the mephits are true, ogre and crocodile are false.
- **Depends:** T1.3.

#### T1.4 Snapshot integrity + loading · S
- **Goal:** load a snapshot by id with its hash verified.
- **Outputs:** `loadSnapshot` in `scripts/src/lib/repo.ts`; check wired into `validate`.
- **Acceptance:** a tampered file fails with a clear message; an unknown id fails.
- **Depends:** T1.1.

---

## W2: RNG + event core

Owns `engine/src/rng/`, `engine/src/events/`, `readEventLog` and `appendEvent`
in `scripts/src/lib/repo.ts`.

#### T2.1 ★ Seeded RNG · S
- **Goal:** `cyrb128`, `sfc32`, `rngFor(seed, key)`, `rollD20`, as in docs/specs/03.
- **Outputs:** `engine/src/rng/index.ts`; `engine/test/rng.test.ts`.
- **Acceptance:** golden values pinned in tests; d20 uniformity
  (chi-square); substream independence; identical results in Node and the
  browser (no platform APIs).
- **Depends:** T0.1.

#### T2.2 ★ Seed grammar · S
- **Goal:** `weekSeed`, `draftOrderSeed`, matching docs/schema.md § Seeds.
- **Outputs:** `engine/src/rng/index.ts`; tests.
- **Acceptance:** the format is documented and tested; the salt is optional and
  changes the seed; the node key is `roll:<node-id>`.
- **Depends:** T2.1.

#### T2.3 ★ Event envelope, codec, hashing · M
- **Goal:** parse and serialize NDJSON and hash lines. Add zod (D-22) and
  `@noble/hashes` to the engine.
- **Inputs:** `engine/src/events/types.ts`.
- **Outputs:** `engine/src/events/replay.ts` (`parseLog`, `serializeEvent`,
  `lineHash`); zod schemas for the envelope and every payload; the JSON Schema
  export script.
- **Acceptance:** round-trip test for every event type; canonical
  serialization (stable key order); a malformed line gives an error with the
  line number; hashing is pure JS.
- **Depends:** T0.2.

#### T2.4 ★ Reducers · M
- **Goal:** `initialState` and `applyEvent` for all event types, with the
  preconditions and fold rules in docs/schema.md § Reducers.
- **Inputs:** T2.3; roster rule functions from W4 (call them, don't
  reimplement them).
- **Outputs:** `engine/src/events/reducers.ts`, `state.ts`; `readEventLog` and
  `appendEvent` in `scripts/src/lib/repo.ts`; `engine/test/events.test.ts`.
- **Acceptance:** each precondition in the schema table has a rejecting test;
  phases advance correctly; `appendEvent` writes nothing when the reducer throws.
- **Depends:** T2.3, T4.2, T4.3 (wire roster stubs early and fill them as W4 lands).

#### T2.5 Replay + verification · M
- **Goal:** `replay` (seq contiguity, hash chain) and `verifyResolutions`.
- **Outputs:** `engine/src/events/replay.ts`; tests.
- **Acceptance:** replaying the same log twice gives deep-equal state; a gap,
  reorder or edited line is detected; an edited d20 in `mission.resolved` is
  flagged by `verifyResolutions`.
- **Depends:** T2.4, T6.3, T6.4.

---

## W3: Characters + modifiers

Owns `engine/src/characters/`, `characters/`, `seasons/*/pool.yaml` schema,
`loadCharacterRef`/`loadCharacterChrome`/`loadSeasonConfig` in `scripts/src/lib/repo.ts`.

#### T3.1 ★ Character files: schema + loaders · S
- **Goal:** validate `characters/<id>/character.yaml` and split mechanics from chrome at load time.
- **Outputs:** zod schema; `loadCharacterRef` (returns `{id, base}` only) and `loadCharacterChrome`.
- **Acceptance:** folder name = id; chrome fields never appear in `CharacterRef`
  (type-level and runtime test); bad files give path + field errors.
- **Depends:** T0.1.

#### T3.2 ★ Modifier registry + budget · M
- **Goal:** `modifierCost`, `validateModifiers`; finalize the v1 vocabulary.
- **Inputs:** `engine/src/characters/registry.ts`, docs/schema.md § Modifier registry.
- **Outputs:** registry, functions, tests.
- **Acceptance:** unknown kinds and traits rejected; range limits enforced;
  stacking rules per the schema; cost of the Bruno example = 3; traits can't
  contain traits.
- **Depends:** T0.1. Final costs come from D-31 and T9.3.

#### T3.3 ★ Effective stats · S
- **Goal:** `effectiveStats`, `checkTargetKey`.
- **Outputs:** `engine/src/characters/index.ts`; tests.
- **Acceptance:** every primitive kind applied and tested; advantage recorded
  by target key; CR unchanged by modifiers; pure.
- **Depends:** T1.3, T3.2.

#### T3.4 ★ Pool + season config loading and validation · M
- **Goal:** load `config.yaml` (CR → eighths), `pool.yaml`, `managers.yaml`,
  `schedule.yaml` into engine types, with full validation.
- **Outputs:** `loadSeasonConfig` and pool/managers/schedule loaders; checks in `validate`.
- **Acceptance:** season-01 files load; every pooled id has a character
  folder; bases exist in the pinned snapshot; modifiers pass T3.2;
  managers have unique GitHub ids; the schedule has `weeks` entries.
- **Depends:** T3.1, T3.2, T1.4.

#### T3.7 Pool spellcaster limit · S
- **Goal:** pool validation enforces `spellcasters.maxInPool` from season config (D-43).
- **Acceptance:** a pool over the limit fails `validate` with the list of caster characters.
- **Depends:** T1.5, T3.4.

#### T3.5 Chrome isolation test · S
- **Goal:** prove chrome can't affect outcomes.
- **Outputs:** test that mutates every chrome field of every character and
  asserts identical replayed state and identical run results.
- **Acceptance:** passes; fails if someone threads chrome into the engine.
- **Depends:** T3.1, T6.3.

#### T3.6 Career history · S
- **Goal:** aggregate per-character history across all season logs by id.
- **Outputs:** pure aggregator in the engine (takes multiple parsed logs); used by `offseason` and `publish`.
- **Acceptance:** a character traded mid-season shows both taverns; retired characters still listed.
- **Depends:** T2.5.

---

## W4: Roster rules

Owns `engine/src/roster/`, `engine/src/league/`.

#### T4.1 Roster fold helpers · S
- **Goal:** pure helpers the reducers call to move characters between taverns
  and free agency, with exclusive ownership enforced.
- **Outputs:** functions in `engine/src/roster/`; tests.
- **Acceptance:** a character can never be owned twice; roster size is never exceeded.
- **Depends:** T0.1.

#### T4.2 ★ Lineup validation · S
- **Goal:** `validateLineup`.
- **Acceptance:** rejects non-owned, duplicate, captain-not-in-four, and
  over-budget lineups with exact fractional sums (four CR 1/8 = 4 eighths);
  every violation listed.
- **Depends:** T0.1.

#### T4.3 ★ Snake draft order · S
- **Goal:** `draftOrder(taverns, config, rng)` (shuffle from the injected rng,
  or manual) and `snakePickOwner`. The rng is a parameter, so this doesn't
  wait on T2.1.
- **Acceptance:** same season → same order; snake reversal correct for odd and
  even tavern counts; keeper-forfeited rounds skipped (behind config, D-11).
- **Depends:** T0.1.

#### T4.4 ★ Missed lineup carryover · S
- **Goal:** `carriedLineup`, with the D-27 fallback.
- **Acceptance:** carries a legal lineup; falls back when a starter is gone;
  returns null when no legal lineup exists; deterministic.
- **Depends:** T4.2.

#### T4.5 Waivers + trades · M
- **Goal:** `resolveWaivers` (rolling priority) and `validateTrade`.
- **Acceptance:** worked examples from docs/rules.md §9–10 as tests; claims for
  the same player go to the highest priority; a winner moves to the back; a
  tavern's own claims are tried in seq order; trades rechecked at completion.
- **Depends:** T4.1.

#### T4.6 ★ Head-to-head schedule + standings · S
- **Goal:** `headToHeadSchedule` and `standings(matchups, results, config, rng)`.
  The rng serves the coin-flip tiebreaker.
- **Acceptance:** each tavern plays once per week; odd tavern counts get a
  bye; standings order and tiebreakers follow the config.
- **Depends:** T0.1.

---

## W5: Mission schema + validator + candidate drafting

Owns `engine/src/missions/`, `scripts/src/validate.ts`,
`scripts/src/draft-missions.ts`, `scripts/src/lib/llm.ts`,
`content/prompts/mission-candidates.md`.

#### T5.1 ★ Mission schema · S
- **Goal:** zod schema for mission YAML. Missions are open (D-08), so no
  commitment hash is needed.
- **Outputs:** schema in `engine/src/missions/`; YAML loader in scripts.
- **Acceptance:** the example mission parses; malformed nodes give errors naming the field.
- **Depends:** T0.2.

#### T5.2 ★ Validator · M
- **Goal:** `validateMission` and `topologicalOrder` covering every rule in
  docs/schema.md § Mission.
- **Outputs:** `engine/src/missions/index.ts`; `engine/test/missions.test.ts`.
- **Acceptance:** one failing fixture per rule code; all violations reported
  together; the example passes against the T1.2 fixtures.
- **Depends:** T5.1, T1.2.

#### T5.6 Encounter spellcaster rule · S
- **Goal:** a validator rule `encounter.caster`: a battle may include at most
  `spellcasters.maxPerEncounter` spellcaster creatures (D-43). Add the limit to
  `MissionRules` and `SeasonConfig`.
- **Acceptance:** an encounter with a mage fails under season-01 rules, and the
  message names the creature and explains why.
- **Depends:** T1.5, T5.2.

#### T5.3 Validate CLI · S
- **Goal:** `scripts/src/validate.ts` runs every content check for a season.
- **Acceptance:** exits 0 on season-01; 1 with a full report on any broken
  fixture; CI-friendly output (`file:line: message` where possible).
- **Depends:** T5.2, T3.4, T8.2.

#### T5.4 LLM candidate drafting · M
- **Goal:** `draft-missions` with a validator retry loop, behind the
  `LlmClient` seam.
- **Inputs:** `content/prompts/mission-candidates.md`.
- **Outputs:** the script; `renderTemplate`; a fake `LlmClient` for tests.
- **Acceptance:** with the fake client: renders all template variables, writes
  only valid candidates, retries with the issue list, gives up after N; never
  runs in CI. The live provider is blocked on D-32 and goes in its own small PR.
- **Depends:** T5.2.

#### T5.5 ★ Hand-built mock season content · S
- **Goal:** content for the critical-path milestone.
- **Outputs:** `sims/fixtures/mock-season/`: 3 missions (varied
  environments, at least one with two battles), a mock pool of about 32
  characters (ids + bases + modifiers, no chrome needed), and a config with B,
  roster 7 and 4–8 taverns.
- **Acceptance:** all 3 missions pass T5.2; the pool passes T3.2 budgets.
- **Depends:** T5.1, T5.2, T3.2.

---

## W6: Resolution + projection

Owns `engine/src/resolution/`, `engine/src/projection/`.

#### T6.1 ★ Check odds + best-fit assignment · S
- **Goal:** `checkOdds`: formula, advantage, `requires` gate, best-fit actor
  with deterministic tiebreak (captain first, then lineup order, D-15).
- **Acceptance:** table tests over DC − mod from −20 to +20 (clamps); advantage
  math; ties resolved as documented; captain role behind a switch (D-12).
- **Depends:** T3.3 (fixtures acceptable before it lands).

#### T6.2 ★ Battle model v0 · M
- **Goal:** `BattleModel` `ev-ttk-v0` and `battleOdds`.
- **Acceptance:** monotonic (stronger party → higher p, more foes → lower p);
  p in [0.01, 0.99]; deterministic; documented formula; calibration note for
  D-28.
- **Depends:** T1.3, T3.3.

#### T6.3 ★ Single seeded run · M
- **Goal:** `runMission`, which produces `RunResult` with per-node records.
- **Acceptance:** same seed → identical result; dice per node depend only on
  node id; DNF on any loss with score 0; score = passed / attempted; the
  record has everything `mission.resolved` needs.
- **Depends:** T6.1, T6.2, T2.2, T5.2.

#### T6.4 ★ Projection by propagation · M
- **Goal:** `projectMission`: exact E[score], P(DNF), reach, distribution.
- **Acceptance:** hand-computed expectations for 3 small DAGs; uses
  E[passed / attempted] (distribution over counts per node), not a ratio of
  expectations; probabilities sum to 1.
- **Depends:** T6.1, T6.2, T5.2.

#### T6.5 Property test: propagation = sampled mean · M
- **Goal:** the guarantee from the specs, checked automatically.
- **Outputs:** generator of random legal missions and parties (fast-check or
  hand-rolled on `rngFor`); a test comparing `projectMission` to the mean of
  N `runMission` seeds.
- **Acceptance:** agreement within 4 standard errors across ≥ 200 random cases;
  fast enough for CI (< 10 s).
- **Depends:** T6.3, T6.4.

---

## W7: Difficulty report

Owns `scripts/src/difficulty-report.ts` and its lib.

#### T7.1 Lineup sampler · S
- **Goal:** sample legal lineups from a pool, uniformly (rejection under B) and
  bot-drafted (via W9 strategies once available).
- **Acceptance:** every sampled lineup passes `validateLineup`; seeded and reproducible.
- **Depends:** T4.2, T3.3.

#### T7.2 Difficulty metrics · M
- **Goal:** per candidate: expected-score spread, DNF rate, node reach,
  archetype dependency (Δ mean score with or without each speed, sense,
  skill tier and creature type).
- **Acceptance:** a constructed "flyers only" mission is flagged; a
  constructed dead branch is flagged; runtime < 1 min for 10 candidates ×
  5k lineups.
- **Depends:** T7.1, T6.4.

#### T7.3 Report output · S
- **Goal:** `seasons/<id>/reports/difficulty.{md,json}` (git-ignored), sorted
  for selection, with a comparison table across candidates.
- **Acceptance:** readable by the GM without code; JSON has the same numbers.
- **Depends:** T7.2.

---

## W8: Chrome pipeline

Owns `scripts/src/lib/chrome.ts`, `scripts/src/draft-chrome.ts`,
`scripts/src/lock-check.ts`, `content/prompts/mission-chrome.md`,
`content/prompts/season-throughlines.md`, `seasons/*/chrome/` schema.

#### T8.1 Chrome schema + loader · S
- **Goal:** zod schema for mission chrome and through-lines, with status states.
- **Acceptance:** the example chrome loads; invalid status rejected.
- **Depends:** T0.1.

#### T8.2 Branch coverage + token scope · M
- **Goal:** `checkCoverage`.
- **Acceptance:** the example is fully covered; tests for a missing
  pass/fail/win/lose, a missing outro, an unknown node, an unknown token,
  `{actor}` on a battle, `{battle_creature}` on a check.
- **Depends:** T8.1, T5.1.

#### T8.3 Mechanical-fact lint · S
- **Goal:** `lintMechanicalFacts`.
- **Acceptance:** flags digits, DC, roll, d20, and margin words; allows an
  explicit per-line ignore with a reason for false positives.
- **Depends:** T8.1.

#### T8.4 Lock check (season-start gate) · S
- **Goal:** `lock-check` per docs/season-lifecycle.md §5.
- **Acceptance:** fails on any unlocked or uncovered selected mission or
  missing mission for a scheduled week; lists every gap.
- **Depends:** T8.2, T8.3.

#### T8.5 Chrome drafting script · M
- **Goal:** `draft-chrome` (+ `--throughlines`) behind `LlmClient`.
- **Acceptance:** with the fake client: writes `status: draft`, never
  overwrites `reviewed` or `locked`, runs coverage and lints and prints gaps.
  The live provider waits on D-32.
- **Depends:** T8.2, T5.4 (LLM seam).

#### T8.6 Story rendering · M
- **Goal:** `renderStory`: chrome + `RunResult` + chrome names → text.
- **Acceptance:** every token filled from data; correct variant per outcome;
  DNF ends at the `lose` beat; `{allies}` lists names naturally.
- **Depends:** T8.2, T6.3, T3.1.

---

## W9: Bots + mock seasons + balance report

Owns `bots/`, `sims/`.

#### T9.1 ★ Bot strategies · M
- **Goal:** the presets in `bots/src/strategies/index.ts`: draft (random,
  cr-greedy, skill-coverage, value), lineup (max-cr, environment-fit), waivers
  (best-available).
- **Acceptance:** `bots/test` todos replaced; every decision is legal per W4;
  deterministic given the view and rng; `PublicView` has no mission structure.
- **Depends:** T4.2, T3.3 (can start against types).

#### T9.2 ★ Mock season runner · L
- **Goal:** `sims/src/mock-season.ts`: a full season in memory through the
  real reducers.
- **Inputs:** T5.5 fixtures.
- **Outputs:** `sims/output/<run>/events-<n>.ndjson`, `summary.json`.
- **Acceptance (milestone):** with 3 hand-built missions and 4–8 bots, a season
  runs from `season.created` to the final `week.finalized`; the output log
  replays to identical state; 200 seasons run in < 1 min.
- **Depends:** T9.1, T2.4, T4.3, T4.4, T4.6, T6.3, T6.4, T3.4, T5.5.

#### T9.3 Balance report · M
- **Goal:** `sims/src/balance-report.ts`.
- **Acceptance:** reports strategy win and title rates against the random
  baseline, with intervals; how often the best-projected tavern wins its week
  and the season; character pick rate, mean draft position, lineup share,
  points contributed; auto-picks (> 95% rostered) and never-picked lists;
  modifier value per point.
- **Depends:** T9.2.

#### T9.4 Experiments · M
- **Goal:** use sims to inform open decisions: captain variants (D-12),
  per-tavern vs shared dice (D-13), points and ties (D-14), roster size (D-03),
  roster CR cap (D-40), keeper rules (D-11).
- **Acceptance:** a short write-up per decision appended to docs/decisions.md
  with the commands and seeds used.
- **Depends:** T9.3.

---

## W10: Season lifecycle tooling

Owns `scripts/src/{run-week,seal,reveal,offseason,publish}.ts`.

#### T10.1 Weekly run · M
- **Goal:** `run-week` (`--lock`, run, `--waivers` modes) per docs/season-lifecycle.md §7.
- **Acceptance:** emits `lineup.locked`, `mission.resolved` × N and
  `week.finalized`; refuses an already-finalized week; replay after the run
  passes `verifyResolutions`; works against a temp copy of season-01 with a
  test mission.
- **Depends:** T2.5, T6.3, T6.4, T4.4, T4.5.

#### T10.4 Publish · M
- **Goal:** `publish` → `dist/published/<season>/` (never committed, D-19).
- **Acceptance:** JSON matches the sketch in docs/schema.md; stories rendered;
  regenerates identically from the log.
- **Depends:** T10.1, T8.6, T4.6.

#### T10.5 Season bootstrap · S
- **Goal:** produce `season.created`, `character.pooled` × N and
  `tavern.joined` × N from the season files.
- **Acceptance:** idempotent refusal if the season already exists; config
  sha256 recorded; requires `lock-check` to pass.
- **Depends:** T3.4, T8.4, T2.4.

---

## W11: GitHub integration

Owns `.github/`, `scripts/src/apply-command.ts`, `scripts/src/lib/issue-forms.ts`.

#### T11.1 Issue-form + comment parser · S
- **Goal:** `parseIssueForm`, `parseComment`.
- **Acceptance:** fixtures of real GitHub-rendered bodies for all four forms;
  `_No response_` handling; `/accept`, `/decline`, `/veto <reason>`.
- **Depends:** T0.1.

#### T11.2 Command workflow · M
- **Goal:** issue opened, edited or commented → `apply-command` → append
  event → commit → reply and close.
- **Outputs:** `.github/workflows/command.yml`, `scripts/src/apply-command.ts`.
- **Acceptance:** author resolved by numeric GitHub id from `managers.yaml`
  (allowlist); rejections reply with every reason and write nothing;
  `concurrency: events-<season>` with `cancel-in-progress: false`; minimal
  `permissions`.
- **Depends:** T11.1, T2.4, T4.2, T4.5.

#### T11.3 Trade comment commands + sweep · S
- **Goal:** `/accept`, `/decline`, `/veto`, plus an hourly sweep that completes
  or expires trades.
- **Acceptance:** only the counterparty can accept; only the commissioner can
  veto; the sweep emits `trade.completed` or `trade.cancelled` per D-41.
- **Depends:** T11.2.

#### T11.4 Scheduled workflows · M
- **Goal:** cron workflows for lock, run, waivers, and the trade sweep, using
  `config.schedules`.
- **Acceptance:** same concurrency group as T11.2; `workflow_dispatch` for
  manual reruns; a failed run leaves the log unchanged.
- **Depends:** T10.1, T11.2. The reveal step waits on T10.2.

#### T11.5 Event-log protection · S
- **Goal:** CI fails any PR that touches `seasons/*/events/`; a pushed log must
  be an append of the previous one; CODEOWNERS; branch-protection notes in README.
- **Acceptance:** tests with a doctored log (edit, delete, reorder) all fail.
- **Depends:** T2.5.

#### T11.6 Content CI · S
- **Goal:** CI runs `validate` on PRs touching content, and `lock-check` before season start.
- **Acceptance:** a broken pool or chrome PR fails with a readable report.
- **Depends:** T5.3, T8.4.

#### T11.7 Generate form dropdowns · S (optional)
- **Goal:** regenerate issue-form options (seasons, weeks, maybe characters)
  from season files.
- **Acceptance:** idempotent; CI checks the forms are up to date.
- **Depends:** T3.4.

---

## Blocked on OPEN decisions

Each task here can be specified but not finished until its decision in
[docs/decisions.md](docs/decisions.md) is made.

| Task | Blocked on | What's blocked |
|---|---|---|
| **T10.2 Live roll + week start** · S | D-13 details | Missions are open (D-08), so there is no sealing. What's left: how `run-week` draws and records a real random roll, and whether `mission.revealed` stays. `seal` and `reveal` scripts can be deleted. |
| **T10.3 Offseason carryover** · M | D-11 carryover | `offseason`: keeper eligibility, `character.retained`, keeper cost in draft order (T4.3 hook), modifier drift cap. |
| **T4.7 Playoffs** · S | D-04 | Bracket generation and playoff standings. |
| **T6.1 captain effect** · S | D-12 | The captain's mechanical role. Ship behind a config switch. |
| **T5.4 / T8.5 live provider** · S | D-32 | The real `LlmClient`. Everything else in those tasks uses the fake. |
| **T8.7 Portraits and images** · M | D-10 | Storage, the `portrait.path` convention, and any image generation script. |
| **T11.2 GM-as-manager rule** · S | D-09 | Whether the allowlist lets the GM hold a tavern. |
| **T1.1 document scope** · S | D-17 | Adding non-SRD documents (license text and notices). SRD-only is unblocked. |
| **Registry costs** · S | D-31 | Final modifier costs. The mechanism (T3.2) is unblocked. |
| **Live bot seats** · S | D-36 | Letting bot managers act in a real season via Actions. |
| **License file** · S | D-33 | LICENSE for code and possibly content. |
