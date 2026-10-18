import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { TRAITS, modifierCost } from '@league-of-taverns/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { ValidationFailure } from '../src/lib/main';
import { loadSnapshot } from '../src/lib/repo';
import { abilityMix, loadChallenges, loadManagers, loadPool, loadSeason, loadSeasonConfig, loadTaverns } from '../src/lib/season';
import { validateSeason } from '../src/lib/validate-season';

const SNAPSHOT_ID = 'open5e-v1-2026-10';
const realSnapshot = loadSnapshot(SNAPSHOT_ID);

/** The thrown message, or '' if `fn` doesn't throw a ValidationFailure. */
function failureOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationFailure) return error.message;
    throw error;
  }
  return '';
}

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** A temp repo root with a small snapshot (`fx-snap`) of real SRD records. */
function makeRoot(prefix: string, slugs: ReadonlyArray<string>): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const records = slugs.map((slug) => realSnapshot.find((r) => r.slug === slug));
  const contents = `${JSON.stringify(records, null, 2)}\n`;
  write(join(root, 'data/open5e/fx-snap/monsters.json'), contents);
  const entry = { id: 'fx-snap', count: records.length, sha256: createHash('sha256').update(contents).digest('hex'), file: 'fx-snap/monsters.json' };
  write(join(root, 'data/open5e/manifest.json'), JSON.stringify({ snapshots: [entry] }));
  return root;
}

interface SeasonFixture {
  readonly config?: Record<string, unknown>;
  readonly pool?: ReadonlyArray<Record<string, unknown>>;
  readonly managers?: Record<string, unknown>;
  readonly taverns?: ReadonlyArray<Record<string, unknown>>;
  /** Challenge files by name; default one per episode. */
  readonly challenges?: Readonly<Record<string, Record<string, unknown>>>;
}

const CHARACTERS = { 'ogre-one': 'ogre', 'ogre-two': 'ogre', 'croc-one': 'crocodile', 'croc-two': 'crocodile' } as const;
const banner = (mark: string): Record<string, string> => ({ field: '#dde8f0', charge: '#f2ead0', mark, texture: 'rain' });

/**
 * A small contest under `root`/seasons/<id>/: a cast of 4, the final 2 (2
 * votes), one tavern with roster 2, one round.
 */
function makeSeason(root: string, id: string, fixture: SeasonFixture = {}): void {
  const dir = join(root, 'seasons', id);
  const config = {
    id,
    name: 'Fixture',
    snapshot: 'fx-snap',
    modifierRegistryVersion: 1,
    pool: 'pool.yaml',
    managers: 'managers.yaml',
    taverns: 'taverns.yaml',
    challenges: 'challenges',
    budget: { modifierPointsPerCharacter: 3 },
    roster: { size: 2 },
    draft: { format: 'snake', order: { mode: 'seeded' } },
    contest: { castSize: 4, finalists: 2, lapDc: 1 },
    scoring: { survive: 2, immunity: 3, juryVote: 2, winner: 10, call: 2, earlyCallBonus: 1 },
    schedule: { rounds: [2] },
    ...fixture.config,
  };
  write(join(dir, 'config.yaml'), toYaml(config));
  const pool = fixture.pool ?? Object.keys(CHARACTERS).map((c) => ({ id: c, strategy: { kind: 'floater' } }));
  write(join(dir, 'pool.yaml'), toYaml({ season: id, registry: 1, characters: pool }));
  for (const [character, base] of Object.entries(CHARACTERS)) write(join(root, 'characters', character, 'character.yaml'), toYaml({ id: character, base, status: 'active', chrome: { name: character } }));
  write(join(dir, 'managers.yaml'), toYaml(fixture.managers ?? { commissioner: { login: 'boss', githubId: 1 }, gm: { login: 'boss', githubId: 1 }, managers: [{ id: 'innkeeper', account: { bot: 'sharp' } }] }));
  write(join(dir, 'taverns.yaml'), toYaml({ season: id, taverns: fixture.taverns ?? [{ id: 'the-inn', name: 'The Inn', banner: banner('#123456') }] }));
  const challenges = fixture.challenges ?? {
    '01-swim.yaml': { id: 'swim', episode: 1, title: 'Swim', story: 'Swim.', checks: [{ type: 'skill', skill: 'athletics', dc: 12, advantage: { speed: 'swim' }, line: 'swim' }] },
    '02-think.yaml': { id: 'think', episode: 2, title: 'Think', story: 'Think.', checks: [{ type: 'ability', ability: 'int', dc: 10, line: 'think' }, { type: 'save', ability: 'wis', dc: 11, line: 'hold on' }] },
  };
  for (const [name, body] of Object.entries(challenges)) write(join(dir, 'challenges', name), toYaml(body));
}

