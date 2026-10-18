# Implementation plan: converting to the Lich's contest

How the game moves from the mission league to the Survivor-style contest in
[survivor-format.md](survivor-format.md), and what the first playtest build
contains. The goal of this pass is **a version you can playtest against
bots**: one season in the browser playground, three bot taverns, told in the
Common Room.

[survivor-format.md](survivor-format.md) is the design. This page is the
build: the order of work, what each module becomes, and the defaults chosen
for the design's open questions so there is something to play. Every
default is a config value or a single constant, so simulation and
playtesting can move it. None of them is a rule until it lands in
[rules.md](rules.md) and [decisions.md](decisions.md).

## 1. Defaults for the playtest

| Open question (survivor-format.md) | Playtest default | Where it lives |
|---|---|---|
| Cast size | 12, drawn by the season seed from the pool | `contest.castSize` |
| Finale size | Final three face the jury | `contest.finalists` |
| Taverns × roster | 4 × 3 (all 12 drafted) | `roster.size` |
| Votes | 9 (cast − finalists) | follows from the two above |
| Challenge format | Elimination rounds over the challenge's checks; everyone fails → replay; the list repeats with DC +1 a lap | `engine/src/contest/challenge.ts` |
| Ability-mix hint | Published: the season lists how often each ability is tested | `season.created` |
| Strategy list | loyal (to a tag), threat hunter, coattails, grudge, floater | `engine/src/contest/types.ts` |
| Affinity model | Public only: shared type (+1), subtype (+1), law and morals (+¼ each, −¼ good against evil); voting together +½; voting against someone −1.2 for the target, −0.4 for the voter | `engine/src/contest/model.ts` |
| Blocs | Each voter leans toward its friends' first choices; floaters toward the room's | same |
| Noise | Each vote follows its card 55% of the time, else a seeded pick between its second and third choices | `noise` |
| Strength | Everyone keeps the useful a little (`keepStrong`); threat hunters target power and immunity wins | `keepStrong`, `threat`, `winThreat` |
| Coattails' late betrayal | Riders protect the strong and vote out the weak; the strong carry riders who flatter them; at the final 5, riders turn on the strongest | `flattery`, `betrayAt`, `betrayal` |
| Early-call bonus | +1 on a correct early call (a call is worth 2) | `scoring.earlyCallBonus` |
| Missing call | Scores 0 | rule |
| Monster points | survive a vote 2, immunity 3, jury vote 2, winner 10 | `scoring.*` |
| Head-to-head | Round-robin of the 4 taverns: 3 rounds of 3 episodes, the finale in round 3 | `schedule.rounds` |
| Standings | Wins, then total points | `engine/src/league` |
| Pacing | One episode at a time, at the player's click | playground |
| Boot odds | Hidden from the player; the workshop shows them | playground |
| Draft information | The cards, the season's ability mix, and the scouts' rating as 1–5 stars (from simulated contests with stand-in challenges) | playground |

The tuning targets are survivor-format.md §7: the favourite boot goes home
about 60–70% of the time, no strategy dominates, different monsters win
different seasons, stats matter without deciding everything. §7 below has
where the defaults landed.

## 2. What stays, changes, goes

**Stays as is:** seeded RNG, det-math, the Open5e adapter, effective stats and
modifiers (minus `battle_bonus`), check odds (`passChance`), the snake draft,
the event envelope, hashing, canonical NDJSON and replay, the character
files, portraits and the image pipeline, the playground's build, cards,
banners, pacing (`pacer`, Skip, reduced motion), the Common Room's chat
rendering and the moments in `fx.ts`.

**Changes:**

- `engine/src/adapters/open5e`: `BaseStats` gains `subtype` and `alignment`.
- `engine/src/events`: the event set is rewritten for the contest (§3).
- `engine/src/league`: the contest config, the round-robin schedule, scoring
  and win–loss standings.
- `bots`: draft bots reworked around contest value; a calling bot replaces
  the lineup, waiver and hex bots.
- `sims`: `ContestSession` replaces `SeasonSession`; the CLI and the batch
  report the §7 numbers.
- Playground: the game is rebuilt around episodes; the workshop becomes a
  contest lab.
- The mock season becomes `sims/fixtures/lich-season/`: the 48-character
  pool with authored voting strategies, 9 authored challenges, and four
  taverns that carry their own banners.

**Goes:** missions (schema, validator, keywords, prompts), battles and the
battle model, the projection, lineups and the CR budget, retreat orders,
injuries, hexes, waivers, trades, gods and sponsors, the luck and bench
reports, battle calibration, and the mission-only scripts.

## 3. The event log

| Event | Payload | Rules |
|---|---|---|
| `season.created` | config, engine version, taverns (id, name), challenge commitments, ability mix | first |
| `character.pooled` | id, base, CR, modifiers, voting strategy | once per cast member |
| `manager.joined` | manager, account | before the tavern pick |
| `tavern.chosen` | manager, tavern | reverse draft order |
| `draft.pick` | pick, tavern, character | snake, `roster.size` rounds |
| `call.made` | episode, tavern, target | target still in; after the challenge, not the immune monster; replaces the tavern's earlier call |
| `challenge.resolved` | episode, challenge, sha256, rounds, winner | matches the commitment and the seeded run |
| `vote.resolved` | episode, ballots, revote, draw, boot | boot is a legal target |
| `finale.resolved` | finalists, jury ballots, winner | after the last vote |
| `round.finalized` | round | every episode in the round is done |

