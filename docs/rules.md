# Rules (draft)

> Draft rulebook for Season 1. Items tagged **[OPEN D-xx]** are defaults
> pending [decisions.md](decisions.md). Every number here is a per-season
> setting in `seasons/<id>/config.yaml`. Where this file and the config
> disagree, the config wins and this file has a bug.

## 1. The league

- A **season** has one weekly **mission** per tavern **[D-48]**. Each tavern
  has a **sponsor** (a god), and each week is one sponsor's mission
  ([lore.md](lore.md)).
- Each **manager** runs one **tavern**. Managers are listed in
  `managers.yaml` and identified by GitHub account. A league has at most
  **6 taverns** **[D-01]**, so a season is 6 weeks.
- **Gods, boons and hexes** **[D-52, not built yet]:** every tavern is
  already blessed by one god, and the pairing never changes. The god gives
  its tavern:
  - a **boon**, which bends one rule for that tavern (the list is being
    playtested: for example, a DNF doesn't injure, or a bigger CR budget for
    one mission), and
  - one **hex** per season (§6).
  A manager keeps their tavern from season to season (details for Season 2).
  There is no home bonus **[D-47]**.
- A **commissioner** administers the league: vetoes, disputes, and
  `managers.yaml`. A **GM** curates characters, modifiers and missions. They
  may be the same person, and the GM may also manage a tavern **[D-09]**.
- All manager actions go through **GitHub issue forms** (§10). Nothing
  counts unless an Action records it as an event.

## 2. Characters and the pool

- A **character** is a named monster with a stable id (e.g.
  `bruno-the-bruiser`) built on an Open5e stat block (its **base**, e.g.
  `ogre`). Two characters can share a base.
- Each season the GM publishes a **pool** of about 64 characters, each with this
  season's **modifiers**: small mechanical tweaks from a fixed list, within a
  per-character budget (3 points in Season 1). The pool, bases and
  modifiers are all public before the draft.
- A character's **chrome** (name, epithet, backstory, portrait) is cosmetic
  and never affects play.
- A character's **CR** is its base CR. Modifiers never change CR. CR is the
  salary: it is what counts against the budget.

## 3. Rosters

- Rosters hold **7** characters **[D-03]**.
- **Exclusive ownership:** a character belongs to at most one tavern
  **[D-01]**. Unowned pool characters are **free agents**.
- There is no roster-level CR cap. The budget applies only to the four starters
  **[OPEN D-40]**.

## 4. The draft

- **Snake draft**, 7 rounds **[D-02]**. Round 1 runs in draft order,
  round 2 in reverse, and so on.
- Draft order is a seeded shuffle of the joined taverns, reproducible from
  the season id. The commissioner may set it manually instead.
- Taverns cannot join after the first pick.
- Each pick has a **24-hour window**. On timeout the tavern autopicks with the
  `value` bot strategy **[OPEN D-26]**.
- Keepers from last season (§12) are placed before the draft and cost the
  tavern a pick **[OPEN D-11]**.
- **Tavern pick** **[D-52, not built yet]:** before the draft, managers
  choose taverns (each with its god, boon and hex) in **reverse** draft
  order. The manager who drafts monsters last chooses a tavern first.

## 5. Lineups and the budget

- Each week a tavern starts a **party** of **4** from its roster. There is
  no captain **[D-12]**. The other 3 sit on the **bench**. Choosing who
  starts is the main weekly decision. *(Until this is built, lineups still
  name an inert captain, which only breaks best-fit ties.)*
- **Budget:** the total CR of the four starters must be **≤ B**. Season 1 uses
  B = 12. Fractional CRs count exactly (four CR 1/2 characters total 2).
- An **injured** character (§6) can't start the week after its injury
  **[D-51, not built yet]**.
- **Retreat order** **[D-49, not built yet]:** each lineup also says when the
  party turns back instead of fighting: `never` (the default),
  `avoid_battles`, or `bank: N` (turn back before a battle once at least N
  loot is banked). Turning back keeps the banked loot and is not a DNF (§6).
