# Lore

The story frame for the league, and the few places where it touches the rules.
The rules themselves live in [rules.md](rules.md). The decisions behind this
page are D-44 to D-48 in [decisions.md](decisions.md).

## The premise

Each manager plays a **barkeep**: an ordinary person who happens to own a
tavern. One day a god's voice turns up in their head and starts giving orders.
Every tavern in the league has a different god, and the barkeep never asked
for any of it.

The gods are competing with each other, and they do it through the taverns.
Each god **sponsors** one tavern and sets one **trial** (a mission). Every
week one god's trial runs, and every tavern's party attempts it.

The taverns all know about each other. That's why there is trash talk, there
are trades, and there's a waiver wire.

## How the story maps to the rules

| Story | Rule |
|---|---|
| A barkeep yanked around by a god | A manager running a tavern |
| Each god sponsors one tavern and sets one trial | One mission per tavern. The season has as many weeks as taverns (D-48) |
| **Recruitment night:** whoever walks in the door that night | The draft from a shared pool |
| Stragglers who turn up after recruitment night | Free agents and waivers |
| The party heads out on the god's trial | The weekly mission, run once |
| Loot carried home | Score (D-45) |
| The party is beaten and flees with what it is carrying | DNF: the mission ends and the party keeps the loot banked so far (D-46) |
| The god is generous with its own tavern on its own trial | Home bonus: ×1.25 loot (D-47) |
| The **scrying ball** in each tavern shows the run as it happens | The narrated run. Before the run, the ball's odds are the projected points |

## Where story touches play

Chrome (names, backstories, story text) still never affects play. A few
**story-shaped rules** do. They are ordinary rules in the season config, and
the story explains them. The test for adding one is that **it treats every
tavern the same over a season**. The home bonus passes because every tavern
gets exactly one home week.

Which god sponsors which tavern, and which trial is whose, is mechanical data.
Each god's name, personality and the words it speaks are chrome.

## Ideas, not rules

These are not decided. Each one would need its own decision before it goes in.

- **A mystery mission.** A secret extra trial chosen by the GM and set by no
  sponsoring god. It could be a finale, a tiebreaker, or loot only.
- **Boons and hexes.** Each god gives its tavern one sealed favour per season,
  played when lineups lock and revealed at the run. It could be a buff to your
  own party or a hex on a rival's. It would be built from the modifier
  registry and kept secret with a commitment, the same way missions are. It
  could expand into more Survivor-style play (alliances, sabotage), but
  complexity climbs quickly.
- **Mission shape.** Loot that grows with each check, and the hard battle late
  in the mission. A DNF then costs roughly half the haul, and the scrying ball
  gets a climax.
- **Round-by-round battles.** Replace the black-box `pWin` (ev-ttk-v0) with
  a battle simulated round by round, with real HP per combatant, so the log
  knows who dropped and when. That opens rules like injuries: the last party
  member standing in a TPK is unavailable the following week. Costs: the
  exact projection no longer works (it would need sampling or a much harder
  calculation), and injuries are a rules change with a knock-on to lineups.
- **Sponsor gifts.** At season start each sponsor offers its tavern a choice
  of one of three magic items (say a headband of intellect, a belt of
  dwarvenkind, or Blackrazor), held by one character. Simple items map onto
  the modifier registry (skill and save bonuses, advantage, senses,
  `battle_bonus`). Ability-score items like the headband need the engine to
  set ability scores. Items with active effects (Blackrazor) only make sense
  with round-by-round battles. Close kin of boons and hexes above.
- **Gods' tastes.** Each god's trial leans on its domain: the sea god writes
  swimming checks. That gives each tavern a reason to draft for its own week
  without adding a rule.
- **Open questions:**
  - Does the barkeep argue with the god?
  - Are the gods named characters, or just "the Voice"?
  - Do gods stay with the same tavern from season to season?
  - Why are the gods doing this at all?
