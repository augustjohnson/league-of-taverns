# Rules (draft)

> Draft rulebook for Season 1. Items tagged **[OPEN D-xx]** are defaults
> pending [decisions.md](decisions.md). Every number here is a per-season
> setting in `seasons/<id>/config.yaml`. Where this file and the config
> disagree, the config wins and this file has a bug.

## 1. The league

- A **season** has a short schedule of weekly **missions**: 6 in Season 1.
- Each **manager** runs one **tavern**. Managers are listed in
  `managers.yaml` and identified by GitHub account.
- A **commissioner** administers the league: vetoes, disputes, and
  `managers.yaml`. A **GM** curates characters, modifiers and missions. They
  may be the same person **[OPEN D-09]**.
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

- Rosters hold **7** characters **[OPEN D-03]**.
- **Exclusive ownership:** a character belongs to at most one tavern
  **[OPEN D-01]**. Unowned pool characters are **free agents**.
- There is no roster-level CR cap. The budget applies only to the four starters
  **[OPEN D-40]**.

## 4. The draft

- **Snake draft**, 7 rounds **[OPEN D-02]**. Round 1 runs in draft order,
  round 2 in reverse, and so on.
- Draft order is a seeded shuffle of the joined taverns, reproducible from
  the season id. The commissioner may set it manually instead.
- Taverns cannot join after the first pick.
- Each pick has a **24-hour window**. On timeout the tavern autopicks with the
  `value` bot strategy **[OPEN D-26]**.
- Keepers from last season (§12) are placed before the draft and cost the
  tavern a pick **[OPEN D-11]**.

## 5. Lineups and the budget

- Each week a tavern starts a **party** of **4**: **1 captain + 3 allies**,
  all from its roster. The other 3 sit on the **bench**. Choosing who starts
  is the main weekly decision.
- **Budget:** the total CR of the four starters must be **≤ B**. Season 1 uses
  B = 12. Fractional CRs count exactly (four CR 1/2 characters total 2).
- The **captain's mechanical role** is not yet defined **[OPEN D-12]**. Until
  it is, the captain is named in the story and is first in tiebreak order for
  best-fit assignment (§6).
- **Submitting:** use the *Set lineup* form any time before the weekly lock.
  The latest valid submission counts. An invalid submission is rejected with
  reasons and leaves the previous one standing.
- **Lock:** at the weekly lock (Thursday 18:00 UTC), every tavern's lineup is
  frozen in one `lineup.locked` event.
- **Missed lineups** **[OPEN D-07]:** with no submission, last week's
  lineup carries over. If the carried lineup is illegal (a starter was traded,
  dropped or claimed away), or there is no previous lineup, a fallback picks the
  legal lineup with the highest total CR, ties broken by draft order
  **[OPEN D-27]**. A tavern with no legal lineup at all scores 0 for the week.

## 6. Missions

- Each week has a **public schedule entry**: title, environment and theme.
  That is all managers know when they set lineups.
- The **mission itself** is hidden until the week runs. It is a branching path
  of **skill checks** and **battles** that the GM locked before the draft.
- **Checks:** a d20 plus the party's best modifier for that check, against a
  DC. Pass chance = `clamp((21 − (DC − mod)) / 20, 0, 1)`. Each check is made
  by the starter with the best modifier for it (**best fit**). Some modifiers
  grant **advantage** (roll twice, keep the higher).
- Some checks need a capability (a fly speed, darkvision). If no starter has
  it, the check fails automatically **[OPEN D-39]**.
- **Battles:** the party's odds of winning come from its combined strength
  against the encounter. **Losing any battle ends the mission (DNF) with score 0.**
- Passing or failing a check decides which way the mission branches. Failing
  often leads into a battle.

## 7. Scoring

- **Score** for a week = checks passed ÷ checks attempted on the path the party
  actually took. A DNF scores 0.
- **Points** = score × 100, rounded **[OPEN D-14]**.
- Each week runs **once**, with dice seeded by (season, week, tavern)
  **[OPEN D-13: plus a secret salt]**. The result is final and reproducible.
- **Projected points** are the exact expected points for the lineup on that
  mission (no dice). They are published next to actual points after the run.
  They cannot be known before the lock, because the mission is hidden.

## 8. Matchups and standings

- **Head to head** **[OPEN D-04]:** each week, every tavern is paired with an
  opponent on a round-robin schedule published before the draft. Higher points
  wins the week.
- **Ties** **[OPEN D-14]:** broken in order by higher projected points, then
  more checks passed, then a seeded coin flip. With the coin in the list, no
  week ends tied.
- **Standings:** win-loss record, then total points for, then total points
  against.
- **Playoffs** are off for a 6-week season **[OPEN D-04]**. The champion is
  the top of the standings after week 6.

## 9. Free agents and waivers

- Free agents are claimed with the *Waiver claim* form. A claim adds one free
  agent and drops one rostered character if the roster is full.
- Claims resolve **once a week, after the run** (Friday 12:00 UTC), all
  together.
- **Rolling priority** **[OPEN D-05]:** initial order is reverse draft order.
  Each claim, in priority order, is awarded if the character is still
  available and the drop is still legal. A tavern that wins a claim moves to
  the back of the order. A tavern's own claims are tried in submission order.
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
| Season announced | Config, schedule (title, environment, theme per week), H2H pairings, pool with bases and modifiers, character chrome |
| Before the draft | A commitment hash of every locked mission **[D-08]** |
| During the season | All rosters, transactions and lineup submissions (issues are public) **[D-24]** |
| Weekly lock | Every tavern's lineup |
| Weekly run | That week's mission structure and seed salt, every tavern's per-node rolls and path, actual and projected points, and the story |
| Never | Future weeks' missions, until their run |

Candidate missions the GM did not select stay unpublished **[D-18]**.

## 12. Carryover between seasons

**[OPEN D-11]**. Season 1 defaults, applied when Season 2 is created:

- Each tavern may **keep 1** character from its final roster. The champion may
  keep 1 more.
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
- Each `mission.resolved` records the exact rolls. Anyone can re-run it from
  the recorded seed and get the same result.
- Missions are locked and committed before the draft. A revealed mission that
  doesn't match its commitment is rejected.
- The GM knows every mission **[OPEN D-09]**.
