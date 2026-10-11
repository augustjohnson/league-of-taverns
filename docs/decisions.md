# Decisions

Three parts:

1. **Open decisions** (D-xx): unresolved. Each has options, a default (what
   the scaffold assumes), and the tasks it blocks.
2. **Scaffold decisions**: choices made while scaffolding. Overturn freely.
3. **Differences from the earlier specs** (Δ-xx): where this repo departs
   from `docs/specs/00–06`, and what it kept.

Status values: **OPEN** (needs a call), **DEFAULTED** (the default works,
but confirm it), **DECIDED**.

---

## 1. Open decisions

### League format

**D-01 Ownership: OPEN.** Exclusive (one tavern per character) or shared
(several taverns may roster the same character, as in salary-cap fantasy).
*Default:* exclusive. *Note:* with exclusive ownership, a pool of 64 and a
roster of 7, at most 9 taverns fit (63 characters), and waivers only work if
some characters go undrafted. Size the pool to about taverns × 7 + 10.
*Blocks:* nothing (T4.1 implements exclusive).

**D-02 Draft format: DEFAULTED.** Snake vs auction (CR as salary suggests an
auction could work) vs linear. *Default:* snake, seeded order.

**D-03 Roster and bench size: DEFAULTED.** Roster of 7, 4 starters, 3 bench.
With 6 weeks and no injuries, the bench matters only through environment fit
and the budget. Confirm with sims (T9.3: how often is the bench used?).

**D-04 Matchups and playoffs: DECIDED (2026-10-11): a league table.** No
matchups. Standings rank taverns by total loot over the season, and there
are no playoffs. Head to head (round-robin with a W-L record) was the
earlier default and is removed from the engine, config and sims.
- Why: with a home bonus (D-47), H2H made it matter whom you met in their
  home week. A table treats every tavern the same.
- Placement points per week (capping one blowout week) were considered and
  not chosen.

**D-05 Waivers: DEFAULTED.** Rolling priority (winner moves to the back),
initial order reverse draft. Alternatives: a fixed reverse-standings order, or
a FAAB budget in CR units.

**D-06 Trades: DEFAULTED.** Proposal by form, `/accept` by the counterparty,
24 h commissioner veto window, deadline after week 4. *Sub-question:* are
uneven trades allowed? *Default (as implemented in T4.5):* a trade passes if
each roster either keeps its size or ends between 1 and `roster.size`. So
between two full rosters an uneven trade always fails, because the receiver
would overflow. A 2-for-1 is allowed when the receiving roster has an open
slot, which leaves the giver one short until it claims a free agent.

**D-07 Missed lineup: DEFAULTED.** Last week's lineup carries over. See D-27
for the fallback.

**D-12 Captain's mechanical role: OPEN.** The brief requires a captain but
gives it no effect. Options:
(a) cosmetic only, plus first in the best-fit tiebreak (*default*);
(b) the captain's checks get advantage, or +2;
(c) the captain must make every check of one chosen type;
(d) points ×1.5 when the captain is the actor on a passed check;
(e) the captain's CR counts double against B (a star tax).
This changes lineup strategy a lot, so decide before T9 balance work.
*Blocks:* T6.1 final form, T9.3.

**D-14 Points scale and ties: SUPERSEDED by D-45 and D-04 (2026-10-11).**
Score is now loot, not a ratio, and with no matchups there are no weekly
ties to break. `scoring.tiebreakers` is removed: equal season totals share a
rank, and a tie for first gives co-champions. *Still open:* whether to add
a tiebreak at season end only (for example a seeded coin) so there is always
one champion. The original text follows. Score is a fraction with small
denominators (about 3–6 checks), so many taverns land on the same values
(0, 1/3, 1/2, 2/3, 1), and H2H ties will be common. Options:
(a) points = round(100 × score) with tiebreakers projected → checks passed →
seeded coin (*default*);
(b) add a small bonus per check passed on top of the ratio;
(c) score margin-of-success (d20 + mod − DC) as a fractional tiebreak.
Also: a DNF scores 0 under every option, so a DNF vs DNF matchup always goes to
the tiebreakers.

