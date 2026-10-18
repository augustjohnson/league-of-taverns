# Design: the Lich's contest

High-level design for moving the game to the premise in [lore.md](lore.md): a
Survivor-style contest among monsters, played as fantasy by people who only
watch. It lists what changes, what stays, and what is still open. Nothing here
is a rule yet: rules land in [rules.md](rules.md) and
[decisions.md](decisions.md) once they are decided.

**Built for playtesting:** [lich-contest-plan.md](lich-contest-plan.md) lists
the default chosen for every Proposed and Open item below, and the sims that
tuned them.

Each item is tagged:

- **Decided:** agreed in design discussion on 2026-10-17.
- **Proposed:** a suggested default, to be confirmed or replaced, usually by
  simulation.
- **Open:** not decided, no default yet.

## 1. Summary

About twenty monsters compete to become the Lich's assistant. Each episode
the Lich sets a task (a challenge), the winner is immune, and the rest vote
one of their own out. Voted-out monsters form the jury that picks the winner.

Managers run taverns. Before the season they snake-draft a few monsters each.
After that they **only watch**: the one recurring decision is **calling the
boot**, a prediction of who is voted out at each vote. Taverns score for
their monsters' results plus their correct calls; the most points after the
finale wins the season.

## 2. Goals

- **Feeling skilful over random results** (Decided). Choices should visibly
  cause results, and the game should show it: steals, MVPs, correct calls.
- **Few rules** (Decided). The base game is complete without extra layers:
  draft, event, scoring, comparison. Each extra layer has to earn its place.
- **Watch only** (Decided). Nothing a manager does reaches the contest. The
  contest for a season is fully determined by its seed, the cast and the
  challenges.
- **Play against bots first** (Decided, from earlier work). The game must be
  complete with one human and bot taverns, told through the Common Room.

Not goals for now: manager influence on the sim (whispers, rumours, idols),
human-to-human sabotage or buffs, trades.

## 3. What stays

| Area | Why it carries over |
|---|---|
| Engine boundaries (pure engine, no I/O, no chrome) | Unchanged. The contest is a pure function of seed and inputs. |
| Seeded RNG (`rngFor(seed, key)`) | Every challenge roll, vote tie-break and noise draw gets a stable key. |
| Append-only event log, state rebuilt by replay | Unchanged. New event types are listed in §6. |
| Characters: base, modifiers, chrome | Unchanged layering. The monster card is a view of these (§4.2). |
| Check math (`passChance`, advantage, best modifier) | Challenges are series of checks, so this is reused as-is. |
| Snake draft (`snakePickOwner`, `draftOrder`) | The draft is unchanged. |
| Sealing and commitments | Challenges are secret but committed before the season, exactly as missions were. |
| Bots, `sims/`, the playground, the Common Room, the scrying ball | Same roles: bot managers, season simulation, the browser game, the feed, the narrated reveal. |

## 4. The contest

### 4.1 Season shape

- **Cast:** about 20 monsters (Decided: "the 20 of you").
- **Episode:** one challenge, then one vote, then one boot (Proposed). Every
  vote is a decision point for calling the boot.
- **Finale:** the last few monsters (Proposed: three) face the jury.
- **Length:** with 20 monsters and a final three, 17 votes (Proposed shape;
  the count follows from cast size and finale size).

### 4.2 The monster card

What a monster brings to the contest (Decided unless tagged):

- **Ability scores, skills and saves.** Everything a check uses.
- **Speeds and senses.** Swim and fly speeds and darkvision can matter in
  challenges.
- **Not used:** AC, HP, attacks, damage. There is no combat.
- **Creature type, subtype, alignment** (Proposed). Inputs to voting
  strategies. `BaseStats` has `creatureType` today, but not subtype or
  alignment. The Open5e adapter would need to add them.
- **Voting strategy.** Shown openly on the card (Decided), chosen from a
  fixed list (Proposed, §4.4).

