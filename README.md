# League of Taverns

A fantasy league where you keep a tavern, draft monsters and watch them
compete. The site can host more than one game; the first, and for now the
only one, is **The Lich's Assistant**: a dozen monsters compete to become the
Lich's new assistant, Survivor style, and people at the bar draft them and
watch. The game is built for phones first.

Every episode the Lich sets a task (a **challenge**: a series of skill checks
run as elimination rounds). The winner is immune, and the rest **vote** one of
their own out, each following the **voting strategy** printed on its card.
When three are left, the voted-out monsters, now the **jury**, choose the
winner. Managers run **taverns**: they snake-draft three monsters each, then
only watch, except to **call the boot** at each vote. Taverns score for
their monsters' results plus their calls, and the most points after the finale
wins the season.

The story is in [docs/lore.md](docs/lore.md), the design in
[docs/survivor-format.md](docs/survivor-format.md), and what is built, with
every playtest default, in [docs/lich-contest-plan.md](docs/lich-contest-plan.md).

> **Status: playtest.** The contest, the fantasy layer, the bots, the sims
> and the browser playground are built. The rules are playtest defaults, not
> decisions yet; [rules.md](docs/rules.md) and the other older docs still
> describe the earlier mission format until they are rewritten.

## Play it

```bash
pnpm install
pnpm --filter @league-of-taverns/sims playground
```

Then open `sims/output/playground/index.html`. On your first visit you give
your name and your tavern; then The Lich's Assistant plays one season against
three bot taverns, told in the Common Room. The header's menu has the
Workshop, the tools.

```bash
pnpm sim -- --runs 100
```

plays 100 all-bot seasons and prints the balance numbers.

## Docs

| Doc | What |
|---|---|
| [docs/lich-contest-plan.md](docs/lich-contest-plan.md) | The implementation plan and the playtest defaults, with the sims behind them |
| [docs/survivor-format.md](docs/survivor-format.md) | Design for the Lich's contest: the format, what changes, what stays, open decisions |
| [docs/lore.md](docs/lore.md) | Story frame: the Lich's contest for a new assistant, and the taverns that front for him |
| [docs/images.md](docs/images.md) | Painted portraits: style, stage placement by height, `draft-images`, local ComfyUI setup |
| [docs/rules.md](docs/rules.md), [docs/schema.md](docs/schema.md), [docs/season-lifecycle.md](docs/season-lifecycle.md), [docs/decisions.md](docs/decisions.md), [docs/glossary.md](docs/glossary.md) | The earlier mission format. To be rewritten once the playtest settles the rules |
| [docs/specs/](docs/specs/) | Earlier specs 00–06 |
| [TODO.md](TODO.md) | Workstreams and tasks |

## Three layers per character

| Layer | What | Affects game? | Lifetime |
|---|---|---|---|
| **Base** | Raw Open5e stat block, untouched | Yes | Pinned snapshot per season |
| **Modifiers and strategy** | GM-authored deltas from a closed vocabulary, within a per-season budget, and the monster's voting strategy | Yes | Per season |
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
   characters, pools, challenges and chrome. LLMs may draft it, but a validator
   and then a human accept it.

## Layout

```
engine/src/          pure game engine (no I/O)
  rng/                 seeded RNG: rngFor(seed, key), contestSeed
  adapters/open5e/     verbatim Open5e record → BaseStats
  characters/          base + modifiers → effective stats; modifier registry
  checks.ts            check odds and modifiers
  contest/             the Lich's contest: cards, challenges, the vote model, the jury, odds
  roster/              the snake draft
  league/              season config, standings
  events/              event schema, reducers, selectors (scores, standings), replay, the seed audit
engine/test/
bots/                draft and calling strategies
scripts/             the I/O edge: snapshot, validate, draft-images, package-characters
sims/                season sims + the browser playground (output git-ignored)
  fixtures/lich-season/  the season sims and the playground play: pool, taverns, 9 challenges
  src/playground/      the game and the workshop: one HTML page running the real engine and bots
data/open5e/         raw pinned snapshots + manifest
characters/<id>/     character.yaml (id, base, chrome, status) + backstory.md + portrait.png
seasons/season-01/   the first live season, in preparation
content/             LLM prompt templates; the fixed image style
explorer/            placeholder, out of scope
docs/
.github/             workflows
```

## Development

Requires Node 22.12+ (24 LTS recommended, see `.node-version`) and pnpm.

```bash
pnpm install
```

```bash
pnpm check
```

`pnpm check` runs lint, typecheck and tests.

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
