import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { replayLog } from '@league-of-taverns/engine';
import type { Ballot } from '@league-of-taverns/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deepEqual } from '../src/deep-equal';
import { loadSeasonParts } from '../src/load';
import { renderPage, scriptSafeJson, writePlayground } from '../src/playground-build';
import { seasonInputFromData, serializeSeason, type PlaygroundData } from '../src/playground/data';
import { currentDraftRound, feedItems, latestEpisode, TEACH_ROUNDS, type FeedItem, type FeedOptions } from '../src/playground/feed';
import { CALL_MARKS, FACES, MEANINGS, SHARE_LINE_MAX, shareEmoji, shareText, type Share } from '../src/playground/share';
import { bannerSchema } from '@league-of-taverns/scripts/lib/banner';
import {
  BANNER_CHOICES,
  artCss,
  bannerCss,
  banneredTaverns,
  checkLabel,
  decidedAfter,
  draftBoard,
  draftCalls,
  formatCr,
  ranksOf,
  readingOrder,
  REACH_PICKS,
  runningTally,
  seedWords,
  STEAL_PICKS,
  strategyLine,
  tableMoves,
  tagPhrase,
  tavernId,
  tavernWord,
  tavernWords,
  voteOrdinal,
} from '../src/playground/view';
import { runSeason, seasonInput } from '../src/season-runner';

// The browser playground (sims/src/playground/): its data round-trips through
// JSON to the same seasons as the Node path, its pure view helpers and the
// Common Room's feed behave, and the build writes one self-contained page.

const parts = loadSeasonParts();
const data: PlaygroundData = JSON.parse(JSON.stringify(serializeSeason(parts, 'sims/fixtures/lich-season', 'Test'))) as PlaygroundData;
const input = seasonInputFromData(data);
const sim1 = runSeason(input, { seed: 'sim-1' });

describe('playground data', () => {
  it('rebuilds a SeasonInput from JSON that plays a seed to the same NDJSON as the Node path', () => {
    expect(sim1.ndjson).toBe(runSeason(seasonInput(parts), { seed: 'sim-1' }).ndjson);
  });

  it('keeps only the snapshot records the pool uses, verbatim', () => {
    const bases = new Set(parts.pool.map((p) => p.character.ref.base));
    expect(data.snapshot.map((r) => r.slug).sort()).toEqual([...bases].sort());
    for (const record of data.snapshot) expect(record).toEqual(parts.snapshot.find((r) => r.slug === record.slug));
  });

  it('rejects data of another version', () => {
    expect(() => seasonInputFromData({ ...data, version: 1 as never })).toThrow(/version/);
  });
});

describe('deepEqual (the replay self-check)', () => {
  it('agrees with isDeepStrictEqual on a replayed season and on a tampered one', () => {
    const replayed = replayLog(sim1.ndjson);
    expect(deepEqual(replayed, sim1.state)).toBe(true);
    expect(isDeepStrictEqual(replayed, sim1.state)).toBe(true);
    const tampered = { ...sim1.state, jury: [...sim1.state.jury].reverse() };
    expect(deepEqual(tampered, sim1.state)).toBe(false);
  });

  it('follows the strict rules on primitives, arrays, objects, Maps and Sets', () => {
    const cases: Array<[unknown, unknown]> = [
      [1, 1],
      [NaN, NaN],
      [0, -0],
      [1, '1'],
      [[1, 2], [2, 1]],
      [{ a: 1, b: [2] }, { b: [2], a: 1 }],
      [{ a: undefined }, {}],
      [new Map([['a', 1]]), new Map([['a', 2]])],
      [new Set([1, 2]), new Set([2, 1])],
    ];
    for (const [a, b] of cases) expect(deepEqual(a, b), `${String(a)} vs ${String(b)}`).toBe(isDeepStrictEqual(a, b));
  });
});

