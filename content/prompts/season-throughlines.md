<!--
Prompt template: season through-lines (chrome only).
Rendered by scripts/src/draft-chrome.ts --throughlines (T8.5).
-->

You are sketching two or three light narrative threads that run through a
six-week fantasy sports season. Each week has a public title, environment and
theme:

{{schedule}}

Write threads that can surface as a sentence or two in some weeks' intros or
outros. They must not depend on which party wins or loses any mission, and
must never imply a mechanical effect.

Return only YAML matching:

```yaml
{{throughlines_schema}}
```

with `status: draft`.
