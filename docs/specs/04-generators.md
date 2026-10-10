# Generators — Names & Missions

Two generators, one shared rule: **seeded, and structure precedes narrative.**

---

## Name generation

### Creature (personal) names

Phonotactic syllable assembly keyed by `culture` (`02`). Define onset / nucleus /
coda sets per culture (harsh stops + short vowels for goblinoids; liquids + long
vowels for fey), concatenate 2–3 syllables from `rngFor(identity, 'name')`.

- The statblock already carries the *type* name. We generate the **personal**
  name and render `{personal}, {typeName}` → "Jeg, Hobgoblin Captain".
- Seeded from identity, so the same genotype always resolves to "Jeg". Name
  collisions are cosmetic — the name is never the key.
- Optional epithet slot from a list-pick substream ("Jeg the Sly").
- Upgrade path (not v1): per-culture Markov chains over a name corpus for better
  realism. Phonotactic assembly is the day-one default.

### Team names

A small template grammar expanded from `rngFor(partyHash, 'teamname')`:

- `The {adjective} {noun}` → "The Iron Fangs"
- `{captain}'s {noun}` → "Jeg's Marauders"

Bias the word pools by the party's dominant `type` or (if OD-1 resolves toward
affinity) environment, so the name reflects the roster.

---

## Mission generation

### Two layers, never merged

- **Structured layer** — pure data the resolver and leaderboard read.
- **Narrative layer** — a pure projection over that data.

Never generate prose and parse structure back out. The moment a flavor roll
decides something the evaluator cares about, structure and story are coupled and
permalinks rot.

### Structured layer

A **layered DAG**: every node has a `rank`; edges point only to strictly higher
ranks. This makes termination free — no cycle detection, no infinite remediation.

```json
{
  "seed": "mission:forest:a1b2c3",
  "dataVersion": 1, "genVersion": 1,
  "environment": "forest",
  "nodes": [
    { "id": "start", "rank": 0, "kind": "arrival" },
    { "id": "n1", "rank": 1, "kind": "check",  "skill": "survival", "dc": 13 },
    { "id": "n2", "rank": 2, "kind": "check",  "skill": "stealth",  "dc": 15 },
    { "id": "b1", "rank": 2, "kind": "battle", "cr": 3, "creatureRef": "giant-spider" },
    { "id": "n3", "rank": 3, "kind": "check",  "skill": "nature",   "dc": 12 },
    { "id": "end", "rank": 4, "kind": "resolution" }
  ],
  "edges": [
    { "from": "start", "to": "n1", "on": "always" },
    { "from": "n1", "to": "n2", "on": "pass" },
    { "from": "n1", "to": "b1", "on": "fail" },
    { "from": "n2", "to": "n3", "on": "pass" },
    { "from": "n2", "to": "n3", "on": "fail" },
    { "from": "b1", "to": "n3", "on": "win" },
    { "from": "n3", "to": "end", "on": "always" }
  ]
}
```

Generation order (`rngFor(missionSeed, ...)` substreams):

1. `env` — pick environment from a weighted table.
2. `checks` — environment selects a themed skill sub-table (forest weights
   Survival / Nature / Stealth / Athletics high, Arcana low); draw 2–5 checks
   into a happy-path spine.
3. `battles` — draw 1–3 battles against an environment-appropriate encounter pool
   under a difficulty budget.
4. Hang a fail-edge off each spine check routing to a battle / detour check /
   skip-ahead, all landing on a later rank. A failed check routing into a battle
   is what couples the two failure modes.

`environment` is a first-class field, never buried in prose — it's the facet the
leaderboard indexes on.

### Narrative layer — token classes

The token taxonomy is the design:

```
{data-bound}   reference already-rolled structure — never a new roll
               {party} {captain} {actor} {skill} {dc} {battle_creature}
[flavor]       pure grammar from rngFor(missionSeed, 'narrative:'+nodeId)
               [forest_adj] [thicket] [push_verb] [lurk_verb]
<outcome>      selected at render time from the actual traversal (pass/fail/win/lose)
```

- `{actor}` is the **best-fit member** chosen by the resolver (`05`) — it binds
  late, after resolution. Surfacing it exposes the assignment policy in prose
  (default on, reversible to just "the party").
- `{battle_creature}` reads `creatureRef` from the structured layer and resolves
  the type name from the snapshot. Flavor **never** picks the monster.
- Flavor pools are environment-scoped (single source of truth, tied to the
  structured `environment`).
- Battles are **black-box**: `win` / `lose` beats only, no round-by-round.
- One template set with a `showMechanics` flag: Sandbox story hides DCs; the
  character-sheet / debug view shows `1/2 checks · score 0.50`.

Implementation: Tracery (MIT, tiny) hides its RNG, so either monkeypatch its
random or write the ~30-line recursive slot-filler yourself for full seed
control. The latter fits the YAGNI posture.

---

## Mission inspector (Lab validation tool)

A per-mission weighted DAG: point it at one `missionSeed`, sample the character
population, weight each edge by the share that walked it. This is the
`forest_mission_traversal_weights` visual.

- **Per-mission only.** Each mission is a different DAG, so you can't overlay edge
  counts across the batch. Cross-mission aggregation is class-level only ("38% of
  traversals hit a fail-into-battle diversion") — a summary stat, not a DAG.
- **It's a generator-validation tool, not player-facing.** A branch nobody
  travels means the generator is emitting structure that never matters (a YAGNI
  flag to stop generating it). A thick `fail → battle → DNF` funnel is a silent
  difficulty spike. Say this explicitly so it isn't mistaken for a feature.
- Edge weights here come from **sampling** (real rolled distribution), consistent
  with Sandbox. The leaderboard's aggregate numbers come from **propagation**
  (`05`).
