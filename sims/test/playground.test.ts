import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { projectMission, replayLog, rngFor } from '@league-of-taverns/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deepEqual } from '../src/deep-equal';
import { loadMockSeason, loadMockSeasonParts } from '../src/load';
import { renderPage, scriptSafeJson, writePlayground } from '../src/playground-build';
import { seasonInputFromData, serializeSeason, usedSlugs, type PlaygroundData } from '../src/playground/data';
import {
  draftBoard,
  formatCr,
  layoutMission,
  partyFrom,
  rostersAtLock,
  sampleMission,
  scoreFraction,
  scoreHistogram,
  seedWords,
  topSkills,
} from '../src/playground/view';
import { runMockSeason } from '../src/season-runner';

// The browser playground (sims/src/playground/): its data round-trips through
// JSON to the same seasons as the Node path, its pure view helpers behave,
// and the build writes one self-contained Artifact body.

const parts = loadMockSeasonParts();
const nodeInput = loadMockSeason();
const data = JSON.parse(JSON.stringify(serializeSeason(parts, 'sims/fixtures/mock-season'))) as PlaygroundData;
const browserInput = seasonInputFromData(data);
const sim1 = runMockSeason(nodeInput, { seed: 'sim-1' });

describe('playground data', () => {
  it('rebuilds a SeasonInput from JSON that plays sim-1 to the same NDJSON as the Node path', () => {
    const fromData = runMockSeason(browserInput, { seed: 'sim-1' });
    expect(fromData.ndjson).toBe(sim1.ndjson);
    expect(fromData.summary).toEqual(sim1.summary);
  });

  it('matches the Node path on other seeds too', () => {
    for (const seed of ['sim-1~2', 'mossy-flagon-37']) {
      expect(runMockSeason(browserInput, { seed }).ndjson, seed).toBe(runMockSeason(nodeInput, { seed }).ndjson);
    }
  });

  it('keeps only the snapshot records the season uses, verbatim', () => {
    const wanted = usedSlugs(parts.pool, parts.missions);
    expect(new Set(data.snapshot.map((r) => r.slug))).toEqual(wanted);
    expect(data.snapshot.length).toBeLessThan(parts.snapshot.length);
    for (const record of data.snapshot) expect(record).toEqual(parts.snapshot.find((r) => r.slug === record.slug));
  });

  it('rejects data of another version', () => {
    expect(() => seasonInputFromData({ ...data, version: 99 } as unknown as PlaygroundData)).toThrow(/version/);
  });
});

describe('season audit', () => {
  it('reports the replay and verify checks the run passed', () => {
    expect(sim1.audit).toEqual({ replayMatches: true, mismatches: [] });
  });
});

describe('deepEqual (the replay self-check)', () => {
  it('agrees with isDeepStrictEqual on a replayed season and on a tampered one', () => {
    const replayed = replayLog(sim1.ndjson);
    expect(deepEqual(replayed, sim1.state)).toBe(true);
    expect(isDeepStrictEqual(replayed, sim1.state)).toBe(true);
    const owner = new Map(sim1.state.owner);
    owner.set('professor-albright', 'someone-else');
    const tampered = { ...sim1.state, owner };
    expect(deepEqual(tampered, sim1.state)).toBe(false);
    expect(isDeepStrictEqual(tampered, sim1.state)).toBe(false);
  });

  it('follows the strict rules on primitives, arrays, objects, Maps and Sets', () => {
    const cases: Array<[unknown, unknown]> = [
      [1, 1],
      [NaN, NaN],
      [0, -0],
      [1, '1'],
      [null, undefined],
      [[1, 2], [1, 2]],
      [[1, 2], [2, 1]],
      [[1], { 0: 1 }],
      [{ a: 1, b: [2] }, { b: [2], a: 1 }],
      [{ a: undefined }, {}],
      [new Map<string, unknown>([['a', { x: 1 }], ['b', 2]]), new Map<string, unknown>([['b', 2], ['a', { x: 1 }]])],
      [new Map([['a', 1]]), new Map([['a', 2]])],
      [new Map([[{ k: 1 }, 'v']]), new Map([[{ k: 1 }, 'v']])],
      [new Set([1, 2]), new Set([2, 1])],
      [new Set([1, 2]), new Set([1, 3])],
      [new Set([{ a: 1 }]), new Set([{ a: 1 }])],
      [new Set([1]), new Map([[1, 1]])],
      [new Date(0), new Date(0)],
    ];
    for (const [a, b] of cases) expect(deepEqual(a, b), `${String(a)} vs ${String(b)}`).toBe(isDeepStrictEqual(a, b));
  });
});

