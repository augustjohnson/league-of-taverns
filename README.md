# League of Taverns

A fantasy-sports league where the players are 5th-edition monsters.

Each manager runs a **tavern** and drafts **characters** (named monsters, like
Bruno the Bruiser, an ogre) from a curated pool of about 64. Each week the
tavern fields a **party** of one captain and three allies under a CR budget.
The party attempts that week's hidden **mission**: a branching run of skill
checks and battles, resolved once with seeded dice. Every tavern runs the same
mission, and the season table ranks taverns by total loot.

> **Status: scaffold.** Types, stubs, draft rules and schemas only. No game
> logic yet. Start with [TODO.md](TODO.md).

## Docs

| Doc | What |
|---|---|
| [docs/rules.md](docs/rules.md) | Draft rulebook: roster, budget, lineups, scoring, standings, waivers, trades, reveals, carryover |
| [docs/schema.md](docs/schema.md) | Draft schemas: character, modifiers, mission, chrome, season config, events, reducers |
| [docs/season-lifecycle.md](docs/season-lifecycle.md) | Offseason → missions → curation → chrome → lock → draft → weekly runs → offseason |
| [docs/decisions.md](docs/decisions.md) | Open decisions, plus every difference from the earlier specs |
| [docs/lore.md](docs/lore.md) | Story frame: barkeeps, sponsoring gods, loot, and where story touches the rules |
| [docs/glossary.md](docs/glossary.md) | Terms |
| [docs/specs/](docs/specs/) | Earlier specs 00–06. Superseded where decisions.md says so |
| [TODO.md](TODO.md) | Workstreams and tasks, one subagent per workstream |

## Three layers per character

| Layer | What | Affects game? | Lifetime |
|---|---|---|---|
| **Base** | Raw Open5e stat block, untouched | Yes | Pinned snapshot per season |
| **Modifiers** | GM-authored deltas from a closed vocabulary, within a per-season budget | Yes | Per season |
| **Chrome** | Name, epithet, backstory, portrait | **Never** | Persists across seasons |

## Boundary rules

These are load-bearing. Lint and `engine/test/boundaries.test.ts` enforce the
first two.

1. **The engine does no I/O and never reads chrome.** `engine/` is pure
   functions that run in Node and the browser. There is no `fs`, `process`,
   `fetch`, `Date` or `Math.random` there, and its character type has no name
   field.
2. **`explorer/` never imports `engine/`.** It reads only published JSON.
3. **Event logs are written only by Actions.** `seasons/*/events/` is
   append-only. Rosters, standings and stats are rebuilt by replay and never
   stored.
4. **Authored content is human-edited and changed by PR.** That covers
   characters, pools, missions and chrome. LLMs may draft it, but a validator
   and then a human accept it.

## Layout

```
engine/src/          pure game engine (no I/O)
  rng/                 seeded RNG: rngFor(seed, key)
  adapters/open5e/     verbatim Open5e record → BaseStats
  characters/          base + modifiers → effective stats; modifier registry
  roster/              ownership, CR budget, lineups, snake draft, waivers, trades
  league/              season config type, standings (total loot)
  missions/            mission schema + validator (no generator)
  resolution/          check odds, battle p(win), the single seeded run
  projection/          exact expected score by DAG propagation
  events/              event schema, reducers, replay
engine/test/
bots/                draft / lineup / waiver strategies
scripts/             the I/O edge: snapshot, validate, draft-missions, difficulty-report,
                     draft-chrome, lock-check, seal, reveal, apply-command, run-week,
                     offseason, publish
sims/                mock-season runner + balance report (output git-ignored)
  src/playground/      browser playground: one HTML page running the real engine and
                       bots. Unlike explorer/, it may import the engine.
data/open5e/         raw pinned snapshots + manifest
characters/<id>/     character.yaml (id, base, chrome, status) + backstory.md
seasons/season-01/   config, managers, schedule, pool, missions, chrome, events
content/prompts/     LLM prompt templates (missions, chrome)
explorer/            placeholder, out of scope
docs/
.github/             issue forms, workflows
```

## Development

Requires Node 22.12+ (24 LTS recommended, see `.node-version`) and pnpm.

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` runs lint, typecheck and tests. Most tests are `it.todo` until
their workstream lands.

## Licensing and attribution

**Code:** license not yet chosen (docs/decisions.md D-33).

**Monster data** comes from the [Open5e](https://open5e.com) API, stored
verbatim in `data/open5e/`. Open5e aggregates documents under their own
licenses, and each snapshot's `manifest.json` records every included document
with its license URL. The default pool uses only System Reference Document 5.1
content (docs/decisions.md D-17). That license requires this attribution:

> This work includes material taken from the System Reference Document 5.1
> ("SRD 5.1") by Wizards of the Coast LLC and available at
> https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is
> licensed under the Creative Commons Attribution 4.0 International License
> available at https://creativecommons.org/licenses/by/4.0/legalcode.

Snapshot `open5e-v1-2026-10` contains only Open5e's `wotc-srd` document (SRD
5.1, 322 monsters). Open5e's metadata titles it "5e Core Rules" and lists its
license as the Open Game License (`document__license_url`
`http://open5e.com/legal`). SRD 5.1 is published under both OGL 1.0a and
CC-BY-4.0. This project relies on the CC-BY-4.0 release and the attribution
above. The manifest keeps Open5e's license URL verbatim, so it reflects Open5e's
metadata, not the license this project uses.

Any document added under the Open Game License 1.0a must ship that license's
text and Section 15 notices. The snapshot script (T1.1) is responsible for
recording them.

This project is unofficial and not affiliated with or endorsed by any game
publisher. It uses no publisher trademarks or branding. Names in the
attribution above appear only because the license requires them.
