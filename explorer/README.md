# explorer

Placeholder. **Out of scope for now.**

A future read-only site for standings, rosters, weekly results (actual and
projected), rendered stories and character careers.

The one rule that holds already: **explorer never imports `engine/`.** It reads
only the published JSON that `scripts/src/publish.ts` builds, so it can be
rebuilt, replaced or rewritten without touching game logic. Lint and
`engine/test/boundaries.test.ts` enforce this.