- **Submitting:** use the *Set lineup* form any time before the weekly lock.
  The latest valid submission counts. An invalid submission is rejected with
  reasons and leaves the previous one standing.
- **Lock:** at the weekly lock (Thursday 18:00 UTC), every tavern's lineup is
  frozen in one `lineup.locked` event.
- **Missed lineups** **[OPEN D-07]:** with no submission, last week's
  lineup carries over. If the carried lineup is illegal (a starter was traded,
  dropped or claimed away), or there is no previous lineup, a fallback picks the
  legal lineup with the highest total CR, ties broken by draft order
  **[OPEN D-27]**. A carried lineup keeps its retreat order, and the
  fallback uses `never` **[D-49]**. A tavern with no legal lineup at all
  scores 0 for the week.

## 6. Missions

- Each week has a **public schedule entry**: title, environment, theme, and
  a **keyword description** of what the mission tests (skills, saves, gates,
  the lead creature of each battle) **[D-42, keywords not built yet]**.
- The **mission itself** is a branching path of **skill checks** and
  **battles** that the GM locked before the draft. For now missions are
  public (§11), so a manager may read the full mission before the lock.
  *Planned* **[D-08]**: each mission stays hidden until its week's lock, and
  managers plan from the schedule entry and its keywords.
- **Checks:** a d20 plus the party's best modifier for that check, against a
  DC. Pass chance = `clamp((21 − (DC − mod)) / 20, 0, 1)`. Each check is made
  by the starter with the best modifier for it (**best fit**). Some modifiers
  grant **advantage** (roll twice, keep the higher).
- Some checks need a capability (a fly speed, darkvision). If no starter has
  it, the check fails automatically **[D-39]**. A gate only opens a better or
  safer route: a party with no special speeds or senses can still reach the
  full haul.
- **Battles:** the party's odds of winning come from its combined strength
  against the encounter. **Losing any battle ends the mission (DNF).** The
  party keeps the loot banked so far **[D-46]**. A battle may carry loot,
  banked when the party wins **[D-50, not built yet]**.
- **Injuries** **[D-51, not built yet]:** when a party loses a battle, one
  of its four starters, picked by a recorded random roll, is injured and
  can't start next week. Injuries last one week.
- **Hex** **[D-52, not built yet]:** once per season, a tavern names a
  rival, one **ability score** and one **week**. That week, the rival's party
  has disadvantage on every check and save using that ability (like
  *Bestow Curse*). Battles are unaffected, and disadvantage cancels
  advantage. A hex is declared with an issue form any time before that
  week's lock, so it is public and the target can adjust. At most one hex
  per target per week (the first declared counts), and it can't be withdrawn.
- **Turning back** **[D-49, not built yet]:** just before a battle, the
  party's retreat order (§5) is checked. If it says to turn back, the mission
  ends there, the party keeps its banked loot, and it is not a DNF.
- Passing or failing a check decides which way the mission branches. Failing
  often leads into a battle.
- **Shape** **[D-45]:** missions are authored so loot rises along each path
  and the biggest battle comes near the end.

## 7. Scoring

- **Loot:** each check carries a loot value. Passing a check banks it, and
  failing banks nothing **[D-45]**. Battles may carry loot too, banked on a
  win **[D-50, not built yet]**.
- **Score** for a week = loot banked. **Points** = loot.
- **Fixed haul:** every mission's best path pays the same total loot, so every
  week counts equally **[D-45]**.
- **No home bonus** **[D-47]:** a god's own week gives its tavern nothing
  extra (`scoring.homeBonus: 1`).
- In the engine, score = loot ÷ haul and points = round(score ×
  `pointsScale`). With the haul and `pointsScale` both 100, points equal loot.
- **Sponsors come from the GM's season package:** `schedule.yaml` names
  each god, the tavern it backs and the week it sets. `config.yaml` can still
  turn a home bonus back on (`scoring.homeBonus`).
- Each week runs **once**, as a single real random roll per check and battle
  **[D-13, details to come]**. The rolls are recorded in the event log, so the
  result is final and auditable, though not re-derivable from a seed.
