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

**D-01 Ownership: DEFAULTED (2026-10-13): exclusive.** Exclusive (one tavern
per character) or shared (several taverns may roster the same character, as
in salary-cap fantasy). *Default:* exclusive. *Hard cap (decided
2026-10-13):* a league has at most **6 taverns**. With rosters of 7 the
draft takes 42 characters, which leaves about 22 free agents from a pool of
64 for waivers and injury cover (D-51). With 6 gods (D-48, D-52) the season
is always 6 weeks. *Note:* with exclusive ownership, a pool of 64 and a
roster of 7, at most 9 taverns fit (63 characters), and waivers only work if
some characters go undrafted. Size the pool to about taverns × 7 + 10.
*Blocks:* nothing (T4.1 implements exclusive). The 6-tavern cap is built
(T4.10): `MAX_TAVERNS`, enforced by `season.created`, `manager.joined` and
the loaders.

**D-02 Draft format: DEFAULTED.** Snake vs auction (CR as salary suggests an
auction could work) vs linear. *Default:* snake, seeded order. Reconfirmed
for Season 1 (2026-10-13): an auction run through public issue forms would be
slow, and every bid would be visible.

**D-03 Roster and bench size: DEFAULTED.** Roster of 7, 4 starters, 3 bench.
With 6 weeks and no injuries, the bench matters only through environment fit
and the budget. Confirm with sims (T9.3: how often is the bench used?).
*Measured (2026-10-13, 300 mock seasons, seed `review`):* the bench is used.
Lineups swap about 1.15 of 4 starters a week, and most taverns field 6 to 8
different starters over a season (waiver pickups included). Injuries (D-51)
will lean on the bench more.

**D-04 Matchups and playoffs: DECIDED (2026-10-11): a league table.** No
matchups. Standings rank taverns by total loot over the season, and there
are no playoffs. Head to head (round-robin with a W-L record) was the
earlier default and is removed from the engine, config and sims.
- Why: with a home bonus (D-47), H2H made it matter whom you met in their
  home week. A table treats every tavern the same.
- Placement points per week (capping one blowout week) were considered and
  not chosen.

**D-05 Waivers: DECIDED (2026-10-13): reverse standings.** Built
(2026-10-13, T4.8): `waivers.priority: reverse_standings`,
`reverseStandingsPriority` and the `waiverPriority` selector. Season 1 and
the mock season use it; `rolling` stays available.
- Each waiver window, claims are tried in reverse order of the current
  standings: the lowest tavern on the table goes first. Ties on the table go
  to reverse draft order. Winning a claim doesn't move a tavern; the order is
  rebuilt from the standings every week.
- Why: a catch-up lever, and it pairs with injuries (D-51). A trailing, hurt
  tavern gets first look at replacements.
- *Not chosen:* rolling priority (the old default: initial order reverse
  draft, and a tavern that wins a claim moves to the back); blind bidding
  from a season budget, because issue forms are public (D-24), so bids would
  need sealed commitments.

**D-06 Trades: DEFAULTED.** Proposal by form, `/accept` by the counterparty,
24 h commissioner veto window, deadline after week 4. *Sub-question:* are
uneven trades allowed? *Default (as implemented in T4.5):* a trade passes if
each roster either keeps its size or ends between 1 and `roster.size`. So
between two full rosters an uneven trade always fails, because the receiver
would overflow. A 2-for-1 is allowed when the receiving roster has an open
slot, which leaves the giver one short until it claims a free agent.

**D-07 Missed lineup: DEFAULTED.** Last week's lineup carries over. See D-27
for the fallback.

**D-12 Captain's mechanical role: DECIDED (2026-10-13): no captain.** Not
built yet (lineups still carry an inert `captain` field).
- A party is four starters. There is no captain: no control, no tiebreak
  role, no story token.
- Why: a 2026-10-13 game-flow review found the inert captain to be a red
  herring (a "Make captain" control that changes nothing). Giving captains a
  strength and a weakness was decided earlier the same day and then
  withdrawn: with boons and hexes (D-52) and a home bonus, the game was
  layering three custom concepts that all meant "a bonus or penalty on some
  checks." D-52 keeps one, at the tavern level.
