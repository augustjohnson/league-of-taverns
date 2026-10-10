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
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  SNAPSHOT_FILE_NAME,
  appendManifestEntry,
  assertAllowedDocuments,
  buildManifestEntry,
  fetchAllPages,
  firstPageUrl,
  monstersSourceUrl,
  parseManifest,
  parseSnapshotArgs,
  serializeManifest,
  serializeSnapshot,
  sortBySlug,
  type FetchLike,
} from './lib/open5e-snapshot';
import { ValidationFailure, runMain } from './lib/main';
import { REPO_ROOT } from './lib/repo';

const OPEN5E_DIR = new URL('data/open5e/', REPO_ROOT);
const MANIFEST_URL = new URL('manifest.json', OPEN5E_DIR);
const PAGE_DELAY_MS = 1000;

const fetchJson: FetchLike = (url) =>
  fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'league-of-taverns-snapshot (T1.1)' } });

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const { id, documents } = parseSnapshotArgs(argv);
  const snapshotDir = new URL(`${id}/`, OPEN5E_DIR);
  const snapshotFile = new URL(SNAPSHOT_FILE_NAME, snapshotDir);

  // Refuse early, before touching the network.
  const manifest = parseManifest(await readFile(MANIFEST_URL, 'utf8'));
  if (manifest.snapshots.some((entry) => entry.id === id)) {
    throw new ValidationFailure(`Snapshot "${id}" is already in data/open5e/manifest.json. Snapshots are immutable.`);
  }
  if (existsSync(snapshotDir)) {
    throw new ValidationFailure(`data/open5e/${id}/ already exists. Snapshots are immutable; pick a new id.`);
  }

  const sourceUrl = monstersSourceUrl(documents);
  const fetchedAt = new Date().toISOString();
  console.log(`Fetching ${sourceUrl}`);
  const fetched = await fetchAllPages(firstPageUrl(sourceUrl), fetchJson, {
    delayMs: PAGE_DELAY_MS,
    onPage: (_url, received, expected) => console.log(`  ${received}/${expected} records`),
  });

  assertAllowedDocuments(fetched, documents);
  const records = sortBySlug(fetched);
  const contents = serializeSnapshot(records);
  const entry = buildManifestEntry({ id, fetchedAt, sourceUrl, records, contents });
  const nextManifest = serializeManifest(appendManifestEntry(manifest, entry));

  // `recursive: false` and flag `wx` make a concurrent or repeated run fail instead of overwriting.
  await mkdir(snapshotDir, { recursive: false });
  await writeFile(snapshotFile, contents, { encoding: 'utf8', flag: 'wx' });
  await writeFile(MANIFEST_URL, nextManifest, 'utf8');

  const documentList = entry.documents.map((doc) => `${doc.slug} (${doc.licenseUrl})`).join(', ');
  console.log(`Wrote data/open5e/${entry.file}: ${entry.count} records, sha256 ${entry.sha256}`);
  console.log(`Documents: ${documentList}`);
}

runMain(main);