describe('view helpers', () => {
  it('puts every draft pick in its snake slot', () => {
    const rows = draftBoard(['a', 'b', 'c'], [0, 1, 2, 3, 4].map((pick) => ({ pick, tavern: 'x', character: `c${pick}` })));
    expect(rows.map((r) => r.cells.map((c) => c?.character ?? null))).toEqual([
      ['c0', 'c1', 'c2'],
      [null, 'c4', 'c3'],
    ]);
  });

  it(`calls a steal ${STEAL_PICKS} picks late and a reach ${REACH_PICKS} early, against the scouts' rank`, () => {
    const ranks = ranksOf(new Map([['a', 10], ['b', 9], ['c', 1]]));
    expect([...ranks]).toEqual([['a', 0], ['b', 1], ['c', 2]]);
    const calls = draftCalls(
      [
        { pick: 0, tavern: 't', character: 'c' },
        { pick: 5, tavern: 't', character: 'b' },
        { pick: 9, tavern: 't', character: 'z' },
      ],
      new Map([['c', 8], ['b', 0]]),
    );
    expect(calls.map((c) => c.notes)).toEqual([['reach'], ['steal'], []]);
  });

  it('reads a card in words', () => {
    expect(tagPhrase('type:undead')).toBe('one of the dead');
    expect(tagPhrase('subtype:orc')).toBe('an orc');
    expect(tagPhrase('law:lawful')).toBe('someone lawful');
    expect(strategyLine({ kind: 'loyal', tag: 'type:giant' })).toBe('wants a giant to win');
    expect(strategyLine({ kind: 'coattails' }, 7)).toMatch(/final 7, turns on the strongest/);
    expect(checkLabel({ type: 'skill', skill: 'sleight_of_hand', dc: 12, advantage: { speed: 'swim' } })).toBe('Sleight of hand DC 12, swim speed: advantage');
    expect(checkLabel({ type: 'save', ability: 'con', dc: 13 }, 15)).toBe('Con save DC 15');
  });

  it("reads the votes with the boot's last vote last, and stops once nobody can catch it", () => {
    const b = (voter: string, target: string): Ballot => ({ voter, target });
    const ballots = [b('1', 'x'), b('2', 'x'), b('3', 'y'), b('4', 'x'), b('5', 'z'), b('6', 'x'), b('7', 'y')];
    const order = readingOrder(ballots, 'x');
    expect([...order].sort((p, q) => p.voter.localeCompare(q.voter))).toEqual(ballots);
    expect(order.at(-1)!.target).toBe('x');
    expect(runningTally(order).at(-1)).toBe(4);
    const lopsided = [b('1', 'x'), b('2', 'x'), b('3', 'x'), b('4', 'x'), b('5', 'x'), b('6', 'y')];
    expect(decidedAfter(lopsided, 'x')).toBe(4);
    expect(decidedAfter(ballots, 'x')).toBe(6);
    expect(decidedAfter([b('1', 'x'), b('2', 'y')], 'x')).toBe(2);
    expect(voteOrdinal(0)).toBe('First vote');
    expect(voteOrdinal(11)).toBe('Vote 12');
  });

  it('formats CRs and seeds', () => {
    expect([1, 2, 4, 8, 100].map(formatCr)).toEqual(['1/8', '1/4', '1/2', '1', '12 1/2']);
    expect(seedWords(() => 0)).toBe('amber-ale-0');
    expect(seedWords(() => 0.999)).not.toContain('/');
  });

  it('takes one word per slot of a tavern name, capitalised, and files it under a kebab id', () => {
    expect(tavernWord('  salty ')).toBe('Salty');
    expect(tavernWord("hog's")).toBe("Hog's");
    expect(tavernWord('half-drunk')).toBe('Half-drunk');
    expect(tavernWord('Ölbräu')).toBe('Ölbräu');
    for (const bad of ['', 'two words', 'r2d2', '-dash', "trail'", 'x'.repeat(15)]) expect(tavernWord(bad)).toBeNull();
    expect(tavernId("The Hog's Anvil")).toBe('the-hogs-anvil');
    expect(tavernId('The Ölbräu Mug')).toBe('the-olbrau-mug');
    const { adjective, noun } = tavernWords(() => 0);
    expect(`The ${adjective} ${noun}`).toBe('The Amber Ale');
  });

  it('offers six well-formed banners, each its own colour and texture', () => {
    for (const b of BANNER_CHOICES) expect(bannerSchema.safeParse(b.banner).success).toBe(true);
    expect(new Set(BANNER_CHOICES.map((b) => b.banner.mark)).size).toBe(BANNER_CHOICES.length);
    expect(new Set(BANNER_CHOICES.map((b) => b.banner.texture)).size).toBe(BANNER_CHOICES.length);
  });

  it('gives each tavern its previous row and the places it rose', () => {
    const moves = tableMoves(
      [
        { tavern: 'a', rank: 1 },
        { tavern: 'b', rank: 2 },
      ],
      [
        { tavern: 'b', rank: 1 },
        { tavern: 'a', rank: 2 },
      ],
    );
    expect(moves.get('b')).toEqual({ wasRow: 1, rose: 1 });
    expect(moves.get('a')).toEqual({ wasRow: 0, rose: -1 });
  });
});

