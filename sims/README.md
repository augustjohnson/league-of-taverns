# sims

Headless mock seasons with bot managers, for balance testing. Everything here
is a consumer of `engine/` and `bots/`. Sims never use rules that the live
league doesn't use.

- `src/mock-season.ts` plays seasons and writes event logs.
- `src/balance-report.ts` aggregates them.

Output goes to `sims/output/` and is git-ignored. To share a result, commit the
command and seed, not the output, because the output is reproducible from them.
