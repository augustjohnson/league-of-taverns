# data/open5e

Raw, pinned snapshots of the Open5e monster API. **Records are stored verbatim.**
Nothing here is reshaped, and only `engine/src/adapters/open5e` interprets them.

```
data/open5e/
  manifest.json              # every snapshot: id, source URL, documents + licenses, count, sha256
  <snapshot-id>/monsters.json
```

- Written only by `scripts/src/snapshot.ts`. Never edit by hand.
- A snapshot is immutable once a season's `config.yaml` references its id. To
  pick up upstream changes, take a new snapshot under a new id.
- Every record keeps its `document__slug` and license URL. See the README's
  licensing section.
