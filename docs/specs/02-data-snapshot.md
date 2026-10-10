# Data Snapshot

## Principle

The browser never touches the Open5e API. Rate limits, offline breakage, and
non-determinism are all unacceptable for a permalink-able static app. Fetch once
at **build time** into static JSON pinned to a `dataVersion`; the runtime only
ever reads the frozen snapshot.

## Extraction is lean (YAGNI)

Extract only the fields the evaluator, generators, or leaderboard touch. Not the
whole Open5e record.

```
Statblock = {
  id:            string   // Open5e slug — the identity anchor for a creature
  typeName:      string   // "Hobgoblin Captain" — rendered after the personal name
  cr:            number   // budget + denominator basis
  size:          string
  type:          string   // "humanoid", "beast", ...
  subtype:       string?  // "hobgoblin" — assembly filters key on this
  ac:            number
  hp:            number
  abilities:     { str,dex,con,int,wis,cha }   // → skill/save modifiers
  skills:        { [skill]: modifier }          // proficiencies already applied
  saves:         { [ability]: modifier }
  speeds:        { walk, fly?, swim?, burrow?, climb? }
  senses:        { darkvision?: number, ... }   // gates some checks
  damage:        { resist: [type], immune: [type], vulnerable: [type] }  // battle EV
  culture:       string   // DERIVED — name-flavor bucket, see below
}
```

- `skills` modifiers already fold in proficiency; the resolver reads them
  directly (best-fit takes the max across the team).
- `damage` feeds the black-box battle EV only; if it complicates the first cut,
  stub it and treat all damage as untyped — the model degrades gracefully.

## `culture` is derived, not from Open5e

Open5e has no "culture" field. Derive it at build time from `type`/`subtype` via
a small mapping (`hobgoblin|goblin|orc → goblinoid`, `elf|fey → fey`, etc.) so
the name generator (`04`) has a phonotactic bucket. This is a build-time
transform, versioned with the snapshot. Unmapped creatures fall back to a
`neutral` bucket.

> Do **not** confuse `culture` (name flavor) with environment affinity (OD-1).
> Different concern, different — possibly absent — data.

## Ally pool

The recruitable pool is a snapshot-derived list: all creatures with
`cr ≤ ALLY_CR_CEILING`. Assembly (`04`) filters and ranks within it. The
under-3-matches fallback is **OD-2** (recommendation: progressively relax the
filter). Pool membership is fixed within a `dataVersion`.

## Versioning (OD-7)

- `dataVersion` is an integer baked into the snapshot filename
  (`snapshot-v1.json`) and into every permalink (`?v=1&...`).
- Identity is content-addressed on `creature.id`, so **the data version is part
  of identity** whether named or not — the same slug can carry a different CR
  across snapshots.
- Re-snapshot policy: keep old snapshots retained and version-pinned. An old
  permalink renders against its snapshot-of-record. If that snapshot is gone or
  the slug vanished upstream, **degrade honestly** ("creature unavailable at
  v1") rather than silently substituting.

## Build step

A Node script (runs the same environment as the runtime, since everything is
pure JS):

1. Page through the Open5e monsters endpoint (a few MB total).
2. Transform each record to the lean schema above; derive `culture`.
3. Write `snapshot-v{N}.json` + a manifest (`{ dataVersion, generatedAt, count }`).
4. Commit to the repo. Jekyll serves it as a static asset.

This is the one place network access happens, and it happens offline at build
time. Everything downstream is a pure function of the committed snapshot.
