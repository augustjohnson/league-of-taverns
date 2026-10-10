/**
 * LLM-draft candidate missions (structure only) for a season.
 *
 * Usage: draft-missions --season season-01 --count 10
 *
 * - Render content/prompts/mission-candidates.md with the schema, the public
 *   schedule, the pooled creatures' archetype summary, and the snapshot slugs
 *   allowed in encounters.
 * - Parse each response, run the engine validator, and feed all violations back
 *   for up to N retries. Only valid missions are written.
 * - Write seasons/<id>/missions/candidates/<mission-id>.yaml.
 * - Never runs in CI. Human-triggered, with an LLM provider configured locally.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/draft-missions', 'T5.4'));
