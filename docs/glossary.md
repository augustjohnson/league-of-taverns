# Glossary

| Term | Meaning |
|---|---|
| **Actor** | The starter who makes a given check: the one with the best modifier for it (best fit). Shown as `{actor}` in story text. |
| **Advantage** | Roll two d20s and keep the higher. Pass chance becomes `1 − (1 − p)²`. Granted only by modifiers. |
| **B** | The party CR budget. The total CR of the four starters must be ≤ B. |
| **Base** | A character's raw Open5e stat block, identified by slug (e.g. `ogre`), from the season's pinned snapshot. |
| **Battle** | A mission node won or lost on a black-box `p(win)` from party vs encounter. A loss is a DNF. |
| **Bench** | Rostered characters not starting this week. |
| **Best fit** | Assignment rule: each check goes to the starter with the highest modifier for it. |
| **Bot manager** | A strategy that plays a tavern headless, used in sims. |
| **Captain** | One of the four starters, designated by the manager. Mechanical role is OPEN (D-12). |
| **Carryover / keeper** | A character a tavern keeps into the next season. |
| **Character** | A named monster with a stable id, a base, per-season modifiers, and chrome. |
| **Check** | A mission node resolved by d20 + modifier vs DC. Pass or fail picks the branch. |
| **Chrome** | Cosmetic layer: names, epithets, backstories, portraits, mission story text. Never affects play. |
| **Commissioner** | League administrator: vetoes, disputes, managers list. |
| **Commitment** | sha256 of a sealed mission's canonical JSON, published before the draft. |
| **CR** | Challenge rating from the base stat block. Works as salary against B. Held in eighths internally. |
| **DAG (layered)** | Mission graph whose edges always point to a higher rank, so every traversal terminates. |
| **DC** | Difficulty class of a check. |
| **DNF** | Did not finish: lost a battle. Scores 0. |
| **Effective stats** | Base stats with season modifiers applied. All the engine ever sees. |
| **Encounter** | The creatures in a battle node, as Open5e slugs with counts. |
| **Event** | One append-only record in a season's log. All state is folded from events. |
| **GM** | Curates characters, modifiers, missions and chrome. Knows every mission. |
| **Manager** | A human (or bot) running a tavern. |
| **Mission** | One week's hidden challenge: a layered DAG of checks and battles. |
| **Modifier** | A GM-authored mechanical delta from the closed registry, within a per-character budget. |
| **Party** | A tavern's four starters for one week: captain + 3 allies. |
| **Points** | Score × 100, rounded. |
| **Pool** | The season's ~64 draftable characters with their modifiers. |
| **Projected points** | Exact expected points for a lineup on a mission, by propagation. No dice. |
| **Propagation** | Pushing probability forward through the DAG to get an exact expectation. |
| **Rank** | A node's layer index in the mission DAG. |
| **Reveal** | Unsealing a week's mission at run time and checking it against its commitment. |
| **Roster** | A tavern's owned characters (7). |
| **Salt** | Optional per-week secret mixed into the dice seed and revealed with the mission (D-13). |
| **Score** | Checks passed ÷ checks attempted on the path taken, or 0 on DNF. |
| **Seal** | Keeping selected missions secret until their week (D-08). |
| **Snapshot** | An immutable, verbatim pull of Open5e records, pinned per season. |
| **Starter** | One of the four characters in this week's party. |
| **Tavern** | A manager's team. |
| **Through-line** | A season-long story thread in chrome. |
| **Trait** | A named bundle of primitive modifiers in the registry (e.g. `amphibious`). |
| **Waivers** | The weekly process for claiming free agents in rolling priority. |
