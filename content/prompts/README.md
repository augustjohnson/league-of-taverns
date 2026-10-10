# content/prompts

Prompt templates for the pre-season LLM drafting steps. Templates only. No
script in this repo calls an LLM during CI or a weekly run, and the provider
is undecided (docs/decisions.md D-32).

| Template | Used by | Produces |
|---|---|---|
| `mission-candidates.md` | `scripts/src/draft-missions.ts` | `seasons/<id>/missions/candidates/*.yaml` (structure only) |
| `mission-chrome.md` | `scripts/src/draft-chrome.ts` | `seasons/<id>/chrome/<mission>.yaml` (`status: draft`) |
| `season-throughlines.md` | `scripts/src/draft-chrome.ts --throughlines` | `seasons/<id>/chrome/throughlines.yaml` |

The rule all three share: **the LLM proposes, the engine vets, the GM curates.**
Output that fails validation is retried with the full issue list, then dropped.
Nothing drafted is used until a human moves it to `reviewed` and then `locked`.

Variables use `{{double_braces}}` so they never collide with the story layer's
single-brace tokens like `{actor}`.
