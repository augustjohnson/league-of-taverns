# Schemas (draft)

Draft schemas for every authored file and every event. The TypeScript types
in `engine/src/` and `scripts/src/lib/` are the source of truth. This doc
explains them. Runtime validation (zod, [D-22](decisions.md)) is built from
the same types in T2.3, T3.1, T5.1 and T8.1.

## Conventions

- **Ids** are kebab-case and stable forever: `bruno-the-bruiser`,
  `the-gilded-flagon`, `example-drowned-toll`, `thick-skull`.
- **Keys** in YAML and JSON are camelCase: `partyCr`, `schemaVersion`.
- **Vocabulary values** are snake_case: `skill_bonus`, `animal_handling`,
  `carry_over`.
- **CR** is written as Open5e writes it in authored files (`2`, `"1/2"`) and is
  held as an integer count of eighths inside the engine (`CrEighths`: 1/8 → 1,
  1/2 → 4, 12 → 96) [D-16].
- **Authored** content is YAML, edited by humans through PRs. **Generated**
  data is JSON (snapshots, published output) or NDJSON (event logs).
- Each top-level authored file has a `schemaVersion` or is versioned by the
  season or registry that references it.

## Seeds

Defined in `engine/src/rng`. Keys use `rngFor(seed, key)`, which seeds sfc32 with
cyrb128 of `seed + '::' + key`.

| Seed | Format | Substream keys |
|---|---|---|
| Week run | `<season>/week-<n>/tavern:<tavern-id>` + `/salt:<salt>` if salted. Per D-13, live weeks will use a single real random roll instead, and this seed serves sims, tests and reports | `roll:<node-id>`, one per node regardless of path |
| Draft order | `<season>/draft-order` | `order` |
| Sim | `sim:<sim-seed>/<run-index>` | `bot:<tavern>:<decision>`, `salt:week-<n>` |

The dice for a node depend only on (season, week, tavern, node), never on the
path taken or on how many nodes came before. Two lineups from the same tavern in
the same week roll the same d20 at the same node.

---

## Character

`characters/<character-id>/character.yaml`. One per character, kept across
seasons.

```yaml
id: bruno-the-bruiser        # required, kebab-case, must match the folder name, never reused
base: ogre                   # required, Open5e slug; must exist in each season's pinned snapshot
status: active               # active | retired
debut: season-01
chrome:                      # everything below is cosmetic and never reaches the engine
  name: Bruno                # required
  epithet: the Bruiser       # optional
  pronouns: { subject: he, object: him, possessive: his }   # optional; story rendering
  tagline: string            # optional
  backstory: backstory.md    # optional, path relative to this folder
  portrait:                  # optional; docs/images.md
    status: none             # none | prompt | draft | final
    prompt: string           # the subject only; content/images/style.yaml adds the style
    path: portrait.png       # set by draft-images accept; required at draft and final
    seed: integer            # ComfyUI seed of the accepted image
  history: [string]          # optional cosmetic notes
```

**What the engine receives:** `CharacterRef { id, base }`, nothing more.
`scripts/src/lib/repo.ts` has separate `loadCharacterRef` and
`loadCharacterChrome` functions, and only publish and the chrome scripts call
the latter.

**Changing base** between seasons is allowed but rare. It is a GM decision
recorded in the PR, and the career history follows the id.

## Pool and modifiers

`seasons/<season>/pool.yaml`

```yaml
season: season-01
registry: 1                  # modifier registry version
characters:
  - id: bruno-the-bruiser    # must exist in characters/
    modifiers:               # list of Modifier, total cost ≤ budget.modifierPointsPerCharacter
      - { kind: skill_bonus, skill: intimidation, value: 2 }
      - { kind: trait, trait: thick-skull }
```

### Modifier registry (closed vocabulary)

Defined in `engine/src/characters/registry.ts`, version `1`. A modifier is
either a **primitive** or a **trait** (a named bundle of primitives).

| Kind | Fields | Effect | Cost (v1 placeholder) |
|---|---|---|---|
| `skill_bonus` | `skill`, `value` 1–3 | +value to that skill | 1 per point |
| `save_bonus` | `ability`, `value` 1–2 | +value to that save | 1 per point |
| `advantage` | `on: { type: skill\|save\|ability, … }` | roll that check with advantage: p → 1 − (1 − p)² | 2 |
| `grant_speed` | `speed`, `feet` | gains or raises a speed (meets `requires: { speed }`) | 3 |
| `grant_sense` | `sense`, `feet` | gains a sense (meets `requires: { sense }`) | 1 |
| `battle_bonus` | `value` 1 | flat input to the battle model | 2 per point |
| `trait` | `trait: <id>` | the trait's primitive effects | per trait |

