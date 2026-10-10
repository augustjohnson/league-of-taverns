import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SnapshotManifestEntry } from '@league-of-taverns/engine';
import { ValidationFailure } from '../src/lib/main';
import {
  appendManifestEntry,
  assertAllowedDocuments,
  buildManifestEntry,
  collectDocuments,
  fetchAllPages,
  firstPageUrl,
  monstersSourceUrl,
  parseManifest,
  parseSnapshotArgs,
  serializeManifest,
  serializeSnapshot,
  sortBySlug,
  type FetchLike,
  type FetchResponseLike,
  type RawRecord,
} from '../src/lib/open5e-snapshot';

// T1.1.

const SRD = { document__slug: 'wotc-srd', document__title: 'Systems Reference Document', document__license_url: 'http://open5e.com/legal' };

function monster(slug: string, extra: Record<string, unknown> = {}): RawRecord {
  return { slug, name: slug, cr: 1, ...SRD, ...extra };
}

function ok(body: unknown): FetchResponseLike {
  return { ok: true, status: 200, statusText: 'OK', json: () => Promise.resolve(body) };
}

/** A fake fetch serving fixed pages by URL, recording every request. */
function fakeFetch(pages: Readonly<Record<string, FetchResponseLike>>): FetchLike & { readonly calls: string[] } {
  const calls: string[] = [];
  const fn = (url: string): Promise<FetchResponseLike> => {
    calls.push(url);
    const page = pages[url];
    return page === undefined ? Promise.reject(new Error(`unexpected URL ${url}`)) : Promise.resolve(page);
  };
  return Object.assign(fn, { calls });
}

const BASE = 'https://api.open5e.com/v1/monsters/?document__slug=wotc-srd';
const P1 = `${BASE}&limit=2`;
const P2 = `${BASE}&limit=2&page=2`;
const P3 = `${BASE}&limit=2&page=3`;

describe('parseSnapshotArgs', () => {
  it('reads --id and defaults documents to SRD 5.1 only', () => {
    expect(parseSnapshotArgs(['--', '--id', 'open5e-v1-2026-10'])).toEqual({
      id: 'open5e-v1-2026-10',
      documents: ['wotc-srd'],
    });
  });

  it('splits --documents and drops duplicates', () => {
    expect(parseSnapshotArgs(['--id', 'x-1', '--documents', 'wotc-srd, tob,wotc-srd']).documents).toEqual([
      'wotc-srd',
      'tob',
    ]);
  });

  it('rejects a missing or non-kebab id and unknown flags', () => {
    expect(() => parseSnapshotArgs([])).toThrow(ValidationFailure);
    expect(() => parseSnapshotArgs(['--id', 'Open5e_V1'])).toThrow(/kebab-case/);
    expect(() => parseSnapshotArgs(['--id', 'x', '--force'])).toThrow();
    expect(() => parseSnapshotArgs(['--id', 'x', '--documents', ' , '])).toThrow(/at least one/);
  });
});

describe('source URLs', () => {
  it('filters by one document with document__slug, several with document__slug__in', () => {
    expect(monstersSourceUrl(['wotc-srd'])).toBe(BASE);
    expect(monstersSourceUrl(['wotc-srd', 'tob'])).toBe(
      'https://api.open5e.com/v1/monsters/?document__slug__in=wotc-srd%2Ctob',
    );
  });

  it('adds the page size to the first page only', () => {
    expect(firstPageUrl(BASE, 2)).toBe(P1);
  });
});