Modifiers stay the GM's balancing tool. `battle_bonus` loses its meaning and
should be dropped from the modifier list (Proposed).

### 4.3 Challenges

- **Individual only** for now, each a **series of checks**, with **one
  winner** who gets immunity (Decided).
- **Authored before the season, kept secret, moderately balanced** (Decided).
  They are sealed and committed like missions were.
- **Format** (Proposed): elimination rounds. Every monster still in the
  challenge makes each check, and those who fail drop out until one is left.
  If everyone fails a round, the round is replayed. This reuses `passChance`
  and reads well in the feed ("three left on the rope").
- **Balance** (Proposed): across a season, each ability is tested a similar
  number of times, and speeds and senses gate only a minority of checks.
- **Public hint** (Open): whether to publish the season's ability mix before
  the draft ("every ability gets tested twice"). It gives managers something
  to plan around without revealing a challenge.
- **Story** is chrome: "fetch my phylactery from the moat" over an Athletics
  check with a swim speed giving advantage.

### 4.4 The vote

This is where most of the design work is.

- **Strategies come from a fixed list** (Proposed), like modifiers. A first
  list to test:
  - **Loyal:** protects monsters sharing a tag (type, subtype or
    alignment), e.g. "I want a goblinoid to win".
  - **Threat hunter:** targets whoever has the most immunity wins.
  - **Coattails:** allies with the strongest, targets the weakest.
  - **Grudge:** targets whoever voted for it last.
  - **Floater:** votes with the biggest bloc.
- **Strength must be dangerous** (Proposed). Some strategies target
  challenge winners, so a high-stat monster wins immunity often but is a
  target whenever it doesn't. This stops the best stats from simply winning,
  and makes reading the cards a skill.
- **Affinity and blocs** (Proposed). Each pair of monsters has an affinity
  score, seeded from their cards and changed by events (voting together
  raises it; voting against each other lowers it). Monsters with high mutual
  affinity vote as a bloc. The vote is a plurality, so blocs decide it.
- **Noise** (Proposed). Each monster follows its card most of the time (start
  at about 80%) and otherwise votes from a seeded random choice among its
  plausible targets. Without noise, a careful player can work out every boot
  exactly.
- **Rules of the vote** (Proposed): no voting for yourself or the immune
  monster. On a tie, revote among the tied, then a seeded draw.

### 4.5 Finale and jury

- Every voted-out monster joins the jury (Decided by the lore: the Lich
  raises them as skeletal staff).
- **Jury vote** (Proposed): each juror votes for the finalist it has the
  highest affinity with. That reuses the vote's affinity model, and it is
  where strategies like "I want a goblinoid to win" pay off at the end.
- The winner is the Lich's new assistant.

## 5. The fantasy layer

### 5.1 Taverns and the draft

- A tavern is a manager's team, and its name is the team name (Decided).
- **Snake draft** before the season, with the monster cards as the public
  information (Decided).
- **Roster size** (Open): managers × roster can't exceed the cast. 5 taverns
  × 4, or 6 × 3 with 2 undrafted, both fit 20. Undrafted monsters still
  compete; nobody owns them.
- **No lineups, waivers or trades** (Decided for lineups; Proposed for
  waivers and trades). Your draft is your team for the season.

### 5.2 Calling the boot

All Decided:

- One call per vote, per manager.
- You may call your own monster.
- No bonus for going against the crowd.
- A correct call is worth about what one monster earns for surviving one
  vote, then tuned by simulation.
- **Calls can be made before or after the challenge.** A correct call made
  before the challenge earns a small bonus, since it was made without
  knowing who would win immunity.

Proposed:

- **The early bonus is small:** start at about half of a call's value, and
  tune it so that waiting for immunity stays the safer choice but not
  always the better one.
- **Changing an early call** after the challenge is allowed, but it then
  counts as a late call and loses the bonus.
- **An early call on the monster that wins immunity** can't be correct.
  The manager may change it after the challenge, as a late call.