v1 traits: `amphibious` (swim 30, cost 2), `keen-nose` (advantage on
Perception, cost 2), `thick-skull` (+1 Con save, cost 1).

**Rules:**
- No free-form mechanics. Anything that isn't a registry kind is a schema
  error.
- Per-character budget: total cost ≤ `budget.modifierPointsPerCharacter`.
- Modifiers stack additively. The same primitive twice is summed and must stay
  within its `max`.
- Advantage doesn't stack.
- Modifiers never change CR.
- Registry changes bump `REGISTRY_VERSION`, and a season pins the version it
  uses.

### Effective stats

`effectiveStats(pooled, base, traits)` folds modifiers onto `BaseStats` from
the adapter. Unproficient skills and saves fall back to the ability modifier.
See `EffectiveStats` in `engine/src/characters/types.ts`.

---

## Mission

`seasons/<season>/missions/{candidates,selected}/<mission-id>.yaml`. Structure
only. Types: `engine/src/missions/types.ts`. Example:
`seasons/season-01/missions/candidates/example-drowned-toll.yaml`.

```yaml
schemaVersion: 1
id: example-drowned-toll
season: season-01
environment: swamp           # must match the schedule entry it is selected for
nodes:
  - { id: start, rank: 0, kind: start }
  - id: find-path
    rank: 1
    kind: check
    check:
      type: skill            # skill | save | ability
      skill: survival        # for type: skill
      # ability: con         # for type: save | ability
      dc: 12
      # requires: { speed: fly } | { sense: darkvision }   # OPEN D-39
    loot: 20                 # banked on a pass (D-45); whole number ≥ 0
  - id: bog-ambush
    rank: 2
    kind: battle
    encounter:
      creatures:             # Open5e slugs in the pinned snapshot; the first is the "lead" ({battle_creature})
        - { ref: crocodile, count: 3 }
  - { id: crossed-dry, rank: 5, kind: end }
edges:
  - { from: start, to: find-path, on: always }   # always | pass | fail | win
```

**Validator rules (T5.2)**, all reported together:

| Code | Rule |
|---|---|
| `start` | exactly one `start` node, at rank 0 |
| `end` | at least one `end` node, and end nodes have no outgoing edges |
| `ids` | node ids unique, edge endpoints exist |
| `rank` | every edge has `rank(to) > rank(from)` (layered DAG, so it always terminates) |
| `reachable` | every node is reachable from start |
| `edges.check` | a check has exactly `pass` + `fail`, or exactly one `always` |
| `edges.battle` | a battle has exactly one `win`. `lose` edges don't exist: losing is a DNF |
| `edges.start` | start has exactly one `always` |
| `scored` | every start→end path attempts ≥ 1 check |
| `haul` | the most loot any start→end path can bank equals `missions.haul` (D-45). A check's loot counts when the path leaves it by `pass` or `always` |
| `dc` | `dcBand.min ≤ dc ≤ dcBand.max` |
| `encounter.ref` | every creature ref exists in the pinned snapshot |
| `encounter.budget` | Σ count × CR ≤ `encounterCrRatio × B` per battle |
| `size` | node count ≤ `maxNodes`, max rank ≤ `maxRank`, battles on any path within `battlesPerPath` |
| `environment` | when selected, matches the schedule entry |

**Commitments:** none. Missions are open (D-08). The `commitment` and `sha256`
fields on `season.created` and `mission.revealed` stay in the event schema,
nullable or unused, until D-13's details settle.

## Mission chrome

`seasons/<season>/chrome/<mission-id>.yaml`. Story only. Types:
`scripts/src/lib/chrome.ts`. Example:
`seasons/season-01/chrome/example-drowned-toll.yaml`.

```yaml
mission: example-drowned-toll   # must name an existing mission
status: draft                   # draft | reviewed | locked
reviewedBy: login               # set when moved to reviewed
lockedAt: ISO-8601              # set when moved to locked
title: string                   # must equal the schedule entry's title once selected
intro: string
beats:
  <check-node-id>:  { enter?: string, pass: string, fail: string }
  <battle-node-id>: { enter?: string, win: string, lose: string }
  <start-or-end-id>: { enter?: string }      # optional
outros:
  <end-node-id>: string
throughlines: [throughline-id]  # optional, ids from chrome/throughlines.yaml
imagePrompts: { cover: string } # optional; the place only. draft-images → <mission>.cover.png (docs/images.md)
```

**Coverage (T8.2):** every check node needs `pass` and `fail`, every battle
needs `win` and `lose`, and every end node needs an outro. A battle's `lose`
beat is its DNF ending, so no separate DNF outro is needed. Beats for unknown
node ids are errors.

**Tokens:** `{actor}` (check beats only), `{battle_creature}` (battle beats
only), `{captain}`, `{allies}`, `{tavern}` (anywhere). Any other `{…}` is an
error. Tokens bind to data at render time and never to new rolls.

