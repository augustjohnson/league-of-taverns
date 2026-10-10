# missions/selected

The GM's chosen missions, one per scheduled week. **Sealed until reveal.**

How they are sealed is OPEN (docs/decisions.md D-08):

- `encrypted` (default): `<mission-id>.yaml.age`. The weekly Action decrypts it
  with a repo secret. Plaintext (`*.plain.yaml`) is git-ignored.
- `commit_reveal`: nothing here until reveal. Only the sha256 commitment is in
  schedule.yaml and season.created.
- `private_repo`: plaintext YAML, and the whole repo is private.

In every mode, `scripts/seal` writes each mission's sha256 commitment, and
`scripts/reveal` refuses a mission that does not match it.