describe('fetchAllPages', () => {
  it('follows next links in order, pausing between requests', async () => {
    const fetch = fakeFetch({
      [P1]: ok({ count: 5, next: P2, previous: null, results: [monster('c'), monster('a')] }),
      [P2]: ok({ count: 5, next: P3, previous: P1, results: [monster('e'), monster('b')] }),
      [P3]: ok({ count: 5, next: null, previous: P2, results: [monster('d')] }),
    });
    const sleeps: number[] = [];
    const records = await fetchAllPages(P1, fetch, {
      delayMs: 250,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    expect(records.map((r) => r.slug)).toEqual(['c', 'a', 'e', 'b', 'd']);
    expect(fetch.calls).toEqual([P1, P2, P3]);
    expect(sleeps).toEqual([250, 250]);
  });

  it('returns record objects untouched', async () => {
    const odd = monster('odd', { speed: { walk: 30, hover: true }, skills: {}, extra_field: [null, 1.5] });
    const fetch = fakeFetch({ [P1]: ok({ count: 1, next: null, results: [odd] }) });
    const [record] = await fetchAllPages(P1, fetch);
    expect(record).toBe(odd);
  });

  it('fails clearly on an HTTP error', async () => {
    const fetch = fakeFetch({
      [P1]: ok({ count: 3, next: P2, results: [monster('a'), monster('b')] }),
      [P2]: { ok: false, status: 503, statusText: 'Service Unavailable', json: () => Promise.resolve({}) },
    });
    await expect(fetchAllPages(P1, fetch)).rejects.toThrow(`HTTP 503 Service Unavailable from ${P2}`);
  });

  it('fails on a malformed page', async () => {
    const fetch = fakeFetch({ [P1]: ok({ count: 1, next: null, results: 'nope' }) });
    await expect(fetchAllPages(P1, fetch)).rejects.toThrow(/"results" is not an array/);
  });

  it('fails when the total disagrees with count', async () => {
    const fetch = fakeFetch({ [P1]: ok({ count: 3, next: null, results: [monster('a')] }) });
    await expect(fetchAllPages(P1, fetch)).rejects.toThrow(/reported 3 records but pagination returned 1/);
  });

  it('fails when count changes between pages', async () => {
    const fetch = fakeFetch({
      [P1]: ok({ count: 2, next: P2, results: [monster('a')] }),
      [P2]: ok({ count: 3, next: null, results: [monster('b')] }),
    });
    await expect(fetchAllPages(P1, fetch)).rejects.toThrow(/count changed/);
  });

  it('refuses a next-link loop and a next link to another origin', async () => {
    const loop = fakeFetch({ [P1]: ok({ count: 9, next: P1, results: [monster('a')] }) });
    await expect(fetchAllPages(P1, loop)).rejects.toThrow(/Pagination loop/);
    const away = fakeFetch({ [P1]: ok({ count: 9, next: 'https://example.com/x', results: [monster('a')] }) });
    await expect(fetchAllPages(P1, away)).rejects.toThrow(/another origin/);
    expect(away.calls).toEqual([P1]);
  });
});

describe('assertAllowedDocuments', () => {
  it('passes records from allowed documents', () => {
    expect(() => assertAllowedDocuments([monster('a'), monster('b')], ['wotc-srd'])).not.toThrow();
  });

  it('names every record from another document, or with none', () => {
    const records = [monster('a'), monster('b', { document__slug: 'tob' }), monster('c', { document__slug: undefined })];
    expect(() => assertAllowedDocuments(records, ['wotc-srd'])).toThrow(
      /2 record\(s\) come from documents outside \[wotc-srd\]: b \(tob\), c \(undefined\)/,
    );
  });
});

describe('sortBySlug', () => {
  it('sorts by slug in code-unit order without mutating the input', () => {
    const input = [monster('zombie'), monster('ape'), monster('ape-giant'), monster('Ape')];
    expect(sortBySlug(input).map((r) => r.slug)).toEqual(['Ape', 'ape', 'ape-giant', 'zombie']);
    expect(input.map((r) => r.slug)).toEqual(['zombie', 'ape', 'ape-giant', 'Ape']);
  });

  it('rejects duplicate or missing slugs', () => {
    expect(() => sortBySlug([monster('a'), monster('a')])).toThrow(/Duplicate slug in API output: a/);
    expect(() => sortBySlug([{ name: 'no slug' }])).toThrow(/no string slug/);
  });
});

describe('serializeSnapshot', () => {
  it('writes 2-space JSON with a trailing newline, keys in API order', () => {
    const text = serializeSnapshot([{ slug: 'a', z: 1, b: [] }]);
    expect(text).toBe('[\n  {\n    "slug": "a",\n    "z": 1,\n    "b": []\n  }\n]\n');
  });
});

describe('manifest entry', () => {
  const records = sortBySlug([monster('b'), monster('a')]);
  const contents = serializeSnapshot(records);
  const entry = buildManifestEntry({
    id: 'open5e-v1-2026-10',
    fetchedAt: '2026-10-10T12:00:00.000Z',
    sourceUrl: BASE,
    records,
    contents,
  });

  it('records id, source, version, documents, count, hash and file', () => {
    expect(entry).toEqual<SnapshotManifestEntry>({
      id: 'open5e-v1-2026-10',
      fetchedAt: '2026-10-10T12:00:00.000Z',
      sourceUrl: BASE,
      apiVersion: 'v1',
      documents: [{ slug: 'wotc-srd', title: 'Systems Reference Document', licenseUrl: 'http://open5e.com/legal' }],
      count: 2,
      sha256: createHash('sha256').update(contents).digest('hex'),
      file: 'open5e-v1-2026-10/monsters.json',
    });
  });

  it('lists each document once, sorted, and rejects conflicting metadata', () => {
    const mixed = [monster('a', { document__slug: 'tob', document__title: 'Tome' }), monster('b'), monster('c')];
    expect(collectDocuments(mixed).map((d) => d.slug)).toEqual(['tob', 'wotc-srd']);
    expect(() => collectDocuments([monster('a'), monster('b', { document__license_url: 'x' })])).toThrow(
      /inconsistent/,
    );
  });

  it('appends to the manifest, keeps other keys, and refuses an existing id', () => {
    const manifest = parseManifest('{ "$comment": "keep me", "snapshots": [] }');
    const next = appendManifestEntry(manifest, entry);
    expect(next.snapshots).toEqual([entry]);
    expect(manifest.snapshots).toEqual([]);
    expect(serializeManifest(next).startsWith('{\n  "$comment": "keep me",\n  "snapshots": [')).toBe(true);
    expect(() => appendManifestEntry(next, entry)).toThrow(/already in the manifest/);
  });

  it('rejects a manifest without a snapshots array', () => {
    expect(() => parseManifest('{}')).toThrow(ValidationFailure);
  });
});
