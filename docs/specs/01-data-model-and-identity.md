# Data Model & Identity

## The character is a value type

A character **is** its genotype. Identity is the content of the genotype, not the
event of minting it. Roll the same tuple twice and it is literally the same
person — same name, same everything. This is content-addressing.

```
Genotype = {
  creature:       StatblockRef      // CR-budgeted pick from the snapshot
  assemblyRule:   StrategyPresetId  // ACTIVE — drives recruitment
  replacementRule: StrategyPresetId // STORED, INERT in v1 (GA-phase)
}
```

- **creature** references a statblock in the pinned snapshot (see
  `02-data-snapshot.md`). It is a reference, so identity is only stable within a
  `dataVersion` — the data version is part of identity whether or not we name it
  (see OD-7).
- **assemblyRule** is the only field the MC evaluator exercises beyond the
  creature itself.
- **replacementRule** rides along for free. It is captured at mint, shown on the
  character sheet, and ignored by the evaluator. The GA phase reads it instead of
  retrofitting it.

### Identity hash

```
identity(g) = hash(g.creature.id + '|' + g.assemblyRule + '|' + g.replacementRule)
```

Everything derived from a character (its name, its recruitment rolls) is seeded
from this hash, so it is stable across sessions and machines.

## Why strategies are discrete presets

Two Hobgoblin Captains only collapse into "the same Jeg" if their strategies are
drawn from a small named library. Continuous weight vectors would make every mint
a unique individual and break content-addressing.

A strategy preset is a **`(filter, ranking-key)` pair** over the ally pool:

```
StrategyPreset = {
  id:      "smart_hobgoblins"        // hashed into identity, NOT the resolved party
  filter:  ally => ally.type === "humanoid" && ally.subtype === "hobgoblin"
  rankKey: ally => ally.abilityScores.int
}
```

- **"Picks smart hobgoblins"** = filter `subtype == hobgoblin`, rank by Int.
- The **preset id** is what gets hashed, not the concrete party it produces.
- Presets are enumerated in a registry. Adding a preset is additive; it never
  changes the identity of existing characters.

> **GA-phase note (not v1):** content-addressed identity + discrete strategies
> means "mutate Jeg slightly" yields a *different person with a different name*.
> The continuous substrate that makes a GA interesting cannot coexist with strict
> content-addressing. When the GA lands, either relax content-addressing to the
> active genotype only, or accept that mutation re-mints identity. Decide then.

## Name derivation

Names are **derived, never rolled per mint** — otherwise two Jegs get two names.

```
name(g) = generateCreatureName(rngFor(identity(g), 'name'), g.creature.culture)
```

- Seeded from the identity hash, so the same tuple always resolves to "Jeg."
- The statblock already carries a *type* name ("Hobgoblin Captain"). We generate
  the **personal** name and render `{personal}, {typeName}` → "Jeg, Hobgoblin
  Captain." See `04-generators.md`.
- Name collisions are cosmetic and harmless — the name was never the key.

## Dedup on the leaderboard

Because `replacementRule` is inert, two characters can differ *only* in
replacement rule and post statistically identical scores under different names.
Under strict content-addressing they are correctly two different people.

**Decision: dedup on full identity — show both.** Hiding the replacement rule at
mint and then quietly collapsing on it in dedup is the kind of inconsistency that
reads as a bug later. "Jeg and his cousin fight identically but Jeg reshuffles
his crew" is acceptable, arguably charming.

## Party

A party is the phenotype developed from a captain's genotype by drawing allies.

```
Party = {
  captain:  Character
  allies:   [Character, Character, Character]   // developed via assemblyRule
  budget:   B                                    // Σ CR (captain + allies) ≤ B
  teamName: derived from hash(party roster)      // see 04-generators.md
}
```

- The party is minted and immutable.
- Assembly draws from the ally pool under the captain's `assemblyRule`. Pool
  definition and the < 3-match fallback are in `04-generators.md` (OD-2).