describe('the Common Room', () => {
  const me = sim1.state.draft.order[0]!;
  const opts: FeedOptions = { me, teams: input.managers.length, rounds: input.config.roster.size, ranks: new Map() };
  const votes = input.config.contest.castSize - input.config.contest.finalists;
  const items = feedItems(sim1.events, opts);
  const kinds = (list: ReadonlyArray<FeedItem>, kind: FeedItem['kind']) => list.filter((i) => i.kind === kind);

  it('tells the season in order: the opening, the tavern pick, the draft, each episode, the finale and the rounds', () => {
    expect(items[1]!.kind).toBe('season');
    expect(kinds(items, 'tavern')).toHaveLength(input.managers.length);
    expect(kinds(items, 'draft-round')).toHaveLength(input.config.roster.size);
    expect(kinds(items, 'episode-open')).toHaveLength(votes);
    expect(kinds(items, 'challenge')).toHaveLength(votes);
    expect(kinds(items, 'vote')).toHaveLength(votes);
    expect(kinds(items, 'finale')).toHaveLength(1);
    const rounds = kinds(items, 'round') as Array<Extract<FeedItem, { kind: 'round' }>>;
    expect(rounds.map((r) => r.final)).toEqual(input.config.schedule.rounds.map((_, i) => i === input.config.schedule.rounds.length - 1));
    expect(currentDraftRound(items)).toBe(3);
    expect(latestEpisode(items)).toBe(votes);
  });

  it("keeps rivals' calls sealed until the vote; your own shows at once", () => {
    const calls = kinds(items, 'call') as Array<Extract<FeedItem, { kind: 'call' }>>;
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.target === null).toBe(c.tavern !== me);
    const votes = kinds(items, 'vote') as Array<Extract<FeedItem, { kind: 'vote' }>>;
    for (const v of votes) expect(v.calls).toHaveLength(input.managers.length);
  });

  it('never takes back a message: every key told so far is still there as more of the log arrives', () => {
    let seen = new Set<string>();
    for (const n of [40, 80, 120, sim1.events.length]) {
      const keys = new Set(feedItems(sim1.events.slice(0, n), opts).map((i) => i.key));
      for (const k of seen) expect(keys.has(k), k).toBe(true);
      seen = keys;
    }
  });
});

