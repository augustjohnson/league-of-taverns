<!--
Prompt template: mission CHROME (story text) for one selected mission.
Rendered by scripts/src/draft-chrome.ts (T8.5). Output is written with
status: draft. A GM then edits it and moves it to reviewed and locked.
Checked by scripts/src/lib/chrome.ts: branch coverage, token scope, and the
mechanical-fact lint.
-->

You are writing the story layer for one mission in a fantasy sports league.
The mechanics are already decided and will be resolved by dice. Your text is
shown after the fact, choosing the variant that matches what happened. You
must never state or decide a mechanical fact.

## The mission (public framing)

- Title: {{title}}
- Environment: {{environment}}
- Theme: {{theme}}
- Season through-lines to weave in, lightly: {{throughlines}}

## The structure you are writing for

{{mission_structure_summary}}

## What to write

1. `intro`: two or three sentences that set the scene.
2. For every check node: `pass` and `fail` beats, plus an optional `enter`.
3. For every battle node: `win` and `lose` beats, plus an optional `enter`.
   `lose` ends the mission, so write it as an ending.
4. For every end node: an `outro`.
5. Optional: `imagePrompts.cover`, one sentence describing an illustration,
   with no names of real artists, brands, or trademarked settings.

Every variant must read naturally whatever path led to it.

## Tokens (the only placeholders allowed)

- `{actor}`: the party member who made this check. **Check nodes only.**
- `{captain}`, `{allies}`, `{tavern}`: allowed anywhere.
- `{battle_creature}`: the encounter's lead creature type. **Battle nodes only.**

Do not invent names for party members. They come from the tokens.

## Never

- Numbers, DCs, dice, modifiers, odds, or the words "roll", "check" or "DC".
- Margins ("barely", "easily", "a natural twenty"). You don't know them.
- Facts the structure doesn't contain: no extra enemies, no loot amounts, no
  injuries that would matter later.
- Trademarked settings, characters, or product names.

## Output

Return only YAML matching:

```yaml
{{chrome_schema}}
```

with `mission: {{mission_id}}` and `status: draft`.