- **Projected points** are the exact expected points for the lineup on that
  mission (no dice). They are published next to actual points after the run.
  While missions are public (§11), managers can also work them out before
  the lock **[D-42]**. Once missions are hidden **[D-08]**, they can't.

## 8. Standings

- **League table** **[D-04]:** no matchups. Every week, every tavern runs the
  same mission against the whole league. Standings rank taverns by **total
  loot** over the season.
- **Ties** **[D-14]:** equal totals share a rank. A tie for first at season
  end goes to the tavern with fewer DNFs over the season, and gives
  co-champions only if that is tied too.
- **No playoffs.** The champion is the top of the table after the last week.

## 9. Free agents and waivers

- Free agents are claimed with the *Waiver claim* form. A claim adds one free
  agent and drops one rostered character if the roster is full.
- Claims resolve **once a week, after the run** (Friday 12:00 UTC), all
  together.
- **Reverse-standings priority** **[D-05, not built yet]:** each window, the
  lowest tavern on the table claims first. Ties on the table go to reverse
  draft order. Each claim, in priority order, is awarded if the character is
  still available and the drop is still legal. Winning a claim doesn't move a
  tavern: the order is rebuilt from the standings every week. A tavern's own
  claims are tried in submission order. *(Until this is built: rolling
  priority, initial order reverse draft, and a tavern that wins a claim moves
  to the back.)*
- Dropped characters become free agents at once and can be claimed in the
  next window.
- A character claimed or dropped after the lock still played this week for its
  old tavern. Roster changes take effect for the next lineup.

## 10. Trades

- Propose with the *Trade offer* form: what you give, what you receive.
- The other manager accepts by commenting `/accept` on the issue **[OPEN D-06]**.
  Closing the issue or commenting `/decline` cancels the trade.
- After acceptance, the commissioner has **24 hours** to `/veto` with a reason.
  If there is no veto, the trade **completes**.
- The trade is re-checked at completion: both rosters must still own the
  characters and stay within roster size. If not, it is cancelled.
- No trades complete after the **week 4** lock (trade deadline).
- Lineups already locked are unaffected. Traded characters join their new
  tavern from the next lineup.

## 11. What is revealed, and when

| When | Public |
|---|---|
| Season announced | Config, schedule (title, environment, theme and keywords per week), pool with bases and modifiers, every tavern's god, boon and hex, character chrome |
| Once selected | Every mission's full structure, for now. *Planned* **[D-08]**: hidden until its week's lock, with only a sha256 commitment public before then |
| Before the draft | Which manager chose which tavern **[D-52]** |
| During the season | All rosters, transactions, lineup submissions and declared hexes (issues are public) **[D-24]** |
| Weekly lock | Every tavern's lineup. *Planned* **[D-08]**: that week's mission |
| Weekly run | Every tavern's per-node rolls and path, actual and projected points, and the story |

Candidate missions can be committed in plaintext too **[D-18, moot]**.

## 12. Carryover between seasons

**[D-11]**. Applied when Season 2 is created:

- Each tavern may **keep 1** character from its final roster. The champion
  gets no extra keeper.
- A keeper costs the pick in the round where that character was drafted last
  season. Undrafted pickups cost the last round.
- A kept character returns with its id, chrome and career history. The GM may
  change its modifiers by **at most 1 point** for the new season.
- Characters that nobody keeps may return to the new pool or retire, at the
  GM's discretion.
- Career history (seasons, taverns, points, missions) follows the character
  id across seasons.

## 13. Integrity

- Every action is an event in an append-only log, written only by Actions.
  Anyone can replay the log and get the same standings.
- Each `mission.resolved` records the exact rolls, and anyone can check that
  the recorded path and score follow from them.
- Missions are locked before the draft. Changing a selected mission after
  `season.created` is a rules violation that CI flags.
- The GM knows every mission and may still manage a tavern **[D-09]**.
  For now missions are locked and public before the draft, and the weekly
  roll is real, so the GM's only edge is having written them. This is
  revisited when missions become hidden **[D-08]**.
