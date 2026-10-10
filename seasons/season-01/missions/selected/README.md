# missions/selected

The GM's chosen missions, one per scheduled week, as plaintext YAML.

Missions are open (docs/decisions.md D-08): the repo is public, and anyone can
read a selected mission before its week runs. Whether that changes lineup
strategy too much is D-42.

Once `season.created` is appended, selected missions are frozen, and CI flags
any change to them.