- What captains were also meant to do, giving taverns different draft
  shapes against the dominant `skill-coverage` strategy, now falls to boons.
  The sims have to show it (T9.4).
- This departs from the original brief, which required a captain.
- *Earlier options, kept for reference:* (a) cosmetic only, plus first in the
  best-fit tiebreak (the scaffold default); (b) the captain's checks get
  advantage, or +2; (c) the captain must make every check of one chosen type;
  (d) points ×1.5 when the captain is the actor on a passed check; (e) the
  captain's CR counts double against B; (f) about 8 captain-eligible
  characters, each with a strength and a weakness (decided and withdrawn
  2026-10-13).
- *Blocks:* T4.7, T9.3.

**D-14 Points scale and ties: SUPERSEDED by D-45 and D-04 (2026-10-11).**
Score is now loot, not a ratio, and with no matchups there are no weekly
ties to break. `scoring.tiebreakers` is removed: equal season totals share a
rank, and a tie for first gives co-champions. *Defaulted (2026-10-13):* a
tie for first at season end goes to the tavern with fewer DNFs over the
season, and co-champions only if that is tied too. Ties for first are rare
(5 in 300 mock seasons). *Built (2026-10-13, T4.9):* `standings(…, {
breakFirstTie })`, applied by `seasonStandings` once the season is complete. *Earlier open question:* whether to add
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
strictly better for the party. T6.1 implements this. With no captain
(D-12), ties go to lineup order alone.

**D-26 Draft pick timeout: DEFAULTED.** 24 h, then autopick with the `value`
bot. Alternatives: skip (pick later), or wait indefinitely.

**D-27 Fallback when the carried lineup is illegal: DEFAULTED.** Use the legal
lineup with the highest total CR, ties broken by roster draft order, with the
first-drafted as captain. If none is legal: no lineup, 0 points. With no
captain (D-12) the fallback names none, and its retreat order is `never`
(D-49).

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

