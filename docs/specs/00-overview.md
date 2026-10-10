# The Great Monster Adventure Generator — Overview

## What this is

A toy that pairs a genetic-algorithm-adjacent framing with D&D 5e data from
[Open5e](https://open5e.com). A **captain** (one creature) recruits three
**allies** under a shared CR budget to form a **party**; the party is run against
procedurally generated **missions**; performance is scored and aggregated. The
output answers questions like "which cheap captains punch above their CR in
aquatic missions."

**Scope for v1: Monte Carlo only.** No evolution, no reproduction. Generate a
population of characters, evaluate each against a mission distribution, rank
them. A generational GA is a deliberately deferred follow-on (see
`01-data-model-and-identity.md` on why the data model is GA-ready but the harness
is not).

## Non-negotiable constraints

- **No backend state.** Everything is a pure function of a seed. Static hosting
  (Jekyll), client-side or precomputed. If it doesn't need a server, it doesn't
  get one.
- **Deterministic and permalink-able.** Any character / party / mission / run is
  reproducible from its seed(s) plus a data-snapshot version. See `03-seeding.md`.
- **Structure precedes narrative.** Mechanical facts are rolled as data; story is
  a pure projection over that data, never parsed back out of prose.

## Two modes, one pipeline

The mint→resolve pipeline is shared. Two consumers differ only at the output end.

| Stage | Shared | Sandbox | Lab |
|---|---|---|---|
| Mint captain | ✓ | human picks | generated |
| Assemble party | ✓ | | |
| Generate mission | ✓ | one | a batch |
| Resolve | ✓ | | |
| **Output** | | **Story** (one narrated run) | **Leaderboard** (aggregated) |

- **Sandbox** runs the pipeline once and narrates it. This is the fun/shareable
  artifact — a permalink to one party's one adventure, rendered client-side.
- **Lab** runs the pipeline many times headless and aggregates into ranked
  tables. Both evaluation questions ("captain × environment", "party × mission
  type") live here.

## Data flow

```
seed ──▶ [snapshot: statblocks@dataVersion]
              │
   genotype ──┼──▶ name (derived from genotype hash)
   (creature, │
    assembly, ├──▶ party (captain + 3 allies, Σ CR ≤ B)
    replacement)
              │
 missionSeed ─┴──▶ mission DAG (env, checks, battles)
                        │
                        ▼
                 resolver (seeded d20 rolls)
                        │
              ┌─────────┴──────────┐
              ▼                    ▼
      Story (Sandbox)      score → MC harness → Leaderboard (Lab)
```

## Build order

Each stage is a pure function testable in isolation. Everything through the
resolver is deterministic over a seed.

1. **Seedable PRNG + namespaced substreams** — `03-seeding.md`
2. **Statblock snapshot with `dataVersion`** — `02-data-snapshot.md`
3. **Generators** (name, mission DAG) — `04-generators.md`
4. **Deterministic check/battle resolver** — `05-resolution-and-scoring.md`
5. **Monte Carlo harness** — `06-monte-carlo-and-leaderboard.md`
6. **Static leaderboard render** — `06-monte-carlo-and-leaderboard.md`

## Locked decisions

- MC only for v1; GA deferred. Replacement rule is **stored but inert** now.
- A character **is** its genotype (value type, content-addressed). Identity is
  content, not the mint event. Two identical genotypes are the same person.
- Strategies are **discrete named presets** — `(filter, ranking-key)` pairs —
  not continuous weight vectors. (Continuous substrate is a GA-phase concern and
  conflicts with strict content-addressing; see `01`.)
- **One CR budget `B`** covers captain + 3 allies (`Σ CR ≤ B`). `B` is both the
  recruitment cap and the denominator basis for per-CR scoring.
- **Battles gate, checks fill the fraction.** Any battle lost → mission = 0
  (DNF). Otherwise mission score = checks passed / checks attempted along the
  actual traversal.
- **Resolution is seeded-stochastic.** Each check is a d20 roll:
  `p(pass) = clamp((21 − (DC − mod)) / 20, 0, 1)`. Battles are black-box with a
  `p(win)`. Dice are seeded (`rngFor(runSeed, 'roll:'+nodeId)`), so a *run* is
  `(team, mission, runIndex)` and is fully reproducible. So a `(team, mission)`
  pair has a real success *rate*, not a single outcome.
- **Two ways to compute the score, by context.** The mission is a layered DAG of
  independent per-check Bernoulli transitions, so:
  - **Leaderboard → propagate.** Forward-propagate reach-probability through the
    DAG and sum `P(path) × score(path)`. Exact expected score, O(nodes), no dice
    sampling, no dice-CI. Leaderboard variance collapses to the mission draw.
  - **Sandbox & mission inspector → sample.** Seeded d20 runs (`k = 0..N`) for
    the actual rolled distribution and the "ran it 20 times" traversal histogram.
- **Assignment is best-fit** — the team uses its highest modifier for each
  required skill. Deterministic given the roster; it's what makes per-CR
  efficiency meaningful. `{actor}` in the narrative is this best-fit member
  (surfaced by default, reversible). Group-check / Help / a policy gene are
  deferred alongside replacement.
- **Missions are layered DAGs** — shared start/end, branching middle on
  pass/fail — so skill weakness routes into more battles, coupling the two
  failure modes.

## Open decisions register

These are unresolved. Each spec references the relevant ID. Recommendations are
my default if you don't override.

| ID | Decision | Recommendation |
|---|---|---|
| **OD-1** | Creature ↔ environment affinity source (Open5e env data is thin) | Drop affinity; rank on **mission performance only** for v1 |
| **OD-2** | Assembly filter returns < 3 allies — fallback | Progressively **relax the filter**, never mint invalid |
| **OD-3** | Per-traversal denominator double-penalizes failure paths | **Accept it** — failure compounding is a feature |
| **OD-4** | Leaderboard mission set per environment: shared frozen batch vs per-team independent draws | **Shared frozen batch** (fair/paired comparison); batch id is part of results identity. Note: propagation removes *dice* variance, not *mission-draw* variance — this is now only about which missions each team faces |
| **OD-5** | Sandbox/inspector sample count `N` (dice runs, not leaderboard) | Start **~200** runs for a smooth inspector histogram; leaderboard needs none (propagated) |
| **OD-6** | Live in-browser vs precomputed results JSON | **Precompute** to JSON; matches static/no-backend |
| **OD-7** | Re-snapshot / `dataVersion` migration for old permalinks | Version-pin; render against snapshot-of-record; degrade honestly |