describe('view helpers', () => {
  const mission = nodeInput.missions.get(3)!.mission;

  it('lays a mission out in columns by rank with no overlapping nodes', () => {
    const layout = layoutMission(mission);
    expect(layout.nodes.map((n) => n.id).sort()).toEqual(mission.nodes.map((n) => n.id).sort());
    expect(layout.edges).toHaveLength(mission.edges.length);
    for (const a of layout.nodes) {
      expect(a.x + a.w).toBeLessThanOrEqual(layout.width);
      expect(a.y + a.h).toBeLessThanOrEqual(layout.height);
      for (const b of layout.nodes) {
        if (a === b) continue;
        if (a.rank < b.rank) expect(a.x).toBeLessThan(b.x);
        if (a.rank === b.rank) expect(a.x === b.x && Math.abs(a.y - b.y) < a.h).toBe(false);
      }
    }
  });

  it('bins sampled scores onto the projected support, and the sample mean converges to the projection', () => {
    expect(scoreHistogram([0, 0.5, 0.5, 1, 0.3], [0, 0.5, 1])).toEqual({ counts: [1, 2, 1], other: 1 });
    const party = partyFrom('krrth', ['bruno-the-bruiser', 'doug', 'gizzik'], nodeInput.statsOf);
    const projection = projectMission(party, mission, nodeInput.baseOf, nodeInput.battleModel);
    const sample = sampleMission(party, mission, nodeInput.baseOf, nodeInput.battleModel, 4000, 'test-seed');
    expect(sample.scores).toHaveLength(4000);
    expect(scoreHistogram(sample.scores, projection.distribution.map(([s]) => s)).other).toBe(0);
    expect(Math.abs(sample.mean - projection.expectedScore)).toBeLessThan(0.02);
    expect(Math.abs(sample.dnfs / 4000 - projection.pDnf)).toBeLessThan(0.03);
  });

  it('puts every draft pick in its snake slot', () => {
    const order = [...sim1.state.draft.order];
    const rows = draftBoard(order, sim1.summary.draft);
    expect(rows).toHaveLength(7);
    rows.forEach((row, r) => {
      expect(row.direction).toBe(r % 2 === 0 ? 'ltr' : 'rtl');
      row.cells.forEach((cell, slot) => {
        expect(cell?.tavern).toBe(order[slot]);
        const i = cell!.pick % order.length;
        expect(row.direction === 'ltr' ? i : order.length - 1 - i).toBe(slot);
      });
    });
  });

  it('rebuilds rosters as of each lineup lock', () => {
    const week1 = rostersAtLock(sim1.events, 1);
    expect([...week1.values()].every((roster) => roster.length === 7)).toBe(true);
    for (const entry of sim1.state.lockedLineups.get(3)!) {
      const roster = rostersAtLock(sim1.events, 3).get(entry.tavern)!;
      if (entry.lineup !== null) for (const id of [entry.lineup.captain, ...entry.lineup.allies]) expect(roster).toContain(id);
    }
  });

  it('formats CRs, scores, skills and seeds', () => {
    expect([0, 1, 2, 4, 8, 12, 96, 100].map(formatCr)).toEqual(['0', '1/8', '1/4', '1/2', '1', '1 1/2', '12', '12 1/2']);
    expect([0, 1, 0.5, 2 / 3, 0.8, 3 / 7].map(scoreFraction)).toEqual(['0', '1', '1/2', '2/3', '4/5', '3/7']);
    const skills = topSkills(nodeInput.statsOf('gizzik'));
    expect(skills).toHaveLength(3);
    expect(skills[0]!.modifier).toBeGreaterThanOrEqual(skills[2]!.modifier);
    const rand = rngFor('seed-words', 'test');
    for (let i = 0; i < 50; i++) expect(seedWords(rand)).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
  });
});

describe('playground build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-playground-'));
  const out = join(dir, 'index.html');
  let page: Awaited<ReturnType<typeof writePlayground>>;
  beforeAll(async () => {
    page = await writePlayground(out);
  }, 60_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes one self-contained Artifact body', () => {
    const { bytes } = page;
    const html = readFileSync(out, 'utf8');
    expect(html.startsWith('<title>League of Taverns Playground</title>')).toBe(true);
    expect(html).not.toMatch(/<(html|head|body)\b|<!doctype/i);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html.match(/<style\b/g)).toHaveLength(1);
    expect(html).toContain('var __PLAYGROUND_DATA__=');
    expect(html).not.toMatch(/\bfetch\(/);
    expect(html).toMatch(/^[\t\n\r -~]*$/);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
  });

  it("carries each pooled character's name and a portrait thumbnail, and nothing the engine reads", () => {
    const built = page.data;
    const ids = parts.pool.map((p) => p.character.ref.id);
    expect(Object.keys(built.chrome).sort()).toEqual([...ids].sort());
    expect(built.chrome['bruno-the-bruiser']).toMatchObject({ name: 'Bruno', epithet: 'the Bruiser' });
    for (const id of ids) {
      const uri = built.chrome[id]!.portrait;
      expect(uri, id).toMatch(/^data:image\/png;base64,/);
      const png = Buffer.from(uri!.slice(uri!.indexOf(',') + 1), 'base64');
      expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20)), id).toBe(160);
    }
    expect(runMockSeason(seasonInputFromData(built), { seed: 'sim-1' }).ndjson).toBe(sim1.ndjson);
  });

  it('escapes the inlined JSON so nothing can close the script early', () => {
    expect(scriptSafeJson({ s: '</script><!-- é' })).toBe('{"s":"\\u003c/script>\\u003c!-- \\u00e9"}');
    expect(() => renderPage('<title>x</title>', data, 'a("</script>")')).toThrow(/script/);
    expect(() => renderPage('<html><title>x</title>', data, '')).toThrow(/html/);
  });
});