describe('the share', () => {
  const me = sim1.state.draft.order[0]!;
  const opts: FeedOptions = { me, teams: input.managers.length, rounds: input.config.roster.size, ranks: new Map() };
  const items = feedItems(sim1.events, opts);
  const votes = items.filter((i) => i.kind === 'vote') as Array<Extract<FeedItem, { kind: 'vote' }>>;
  const finale = items.find((i) => i.kind === 'finale') as Extract<FeedItem, { kind: 'finale' }>;
  const roster = sim1.state.taverns.get(me)!.roster;
  const roundOfVote = (episode: number): number => {
    let end = 0;
    for (const [i, n] of input.config.schedule.rounds.entries()) if (episode <= (end += n)) return i + 1;
    return input.config.schedule.rounds.length;
  };

  it('reads in four parts: the vote, the exit prediction, the tavern and the head-to-head', () => {
    const share: Share = { kind: 'vote', episode: 6, votes: 9, call: CALL_MARKS.none, faces: [FACES.safe, FACES.gone, FACES.immune], h2h: { mine: 19, theirs: 22, rival: 'The Sleeping Giant' } };
    expect(shareText(share)).toBe('Vote 6 of 9\nExit Prediction:\n💤\nMy Tavern:\n😌🪦🛡️\nHead to Head:\n19–22 (The Sleeping Giant)');
    expect(shareText({ kind: 'finale', right: 6, votes: 9, faces: [FACES.winner, FACES.gone, FACES.gone], h2h: null })).toBe('The finale\nExit Prediction:\n6 of 9\nMy Tavern:\n👑🪦🪦');
    expect(shareEmoji(share)).toEqual(['💤', '😌', '🛡️', '🪦']);
  });

  it(`keeps every line within ${SHARE_LINE_MAX} characters, so no chat bubble wraps it`, () => {
    const long: Share = { kind: 'vote', episode: 2, votes: 9, call: CALL_MARKS.right, faces: [FACES.safe], h2h: { mine: 104, theirs: 98, rival: 'The Tarnished Wyvernmonger' } };
    expect(shareText(long).split('\n').slice(-2)).toEqual(['104–98', '(The Tarnished Wyvernmonger)']);
    for (const card of [...votes.map((v) => v.share!), finale.share!]) {
      for (const line of shareText(card.share).split('\n')) expect([...line].length, line).toBeLessThanOrEqual(SHARE_LINE_MAX);
    }
  });

  it('marks your exit prediction from your call: right, early, or none', () => {
    for (const v of votes) {
      const call = v.calls.find((c) => c.tavern === me)!;
      const mark = v.share!.share.kind === 'vote' ? v.share!.share.call : null;
      if (call.target === null) expect(mark).toBe(CALL_MARKS.none);
      else if (call.right) expect(mark).toBe(call.early ? CALL_MARKS.early : CALL_MARKS.right);
      else expect(mark).toBe(v.vote.ballots.some((b) => b.target === call.target) ? CALL_MARKS.close : CALL_MARKS.missed);
    }
  });

  it('gives each of your monsters one face, in draft order, and keeps the gone in their slots', () => {
    const out = new Set<string>();
    for (const v of votes) {
      const faces = v.share!.share.faces;
      expect(faces).toHaveLength(roster.length);
      roster.forEach((id, i) => {
        if (out.has(id)) expect(faces[i]).toBe(FACES.gone);
        else if (id === v.vote.boot) expect(faces[i]).toBe(FACES.out);
        else if (id === v.immune) expect(faces[i]).toBe(FACES.immune);
        else expect([FACES.safe, FACES.scared]).toContain(faces[i]);
      });
      out.add(v.vote.boot);
    }
    const crowned = roster.map((id) => (id === sim1.state.finale!.winner ? FACES.winner : sim1.state.finale!.finalists.includes(id) ? FACES.finalist : FACES.gone));
    expect(finale.share!.share.faces).toEqual(crowned);
  });

  it("ends each round's last vote on the score the round's results report", () => {
    const rounds = items.filter((i) => i.kind === 'round') as Array<Extract<FeedItem, { kind: 'round' }>>;
    for (const round of rounds) {
      const m = round.matchups.find((x) => x.home === me || x.away === me)!;
      const [mine, theirs] = m.home === me ? [m.homePoints, m.awayPoints] : [m.awayPoints, m.homePoints];
      const last = round.final ? finale.share!.share : votes.filter((v) => roundOfVote(v.episode) === round.round).at(-1)!.share!.share;
      expect(last.h2h).toMatchObject({ mine, theirs });
    }
  });

  it(`explains every emoji in round ${TEACH_ROUNDS}'s shares, then only ones not seen before`, () => {
    const seen = new Set<string>();
    for (const card of [...votes.map((v) => ({ round: roundOfVote(v.episode), card: v.share! })), { round: Infinity, card: finale.share! }]) {
      const used = shareEmoji(card.card.share);
      expect(card.card.teach).toEqual(card.round <= TEACH_ROUNDS ? used : used.filter((e) => !seen.has(e)));
      for (const e of used) seen.add(e);
    }
    for (const e of seen) expect(MEANINGS[e as keyof typeof MEANINGS]).toBeTruthy();
  });

  it('has no share without a tavern of your own', () => {
    const none = feedItems(sim1.events, { ...opts, me: null });
    for (const i of none) if (i.kind === 'vote' || i.kind === 'finale') expect(i.share).toBeNull();
  });
});