**D-42 Public missions and pre-lock projections: DECIDED (2026-10-13): open
for now, plus keywords.** Missions are open today, and anyone can compute
exact projected points for every lineup before the lock. They will become
hidden until the lock (D-08's direction), and then the keywords below are
what managers plan from. Each
schedule entry gains a **keyword description** next to its title,
environment and theme: a short list of what the mission tests (skills, saves,
gates, the lead creature of each battle), for example
`[survival, stealth, athletics, con save, crocodile fight, lizardfolk fight]`.
Built (2026-10-13, T5.7): `keywords` in `schedule.yaml` and `season.created`,
the vocabulary and `dishonestKeywords` in `engine/src/missions/keywords.ts`,
checked by `validate` and at `mission.revealed`.
- Why keywords: they are the readable summary for managers who won't open
  mission YAML, and the vocabulary a hex (D-52) and environment fit are
  judged against.
- *Defaults (confirm):* keywords are authored in `schedule.yaml` by the GM.
  `lock-check` (T8.4) rejects a keyword that names nothing in the mission (no
  red herrings). The GM may leave things out.
- *Accepted cost:* the weekly lineup stays largely solvable. A 2026-10-13
  measurement (300 mock seasons, seed `review`) put optimizing the lineup at
  +4.7 points a week (the `value` bot at 59.4 against `projection-off` at
  54.7, same draft), against a week-to-week dice swing of about ±32 points
  (standard deviation of points minus projection). Depth is expected to come
  from boons and hexes (D-52), retreat orders (D-49) and the draft.
- *Once missions are hidden (D-08):* the "accepted cost" above goes away.
  Lineups, retreat orders and hexes are then chosen from the schedule and its
  keywords, and the projection is published after the run as feedback. The
  boon candidate "see the mission before the lineup" (D-52) becomes
  meaningful: everyone sees the mission at the lock, and the boon holder may
  change its lineup after the reveal. Keywords then carry real weight, so
  their honesty rule (no keyword that names nothing) matters more.
- *Options not chosen:* (b) publish each mission only at its week's lock
  (needs D-08 secrecy back); (c) publish structure but hide DCs until the run
  (knowing which skills are tested is most of the information); rumors only,
  with the full mission encrypted until the lock.
- *Blocks:* T5.7.

**D-40 Roster-level CR cap: DEFAULTED.** None. B applies only to starters.
Without a roster cap, drafting all high-CR characters is legal, but you can
only start about 12 CR worth. Sims will show whether high-CR hoarding is a
problem.

### Story and scoring (2026-10-11)

The story behind these is in [lore.md](lore.md). D-45 to D-48 are in the
engine.

**D-44 Story frame: DECIDED (2026-10-11).**
- Managers play barkeeps, each pushed around by a different god.
- Each god sponsors one tavern and sets one mission. The god chose the
  tavern; managers pick a tavern that is already blessed (D-52).
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
- *Open:* the haul amount.
- *Loot shape, decided (2026-10-13): rising loot, late climax.* Missions are
  authored so loot grows along each path and the biggest battle sits near the
  end. A DNF then costs about half the haul, retreat orders (D-49) matter, and
  the reveal builds to a peak. This is an authoring rule, not a hard
  validator rule. *Default (confirm):* the difficulty report (T7.2) flags a
  mission whose best path doesn't pay at least half its loot in its last
  third, or whose last battle isn't in the last third of its ranks.
  *Built (2026-10-13):* `lootShape` in `engine/src/missions` computes both,
  and the mock missions were rewritten to pass it (T5.8). Measured over 200
  mock seasons (seed `review`, bots always fight): DNFs rose from 15% to 30%
  of runs, since every path now meets a climax battle, and `cr-greedy`
  overtook `skill-coverage` for titles (0.33 against 0.20 per seat, from
  0.23 against 0.36). Bots that pick a retreat order (T9.5) should pull DNFs
  back down.

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

**D-47 Home bonus: DROPPED (2026-10-13), was ×1.25.** Season 1 sets
`scoring.homeBonus: 1` (off). The engine support stays, so it can come back
by config. The original entry follows. On its sponsor's mission, a
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
- *Built (2026-10-11):* the GM's season package sets it. `schedule.yaml`
  lists `sponsors` (god id → tavern) and each week's `sponsor`, and
  `config.yaml` sets `scoring.homeBonus` (1 turns it off). The engine only
  applies it: `runPoints` and `projectedPoints` multiply at home, and
  `verifyResolutions` audits it.
- *Dropped (2026-10-13).* A multiplier on every lineup never changes which
  lineup is best, so the bonus added standings noise without adding a
  decision. A "home blessing" (name a skill, get advantage on the home week)
  was decided and withdrawn the same day, to keep custom concepts to boons
  and hexes (D-52). Each god still sets one week's mission (D-48), as story.

**D-48 One mission per sponsor: DECIDED (2026-10-11).** The season has as many
weeks as taverns, and each week is one sponsor's mission.
- `weeks` follows the tavern count, so the tavern count must be fixed before
  missions are sealed. That means before the draft.
- D-01 caps a 64-character pool at 9 taverns.
- A mystery mission set by the GM is parked as an idea.
- *Built (2026-10-11):* `validateSponsors` enforces one week per sponsor
  and one sponsor per tavern, at load and at `season.created`. The first
  `draft.pick` requires every sponsored tavern to have joined. A week with
  `sponsor: null` is allowed (room for the mystery mission). That every
  tavern gets exactly one week is not enforced yet; lock-check (T8.4) is
  the place for it.

### Game flow (2026-10-13)

From a review of the weekly loop against Lostgarden's "game mechanics as
learning loops" framing: a mechanic should give the player an action, legible
feedback and something left to learn. The review found the weekly lineup
mostly solved by the projection, the mission run free of player choices, and
the captain and home bonus unable to change a decision. D-12 and D-42 above
come from the same review.

**D-49 Retreat orders: DECIDED (2026-10-13).** Built in the engine
(2026-10-13, T4.7, T6.6): `Lineup.retreat`, `retreatsBeforeBattle`,
`RunResult.retreatedBefore`, `Projection.pRetreat`, and the
`verifyResolutions` audit. Bots still always say `never` (T9.5).
- Each locked lineup carries a **retreat order**, which says when the party
  turns back instead of fighting:
  - `never`: always fight (the default, and today's behaviour).
  - `avoid_battles`: turn back before any battle.
  - `bank: N`: turn back before a battle once at least N loot is banked.
- The order is checked only when the party is about to enter a battle node.
  Checks carry no DNF risk, so turning back before one can never help.
- Turning back ends the mission and keeps the banked loot. It is not a DNF.
- Why: the run had no player choices. Push-your-luck gives a risk decision
  whose right answer depends on the standings as well as the expectation. A
  tavern that is behind late in the season has a reason to say `never`.
- The projection stays exact: propagation state becomes (node, loot banked),
  which is finite. The projection reports the expectation for every order,
  so the choice is informed, not solved.
- *Defaults (confirm):* `N` is a multiple of 10, up to the haul. A missed
  lineup carries its order over (D-07), and the D-27 fallback uses `never`.
- *Blocks:* T4.7, T6.6.

**D-50 Battles pay loot: DECIDED (2026-10-13): a bounty on a win.** Built
(2026-10-13, T5.8, T6.6). Before, a battle banks nothing, and the usual way into one is a
failed check, so one bad roll is punished twice: the check's loot is lost,
and the party risks a DNF for no reward. Now a battle node may carry `loot`,
banked on a win. The `haul` validator rule counts it like check loot.
Combined with D-49 this makes a fight a real choice: turn back with what you
have, or fight for the bounty. *Not chosen:* a failed check costs some banked
loot instead, which is harsher and closer to a DNF. *Blocks:* T5.8, T6.6.

**D-51 Injuries: DECIDED (2026-10-13): a random starter is hurt on a DNF.**
Built (2026-10-13, T6.7): `RunResult.injury`, `LeagueState.injuries`,
`injuredFor`, and `validateLineup`'s `injured` violation. *Measured* (200
mock seasons, seed `review`): 7 of 7,200 tavern-weeks had no legal lineup,
because the injury left no four under B, so the tavern scored 0. *Open
question:* should such a tavern start three, or go over B by the injured
starter's CR, instead of scoring 0?
- When a party loses a battle, one of its four starters, picked by a
  recorded random roll, is **injured**. An injured character can't start the
  next week's lineup. It can still be benched, traded or dropped.
- Why: nothing carried from one week to the next, so a week's result never
  fed the next week's decision. An injury ties battle risk to bench depth and
  gives retreat orders (D-49) more weight, since turning back avoids it.
- The week's projection is unaffected (an injury only touches later weeks),
  so it stays exact. The roll is part of `mission.resolved`, like the
  check and battle rolls (D-13).
- A carried lineup (D-07) that includes an injured starter is illegal, so
  the D-27 fallback applies.
- *Defaults (confirm):* injuries last one week and don't stack; an injury
  from the last week of a season expires at season end.
- *Not chosen:* form (+1 next week after a passed check: strong taverns get
  stronger), fatigue (a cap on consecutive starts: a chore), injuring the
  captain or the most expensive starter, or letting the manager choose.
- *Blocks:* T6.7.

**D-52 Taverns, gods, boons and hexes: DECIDED (2026-10-13).** The tavern
pick is built (2026-10-13, T4.10): `manager.joined`, `tavern.chosen`,
taverns with their gods in `schedule.yaml`, and bots choosing at random.
Hexes are built too (T6.9): `hex.declared`, `Party.hex`, disadvantage in
`checkOdds` and the run, the `verifyResolutions` audit, and a `leader` bot
strategy (in the second half, hex the highest rival who leads you, on the
ability with the most loot that week; in the last week regardless). Boons
are not built yet.
The only custom concepts on top of draft, monsters and missions. Each one
sits at its own level of play and borrows from D&D.
- **The god chooses the tavern.** Each tavern is already blessed by one god,
  and tavern and god are one identity (the pairing never changes). Managers
  don't pick gods; they pick taverns.
- **Tavern pick:** before the monster draft, managers pick taverns in
  **reverse** monster-draft order (the draft order is still the seeded
  shuffle, D-02). The manager who drafts monsters last gets first choice of
  tavern. It's public, like everything else.
- **Boon (season level):** each tavern's god grants it one boon, written on
  the tavern. Boons bend a rule rather than add a bonus. Inspired by the
  DMG's blessings, supernatural gifts from a deity, but not copied from it.
  *Playtest candidates:*

  | Candidate | Level | Inspiration | Notes |
  |---|---|---|---|
  | Jump ahead in the draft | draft | initiative | Works against the reverse-order compensation; size it (one slot? an extra early pick?) |
  | A DNF doesn't injure | mission | *Death Ward* | Passive, or N uses a season? Makes battles safer for that tavern (D-51) |
  | Anti-hex | week | *Remove Curse* | Ignore the first hex, or every hex? Most valuable to the leader |
  | CR budget increase | week | | +N to B. Once for one chosen mission, or a smaller +1 all season? |
  | See the mission before the lineup | week | *Augury* | Works once missions are hidden until the lock (D-08's direction): the holder may change its lineup after the reveal |
  | A recruit joins the party | week | a familiar, a hireling | A random undrafted monster of CR 1/2 or less joins as a fifth member. Outside B? Same recruit all season, or a new one each week? |
  | Advantage on checks | week | *Bless*, *Guidance* | Needs a scope: one ability score all season, or every check for one chosen mission |
  | Shared blessing | week | *Bless* (several targets) | Each mission, you and one other tavern of your choice get advantage on a named check. The first reason to cooperate; watch for two taverns trading it all season (kingmaking). "Named check": one check node in that week's mission, or a skill? |
  | Double battle bounty | mission | | Battle loot (D-50) ×2 for this tavern. Changes decisions: fight where others turn back. Strength depends on bounty sizes, not set yet |
  | Double check loot | mission | | As written, close to ×2 on the score, since checks hold most of the haul. Like the dropped home bonus, a multiplier that never changes which lineup is best. Scale it down: one doubled check per mission? |
  | Paid retreat | mission | | "Retreating still gets half the gold." Turning back already keeps all banked loot (D-49), so this needs defining: half the loot left on the path? Or retreat costs something by default and this boon removes the cost? |

  The list is open: these are candidates, and more can be added. A season
  uses six, one per tavern. Whether each boon is passive or has limited uses,
  and how strong it is, comes from playtests and sims. Rule-bending boons
  (draft order, injuries, hexes, information) and stat boons (advantage, a
  recruit, budget) should be compared separately: stat boons are easier to
  balance, and rule-bending ones are more distinctive.
- **Hex (week level):** once per season, a tavern names a rival, one
  **ability score** and one **week**. That week, the rival's party has
  disadvantage on every check and save that uses that ability. Modeled on
  *Bestow Curse* (SRD 5.1), which picks an ability score the same way.
  Battles are unaffected (the battle model has no ability checks).
  Disadvantage cancels advantage, as in 5e, and the projection stays exact.
  - *Defaults (confirm):* declared with an issue form any time before that
    week's lock, so it is public and the target can adjust its lineup; at
    most one hex per target per week (first declared wins); it can't be
    withdrawn; an unused hex expires at season end.
- **Carryover:** a manager's tavern, and so its god, boon and hex, is meant
  to stay with them from season to season. The details wait for Season 2.
  The one-character keeper (D-11) is unchanged.
- *Not chosen:* captains with strengths and weaknesses (D-12) and a home
  blessing (D-47), both withdrawn to keep the concept count down; managers
  choosing gods; a god "domain" of skills driving the boon, the hex and its
  mission's lean.
- *Blocks:* T4.10, T6.9, T6.10, T9.5.

**D-53 Longer, generated missions: DECIDED (2026-10-13).** Not built yet.
- Missions will come from a generator (the GM's own work, replacing most
  hand-authoring) and be about **twice as long**, with more branches.
- A 2026-10-13 experiment (300 mock seasons, seed `review`, each mock mission
  chained to the next) found that doubling the checks cut the weekly dice
  swing among finishers from about ±30 to ±24 points, and weeks with a tied
  top from 27% to 9%. Doubling the battles too nearly doubled DNFs (16% → 29%),
  which then caused about half of the remaining luck. The best projected
  season won the title 48% of the time, against 40%.
- *Defaults (confirm), as generator targets:* about twice today's checks per
  path; still 1–3 battles per path; about twice today's branching (more
  width doesn't cut luck, since a party walks one path, but it lets
  different rosters succeed by different routes); the D-45 shape (rising
  loot, late climax battle); D-39 gates as shortcuts only. The config limits
  (`maxNodes` 14, `maxRank` 8) rise to fit, about 28 and 14.
- *Blocks:* T5.9.

### Missions and secrecy

**D-08 Mission secrecy: DECIDED (2026-10-10): open for now. DIRECTION SET
(2026-10-13): hidden later.** Missions are open today: no sealing, encryption
or commitments. **They will become hidden until the lock**, which is still to
be implemented.
- Why: with open missions the weekly lineup is mostly solved by the
  projection (D-42), and the "see the mission" boon (D-52) can't work.
- *Defaults (confirm):* every mission is revealed to everyone at its week's
  lock, not just at the run. That leaves a window for the "see the mission"
  boon, and the reveal opens the week's drama. The mechanism is option (c)
  below, encrypted in the repo with sha256 commitments in `season.created`,
  so the weekly run stays automatic and every reveal is checkable.
- *Knock-on decisions:* D-09 (the GM again knows what managers don't), D-18
  (candidates and generator output must stay out of the public repo, or be
  encrypted too), D-42 (planning from keywords), and bots: `PublicView` may
  only show a mission after its lock, so sims need a lineup strategy that
  works from keywords.
- *Blocks:* T10.2, T10.6, T11.4 (reveal step).

The options considered are kept below for reference.

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

**D-18 Candidate missions are as secret as selected ones: MOOT for now
(2026-10-10), returns with hidden missions.** Missions are open today (D-08),
so candidates can be committed in plaintext. Once missions are hidden (D-08's
direction), the reasoning below applies again, and to the mission
generator's output (D-53) too. The brief puts
`missions/candidates/` in the repo, but the selected missions are a subset of
the candidates, so plaintext candidates in a public repo reveal the season.
Options: keep candidates out of the repo (local or a private companion repo),
encrypt them like selected missions, or use a private repo (D-08a). The
difficulty report is git-ignored for the same reason. *Default:* candidates
are git-ignored in real seasons. Only the hand-written example is committed.
*Blocks:* T5.4 output location, T7.2.

**D-09 GM integrity: DECIDED (2026-10-13).** The GM knows every mission (and, with D-13
unsalted, can compute every tavern's exact outcome for any lineup). Options:
(a) the GM is the commissioner and doesn't manage a tavern;
(b) co-GMs split missions, and each is blind to some weeks;
(c) missions are locked before the draft and the GM plays anyway, edge
accepted. That works best with salted seeds (D-13), so the GM knows the odds
but not the dice.
*Default:* (c) with salt, and the GM is listed in `managers.yaml`.
*Blocks:* T11.2 (whether the GM may hold a tavern).
*Decided (2026-10-13): (c), the GM may manage a tavern, edge accepted.*
Missions are locked and public before the draft (D-08, D-42), and the weekly
roll is a real random roll (D-13), so the GM knows neither more about
missions nor the dice than anyone else. The remaining edge is having written
the missions. The salt is moot. *Revisit when missions become hidden
(D-08):* the GM will then know every mission while managers see only
keywords, a real edge. Options then: (a) the GM doesn't manage a tavern, or
the generator (D-53) picks missions without the GM reading them in full.

**D-13 Seed salt: SUPERSEDED, DIRECTION SET (2026-10-10).** Each week's
result is an actual single random roll, **not** deterministic from a seed.
Details are still to be worked out. Consequences: `mission.resolved` stays the
record of truth, since its rolls can't be recomputed. `verifyResolutions`
shrinks to consistency checks (the path follows the recorded outcomes, and
the score matches). `rngFor` stays for sims, tests and the difficulty report.
The text below is the earlier analysis.

*Dice per tavern, confirmed (2026-10-13).* Each tavern rolls its own dice.
Shared dice per week (the alternative below) was measured and declined. In
300 mock seasons (seed `review`, the tavern id in `weekSeed` replaced by a
constant), shared dice raised how often the best-projected lineup topped its
week from 38% to 67%, and the `skill-coverage` bot's title share from 36% to
50%. Per-tavern dice keep upsets and a week-to-week swing of about ±32
points. How `run-week` draws and records the real roll is still T10.2.

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

**D-39 Capability gates on checks: DEFAULTED.** Should a check be able to require a
fly speed, darkvision, and so on? Gates create archetype dependency, the very
thing the difficulty report warns about, but they also give environment and
theme real teeth. *Default:* the schema supports `requires`, the validator
allows at most one gated check per mission, and the difficulty report flags it.
*Defaulted (2026-10-13): gates are shortcuts, not walls.* A party with no
special speeds or senses must still be able to reach the full haul. A gate
may only open a better or safer route. The `gates` validator rule enforces
it (built 2026-10-13, T5.8): with every gated check failed, the best path
must still pay the most.

**D-28 Battle model v0: OPEN.** Spec 05 sketches DPR/eHP time-to-kill,
logistic-squashed. Questions: party DPR as a sum of members; how to model
multiattack; whether `battle_bonus` is additive to DPR or to the logistic input;
calibration target (e.g. an encounter at CR = B → p(win) ≈ 0.5?).
*Default:* ship a simple model behind the `BattleModel` interface (T6.2), and
calibrate in T9.3. *Blocks:* nothing on the critical path.

### Characters, modifiers, carryover

**D-11 Carryover rules: DECIDED (2026-10-13): 1 keeper, no champion bonus.**
Every tavern may keep 1 character. A keeper costs the pick in the round it was
drafted last season (undrafted pickups cost the last round). Modifier drift on
keepers is at most 1 point. The champion gets no extra keeper
(`carryover.championBonusKeepers: 0`): a keeper gives every tavern a
long-term reason to care, without rewarding last season's winner twice.
*Not chosen:* the champion bonus keeper (the old default), no keepers (a
clean redraft), keeper salary (its CR counts +1 against B).
*Blocks:* T3.6, T10.3.

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

**D-10 Image storage: DECIDED (2026-10-11).** Plain git, because the images
are tiny: palette-locked pixel art, 112×144 portraits at
`characters/<id>/portrait.png` and 216×72 covers at
`seasons/<s>/chrome/<mission>.cover.png`, about 2–3 KB each. `validate`
enforces size, palette and a 32 KB cap per file, so nothing large slips in.
Raw renders and candidates are never committed (`.image-drafts/` is
git-ignored). This replaces "never plain-git binaries". LFS or a bucket only
comes back if the style moves to large painted images. Style and pipeline:
[images.md](images.md). *Unblocks:* T8.7.

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
| Δ-07 | Seeded procedural mission generator | A generator again (D-53, 2026-10-13), built by the GM. Before that: no generator; the LLM proposed, the engine validated, the GM curated. The engine still validates and the GM still curates | 04 |
| Δ-08 | `[flavor]` grammar seeded per node; `{skill}`, `{dc}` tokens | Authored per-outcome chrome. Data-bound tokens kept (`{actor}`, `{battle_creature}`, plus `{allies}`, `{tavern}`; `{captain}` goes with D-12). `{skill}`, `{dc}` dropped as mechanical facts | 04 |
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
