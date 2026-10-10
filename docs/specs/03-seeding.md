# Seeding & Determinism

Everything from seed to resolver is a pure function. This spec is the foundation
the whole build order sits on — write it and test it first.

## PRNG

`Math.random()` isn't seedable, so use the standard no-dependency combo:
`cyrb128` (string → four 32-bit seeds) feeding `sfc32` (seeds → uniform float
stream). ~15 lines, public-domain, ships in the JS bundle. `mulberry32` is an
acceptable single-state alternative.

```js
function cyrb128(str) { /* string -> [h1,h2,h3,h4] */ }
function sfc32(a, b, c, d) { return () => { /* -> float in [0,1) */ }; }

const makeRng = (str) => sfc32(...cyrb128(str));
```

## Namespaced substreams — do this from day one

Never pull every roll from one stream. Derive a substream per concern:

```js
const rngFor = (seed, ns) => makeRng(seed + '::' + ns);
```

Why it matters for permalinks: if all rolls share one stream in draw-order,
inserting a new roll in the middle shifts every downstream value, and every old
permalink silently renders something different. Namespaced substreams insulate
concerns — adding a check-roll can't perturb a battle-roll or a name.

It contains the blast radius; it does **not** solve versioning. Changing a *table*
(env→skill weights) or a snapshot still changes output — that's what
`dataVersion` / `genVersion` are for.

## Seed taxonomy

| Seed | Formula | Drives | Substreams (`ns`) |
|---|---|---|---|
| identity | `hash(creature.id + assemblyRule + replacementRule)` | name | `name` |
| missionSeed | opaque string per mission | structure + flavor | `env`, `checks`, `battles`, `narrative:<nodeId>` |
| partyHash | `hash(roster)` | team name | `teamname` |
| runSeed | `missionSeed + ':' + teamId + ':' + k` | dice for one sampled run | `roll:<nodeId>` |

- Narrative flavor is seeded **per node** (`narrative:<nodeId>`), so re-rendering
  one beat is stable and adding a node can't shift another node's word choices —
  same containment logic as the structured substreams.
- Dice are seeded **per run** — a run is `(mission, team, k)`. Leaderboard
  scores are propagated (no dice), so `runSeed` only exists in the Sandbox and
  the mission inspector.

## Permalinks

```
?v={dataVersion}&g={genVersion}&captain={identity}&mission={missionSeed}[&run={k}]
```

- `v` pins the statblock snapshot (`02`).
- `g` pins the generator tables (mission env/skill weights, name syllable sets,
  grammars). Bump it when a table changes; old links then render against their
  pinned generation or degrade honestly.
- Sandbox is a pure function of these params — no stored state, client-side
  render on a static Jekyll page. That's the shareable artifact.
