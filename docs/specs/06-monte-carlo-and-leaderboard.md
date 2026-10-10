# Monte Carlo Harness & Leaderboard

## Team ≡ captain (one population)

Assembly is deterministic `(filter, ranking-key)` top-3 over the fixed ally pool,
so a captain genotype always yields the same three allies (a stable tiebreak on
`id` handles ranking ties). **Party ≡ captain, 1:1.** There is one population of
entities, each fronted by its captain — not two cross-referenced populations. The
"team view" is just an entity zoomed in.

> If you ever want a captain to spawn *many* different parties, that needs a
> `partySeed` on assembly and it breaks content-addressing. Explicitly not v1.

## Harness (leaderboard path — propagated)

```
for each entity (captain + developed allies):
  for each environment:
    for each mission in FROZEN_BATCH[environment]:      # shared across all entities (OD-4)
      s = propagate(entity, mission)                    # exact expected score, 05
    scoreByEnv[environment] = mean(s over the batch)
  overall = mean over all environments (or the batch union)
```

- **Shared frozen batch** so every entity faces the same missions — fair, paired
  comparison. The batch id is part of results identity (OD-4).
- Propagation removes dice variance entirely; the only remaining variance is
  which missions are in the batch, which the shared batch holds constant.

### Two metrics — same samples, two columns

| Column | Formula | Surfaces |
|---|---|---|
| **Efficiency** (default sort) | `mean missionScore / B` | undercosted, cheap over-performers — the broken-monster detector |
| **Power** | `mean missionScore` (un-normalized) | strongest regardless of cost |

Keep both. Efficiency divides a 0–1 fraction by `B`, so it structurally favors
cheap low-CR parties — correct for "who's undercosted", wrong if misread as a
power ranking. Two columns stop the misread.

## Output (OD-6 — precompute)

A Node script runs the identical pure functions offline and emits:

```
results.json = {
  dataVersion, genVersion, batchId,
  entities: [ { id, captain, allies, assemblyRule, replacementRule,
                B, efficiency, power, scoreByEnv } ],
  missions: { [missionSeed]: { environment, classRates } }
}
```

Committed to the repo; Jekyll serves it. The leaderboard app is a table renderer
over static JSON — the MC loop never runs in a visitor's browser. Because
everything from seed to resolver is pure, the *same* modules run under Node
(precompute) or in the browser / a Web Worker (if you later want live re-runs);
write the resolver as a pure `(entity, mission) → score` with no DOM, no I/O, and
OD-6 stays deferrable forever.

## Four views

### 1. General leaderboard
Ranked entities, each fronted by its captain. Default sort = efficiency; power as
a sortable column. Filter by environment. Row click → entity detail.

### 2. Entity (team) detail
One entity zoomed in: success rate **by environment** (not by individual mission —
a single mission now has a rate, but the meaningful pivot is the environment
aggregate), captain, the three members, assembly rule, replacement rule (shown
though inert), and the `B` breakdown (captain CR vs allies CR).

### 3. Environment (mission-type) view
For one environment: success-rate-by-team across the frozen batch, plus
class-level funnel stats (`% fail-into-battle`, `% DNF`). **No single DAG** —
every mission in the environment is a different graph, so there's nothing to
overlay here. Row click on a specific mission → inspector.

### 4. Mission inspector
One `missionSeed`: the weighted-DAG traversal viz (`04`, sampled) + a ranked list
of teams by their score **on that exact mission**. Single-mission scope is what
lets the DAG exist. This is the generator-validation / difficulty-audit tool.

## View → data source, at a glance

| View | Number source | DAG? |
|---|---|---|
| General leaderboard | propagated aggregate | no |
| Entity detail | propagated, grouped by env | no |
| Environment view | propagated rate-by-team + sampled class rates | no |
| Mission inspector | **sampled** (rolled distribution) | **yes** (one topology) |

The split is the recurring rule: aggregates propagate; the inspector and Sandbox
sample.

## Permalinks

Each view is a pure function of URL params over the committed `results.json`:

```
leaderboard:        ?v&g&batch&sort=efficiency|power[&env=forest]
entity detail:      ?v&g&batch&captain={identity}
environment view:   ?v&g&batch&env=forest
mission inspector:  ?v&g&mission={missionSeed}          # samples live client-side
```

No backend, no stored state — consistent with the whole architecture.