Open:

- **No call:** whether a missing call scores zero or falls back to a bot pick.

Calls stay hidden until the vote, then the Common Room reveals them.
Calling keeps a manager in contention even after their monsters are gone.

### 5.3 Scoring

- **Monster points** (Proposed): points for surviving each vote, for each
  immunity win, for jury votes received, and a bonus for the winner. These
  are the categories every fantasy Survivor league uses.
- **Call points:** per §5.2.
- **Standings** (Decided, 2026-10-18): total points over the season; the
  most points after the finale wins. Head-to-head matchups were dropped:
  they added a schedule and a record without adding a decision.
- **Season ratings** (Decided in principle): every monster's results are
  recorded over the season. Proposed on top of that: rate monsters against
  what a typical undrafted monster earned, so a season MVP and draft
  steals and busts mean something.

### 5.4 Pacing

**Open.** The game may run daily rather than weekly. Proposed: a challenge
one day and its vote the next, so 9 episodes take 18 days plus the finale,
with one check-in a day. The rules above don't depend on it.

## 6. Impact on the code

| Module | Change |
|---|---|
| `engine/src/adapters/open5e` | Add subtype and alignment to `BaseStats`. AC, HP and attacks remain but go unused. |
| `engine/src/characters` | Drop `battle_bonus`. Add the voting strategy to the pooled character's mechanical data. |
| `engine/src/missions` | Replaced by challenges: a schema and a validator for a series of checks. Keywords go with it. |
| `engine/src/resolution` | Keep check odds. Remove battles, injuries, the mission run and loot scoring. Add challenge resolution, the vote and the jury vote. |
| `engine/src/projection` | The exact projection over the mission graph goes. Boot odds will come from seeded sampling of the vote. |
| `engine/src/roster` | Keep the snake draft. Remove lineups, the CR budget, retreat orders, waivers and trades. |
| `engine/src/league` | Season config: cast size, finale size, scoring values. Standings by total points. |
| `engine/src/events` | Remove tavern pick, lineup, hex, waiver, trade and mission events. Add call events, call locks, and an episode result (challenge, votes, boot) plus the finale. |
| `bots/src/strategies` | Keep draft strategies (retuned). Replace lineup, waiver and hex bots with a calling bot. |
| `sims/` | Season runner for the contest. Reports per §7. |
| Playground | The Common Room tells episodes, votes and calls. The draft stays as it is. |
| Docs | `rules.md`, `schema.md`, `season-lifecycle.md`, `glossary.md` and `decisions.md` all need rewriting once this is decided. |

## 7. Testing by simulation

Run thousands of seasons and report:

- **Stats vs placement:** how strongly a monster's challenge strength
  predicts how far it goes. Too strong and the draft is trivial; too weak
  and stats don't matter.
- **Strategy win rates:** no strategy should dominate.
- **Winner spread:** different monsters should win different seasons.
- **Boot predictability:** how often the most likely boot actually goes
  home. Somewhere around 60–70% should make calling feel skilful without
  being solved.
- **Call value:** how often calls decide the title.

## 8. Open decisions

- Cast size, finale size and roster size.
- Challenge format, and whether to publish a hint about the season's ability
  mix.
- The strategy list, the affinity model and the noise level.
- The size of the early-call bonus, and what happens to a missing call.
- Scoring values for monster points and calls.
- Pacing: daily or weekly.
- Whether trades or other between-vote decisions come back later.
- Names: "league" and possibly "tavern" may not survive (see
  [lore.md](lore.md)).

## 9. Suggested order of work

1. A `sims/` prototype of one contest: challenges, the vote, the jury. No
   managers. Report the §7 numbers.
2. Tune strategies, affinity and noise until those numbers look right.
3. Add the fantasy layer: draft, calls, scoring, head-to-head with bots.
4. Write the agreed rules into `rules.md` and `decisions.md`, then change the
   engine modules in §6.
5. Rebuild the playground around the Common Room.
