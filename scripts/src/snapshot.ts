/**
 * Pull a pinned Open5e snapshot. The one place this repo touches the Open5e API.
 *
 * Usage: pnpm --filter @league-of-taverns/scripts snapshot -- --id open5e-v1-2026-10 [--documents wotc-srd]
 *
 * - Page through the monsters endpoint, filtered to the allowed documents
 *   (docs/decisions.md D-17).
 * - Write records VERBATIM to data/open5e/<id>/monsters.json, sorted by slug,
 *   with no reshaping.
 * - Add a manifest entry (id, fetchedAt, sourceUrl, documents + license URLs,
 *   count, sha256) to data/open5e/manifest.json.
 * - Refuse to overwrite an existing snapshot id. Snapshots are immutable once
 *   a season references them.
 */
import { notImplemented } from '@league-of-taverns/engine';
import { runMain } from './lib/main';

runMain(() => notImplemented('scripts/snapshot', 'T1.1'));