**Mechanical-fact lint (T8.3):** no digits, no `DC`, `roll`, `d20`,
`modifier`, no margin words (`barely`, `easily`, `natural`), and no claims
that contradict the variant they sit in.

**Lock (T8.4):** season start requires every selected mission's chrome to be
`locked` with full coverage. `draft-chrome` never overwrites a `reviewed` or
`locked` file.

### Through-lines

`seasons/<season>/chrome/throughlines.yaml`: `{ season, status, throughlines: [{ id, summary, missions: [mission-id] }] }`.

---

## Season config

`seasons/<season>/config.yaml`. Type: `SeasonConfig` in `engine/src/league`.
The annotated example in the file is the reference. Key groups:

| Group | Fields |
|---|---|
| identity | `id`, `name`, `snapshot`, `modifierRegistryVersion`, `weeks` |
| files | `schedule`, `pool`, `managers` |
| `budget` | `partyCr` (B), `modifierPointsPerCharacter` |
| `roster` | `size`, `starters` (4), `ownership` |
| `draft` | `format`, `rounds`, `order`, `pickWindowHours`, `onTimeout` |
| `scoring` | `pointsScale`, `homeBonus` (D-47; 1 = off) |
| `waivers` | `priority`, `initialOrder` |
| `trades` | `vetoWindowHours`, `vetoBy`, `deadlineWeek` |
| `missedLineup` | `carry_over` |
| `schedules` | cron for `lineupLock`, `weeklyRun`, `waivers` |
| `secrecy`, `seedSalt` | D-08, D-13 |
| `missions` | `dcBand`, `maxNodes`, `maxRank`, `battlesPerPath`, `encounterCrRatio`, `haul` (D-45), `battleModel` |
| `carryover` | `mode`, `keepersPerTavern`, `keeperCost`, `championBonusKeepers`, `maxModifierChangePoints` |

The config is copied into `season.created`. From then on the **event's copy**
governs, and CI flags later edits to the file.

`managers.yaml`: `commissioner`, `gm`, and `taverns: [{ id, name, manager: { login, githubId } | { bot } }]`.

`schedule.yaml`: `season`, `sponsors: [{ id, tavern }]`, `weeks: [{ week, title, environment, theme, commitment, sponsor }]`.
`sponsor` is a sponsor id or null. Each sponsor backs one tavern (in
`managers.yaml`) and sets at most one week (D-48). On that week the tavern's
points are × `scoring.homeBonus` (D-47). A god's name and voice are chrome.

---

## Events

`seasons/<season>/events/events.ndjson`, one JSON object per line. Types:
`engine/src/events/types.ts`.

### Envelope

```json
{ "v": 1, "seq": 17, "type": "draft.pick", "season": "season-01",
  "at": "2026-11-02T18:04:11Z",
  "actor": { "kind": "manager", "githubId": 1234, "login": "someone" },
  "source": { "issue": 42 },
  "prev": "9f2c…",
  "payload": { … } }
```

- `seq`: 1-based and contiguous.
- `prev`: sha256 of the previous line's exact bytes, or `null` for seq 1. This
  makes a tamper-evident chain [D-34].
- `actor.kind`: `manager` | `commissioner` | `system` (a scheduled Action) |
  `bot` (sims, or bot seats per D-36).
- `at` is informational. Reducers order by `seq` and never read a clock.

### Event types