describe('stylesheets', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const inn = { banner: { field: '#d4e6f7', charge: '#f5e9a8', mark: '#2a78d6', texture: 'rain' as const } };

  it("sets each character's face and thumbnail, skipping anything that could break out", () => {
    expect(artCss({ doug: { face: png, portrait: png } })).toBe(`[data-art="doug"]{--art-face:url("${png}");--art-thumb:url("${png}")}`);
    expect(artCss({ 'x"]{}': { face: png }, sneaky: { face: 'data:image/png;base64,AA")}body{x:url("' } })).toBe('');
  });

  it("sets each tavern's colours and texture, skipping a bad id or colour", () => {
    expect(bannerCss({ 'the-inn': inn }).split('\n')).toEqual([
      ':root{--mark-the-inn:#2a78d6}',
      '[data-banner="the-inn"]{--banner-field:#d4e6f7;--banner-charge:#f5e9a8;--banner-mark:#2a78d6;--banner-pattern:var(--tex-rain)}',
    ]);
    const bad = { 'the-inn': inn, 'bad"]{x:y}': inn, 'red-one': { banner: { ...inn.banner, mark: 'red;}' } } };
    expect([...banneredTaverns(bad)]).toEqual(['the-inn']);
  });
});

describe('playground build', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lot-playground-'));
  const out = join(dir, 'index.html');
  let page: Awaited<ReturnType<typeof writePlayground>>;
  beforeAll(async () => {
    page = await writePlayground(out);
  }, 120_000);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('writes one self-contained page under 2 MiB, pure ASCII', () => {
    const html = readFileSync(out, 'utf8');
    expect(html.startsWith("<title>The Lich's Contest</title>")).toBe(true);
    expect(html).not.toMatch(/<(html|head|body)\b|<!doctype/i);
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain('var __PLAYGROUND_DATA__=');
    expect(html).toContain('Copyright (c) 2018 Webkul');
    expect(html).toMatch(/^[\t\n\r -~]*$/);
    expect(page.bytes).toBeLessThan(2 * 1024 * 1024);
  });

  it('carries the chrome for every pooled character, tavern and challenge, and plays the same seasons', () => {
    const built = page.data;
    expect(Object.keys(built.chrome).sort()).toEqual(parts.pool.map((p) => p.character.ref.id).sort());
    for (const p of parts.pool) expect(built.chrome[p.character.ref.id]!.face, p.character.ref.id).toMatch(/^data:image\/png;base64,/);
    expect(Object.keys(built.tavernChrome).sort()).toEqual(parts.taverns.map((t) => t.id).sort());
    expect(Object.keys(built.challengeChrome)).toHaveLength(parts.challenges.length);
    expect(runSeason(seasonInputFromData(built), { seed: 'sim-1' }).ndjson).toBe(sim1.ndjson);
  });

  it('escapes the inlined JSON so nothing can close the script early', () => {
    expect(scriptSafeJson({ s: '</script><!-- é' })).toBe('{"s":"\\u003c/script>\\u003c!-- \\u00e9"}');
    expect(() => renderPage('<title>x</title>', data, 'a("</script>")')).toThrow(/script/);
    expect(() => renderPage('<html><title>x</title>', data, '')).toThrow(/html/);
  });
});
