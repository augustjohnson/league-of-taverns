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
  artCss,
  bannerCss,
  bestWeek,
  bannerGods,
  draftBoard,
  draftCalls,
  REACH_ROUNDS,
  STEAL_ROUNDS,
  formatCr,
  formatCrTotal,
  layoutMission,
  partyFrom,
  rostersAtLock,
  sampleMission,
  scoreFraction,
  scoreHistogram,
  seedWords,
  tableMoves,
  taleSteps,
  topSkills,
  weekOutcome,
  waiverReasonLabel,
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
    const party = partyFrom(['krrth', 'bruno-the-bruiser', 'doug', 'gizzik'], nodeInput.statsOf);
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
      if (entry.lineup !== null) for (const id of entry.lineup.starters) expect(roster).toContain(id);
    }
  });

  it('formats CRs, scores, skills and seeds', () => {
    expect([0, 1, 2, 4, 8, 12, 96, 100].map(formatCr)).toEqual(['0', '1/8', '1/4', '1/2', '1', '1 1/2', '12', '12 1/2']);
    expect([0, 1, 0.5, 2 / 3, 0.8, 3 / 7].map(scoreFraction)).toEqual(['0', '1', '1/2', '2/3', '4/5', '3/7']);
    expect([0, 2, 30, 58, 96, 100].map(formatCrTotal)).toEqual(['0', '0.25', '3.75', '7.25', '12', '12.5']);
    expect(['awarded', 'add_unavailable', 'roster_full', 'something_new'].map(waiverReasonLabel)).toEqual(['awarded', 'already taken', 'roster full', 'something new']);
    const skills = topSkills(nodeInput.statsOf('gizzik'));
    expect(skills).toHaveLength(3);
    expect(skills[0]!.modifier).toBeGreaterThanOrEqual(skills[2]!.modifier);
    const rand = rngFor('seed-words', 'test');
    for (let i = 0; i < 50; i++) expect(seedWords(rand)).toMatch(/^[a-z]+-[a-z]+-\d{1,2}$/);
  });
});