**D-15 Best-fit tiebreak: DEFAULTED.** When two starters have the same best
modifier for a check, the actor is chosen deterministically: the captain first,
then the allies in lineup order. Ties are common because many monsters share
ability modifiers. The rule decides who appears as `{actor}` in the story, and
which advantage applies if only one of the tied starters has it. *Note:* with
advantage in play, prefer the tied starter who has advantage, since that's
strictly better for the party. T6.1 implements this.

**D-26 Draft pick timeout: DEFAULTED.** 24 h, then autopick with the `value`
bot. Alternatives: skip (pick later), or wait indefinitely.

**D-27 Fallback when the carried lineup is illegal: DEFAULTED.** Use the legal
lineup with the highest total CR, ties broken by roster draft order, with the
first-drafted as captain. If none is legal: no lineup, 0 points.

**D-36 Bot seats in a live league: OPEN.** Can a bot manager fill an empty
tavern? *Default:* sims only. Allowing it is cheap: bots already emit the same
commands.

**D-37 Timing of roster changes around the lock: DEFAULTED.** Waivers resolve
after the run. Trades complete at any time but never touch a locked lineup.
A character acquired mid-week first plays next week.

**D-43 Low-spellcaster seasons: DECIDED (2026-10-10).** The battle model
(T6.2) reads only weapon and spell *attacks*, so spellcasting monsters look
almost harmless: a CR-12 archmage alone gives a CR-12 party about 0.98. Until
the adapter models spells, the first season or two keep spellcasters to a
minimum in both the pool and mission encounters. A spellcaster is any creature
with a "Spellcasting" or "Innate Spellcasting" ability: 37 of the 322 SRD
monsters, 21 of them at CR 8 or below. That leaves 210 non-casters from CR 1/8
to 8, plenty for a pool of about 64. *Defaults (confirm):* no spellcasters in
encounters, at most 4 in the pool. Both are per-season config limits. Tasks:
T1.5, T3.7, T5.6.

**D-42 Public missions and pre-lock projections: OPEN (new, 2026-10-10).**
With missions open (D-08), managers can read each week's structure, and anyone
with the engine can compute exact projected points for every lineup before the
lock. Lineup choice becomes an optimization problem, and only the real roll
(D-13) adds variance. Options: (a) embrace it and publish a projection tool;
(b) publish each mission only at its week's lock; (c) publish structure but
hide DCs until the run. *Default:* (a), pending sims (T9.3) on how much skill
vs luck decides weeks.

**D-40 Roster-level CR cap: DEFAULTED.** None. B applies only to starters.
Without a roster cap, drafting all high-CR characters is legal, but you can
only start about 12 CR worth. Sims will show whether high-CR hoarding is a
problem.

### Story and scoring (2026-10-11)

The story behind these is in [lore.md](lore.md). D-45 and D-46 are in the
engine. D-47 and D-48 are not yet.

**D-44 Story frame: DECIDED (2026-10-11).**
- Managers play barkeeps, each pushed around by a different god.
- Each god sponsors one tavern and sets one mission.
- The draft is recruitment night.
- Story-shaped rules are allowed if they treat every tavern the same over a
  season.
- Sponsorship (which god backs which tavern, and which mission is whose) is
  mechanical data. The gods' names and voices are chrome.

**D-45 Score is loot, with a fixed haul: DECIDED (2026-10-11).** Replaces
"score = checks passed ÷ checks attempted" (rules §7).
- Each check node carries a loot value. Passing banks it, and failing banks
  nothing.
- A week's score is the loot banked, and points equal loot.
- Every mission is authored so its best path pays the same fixed haul (e.g.
  100), which makes weeks count equally. The validator checks this.
- Branches may pay different amounts. A failure branch paying less is
  intended.
- Projected points become expected loot, which is still exact by propagation.
- *Implemented:* `loot` on check nodes, `missions.haul` in the season config,
  the `haul` validator rule, and `missionHaul`. Score = loot ÷ haul in
  `resolution/` and `projection/`, and the reducers and `verifyResolutions`
  check `run.loot`.