A call is **early** when it lands before its episode's `challenge.resolved`
and is not replaced after it. Scores, matchups and standings are selectors
over this log; nothing derived is stored.

The contest itself is a pure function of the season seed, the cast and the
challenges (`runEpisode`). The session writes its results as events, and
the audit recomputes them from the seed.

## 4. Order of work

1. **Contest core** (`engine/src/contest/`): challenge schema and
   resolution, the cards' tags, strategies, affinity, the vote, the jury,
   and `bootOdds` by seeded sampling. Unit tests.
2. **League layer:** config, round-robin, scoring, standings, the new
   events, reducers, selectors and replay. Tests.
3. **Bots:** draft value by simulating contests over the public cards with
   generic challenges; calling bots of different skill; the tavern pick.
4. **Sims:** `ContestSession` (with a human seat, early and late calls),
   `runContestSeason`, the CLI, and the balance report. Tune the defaults
   against §7 until the numbers sit in range.
5. **Content:** the lich-season fixture: strategies for the 48, 9
   challenges with their story, tavern banners.
6. **Playground:** the game (draft, episodes, calls, the scrying ball on the
   challenge, the vote read one parchment at a time, matchups, the finale)
   and the contest lab.
7. **Remove the old format:** delete the modules, scripts, tests and
   fixtures in §2's last list, and point the docs at this plan.
8. **Verify:** `pnpm check`, a batch of sims, and a full season played in the
   browser.

## 5. The playtest loop

1. On your first visit, give your name and your tavern ("The <adjective>
   <noun>", under one of six banners); then start a season of The Lich's
   Assistant. You take a random bot's seat on a random seed. The bots
   choose taverns from the rest, then the snake draft (3 rounds), told pick
   by pick.
2. Each episode: the Lich summons the contestants. You may **call the boot
   early**. Bots call too (sealed).
3. **The challenge** plays in the scrying ball: round by round, who is out,
   until one monster holds immunity.
4. You may call (or change your call) now, as a late call.
5. **The vote** is read one parchment at a time. The boot leaves for the
   jury, the calls are revealed, points land.
6. After the round's last episode: the round's head-to-head results and the
   table.
7. The finale: the jury's votes are read, the Lich names his assistant, and
   the season ends.

## 6. After the playtest

Decide with the playtest and the sims: pacing (daily or weekly), the scoring
values, the noise level, whether to publish boot odds or keep them hidden,
and whether trades or other between-vote decisions return. Then write the
rules into rules.md and decisions.md, and rebuild the live-league scripts
(seal, reveal, run an episode, apply a call) on the new events.

## 7. Where the defaults landed

The defaults were first tuned on a cast of 20 and six taverns, below. On
2026-10-17 the season shrank to **a cast of 12 and four taverns**; with
that, the betrayal moved from the final 7 to the final 5, and
`pnpm sim -- --runs 100 --seed small` gives: the favourite goes home 59%,
power vs place r = 0.41, 36 different winners in 100 seasons, strategy win
rates 6–13% (par 8.3%), calls 20% of points and decide 10% of matchups, and
`sharp` takes 33% of titles (par 25%), `brawn` 29%, `gossip` 21%, `scout` 18%.

The original tuning, `pnpm sim -- --runs 200 --seed final` with 20 of 48
drawn per season and six bot taverns:

| §7 measure | Target | Result |
|---|---|---|
| Favourite boot goes home | 60–70% | 65% (its mean chance 66%) |
| Challenge power vs finishing place | positive, not decisive | r = 0.38; the strongest quarter finishes behind the third quarter |
| Different winners | many | 38 different winners in 200 seasons; the most frequent won 18 |
| Win rate by strategy (par 5%) | none dominates | threat 7.3%, coattails 5.8%, loyal 5.1%, grudge 4.7%, floater 2.9% |
| Calls | matter | 20% of all points; they decide 16% of matchups |
| Ties | some | 3.3 revotes and 0.6 draws a season |

What the tuning found, in order:

1. **Alignment decided everything at first.** Chaotic-evil monsters (a third
   of the pool) averaged 6th of 20 and good ones 19.5th. Halving the
   alignment affinity made it a lean, not a bloc.
2. **Stats didn't matter** (r ≈ 0): threat hunters cancelled the benefit of
   winning immunity. A small "keep the useful" term (`keepStrong` 0.1) gives
   r ≈ 0.35, with the very strongest still targeted.
3. **Coattails monsters almost never won** (0.6%): the authored riders are
   mostly weak, and nothing protected them. The late betrayal alone didn't
   change that; flattery (the strong carry their riders) brought them to par.
4. **Noise sets predictability.** 0.45 puts the favourite at about two in
   three.

Still uneven, for the playtest to judge:

- By content, not rules: beasts (mostly weak) average 15th, and the two
  good-aligned monsters 17th. Humanoids do best.
- Bots: `sharp` (scouted draft, odds-reading calls) wins about 45% of
  all-bot titles (par 17%); `scout` 19–27%, `brawn` 11–16%, `gossip` 9–15%,
  `socialite` 3–8%, `random` under 1%. Its calls are right 65% of the time
  against 52% for the next best, and almost all early. It is the table's
  expert; whether a person can match it without seeing the odds is what the
  playtest will tell.
