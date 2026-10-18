# challenges

One file per episode: the Lich's task, `<nn>-<id>.yaml`. Sealed before the
season (their sha256 commitments go into `season.created`) and revealed as
each episode's challenge runs.

```yaml
id: moat-phylactery          # kebab-case, unique in the season
episode: 1                   # 1..votes, one file each
title: Fetch My Phylactery from the Moat   # chrome
story: >-                    # chrome: the Lich's words
  I have dropped my phylactery in the moat. Again.
checks:                      # the rules: run in order as elimination rounds, repeating harder
  - { type: skill, skill: athletics, dc: 12, advantage: { speed: swim }, line: "swim out across the moat" }
  - { type: save, ability: con, dc: 12, line: "hold their breath" }
```

`line` is chrome: what the scrying ball says the contestants are doing.
`advantage` gives advantage to contestants with that speed or sense;
`requires` fails anyone without it. See sims/fixtures/lich-season/challenges/
for a full season of 17.
