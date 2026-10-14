# Glossary

| Term | Meaning |
|---|---|
| **Actor** | The starter who makes a given check: the one with the best modifier for it (best fit). Shown as `{actor}` in story text. |
| **Advantage** | Roll two d20s and keep the higher. Pass chance becomes `1 − (1 − p)²`. Granted only by modifiers. |
| **B** | The party CR budget. The total CR of the four starters must be ≤ B. |
| **Barkeep** | Story name for a manager: an ordinary tavern owner pushed around by a god (lore.md). |
| **Base** | A character's raw Open5e stat block, identified by slug (e.g. `ogre`), from the season's pinned snapshot. |
| **Battle** | A mission node won or lost on a black-box `p(win)` from party vs encounter. A win may bank loot (D-50). A loss is a DNF and injures a starter (D-51). |
| **Boon** | A rule-bending gift a tavern's god grants it, such as "a DNF doesn't injure" (D-52). |
| **Bench** | Rostered characters not starting this week. |
| **Best fit** | Assignment rule: each check goes to the starter with the highest modifier for it. |
| **Bot manager** | A strategy that plays a tavern headless, used in sims. |
| **Carryover / keeper** | A character a tavern keeps into the next season. |
| **Character** | A named monster with a stable id, a base, per-season modifiers, and chrome. |
| **Check** | A mission node resolved by d20 + modifier vs DC. Pass or fail picks the branch. |
| **Chrome** | Cosmetic layer: names, epithets, backstories, portraits, mission story text. Never affects play. |
| **Commissioner** | League administrator: vetoes, disputes, managers list. |
| **Commitment** | sha256 of a sealed mission's canonical JSON, published before the draft. |
| **CR** | Challenge rating from the base stat block. Works as salary against B. Held in eighths internally. |
| **DAG (layered)** | Mission graph whose edges always point to a higher rank, so every traversal terminates. |
| **DC** | Difficulty class of a check. |
| **DNF** | Did not finish: lost a battle. The mission ends and the party loses everything it banked on it (D-54). Missions aim for about 5% of runs. |
| **Effective stats** | Base stats with season modifiers applied. All the engine ever sees. |
| **Encounter** | The creatures in a battle node, as Open5e slugs with counts. |
| **Event** | One append-only record in a season's log. All state is folded from events. |
| **Fixed haul** | The loot every mission's best path pays, the same for every week (D-45). |
| **GM** | Curates characters, modifiers, missions and chrome. Knows every mission. |
| **Hex** | Once per season, a tavern names a rival, an ability score and a week; that week the rival has disadvantage on checks and saves with that ability (D-52). |
| **Home bonus** | Loot multiplier for a tavern on its sponsor's mission. Dropped for Season 1 (D-47). |
| **Home mission** | The mission set by a tavern's own sponsor. |
| **Keywords** | A schedule entry's short list of what its mission tests: skills, saves, gates, battle leads (D-42). |
| **Injury** | After a DNF, one starter (picked by a recorded roll) can't start the next week (D-51). |
| **Loot** | Value banked by passing a check or winning a battle (D-45, D-50). Sums to the score. |
| **Manager** | A human (or bot) running a tavern. |
| **Mission** | One week's hidden challenge: a layered DAG of checks and battles. |
| **Modifier** | A GM-authored mechanical delta from the closed registry, within a per-character budget. |
| **Party** | A tavern's four starters for one week. No captain (D-12). |
| **Points** | Equal to loot (D-45). |
| **Pool** | The season's ~64 draftable characters with their modifiers. |
| **Projected points** | Exact expected points for a lineup on a mission, by propagation. No dice. |
| **Propagation** | Pushing probability forward through the DAG to get an exact expectation. |
| **Retreat order** | Part of a lineup: when the party turns back before a battle instead of fighting (`never`, `avoid_battles`, `bank: N`). Turning back keeps banked loot and is not a DNF (D-49). |
| **Rank** | A node's layer index in the mission DAG. |
| **Recruitment night** | Story name for the draft. |
| **Reveal** | Unsealing a week's mission at run time and checking it against its commitment. |
| **Roster** | A tavern's owned characters (7). |
| **Salt** | Optional per-week secret mixed into the dice seed and revealed with the mission (D-13). |
| **Score** | Loot banked on the week's mission, × 1.25 on the home mission (D-45, D-47). |
| **Scrying ball** | Story device that shows a tavern its party's run. |
| **Seal** | Keeping selected missions secret until their week (D-08). |
| **Snapshot** | An immutable, verbatim pull of Open5e records, pinned per season. |
| **Sponsor** | The god behind a tavern. Each sponsor sets one mission per season (D-44, D-48). |
| **Starter** | One of the four characters in this week's party. |
| **Tavern** | A manager's team, permanently blessed by one god, with that god's boon and hex (D-52). |
| **Tavern pick** | Before the draft, managers choose taverns in reverse draft order (D-52). |
| **Through-line** | A season-long story thread in chrome. |
| **Trait** | A named bundle of primitive modifiers in the registry (e.g. `amphibious`). |
| **Waivers** | The weekly process for claiming free agents, in reverse-standings priority (D-05). |
