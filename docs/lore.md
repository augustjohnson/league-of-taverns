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
| Someone limps home hurt | Injury: after a DNF, one starter sits out next week (D-51) |
| The party thinks better of it and turns for home | Retreat order: turn back before a battle with the loot in hand (D-49) |
| A god chose this tavern long before the barkeep noticed | Every tavern is already blessed; managers pick a tavern, not a god (D-52) |
| The god's favour | Boon: one rule bent for that tavern (D-52) |
| The god's spite | Hex: once a season, curse a rival's party for one trial (D-52) |
| The **scrying ball** in each tavern shows the run as it happens | The narrated run. Before the run, the ball's odds are the projected points |

## Where story touches play

Chrome (names, backstories, story text) still never affects play. A few
**story-shaped rules** do. They are ordinary rules in the season config, and
the story explains them. The test for adding one is that **it treats every
tavern the same over a season**. A hex passes because every tavern gets
exactly one. (The home bonus passed for the same reason, with one home week
each, but was dropped to keep the rules small, D-47.)

Which god sponsors which tavern, and which trial is whose, is mechanical data.
Each god's name, personality and the words it speaks are chrome.

## Ideas, not rules

These are not decided. Each one would need its own decision before it goes in.
Mission shape (rising loot, a late climax) became a rule in D-45, injuries
became D-51, and boons and hexes became D-52.

- **A mystery mission.** A secret extra trial chosen by the GM and set by no
  sponsoring god. It could be a finale, a tiebreaker, or loot only.
- **Round-by-round battles.** Replace the black-box `pWin` (ev-ttk-v0) with
  a battle simulated round by round, with real HP per combatant, so the log
  knows who dropped and when. Injuries (D-51) could then hit whoever
  actually fell, instead of a random starter. Cost: the exact projection no
  longer works (it would need sampling or a much harder calculation).
- **Sponsor gifts.** At season start each sponsor offers its tavern a choice
  of one of three magic items (say a headband of intellect, a belt of
  dwarvenkind, or Blackrazor), held by one character. Simple items map onto
  the modifier registry (skill and save bonuses, advantage, senses,
  `battle_bonus`). Ability-score items like the headband need the engine to
  set ability scores. Items with active effects (Blackrazor) only make sense
  with round-by-round battles. Close kin of boons (D-52).
- **Gods' tastes.** Each god's trial leans on its domain: the sea god writes
  swimming checks. That gives each tavern a reason to draft for its own week
  without adding a rule.
- **Open questions:**
  - Does the barkeep argue with the god?
  - Are the gods named characters, or just "the Voice"?
  - Do gods stay with the same tavern from season to season?
  - Why are the gods doing this at all?