describe('the week reveal', () => {
  it('banks loot along the path and ends on what the engine carried home, or on 0 after a DNF', () => {
    let runs = 0;
    let dnfs = 0;
    for (const [week, byTavern] of sim1.state.results) {
      const mission = nodeInput.missions.get(week)!.mission;
      for (const { run } of byTavern.values()) {
        const steps = taleSteps(mission, run);
        expect(steps.map((st) => st.node)).toEqual(run.path);
        expect(steps.map((st) => st.from)).toEqual([null, ...run.path.slice(0, -1)]);
        expect(steps.filter((st) => st.record !== null).map((st) => st.record)).toEqual(run.nodes);
        const banked = steps.at(-1)?.total ?? 0;
        expect(banked).toBe(steps.reduce((sum, st) => sum + st.bank, 0));
        if (run.dnf) {
          dnfs++;
          expect(run.loot).toBe(0);
        } else {
          expect(banked).toBe(run.loot);
        }
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(30);
    expect(dnfs).toBeLessThan(runs);
  });
});

describe('week outcomes', () => {
  const week = { rank: 3, points: 40, projected: 50, dnf: false, retreated: false };

  it('picks one moment per week, the first that holds: DNF, top, retreat, beat the projection, else quiet', () => {
    expect(weekOutcome(week)).toBe('quiet');
    expect(weekOutcome({ ...week, points: 51 })).toBe('good');
    expect(weekOutcome({ ...week, points: 51, retreated: true })).toBe('retreat');
    expect(weekOutcome({ ...week, rank: 1, retreated: true })).toBe('top');
    expect(weekOutcome({ ...week, rank: 1, points: 0, dnf: true })).toBe('dnf');
  });

  it('does not crown a week where every tavern scored nothing', () => {
    expect(weekOutcome({ ...week, rank: 1, points: 0, projected: 0 })).toBe('quiet');
  });
});

describe('season finish', () => {
  it('finds the best week: the most points, the earliest on a tie, and whether it topped the week', () => {
    expect(bestWeek([])).toBeNull();
    expect(bestWeek([{ week: 1, points: 40, rank: 3 }, { week: 2, points: 90, rank: 1 }, { week: 3, points: 90, rank: 2 }])).toEqual({ week: 2, points: 90, topped: true });
    expect(bestWeek([{ week: 4, points: 0, rank: 1 }])).toEqual({ week: 4, points: 0, topped: false });
  });
});

describe('table moves', () => {
  it('gives each tavern its previous row and the places it rose, shared ranks included', () => {
    const before = [
      { tavern: 'a', rank: 1 },
      { tavern: 'b', rank: 2 },
      { tavern: 'c', rank: 2 },
      { tavern: 'd', rank: 4 },
    ];
    const after = [
      { tavern: 'd', rank: 1 },
      { tavern: 'a', rank: 2 },
      { tavern: 'c', rank: 2 },
      { tavern: 'e', rank: 4 },
    ];
    expect(Object.fromEntries(tableMoves(before, after))).toEqual({
      d: { wasRow: 3, rose: 3 },
      a: { wasRow: 0, rose: -1 },
      c: { wasRow: 2, rose: 0 },
      e: { wasRow: 3, rose: 0 },
    });
  });
});

describe('draft calls', () => {
  // Usually taken in the order a, b, c, d, e, then z (rarely drafted); two teams, so a round is two picks.
  const adp = new Map([
    ['z', 9],
    ['a', 0],
    ['b', 1.2],
    ['c', 2],
    ['d', 3.5],
    ['e', 4],
  ]);
  const pick = (n: number, tavern: string, character: string) => ({ pick: n, tavern, character });
  const none = { me: null, teams: 2, advice: new Map<number, string>() };

  it(`calls a steal ${STEAL_ROUNDS} round late and a reach ${REACH_ROUNDS} rounds early, against the average draft position`, () => {
    const calls = draftCalls([pick(0, 'x', 'b'), pick(1, 'y', 'c'), pick(2, 'y', 'z'), pick(3, 'x', 'a'), pick(4, 'x', 'd')], adp, none);
    expect(calls.map((c) => [c.character, c.adp, c.notes])).toEqual([
      ['b', 1.2, []],
      ['c', 2, []],
      ['z', 9, ['reach']],
      ['a', 0, ['steal']],
      ['d', 3.5, []],
    ]);
  });

  it('runs its eye over who usually goes next among those left', () => {
    const calls = draftCalls([pick(0, 'x', 'a'), pick(1, 'y', 'c'), pick(2, 'y', 'b')], adp, none);
    expect(calls.map((c) => c.board)).toEqual([
      ['a', 'b', 'c'],
      ['b', 'c', 'd'],
      ['b', 'd', 'e'],
    ]);
  });

  it('has no average for a character outside it, and no note', () => {
    expect(draftCalls([pick(9, 'x', 'q')], adp, none)[0]).toMatchObject({ adp: null, notes: [] });
  });

  it("marks your advisor's pick when you take it, and a rival sniping it when you pass on it", () => {
    const advice = new Map([
      [0, 'a'],
      [3, 'c'],
    ]);
    const picks = [pick(0, 'me', 'a'), pick(1, 'y', 'b'), pick(2, 'y', 'd'), pick(3, 'me', 'e'), pick(4, 'y', 'c')];
    expect(draftCalls(picks, adp, { me: 'me', teams: 2, advice }).map((c) => c.notes)).toEqual([['advice'], [], [], [], ['steal', 'sniped']]);
  });

  it('snipes only the suggestion from your latest turn, and never your own pick', () => {
    // Advised b at pick 0 (passed on), c at pick 2 (passed on): b going later is no snipe, c is.
    const advice = new Map([
      [0, 'b'],
      [2, 'c'],
    ]);
    const picks = [pick(0, 'me', 'a'), pick(1, 'y', 'd'), pick(2, 'me', 'e'), pick(3, 'y', 'b'), pick(4, 'y', 'c')];
    expect(draftCalls(picks, adp, { me: 'me', teams: 2, advice }).map((c) => c.notes.includes('sniped'))).toEqual([false, false, false, false, true]);
  });
});

describe('card art stylesheet', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';

  it("sets each character's face and thumbnail as custom properties, once", () => {
    expect(artCss({ doug: { face: png, portrait: png }, bruno: { face: png } }).split('\n')).toEqual([
      `[data-art="doug"]{--art-face:url("${png}");--art-thumb:url("${png}")}`,
      `[data-art="bruno"]{--art-face:url("${png}")}`,
    ]);
  });

  it('skips a character with no face, or an id or image that could break out of the stylesheet', () => {
    expect(artCss({ plain: { portrait: png }, 'x"]{}': { face: png }, sneaky: { face: 'data:image/png;base64,AA")}body{x:url("' } })).toBe('');
  });
});

describe('banner stylesheet', () => {
  const crow = { name: 'The Storm Crow', banner: { field: '#d4e6f7', charge: '#f5e9a8', mark: '#2a78d6', texture: 'rain' as const } };

  it('sets each god\'s colours and texture as custom properties, and its mark on :root', () => {
    expect(bannerCss({ 'the-storm-crow': crow }).split('\n')).toEqual([
      ':root{--mark-the-storm-crow:#2a78d6}',
      '[data-banner="the-storm-crow"]{--banner-field:#d4e6f7;--banner-charge:#f5e9a8;--banner-mark:#2a78d6;--banner-pattern:var(--tex-rain)}',
    ]);
  });

  it('skips a god whose id or colours could break out of the stylesheet', () => {
    const gods = {
      'the-storm-crow': crow,
      'bad"]{x:y}': crow,
      'the-red-one': { ...crow, banner: { ...crow.banner, mark: 'red;}body{display:none' } },
    };
    expect([...bannerGods(gods)]).toEqual(['the-storm-crow']);
    expect(bannerCss(gods)).not.toMatch(/bad|red|display/);
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
    const { bytes, data: built } = page;
    // Every sponsoring god's chrome rides along for the banners.
    expect(Object.keys(built.gods).sort()).toEqual(parts.sponsors.map((sp) => sp.id).sort());
    expect(bannerGods(built.gods).size).toBe(parts.sponsors.length);
    // Every pooled character with a portrait gets the card's face crop.
    for (const { character } of parts.pool) expect(built.chrome[character.ref.id]?.face, character.ref.id).toMatch(/^data:image\/png;base64,/);
    const html = readFileSync(out, 'utf8');
    expect(html.startsWith('<title>League of Taverns Playground</title>')).toBe(true);
    expect(html).not.toMatch(/<(html|head|body)\b|<!doctype/i);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html.match(/<style\b/g)).toHaveLength(1);
    expect(html).toContain('var __PLAYGROUND_DATA__=');
    // micron's CSS is vendored into the one style block, with its MIT notice.
    expect(html).toContain('.mjs-swing{');
    expect(html).toContain('Copyright (c) 2018 Webkul');
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
      expect(Math.max(png.readUInt32BE(16), png.readUInt32BE(20)), id).toBe(88);
    }
    expect(runMockSeason(seasonInputFromData(built), { seed: 'sim-1' }).ndjson).toBe(sim1.ndjson);
  });

  it('escapes the inlined JSON so nothing can close the script early', () => {
    expect(scriptSafeJson({ s: '</script><!-- é' })).toBe('{"s":"\\u003c/script>\\u003c!-- \\u00e9"}');
    expect(() => renderPage('<title>x</title>', data, 'a("</script>")')).toThrow(/script/);
    expect(() => renderPage('<html><title>x</title>', data, '')).toThrow(/html/);
  });
});