- *Open:* the haul amount, and how loot is spread across a path. Rising loot
  late in the path is an idea (lore.md).

**D-46 DNF keeps banked loot: DECIDED (2026-10-11).** Replaces "a DNF scores
0". Losing a battle ends the mission, and the party keeps the loot banked
before the battle. The penalty for a DNF is the loot it didn't reach, so
where battles sit in a mission sets the penalty. Sims (200 seasons, mock
missions, old scoring) showed about 21% DNF, which is the target, and a score
spread of about ±34 points that came mostly from DNFs scoring 0. *Implemented.*
Re-run on the mock missions (same seed): DNFs stay at 20%, and runs scoring
0 fall from 21% to 7%. The spread only falls to about ±32, because the mock
missions' battles come early, so a DNF has banked little. Late battles and
rising loot (lore.md) are the levers for cutting it further.

**D-47 Home bonus ×1.25: DECIDED (2026-10-11).** On its sponsor's mission, a
tavern's loot is multiplied by 1.25.
- Mock sims, old scoring: the home tavern beat a given rival about 61% of the
  time (NFL home teams win about 57%) and topped its week about 34% of the
  time, against a baseline of 17%.
- ×2 was rejected: the home tavern topped the week about 67% of the time, so
  weekly wins would mostly rotate through the home taverns.
