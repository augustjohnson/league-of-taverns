/**
 * LLM provider seam for the drafting scripts. Nothing here makes a network
 * call during scaffolding, and the provider is undecided (docs/decisions.md D-32).
 *
 * Contract: drafting is offline and human-triggered. Never in CI, never in
 * the weekly Action. Output is a draft that a validator and then the GM must
 * accept. Prompt templates live in content/prompts/.
 */
import { notImplemented } from '@league-of-taverns/engine';

export interface LlmRequest {
  /** Path under content/prompts/, e.g. "mission-candidates.md". */
  readonly template: string;
  readonly variables: Readonly<Record<string, string>>;
  /** For structured output: the JSON Schema the response must satisfy. */
  readonly responseSchema?: unknown;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<string>;
}

export function renderTemplate(_template: string, _variables: Readonly<Record<string, string>>): string {
  return notImplemented('renderTemplate', 'T5.4');
}

export function llmClient(): LlmClient {
  return notImplemented('llmClient', 'T5.4');
}
