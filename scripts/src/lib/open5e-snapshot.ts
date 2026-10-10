/**
 * Helpers for the Open5e snapshot script (T1.1): argument parsing, pagination,
 * document checks, serialization and the manifest entry.
 *
 * Records are handled as opaque JSON objects. Nothing here renames, drops,
 * adds or transforms a field; the only change to the API output is the sort
 * by slug. `Open5eMonster` is deliberately not assumed (T1.2 verifies it).
 */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import type { SnapshotManifestEntry } from '@league-of-taverns/engine';
import { ValidationFailure } from './main';

export const OPEN5E_API_BASE = 'https://api.open5e.com/v1/';
/** SRD 5.1 only by default (docs/decisions.md D-17). */
export const DEFAULT_DOCUMENTS: ReadonlyArray<string> = ['wotc-srd'];
export const DEFAULT_PAGE_LIMIT = 100;
export const SNAPSHOT_FILE_NAME = 'monsters.json';

/** One raw API record, kept opaque. */
export type RawRecord = Readonly<Record<string, unknown>>;

export interface SnapshotArgs {
  readonly id: string;
  readonly documents: ReadonlyArray<string>;
}

const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Parse `--id <kebab-id> [--documents a,b]`. A bare `--` (from `pnpm run x -- ...`) is ignored. */
export function parseSnapshotArgs(argv: ReadonlyArray<string>): SnapshotArgs {
  const { values } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: { id: { type: 'string' }, documents: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  if (values.id === undefined) throw new ValidationFailure('Missing --id, e.g. --id open5e-v1-2026-10.');
  if (!KEBAB_ID.test(values.id)) throw new ValidationFailure(`Snapshot id must be kebab-case: "${values.id}".`);
  const documents =
    values.documents === undefined
      ? DEFAULT_DOCUMENTS
      : values.documents
          .split(',')
          .map((slug) => slug.trim())
          .filter((slug) => slug !== '');
  if (documents.length === 0) throw new ValidationFailure('--documents must name at least one document slug.');
  const bad = documents.filter((slug) => !KEBAB_ID.test(slug));
  if (bad.length > 0) throw new ValidationFailure(`Invalid document slug(s): ${bad.join(', ')}.`);
  return { id: values.id, documents: [...new Set(documents)] };
}

/** The query URL recorded in the manifest: the monsters endpoint filtered to `documents`. */
export function monstersSourceUrl(documents: ReadonlyArray<string>, apiBase: string = OPEN5E_API_BASE): string {
  const url = new URL('monsters/', apiBase);
  if (documents.length === 1) url.searchParams.set('document__slug', documents[0] ?? '');
  else url.searchParams.set('document__slug__in', documents.join(','));
  return url.toString();
}

/** The first page actually fetched: the source URL plus a page size. */
export function firstPageUrl(sourceUrl: string, limit: number = DEFAULT_PAGE_LIMIT): string {
  const url = new URL(sourceUrl);
  url.searchParams.set('limit', String(limit));
  return url.toString();
}

/** The subset of `Response` the pager uses, so tests can pass a fake. */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}
export type FetchLike = (url: string) => Promise<FetchResponseLike>;

export interface FetchAllOptions {
  /** Pause between page requests, to be polite to the API. */
  readonly delayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Hard cap on pages followed, against a `next` loop. */
  readonly maxPages?: number;
  /** Called after each page, for progress output. */
  readonly onPage?: (url: string, received: number, expected: number) => void;
}

interface Page {
  readonly count: number;
  readonly next: string | null;
  readonly results: ReadonlyArray<RawRecord>;
}

