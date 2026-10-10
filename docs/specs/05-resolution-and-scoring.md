# Resolution & Scoring

## Assignment: best-fit

For each check, the team uses its **highest modifier** for the required skill.
Deterministic given the roster. This is what makes per-CR efficiency a meaningful
ranking (a cheap team with one skilled specialist can outperform a costly
generalist).

```
mod(team, skill) = max over members of member.skills[skill]   // 0 or ability-mod if unproficient
actor(team, skill) = argmax member                             // → {actor} in narrative
```

Deferred (GA-phase, alongside replacement): group checks, the Help action, or an
assignment **policy gene**. v1 is best-fit only.

## Check resolution — seeded-stochastic

Each check is a d20 vs DC:

```
p_pass = clamp((21 - (DC - mod)) / 20, 0, 1)
```

- Sampling: draw `d20 = 1 + floor(20 * rngFor(runSeed, 'roll:'+nodeId)())`,
  pass iff `d20 + mod >= DC`.
- Propagation: use `p_pass` directly as the edge probability.

This replaces the earlier deterministic (modifier-vs-DC) model, which made every
check a step function — a +3 team *always* fails DC 13, nothing marginal ever
swings. Bad model of 5e; discarded.

## Battle resolution — black-box EV

A battle yields `p_win` from an expected-value comparison, no round-by-round.
Both sides:

```
DPR   = hitChance * avgDamage            // attack bonus vs AC → hit prob × mean damage
eHP   = HP adjusted for AC and damage resist/immunity
p_win ≈ f(team.DPR, team.eHP, foe.DPR, foe.eHP)   // e.g. time-to-kill ratio, logistic-squashed
```

This mirrors the DMG's own CR math, so it's a defensible approximation and it's
deterministic in expectation. Sampling draws a Bernoulli against `p_win`;
propagation uses `p_win` as the `win`/`lose` edge split. If typed damage
complicates the first cut, stub resist/immunity and treat damage as untyped.

## Scoring

Battles **gate**; checks **fill the fraction**.

```
if any battle on the traversal is lost:   missionScore = 0        (DNF)
else:                                      missionScore = checksPassed / checksAttempted
```

- Denominator is **per-traversal** — only checks actually attempted count.
  Skipped nodes are neither numerator nor denominator. Failing early can route
  onto a longer remediation path, inflating the denominator and double-penalizing
  (OD-3 — accepted; failure compounding is a feature).
- One budget `B` = captain + 3 allies (`Σ CR ≤ B`). Per-CR score = `missionScore / B`.
  A beefy captain costs twice: less crew budget *and* a bigger `B` to divide
  against. That's the intended broken-monster-detector behavior.

## Two computations — same model, different caller

The mission is a layered DAG of independent Bernoulli transitions, so the
per-mission expected score has a closed form *and* a sampled form.

### Propagate (leaderboard) — exact

Forward-propagate reach-probability from `start`; enumerate terminal paths via DP
(low branching, ~10 nodes → trivial):

```
expected(team, mission)
  = Σ over surviving terminal paths P(path) * (checksPassed(path) / checksAttempted(path))
  // DNF paths contribute 0
```

`P(path)` is the product of edge probabilities (`p_pass`, `1-p_pass`, `p_win`,
`1-p_win`). No dice, no dice-CI. Returns the exact mean sampling only converges
to. This is why the leaderboard has no sample-budget problem.

### Sample (Sandbox + inspector) — distribution

Run `k = 0..N` seeded traversals; each is a reproducible permalink
(`(mission, team, k)`). Gives the actual rolled traversals, the "ran it 20 times"
histogram, and the inspector's per-edge weights. `N ≈ 200` for a smooth
histogram (OD-5); the leaderboard needs none.

## What stayed fixed

Identity, assembly (deterministic top-3), the CR budget, and the score formula
are all unchanged by the switch to stochastic resolution. The **only** thing
non-deterministic is how a mission goes — not who's on the team.
