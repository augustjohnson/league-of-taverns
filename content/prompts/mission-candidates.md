<!--
Prompt template: candidate mission STRUCTURE (no prose).
Rendered by scripts/src/draft-missions.ts (T5.4). Variables in {{double_braces}}.
The output is validated by engine/src/missions validateMission. On failure,
the full issue list is appended under "Previous attempt was rejected" and the
model retries.
-->

You are designing the hidden structure of one weekly mission for a fantasy
sports league. Parties of four monsters (one captain and three allies) attempt
the mission. You design **structure only**: a layered graph of skill checks and
battles. Do not write any story, titles, or descriptions. Those are written
separately.

## The week you are designing for (public to managers)

- Week: {{week}}
- Title: {{title}}
- Environment: {{environment}}
- Theme: {{theme}}

## How missions resolve (so your design has the effect you intend)

- A **check** is one d20 roll plus the best modifier in the party against a DC.
  Pass chance = clamp((21 − (DC − modifier)) / 20, 0, 1). The party member with
  the highest modifier always makes the roll.
- A **battle** is resolved from party strength vs encounter strength. Losing
  any battle ends the mission with score 0.
- Otherwise score = checks passed / checks attempted on the path taken.
- Failed checks should usually route into a battle or a harder detour. That
  coupling is the core tension.

## The season's pool (for calibration, not for naming)

Party CR budget B = {{party_cr}}. Archetype summary of the draftable pool:

{{pool_summary}}

## Hard rules (the validator enforces all of these)

{{rules}}

- Exactly one node with `kind: start` at rank 0, and at least one `kind: end`.
- Every edge goes to a strictly higher rank.
- Each check node has a `pass` and a `fail` edge (or a single `always` edge).
  Each battle node has exactly one `win` edge. There are no `lose` edges.
- Every path from start to an end attempts at least one check.
- DC between {{dc_min}} and {{dc_max}}.
- Encounter creatures must be slugs from this list, and total encounter CR must
  be ≤ {{encounter_cr_ratio}} × B:
  {{allowed_encounter_slugs}}
- At most {{max_nodes}} nodes and rank ≤ {{max_rank}}.
- Allowed skills: {{skills}}. Saves and raw ability checks use abilities:
  str, dex, con, int, wis, cha.

## Design goals (soft)

- Reward a party built for this environment and theme without making any
  single archetype mandatory. A mission only flyers can finish is a bad mission.
- Spread DCs. Include at least one check most parties pass and one that only a
  specialist passes reliably.
- Two or three distinct paths. A branch nobody can reach is wasted.

## Output

Return only YAML matching this schema, with no commentary and no prose fields:

```yaml
{{mission_schema}}
```

Use `id: {{mission_id}}`, `season: {{season}}`, `environment: {{environment}}`.