- Re-measured under D-45 and D-46 on the mock missions: ×1.25 beats a given
  rival 62% of the time and tops the week 39% of the time. (This is a
  post-hoc multiplier on sim results. The engine doesn't apply it yet.)
- Re-measured for the league table (D-04), 300 mock seasons, each tavern
  taking a turn as home: ×1 tops the week 16.7% (one in six, but only 9.9%
  alone: ties for the top are common); ×1.25 tops it 38.8% (37.0% alone);
  ×1.5 50.5%; ×2 66.8%. Under the table a weekly top earns nothing by
  itself: the bonus is 25% of one week's loot, and every tavern gets one
  home week (D-48), so it evens out over a season.
- *Needs:* a sponsor per tavern and per week in the season config.

**D-48 One mission per sponsor: DECIDED (2026-10-11).** The season has as many
weeks as taverns, and each week is one sponsor's mission.
- `weeks` follows the tavern count, so the tavern count must be fixed before
  missions are sealed. That means before the draft.
- D-01 caps a 64-character pool at 9 taverns.
- A mystery mission set by the GM is parked as an idea.

### Missions and secrecy

**D-08 Mission secrecy: DECIDED (2026-10-10): open.** The repo is not secret
and missions are open for each season. No sealing, encryption or commitments
for now. The options considered are kept below for reference.

Original question: how selected missions stay hidden until their
week:
- (a) **Private repo.** Simple, but managers can't audit events, and the event
  log and published JSON need a separate public home.
- (b) **Commit-reveal.** The GM publishes sha256 commitments before the draft
  and keeps plaintext off-repo, then pushes each mission at reveal time. That
  needs a human every week, so the weekly run is no longer hands-off.
- (c) **Encrypted in repo** (*default*). `age`-encrypted files in
  `missions/selected/`, decrypted by the weekly Action with a repo secret,
  plus sha256 commitments as in (b) for verifiability. The weekly run is fully
  automatic. The risk is that anyone with secret access (repo admins) can
  decrypt early.
Whatever is chosen, commitments go in `season.created` so a reveal is
checkable. *Blocks:* T10.2, T11.4 (reveal step).

**D-18 Candidate missions are as secret as selected ones: MOOT (2026-10-10).**
Missions are open (D-08), so candidates can be committed in plaintext. The
reasoning below only matters if secrecy comes back. The brief puts
`missions/candidates/` in the repo, but the selected missions are a subset of
the candidates, so plaintext candidates in a public repo reveal the season.
Options: keep candidates out of the repo (local or a private companion repo),
encrypt them like selected missions, or use a private repo (D-08a). The
difficulty report is git-ignored for the same reason. *Default:* candidates
are git-ignored in real seasons. Only the hand-written example is committed.
*Blocks:* T5.4 output location, T7.2.

**D-09 GM integrity: OPEN.** The GM knows every mission (and, with D-13
unsalted, can compute every tavern's exact outcome for any lineup). Options:
(a) the GM is the commissioner and doesn't manage a tavern;
(b) co-GMs split missions, and each is blind to some weeks;
(c) missions are locked before the draft and the GM plays anyway, edge
accepted. That works best with salted seeds (D-13), so the GM knows the odds
but not the dice.
*Default:* (c) with salt, and the GM is listed in `managers.yaml`.
*Blocks:* T11.2 (whether the GM may hold a tavern).

**D-13 Seed salt: SUPERSEDED, DIRECTION SET (2026-10-10).** Each week's
result is an actual single random roll, **not** deterministic from a seed.
Details are still to be worked out. Consequences: `mission.resolved` stays the
record of truth, since its rolls can't be recomputed. `verifyResolutions`
shrinks to consistency checks (the path follows the recorded outcomes, and
the score matches). `rngFor` stays for sims, tests and the difficulty report.
The text below is the earlier analysis.

Earlier: **D-13 Seed salt.** Seeds from (season, week, tavern) alone are public, so
anyone who knows a mission early (the GM, anyone with the decryption key) can
compute exact actual results for every lineup, not just the odds. A per-week
salt committed before the season and revealed with the mission closes that
gap. *Default:* `revealed_with_mission`. Salts are generated at seal time,
and their hashes are committed in `season.created`.
*Related alternative:* **shared dice per week** (seed from season + week only,
no tavern). Every tavern rolls the same d20 at the same node, like duplicate
bridge, so weekly results reflect lineup choice more than luck. The brief says
(season, week, tavern), so that's the default, but sims could compare both
(T9.3).

**D-39 Capability gates on checks: OPEN.** Should a check be able to require a
fly speed, darkvision, and so on? Gates create archetype dependency, the very
thing the difficulty report warns about, but they also give environment and
theme real teeth. *Default:* the schema supports `requires`, the validator
allows at most one gated check per mission, and the difficulty report flags it.

**D-28 Battle model v0: OPEN.** Spec 05 sketches DPR/eHP time-to-kill,
logistic-squashed. Questions: party DPR as a sum of members; how to model
multiattack; whether `battle_bonus` is additive to DPR or to the logistic input;
calibration target (e.g. an encounter at CR = B → p(win) ≈ 0.5?).
*Default:* ship a simple model behind the `BattleModel` interface (T6.2), and
calibrate in T9.3. *Blocks:* nothing on the critical path.

### Characters, modifiers, carryover

**D-11 Carryover rules: OPEN.** Who keeps whom: 1 keeper per tavern, plus 1
for the champion. Keeper cost: the round the character was drafted last season.
Modifier drift on keepers: ≤ 1 point. Alternatives: no keepers (clean
redraft), champion-only reward, auction-style keeper salary (its CR counts
+1 against B). *Blocks:* T3.6, T10.3.

**D-31 Modifier budget and costs: OPEN.** 3 points per character, with
placeholder costs in `engine/src/characters/registry.ts`. Real costs need
sims. A modifier's value depends on the base: +2 Stealth is worth more on a
creature that's already the stealthiest in the pool. *Blocks:* final values
only. T3.2 builds the mechanism.

**D-38 Advantage as a modifier: DEFAULTED.** Allowed, cost 2, no stacking. It
changes the check formula to `1 − (1 − p)²`. Projection handles it exactly.

### Data and licensing

**D-17 Open5e API version and documents: OPEN.** v1 `/monsters/` is flat and
stable. v2 `/creatures/` is richer but shaped differently. Open5e also serves
third-party documents under OGL 1.0a. *Default:* v1, **SRD 5.1 only**
(CC-BY-4.0). Adding OGL documents means shipping the OGL text and Section 15.
*Blocks:* T1.1.

**D-16 Exact CR arithmetic: DECIDED (scaffold).** CR is held as integer
eighths (`CrEighths`). Floats would make budget checks with 1/8, 1/4 and 1/2
fragile.

**D-10 Image storage: OPEN.** Git LFS (in the repo, quota-limited, PR-able)
vs an external bucket (cheap and scalable, but a second system and links can
rot). Never plain-git binaries. *Default:* none. Portraits stay at
`status: prompt`. *Blocks:* T8.7.

**D-33 Code license: OPEN.** No LICENSE file yet. Content license interplay:
SRD 5.1 is CC-BY-4.0, and chrome is original. Choose a code license (MIT?)
and decide whether authored chrome gets its own (CC-BY?).

### Platform

**D-19 Published JSON vs "derived state is never stored": DECIDED (scaffold).**
`explorer/` reads published JSON, but committing that JSON would store derived
state. *Decision:* publish is a CI build artifact deployed to Pages or a
release, never committed.

**D-20 What `mission.resolved` records: DECIDED (scaffold).** It records rolls,
path, score, projection and engine version as facts. Reducers trust the
record, and `verifyResolutions` recomputes to audit it. Otherwise an engine
bug fix would silently rewrite last season's history.

**D-25 Engine version per season: DEFAULTED.** A season pins the engine
version in `season.created`. Mid-season engine changes that alter resolution
are not allowed. Bug fixes land for the next week only with commissioner
sign-off, and are recorded in the event's `engineVersion`.

**D-24 Lineup visibility: DEFAULTED.** Issue forms are public, so lineups
are visible before the lock. Opponents' lineups don't affect your score, so
the main risk is copying. Accepted. If it matters, lineups could be submitted
as hashed commitments.

**D-32 LLM provider for drafting scripts: OPEN.** Scripts call through
`scripts/src/lib/llm.ts`. Drafting is offline and human-triggered, never in CI.
*Blocks:* T5.4, T8.5 (the live call only; prompts and validation loops can be
built against a fake client).

**D-34 Event storage format: DEFAULTED.** One NDJSON file per season,
appended under a per-season Actions concurrency group, with a sha256 `prev`
hash chain. Alternative: one file per event, which gives fewer merge conflicts
but more files. `.gitattributes` marks the log `-merge` so git never
auto-merges two writers.

**D-35 Manager identity: DEFAULTED.** Managers are identified by GitHub
**numeric user id**, not login, because logins can be renamed.
`managers.yaml` holds both.

**D-41 Trade completion and cancellation events: DECIDED (scaffold).** The
brief's event list has `trade.proposed/accepted/vetoed` but no event for the
veto window ending. Reducers can't read clocks, so "no veto within 24 h" has to
become an explicit `trade.completed`. `trade.cancelled` covers declined,
withdrawn, expired and invalidated trades.

---

## 2. Scaffold decisions (stack)

**D-21 Node and TypeScript versions.** The brief says Node 20+. **Node 20
reached end-of-life in April 2026**, and vitest 5 requires Node ≥ 22.12. So:
`engines.node >= 22.12`, `.node-version` 24 (current LTS). TypeScript is pinned
to `~6.0`, not 7.x, because typescript-eslint 8 supports TypeScript < 6.1.
Revisit when typescript-eslint supports TS 7.

**D-22 Schema library.** Recommend **zod 4** in the engine: TypeScript types
plus runtime parsing, browser-safe, and `z.toJSONSchema()` so YAML files can be
validated in editors and by the LLM's structured output. It's not installed
yet. T2.3 adds it. Alternative: TypeBox + Ajv.

**D-23 Stack.** TypeScript stays, with no switch. The engine has to run in the
browser and in Actions, and the pure-function architecture suits it. The
only strong alternative would be Python for the sims' statistics, which isn't
worth a second language.

**Other choices:** pnpm workspace (`engine`, `bots`, `scripts`, `sims`);
packages export TS source directly (no build step; `tsx` for scripts);
`moduleResolution: Bundler`; the engine's tsconfig has no Node or DOM types,
so I/O fails to typecheck; ESLint bans I/O modules, `Date` and `Math.random`
in `engine/src`. Added `engine/src/league/` (season config type, H2H
schedule, standings) and `engine/src/vocabulary.ts`, which the brief's layout
doesn't list. Added scripts `draft-missions`, `lock-check`, `apply-command`
and `offseason` alongside the brief's script list.

**Hashing in the engine:** the hash chain and commitments need sha256 in pure
JS that runs in the browser (WebCrypto is async). Use `@noble/hashes`.

---

## 3. Differences from `docs/specs/` (this brief wins)

**Kept as-is:** cyrb128 + sfc32 PRNG and `rngFor(seed, key)` namespaced
substreams (03); layered DAG with ranks, where edges only go up (04); check
math `clamp((21 − (DC − mod)) / 20, 0, 1)` (05); best-fit assignment and
`{actor}` (05); black-box EV battles (05); battles gate and checks fill the
fraction, with a per-traversal denominator (05, OD-3 accepted); propagate for
expectations and sample for validation (05); structure precedes narrative and
story never decides a mechanical fact (00, 04).

| Δ | Spec said | Now | Spec |
|---|---|---|---|
| Δ-01 | Monte Carlo toy with a leaderboard of generated characters | Human fantasy league with taverns, drafts and weekly H2H. Monte Carlo survives as sims and the difficulty report | 00 |
| Δ-02 | Character = content-addressed genotype; identity = hash | Stable authored id (`bruno-the-bruiser`) + base slug. Chrome is a separate layer | 01 |
| Δ-03 | Assembly and replacement strategy presets inside each character; party ≡ captain | Managers pick lineups. Strategies live only in `bots/` | 01, 06 |
| Δ-04 | Lean, reshaped snapshot schema | Verbatim Open5e records + a thin adapter (`engine/src/adapters/open5e`) | 02 |
| Δ-05 | Procedural personal names from a derived `culture`; team-name grammar | Removed. Names are authored chrome and the engine never reads them | 01, 02, 04 |
| Δ-06 | Integer `dataVersion` in snapshot filename and permalinks | Named snapshot ids in `manifest.json`, pinned per season | 02, 03 |
| Δ-07 | Seeded procedural mission generator | No generator. The LLM proposes, the engine validates, the GM curates | 04 |
| Δ-08 | `[flavor]` grammar seeded per node; `{skill}`, `{dc}` tokens | Authored per-outcome chrome. Data-bound tokens kept (`{actor}`, `{captain}`, `{battle_creature}`, plus `{allies}`, `{tavern}`). `{skill}`, `{dc}` dropped as mechanical facts | 04 |
| Δ-09 | `runSeed = missionSeed:team:k`, many runs per pair | One run per week per tavern, seeded (season, week, tavern[, salt]). Sampling remains for tests and validation | 03, 05 |
| Δ-10 | Efficiency (score / B) and power columns | League scoring is points (score × 100). Efficiency may appear in the balance report | 05, 06 |
| Δ-11 | Static Jekyll site, no backend, permalinks for every view | GitHub issues + Actions + event log. Published JSON is a build artifact. The explorer and permalinks are out of scope | 00, 03, 06 |
| Δ-12 | Shared frozen mission batch per environment (OD-4) | One curated mission per week, the same for every tavern | 06 |
| Δ-13 | Node kinds `arrival`/`resolution`; battle `cr` + single `creatureRef` | `start`/`end` (multiple ends allowed); `encounter.creatures[{ref, count}]` with CR from the snapshot | 04 |
| Δ-14 | No per-season mechanics | New modifier layer: a closed vocabulary with a per-character budget | — |
| Δ-15 | Mission inspector: sampled per-edge weights | The difficulty report uses propagated reach rates. Sampling is used for the T6.5 property test | 04, 06 |
| Δ-16 | OD-1 environment affinity: drop | Still dropped. Environment matters only through mission content (and D-39 gates) | 00 |
| Δ-17 | OD-2 assembly fallback | Not applicable (no assembly) | 00 |
| Δ-18 | OD-5 inspector sample count | Not applicable to league play. Sims choose their own N | 00 |
| Δ-19 | OD-6 precompute vs live | Kept in spirit: publish precomputes, and the engine also runs in the browser | 00 |
| Δ-20 | OD-7 degrade honestly on re-snapshot | A season replays against its own pinned snapshot forever. Snapshots are immutable | 00 |