describe('season-01 (in preparation)', () => {
  it('loads its config, managers and taverns in the contest format', () => {
    const { config, name } = loadSeasonConfig('season-01');
    expect(name).toBe('Season One');
    expect(config.contest).toMatchObject({ castSize: 12, finalists: 3 });
    expect(config.schedule.rounds.reduce((a, b) => a + b, 0)).toBe(9);
    expect(loadTaverns('season-01').map((t) => t.id)).toEqual(['the-gilded-flagon']);
    expect(loadManagers('season-01').managers.length).toBeGreaterThan(0);
  });

  it('is not ready to play yet: its pool and challenges are still to be authored', { timeout: 60_000 }, () => {
    const { issues } = validateSeason('season-01');
    expect(issues.join('\n')).toMatch(/fewer than config\.yaml contest\.castSize 12/);
    expect(issues.join('\n')).toMatch(/episode 1 has 0 challenges/);
  });
});

describe('a contest season', () => {
  let root: string;
  beforeAll(() => {
    root = makeRoot('lot-season-', ['ogre', 'crocodile']);
    makeSeason(root, 'good');
    makeSeason(root, 'wrong-id', { config: { id: 'other-id' } });
    makeSeason(root, 'bad-config', { config: { contest: { castSize: 4, finalists: 2, lapDc: 1, model: { noize: 1 } }, roster: { size: 0 } } });
    makeSeason(root, 'small-pool', { pool: [{ id: 'ogre-one', strategy: { kind: 'floater' } }] });
    makeSeason(root, 'bad-pool', {
      pool: [
        { id: 'ogre-one', strategy: { kind: 'loyal', tag: 'type:dragon' }, modifiers: [{ kind: 'skill_bonus', skill: 'athletics', value: 3 }, { kind: 'trait', trait: 'thick-skull' }] },
        { id: 'ogre-two' },
        { id: 'croc-one', strategy: { kind: 'floater' } },
        { id: 'croc-two', strategy: { kind: 'floater' } },
      ],
    });
    makeSeason(root, 'gappy', { challenges: { '01-swim.yaml': { id: 'swim', episode: 1, title: 'Swim', story: 'Swim.', checks: [{ type: 'skill', skill: 'athletics', dc: 12, line: 'swim' }] } } });
    makeSeason(root, 'no-line', { challenges: { '01.yaml': { id: 'a', episode: 1, title: 'A', story: 'A.', checks: [{ type: 'skill', skill: 'athletics', dc: 12 }] }, '02.yaml': { id: 'b', episode: 2, title: 'B', story: 'B.', checks: [{ type: 'skill', skill: 'jumping', dc: 12, line: 'jump' }] } } });
    makeSeason(root, 'same-marks', { taverns: [{ id: 'a', name: 'A', banner: banner('#123456') }, { id: 'b', name: 'B', banner: banner('#123456') }] });
    makeSeason(root, 'loyal-alone', { pool: [{ id: 'ogre-one', strategy: { kind: 'loyal', tag: 'type:dragon' } }, ...['ogre-two', 'croc-one', 'croc-two'].map((id) => ({ id, strategy: { kind: 'floater' } }))] });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('loads everything, with chrome split off the challenges', () => {
    const season = loadSeason('good', root);
    expect(season.config.contest.model).toEqual({});
    expect(season.pool.characters.map((c) => c.ref.id)).toEqual(['ogre-one', 'ogre-two', 'croc-one', 'croc-two']);
    expect(season.pool.strategies.get('ogre-one')).toEqual({ kind: 'floater' });
    expect(season.challenges.map((c) => c.episode)).toEqual([1, 2]);
    expect(season.challenges[1]!.challenge).toEqual({ id: 'think', checks: [{ type: 'ability', ability: 'int', dc: 10 }, { type: 'save', ability: 'wis', dc: 11 }] });
    expect(season.challenges[1]!.chrome).toEqual({ title: 'Think', story: 'Think.', lines: ['think', 'hold on'] });
    expect(abilityMix(season.challenges.map((c) => c.challenge))).toEqual({ str: 1, dex: 0, con: 0, int: 1, wis: 1, cha: 0 });
    expect(validateSeason('good', root).issues).toEqual([]);
  });

  it('requires id to match the folder name', () => {
    expect(failureOf(() => loadSeasonConfig('wrong-id', root))).toBe('seasons/wrong-id/config.yaml: id: "other-id" does not match its folder name "wrong-id"');
  });

  it('names every bad config field, an unknown model dial included', () => {
    const lines = failureOf(() => loadSeasonConfig('bad-config', root)).split('\n');
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/config\.yaml: contest\.model: /), expect.stringMatching(/config\.yaml: roster\.size: /)]));
  });

  it('needs at least the cast in the pool to load as a season (the pool alone still loads)', () => {
    expect(loadPool('small-pool', root).characters).toHaveLength(1);
    expect(failureOf(() => loadSeason('small-pool', root))).toMatch(/1 characters, fewer than config\.yaml contest\.castSize 4/);
  });

  it('lists every pool issue: over budget, and a missing strategy', () => {
    const message = failureOf(() => loadPool('bad-pool', root));
    expect(message).toMatch(/characters\[1\]\.strategy: /);
    expect(modifierCost([{ kind: 'skill_bonus', skill: 'athletics', value: 3 }, { kind: 'trait', trait: 'thick-skull' }], TRAITS)).toBe(4);
  });

  it('needs one challenge per episode, each check with a line and a real skill', () => {
    expect(failureOf(() => loadChallenges('gappy', root))).toMatch(/episode 2 has 0 challenges/);
    const lines = failureOf(() => loadChallenges('no-line', root)).split('\n');
    expect(lines).toEqual(expect.arrayContaining([expect.stringMatching(/01\.yaml: checks\[0\]\.line: /), expect.stringMatching(/02\.yaml: checks\[0\]\.skill: /)]));
  });

  it('gives every tavern its own banner mark', () => {
    expect(failureOf(() => loadTaverns('same-marks', root))).toMatch(/taverns\[1\]\.banner\.mark: #123456 is another tavern's mark/);
  });

  it('flags a loyal strategy no one else can satisfy', () => {
    expect(validateSeason('loyal-alone', root).issues).toEqual([expect.stringMatching(/ogre-one: loyal to "type:dragon", which no other pool member carries/)]);
  });
});

describe('loadSnapshot', () => {
  let root: string;
  beforeAll(() => {
    root = makeRoot('lot-snapshot-', ['ogre', 'crocodile']);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('loads the pinned snapshot with its hash verified', () => {
    expect(realSnapshot).toHaveLength(322);
    expect(loadSnapshot('fx-snap', root).map((r) => r.slug)).toEqual(['ogre', 'crocodile']);
  });

  it('fails on an unknown id, naming the known ones', () => {
    expect(failureOf(() => loadSnapshot('nope', root))).toBe('data/open5e/manifest.json: unknown snapshot "nope" (known: "fx-snap")');
  });

  it('fails on a tampered file', () => {
    const file = join(root, 'data/open5e/fx-snap/monsters.json');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, original.replace('"hit_points": 59', '"hit_points": 95'));
    try {
      expect(failureOf(() => loadSnapshot('fx-snap', root))).toMatch(/sha256 is [0-9a-f]{64}, but data\/open5e\/manifest\.json pins/);
    } finally {
      writeFileSync(file, original);
    }
  });
});