| Type | Actor | Payload | Preconditions (reducer rejects otherwise) |
|---|---|---|---|
| `season.created` | commissioner | `config`, `configSha256`, `engineVersion`, `schedule[{week,title,environment,theme,commitment,sponsor}]`, `sponsors[{id,tavern}]` | first event, and only once; sponsors pass `validateSponsors` |
| `character.pooled` | commissioner | `character`, `base`, `cr`, `modifiers` | phase `preseason`, id not already pooled, modifiers within budget |
| `tavern.joined` | commissioner | `tavern`, `name`, `manager` | phase `preseason`, tavern id unique, manager not already in a tavern |
| `character.retained` | commissioner | `tavern`, `character`, `fromSeason`, `basis`, `costRound` | before the first pick, character pooled and unowned, tavern within its keeper limit |
| `draft.pick` | manager / system (autopick) | `pick`, `tavern`, `character`, `auto` | `pick` = number of prior picks, `tavern` is on the clock, character pooled and unowned, roster not full. The first pick freezes the tavern list and order |
| `lineup.set` | manager | `tavern`, `week`, `lineup{captain, allies[3]}` | draft complete, week not locked, lineup legal (§ Roster) |
| `lineup.locked` | system | `week`, `lineups[{tavern, lineup, source}]` | week not already locked, previous week finalized, one entry per tavern, each lineup legal |
| `waiver.claimed` | manager | `claim`, `tavern`, `add`, `drop` | draft complete, `add` is a free agent now, `drop` is on the roster |
| `waiver.resolved` | system | `week`, `outcomes[{claim, awarded, reason}]`, `priorityAfter` | week finalized, outcomes cover every pending claim and match `resolveWaivers` |
| `trade.proposed` | manager | `trade`, `from`, `to`, `give[]`, `receive[]` | both taverns own the listed characters, before the deadline |
| `trade.accepted` | manager (the `to` tavern) | `trade` | trade is `proposed` |
| `trade.vetoed` | commissioner | `trade`, `reason` | trade is `accepted` and within the veto window |
| `trade.completed` | system | `trade` | trade is `accepted`, veto window passed, still legal [D-41] |
| `trade.cancelled` | manager / system | `trade`, `reason` | trade is `proposed` or `accepted` [D-41] |
| `mission.revealed` | system | `week`, `mission`, `sha256`, `salt` | week locked, `sha256` = schedule commitment, mission validates |
| `mission.resolved` | system | `week`, `tavern`, `mission`, `seed`, `engineVersion`, `battleModel`, `lineup`, `run`, `projected`, `points`, `projectedPoints` | mission revealed, lineup = the locked lineup, one per (week, tavern) |
| `week.finalized` | system | `week` | every tavern has `mission.resolved` for the week, and the week isn't already finalized |

`mission.resolved.run` holds the full `RunResult`: `path`, and for each node
`{node, kind, actor, d20, modifier, dc, advantage, outcome}` (checks) or
`{node, kind, pWin, roll, outcome}` (battles), plus `dnf`, `checksPassed`,
`checksAttempted`, `loot` (banked by passed checks, kept on a DNF) and `score`
(loot ÷ the mission's haul, D-45, D-46).

### What's recorded vs derived [D-20]

`mission.resolved` **records** the run as a historical fact, including rolls
and projection, along with the engine version that produced it. Reducers
read the recorded values. They don't recompute them, so a later engine change
can never rewrite history. `verifyResolutions` recomputes each run with the
recorded inputs to prove the record honest.

Standings, records, rosters, career stats and waiver order are **derived** and
never written down.

---

## Reducers

`engine/src/events/reducers.ts`, `applyEvent(state, event) → state`, pure.
State shape: `LeagueState` in `engine/src/events/state.ts`.

**Phases:** `empty` → (`season.created`) → `preseason` → (first `draft.pick`)
→ `drafting` → (last pick) → `regular` → (`week.finalized` for the last week)
→ `complete`.

**Fold rules:**

| Event | State change |
|---|---|
| `season.created` | set `config`, `schedule`, `sponsors` and phase `preseason` |
| `character.pooled` | add to `pool` |
| `tavern.joined` | add to `taverns` with an empty roster |
| `character.retained` | `owner[character] = tavern`, append to the roster, record the forfeited round |
| `draft.pick` | on the first pick, freeze `draft.order` (from config + joined taverns). Set `owner`, append to the roster, `draft.picks++`. After the last pick, set `complete` and phase `regular`, and seed waiver priority from reverse draft order |
| `lineup.set` | `pendingLineups[week][tavern] = lineup` (replaces earlier) |
| `lineup.locked` | `lockedLineups[week] = lineups`, clear `pendingLineups[week]` |
| `waiver.claimed` | append to `waivers.pending` |
| `waiver.resolved` | apply awarded adds and drops to `owner` and rosters, clear pending, set `waivers.priority = priorityAfter` |
| `trade.proposed` | `trades[id] = { terms, status: proposed }` |
| `trade.accepted` / `vetoed` / `cancelled` | update status |
| `trade.completed` | swap ownership and rosters, status `completed` |
| `mission.revealed` | `revealed[week] = mission` |
| `mission.resolved` | `results[week][tavern] = payload` |
| `week.finalized` | add to `finalizedWeeks`. On the last week, phase `complete` |

**Derived views** (selectors over state, never stored): `standings` from
`results`, total loot per tavern (`engine/src/league`), `freeAgents` = pool −
owned, `onTheClock` from the draft order and pick count, career stats across
season logs.

**Validation path:** Actions build a candidate event and call `applyEvent` on
the replayed state. A throw becomes the rejection reply on the issue, and
nothing is written. Replaying a committed log that throws is corruption and
fails CI.

## Published JSON (sketch)

`scripts/src/publish.ts` → `dist/published/<season>/`: `standings.json`,
`weeks/<n>.json` (per-tavern actual, projected, path, rolls, story),
`rosters.json`, `characters/<id>.json` (career). This is a deployed build
artifact and is never committed [D-19]. `explorer/` reads only this.