function isRecord(value: unknown): value is RawRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePage(url: string, body: unknown): Page {
  if (!isRecord(body)) throw new Error(`Unexpected response from ${url}: not a JSON object.`);
  const { count, next, results } = body;
  if (typeof count !== 'number') throw new Error(`Unexpected response from ${url}: "count" is not a number.`);
  if (next !== null && typeof next !== 'string') throw new Error(`Unexpected response from ${url}: bad "next".`);
  if (!Array.isArray(results) || !results.every(isRecord)) {
    throw new Error(`Unexpected response from ${url}: "results" is not an array of objects.`);
  }
  return { count, next, results };
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Follow `next` links from `startUrl` and return every record in API order.
 * Fails on any HTTP error, a malformed page, a `next` link to another origin,
 * a repeated page, or a total that disagrees with the API's `count`.
 */
export async function fetchAllPages(
  startUrl: string,
  fetchFn: FetchLike,
  options: FetchAllOptions = {},
): Promise<ReadonlyArray<RawRecord>> {
  const { delayMs = 0, sleep = realSleep, maxPages = 100, onPage } = options;
  const origin = new URL(startUrl).origin;
  const seen = new Set<string>();
  const records: RawRecord[] = [];
  let expected: number | undefined;
  let url: string | null = startUrl;

  while (url !== null) {
    if (seen.has(url)) throw new Error(`Pagination loop: ${url} was already fetched.`);
    if (seen.size >= maxPages) throw new Error(`Gave up after ${maxPages} pages; the API kept returning "next".`);
    if (new URL(url).origin !== origin) throw new Error(`Refusing to follow "next" to another origin: ${url}`);
    if (seen.size > 0 && delayMs > 0) await sleep(delayMs);
    seen.add(url);

    const response = await fetchFn(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    const page = parsePage(url, await response.json());
    expected ??= page.count;
    if (page.count !== expected) {
      throw new Error(`The API's count changed mid-snapshot (${expected} → ${page.count}). Try again.`);
    }
    records.push(...page.results);
    onPage?.(url, records.length, expected);
    url = page.next;
  }

  if (records.length !== expected) {
    throw new Error(`The API reported ${expected} records but pagination returned ${records.length}.`);
  }
  return records;
}

/** Throw if any record lacks a string `document__slug` in `allowed`. Lists every offender. */
export function assertAllowedDocuments(records: ReadonlyArray<RawRecord>, allowed: ReadonlyArray<string>): void {
  const offenders = records
    .filter((record) => typeof record.document__slug !== 'string' || !allowed.includes(record.document__slug))
    .map((record) => `${String(record.slug)} (${String(record.document__slug)})`);
  if (offenders.length > 0) {
    throw new ValidationFailure(
      `${offenders.length} record(s) come from documents outside [${allowed.join(', ')}]: ${offenders.join(', ')}`,
    );
  }
}

/** Return the records sorted by `slug`. Throws on a missing or duplicate slug. Does not mutate. */
export function sortBySlug(records: ReadonlyArray<RawRecord>): ReadonlyArray<RawRecord> {
  const slugs = new Set<string>();
  for (const record of records) {
    if (typeof record.slug !== 'string' || record.slug === '') {
      throw new ValidationFailure(`A record has no string slug: ${JSON.stringify(record).slice(0, 120)}`);
    }
    if (slugs.has(record.slug)) throw new ValidationFailure(`Duplicate slug in API output: ${record.slug}`);
    slugs.add(record.slug);
  }
  // Code-unit order, not locale order, so the file is the same on every machine.
  return [...records].sort((a, b) => (String(a.slug) < String(b.slug) ? -1 : 1));
}

/** The exact file contents: 2-space JSON plus a trailing newline. */
export function serializeSnapshot(records: ReadonlyArray<RawRecord>): string {
  return `${JSON.stringify(records, null, 2)}\n`;
}

export function sha256Hex(contents: string): string {
  return createHash('sha256').update(contents, 'utf8').digest('hex');
}

type ManifestDocument = SnapshotManifestEntry['documents'][number];

/** Distinct documents in the records, sorted by slug. Throws if one slug has conflicting title or license. */
export function collectDocuments(records: ReadonlyArray<RawRecord>): ReadonlyArray<ManifestDocument> {
  const bySlug = new Map<string, ManifestDocument>();
  for (const record of records) {
    const { document__slug: slug, document__title: title, document__license_url: licenseUrl } = record;
    if (typeof slug !== 'string' || typeof title !== 'string' || typeof licenseUrl !== 'string') {
      throw new ValidationFailure(`Record ${String(record.slug)} lacks string document__slug/title/license_url.`);
    }
    const existing = bySlug.get(slug);
    if (existing === undefined) bySlug.set(slug, { slug, title, licenseUrl });
    else if (existing.title !== title || existing.licenseUrl !== licenseUrl) {
      throw new ValidationFailure(`Document ${slug} has inconsistent title or license URL across records.`);
    }
  }
  return [...bySlug.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
}

export interface ManifestEntryInput {
  readonly id: string;
  readonly fetchedAt: string;
  readonly sourceUrl: string;
  readonly records: ReadonlyArray<RawRecord>;
  /** The serialized file contents, hashed as written. */
  readonly contents: string;
}

export function buildManifestEntry(input: ManifestEntryInput): SnapshotManifestEntry {
  return {
    id: input.id,
    fetchedAt: input.fetchedAt,
    sourceUrl: input.sourceUrl,
    apiVersion: 'v1',
    documents: collectDocuments(input.records),
    count: input.records.length,
    sha256: sha256Hex(input.contents),
    file: `${input.id}/${SNAPSHOT_FILE_NAME}`,
  };
}

/** On-disk shape of data/open5e/manifest.json. Extra top-level keys (e.g. `$comment`) are kept. */
export interface SnapshotManifest {
  readonly snapshots: ReadonlyArray<SnapshotManifestEntry>;
  readonly [key: string]: unknown;
}

export function parseManifest(text: string): SnapshotManifest {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value) || !Array.isArray(value.snapshots)) {
    throw new ValidationFailure('data/open5e/manifest.json has no "snapshots" array.');
  }
  return value as SnapshotManifest;
}

/** Return a new manifest with `entry` appended. Refuses an id that is already pinned. */
export function appendManifestEntry(manifest: SnapshotManifest, entry: SnapshotManifestEntry): SnapshotManifest {
  if (manifest.snapshots.some((existing) => existing.id === entry.id)) {
    throw new ValidationFailure(`Snapshot "${entry.id}" is already in the manifest. Snapshots are immutable.`);
  }
  return { ...manifest, snapshots: [...manifest.snapshots, entry] };
}

export function serializeManifest(manifest: SnapshotManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
