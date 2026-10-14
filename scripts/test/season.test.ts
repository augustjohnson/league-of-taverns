import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAITS, modifierCost } from '@league-of-taverns/engine';
import type { Open5eMonster } from '@league-of-taverns/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { ValidationFailure } from '../src/lib/main';
import { REPO_ROOT, loadSnapshot } from '../src/lib/repo';
import {
  isSpellcaster,
  loadManagers,
  loadPool,
  loadSchedule,
  loadSeason,
  loadSeasonConfig,
} from '../src/lib/season';
import { validateSeason } from '../src/lib/validate-season';

// T3.4 (season loaders) and T1.4 (snapshot integrity).

const repo = fileURLToPath(REPO_ROOT);
const SNAPSHOT_ID = 'open5e-v1-2026-10';
const realSnapshot = loadSnapshot(SNAPSHOT_ID);
const season01Config = parseYaml(readFileSync(join(repo, 'seasons/season-01/config.yaml'), 'utf8')) as Record<string, unknown>;

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
  const entry = {
    id: 'fx-snap',
    count: records.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
    file: 'fx-snap/monsters.json',
  };
  write(join(root, 'data/open5e/manifest.json'), JSON.stringify({ snapshots: [entry] }));
  return root;
}

interface SeasonFixture {
  readonly config?: Record<string, unknown>;
  readonly pool?: ReadonlyArray<Record<string, unknown>>;
  readonly characters?: Readonly<Record<string, string>>;
  readonly managers?: Record<string, unknown>;
  readonly weeks?: ReadonlyArray<number>;
  /** The season's taverns and their gods (D-52). Default: The Inn, blessed by the-sea. */
  readonly taverns?: ReadonlyArray<{ readonly id: string; readonly name: string; readonly god: string }>;
  /** Week → sponsor (god) id. Unlisted weeks are unsponsored. */
  readonly sponsorOf?: Readonly<Record<number, string>>;
}

/** Write seasons/<id>/ under `root` with season-01's config adjusted by `fixture`. */
function makeSeason(root: string, id: string, fixture: SeasonFixture = {}): void {
  const dir = join(root, 'seasons', id);
  const config = { ...season01Config, id, snapshot: 'fx-snap', weeks: (fixture.weeks ?? [1, 2]).length, ...fixture.config };
  write(join(dir, 'config.yaml'), toYaml(config));
  write(join(dir, 'pool.yaml'), toYaml({ season: id, registry: 1, characters: fixture.pool ?? [{ id: 'ogre-one' }] }));
  for (const [character, base] of Object.entries(fixture.characters ?? { 'ogre-one': 'ogre' })) {
    write(
      join(root, 'characters', character, 'character.yaml'),
      toYaml({ id: character, base, status: 'active', chrome: { name: character } }),
    );
  }
  write(
    join(dir, 'managers.yaml'),
    toYaml(
      fixture.managers ?? {
        commissioner: { login: 'boss', githubId: 1 },
        gm: { login: 'boss', githubId: 1 },
        managers: [{ id: 'innkeeper', account: { bot: 'value' } }],
      },
    ),
  );
  const weeks = (fixture.weeks ?? [1, 2]).map((week) => ({
    week,
    title: `Week ${week}`,
    environment: 'forest',
    theme: '',
    commitment: null,
    sponsor: fixture.sponsorOf?.[week] ?? null,
  }));
  const taverns = fixture.taverns ?? [{ id: 'the-inn', name: 'The Inn', god: 'the-sea' }];
  write(join(dir, 'schedule.yaml'), toYaml({ season: id, taverns, weeks }));
}

describe('season-01', () => {
  it('loads config.yaml as the engine SeasonConfig, with B in eighths', () => {
    const loaded = loadSeasonConfig('season-01');
    expect(loaded.config.budget.partyCr).toBe(96);
    expect(loaded.config.id).toBe('season-01');
    expect(loaded.name).toBe('Season One');
    expect(loaded.files).toEqual({ schedule: 'schedule.yaml', pool: 'pool.yaml', managers: 'managers.yaml' });
    expect(loaded.spellcasters).toEqual({ maxInPool: 4, maxPerEncounter: 0 });
    for (const key of ['name', 'schedule', 'pool', 'managers', 'spellcasters']) expect(loaded.config).not.toHaveProperty(key);
  });

  it('loads the pool: Bruno is an ogre at CR 2 whose modifiers cost 3 of 3', () => {
    const pool = loadPool('season-01');
    expect(pool.characters).toHaveLength(1);
    const bruno = pool.characters[0]!;
    expect(bruno.ref).toEqual({ id: 'bruno-the-bruiser', base: 'ogre' });
    expect(pool.cr.get('bruno-the-bruiser')).toBe(16);
    expect(modifierCost(bruno.modifiers, TRAITS)).toBe(3);
    expect(loadSeasonConfig('season-01').config.budget.modifierPointsPerCharacter).toBe(3);
    expect(pool.spellcasters).toEqual([]);
  });

  it('loads managers and a six-week schedule', () => {
    expect(loadManagers('season-01').managers.map((m) => m.id)).toEqual(['example-manager']);
    expect(loadSchedule('season-01').taverns.map((t) => t.id)).toEqual(['the-gilded-flagon']);
    expect(loadSchedule('season-01').weeks.map((w) => w.week)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('passes every validate check', () => {
    const report = validateSeason('season-01');
    expect(report.issues).toEqual([]);
    expect(report.checked.missions.map((m) => m.id)).toContain('example-drowned-toll');
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
      expect(failureOf(() => loadSnapshot('fx-snap', root))).toMatch(
        /^data\/open5e\/fx-snap\/monsters\.json: sha256 is [0-9a-f]{64}, but data\/open5e\/manifest\.json pins [0-9a-f]{64} for snapshot "fx-snap"/,
      );
    } finally {
      writeFileSync(file, original);
    }
  });
});

describe('isSpellcaster', () => {
  it('flags 37 of the 322 SRD records, mephits and hags included (D-43)', () => {
    const casters = realSnapshot.filter(isSpellcaster).map((r) => r.slug);
    expect(casters).toHaveLength(37);
    for (const slug of ['mage', 'archmage', 'druid', 'priest', 'dust-mephit', 'ice-mephit', 'magma-mephit', 'steam-mephit', 'sea-hag']) {
      expect(casters).toContain(slug);
    }
    for (const slug of ['ogre', 'crocodile', 'imp', 'sprite']) expect(casters).not.toContain(slug);
  });

  it('looks at actions as well as special abilities', () => {
    const caster = { special_abilities: null, actions: [{ name: 'Innate Spellcasting (3/Day)', desc: '' }] } as unknown as Open5eMonster;
    expect(isSpellcaster(caster)).toBe(true);
  });
});

describe('loadSeasonConfig', () => {
  let root: string;
  beforeAll(() => {
    root = makeRoot('lot-config-', ['ogre']);
    makeSeason(root, 'half-b', { config: { budget: { partyCr: '1/2', modifierPointsPerCharacter: 3 } } });
    makeSeason(root, 'bad-config', {
      config: { name: undefined, budget: { partyCr: '13/2', modifierPointsPerCharacter: 3 }, roster: { size: 7, starters: 5, ownership: 'exclusive' } },
    });
    makeSeason(root, 'wrong-id', { config: { id: 'other-id' } });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('converts fractional CR to eighths', () => {
    expect(loadSeasonConfig('half-b', root).config.budget.partyCr).toBe(4);
  });

  it('names the file and every bad field', () => {
    const lines = failureOf(() => loadSeasonConfig('bad-config', root)).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^seasons\/bad-config\/config\.yaml: name: /),
        'seasons/bad-config/config.yaml: budget.partyCr: "13/2" is not a CR: expected 0, "1/8", "1/4", "1/2" or a whole number up to 30',
        expect.stringMatching(/^seasons\/bad-config\/config\.yaml: roster\.starters: /),
      ]),
    );
    expect(lines).toHaveLength(3);
  });

  it('requires id to match the folder name', () => {
    expect(failureOf(() => loadSeasonConfig('wrong-id', root))).toBe(
      'seasons/wrong-id/config.yaml: id: "other-id" does not match its folder name "wrong-id"',
    );
  });
});

describe('loadPool', () => {
  let root: string;
  beforeAll(() => {
    root = makeRoot('lot-pool-', ['ogre', 'crocodile', 'mage', 'priest']);
    makeSeason(root, 'over-budget', {
      pool: [
        { id: 'ogre-one', modifiers: [{ kind: 'skill_bonus', skill: 'athletics', value: 3 }, { kind: 'trait', trait: 'thick-skull' }] },
        { id: 'croc', modifiers: [{ kind: 'trait', trait: 'gills' }] },
        { id: 'ogre-one' },
        { id: 'ghost-folder' },
        { id: 'not-in-snapshot' },
        { id: 'fine-croc', modifiers: [{ kind: 'trait', trait: 'amphibious' }] },
      ],
      characters: { 'ogre-one': 'ogre', croc: 'crocodile', 'not-in-snapshot': 'tarrasque', 'fine-croc': 'crocodile' },
    });
    makeSeason(root, 'casters', {
      config: { spellcasters: { maxInPool: 1, maxPerEncounter: 0 } },
      pool: [{ id: 'ogre-one' }, { id: 'merlin' }, { id: 'friar' }],
      characters: { 'ogre-one': 'ogre', merlin: 'mage', friar: 'priest' },
    });
    makeSeason(root, 'one-caster', {
      config: { spellcasters: { maxInPool: 1, maxPerEncounter: 0 } },
      pool: [{ id: 'ogre-one' }, { id: 'merlin' }],
      characters: { 'ogre-one': 'ogre', merlin: 'mage' },
    });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('lists every pool issue in one failure', () => {
    const lines = failureOf(() => loadPool('over-budget', root)).split('\n');
    const label = 'seasons/over-budget/pool.yaml';
    expect(lines).toEqual([
      `${label}: characters[0] (ogre-one): [over_budget] modifiers cost 4, over the budget of 3`,
      `${label}: characters[1] (croc): [unknown_trait] modifiers[0]: unknown trait "gills"`,
      `${label}: characters[2] (ogre-one): duplicate id: already pooled at characters[0]`,
      `${label}: characters[3] (ghost-folder): characters/ghost-folder/character.yaml: file not found`,
      `${label}: characters[4] (not-in-snapshot): base "tarrasque" is not in snapshot "fx-snap"`,
    ]);
  });

  it('fails a pool over the spellcaster limit, naming the casters', () => {
    expect(failureOf(() => loadPool('casters', root))).toBe(
      'seasons/casters/pool.yaml: characters: 2 spellcasters, over config.yaml spellcasters.maxInPool of 1 (D-43): merlin (mage), friar (priest)',
    );
  });

  it('allows casters up to the limit and reports them', () => {
    const pool = loadPool('one-caster', root);
    expect(pool.spellcasters).toEqual(['merlin']);
    expect(pool.cr).toEqual(new Map([['ogre-one', 16], ['merlin', 48]]));
  });
});

describe('loadManagers and loadSchedule', () => {
  let root: string;
  beforeAll(() => {
    root = makeRoot('lot-managers-', ['ogre']);
    makeSeason(root, 'clash', {
      managers: {
        commissioner: { login: 'boss', githubId: 1 },
        gm: { login: 'boss', githubId: 1 },
        managers: [
          { id: 'alice', account: { login: 'alice', githubId: 10 } },
          { id: 'alice', account: { login: 'bob', githubId: 10 } },
          { id: 'pub', account: { login: 'Alice', githubId: null } },
          { id: 'bar', account: { bot: 'value' } },
          { id: 'den', account: { bot: 'value' } },
        ],
      },
      weeks: [1, 3],
    });
    makeSeason(root, 'no-boss', {
      managers: { gm: { login: 'boss', githubId: null }, managers: [{ id: 'innkeeper', account: { bot: 'genius' } }] },
    });
    makeSeason(root, 'short', { weeks: [1, 2], config: { weeks: 3 } });
    makeSeason(root, 'gods', {
      taverns: [
        { id: 'the-inn', name: 'The Inn', god: 'the-sea' },
        { id: 'the-pub', name: 'The Pub', god: 'the-sky' },
      ],
      sponsorOf: { 1: 'the-sea', 2: 'the-sea' },
    });
    makeSeason(root, 'stranger', { sponsorOf: { 1: 'nobody' } });
    makeSeason(root, 'home', { sponsorOf: { 2: 'the-sea' } });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('requires unique manager ids, GitHub ids and logins', () => {
    const label = 'seasons/clash/managers.yaml';
    expect(failureOf(() => loadManagers('clash', root)).split('\n')).toEqual([
      `${label}: managers[1].id: duplicate manager id "alice" (also managers[0])`,
      `${label}: managers[1].account.githubId: GitHub id 10 is already managers[0]`,
      `${label}: managers[2].account.login: "Alice" is already managers[0]`,
    ]);
  });

  it('requires the commissioner and known bot strategies', () => {
    const lines = failureOf(() => loadManagers('no-boss', root)).split('\n');
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^seasons\/no-boss\/managers\.yaml: commissioner: /),
        expect.stringMatching(/^seasons\/no-boss\/managers\.yaml: managers\[0\]\.account/),
      ]),
    );
  });

  it('requires weeks 1..N in order, matching config weeks', () => {
    expect(failureOf(() => loadSchedule('clash', root))).toBe(
      'seasons/clash/schedule.yaml: weeks[1].week: is 3, expected 2: weeks run 1..N in order with no gaps',
    );
    expect(failureOf(() => loadSchedule('short', root))).toBe(
      'seasons/short/schedule.yaml: weeks: has 2 entries, but config.yaml weeks is 3',
    );
  });

  it('loads taverns, their gods as sponsors, and each week\'s sponsor', () => {
    const schedule = loadSchedule('home', root);
    expect(schedule.taverns).toEqual([{ id: 'the-inn', name: 'The Inn', god: 'the-sea' }]);
    expect(schedule.sponsors).toEqual([{ id: 'the-sea', tavern: 'the-inn' }]);
    expect(schedule.weeks.map((w) => w.sponsor)).toEqual([null, 'the-sea']);
  });

  it('requires each week\'s sponsor to be a tavern\'s god, one week each, at most six taverns, and no more managers than taverns', () => {
    expect(failureOf(() => loadSchedule('gods', root))).toBe('seasons/gods/schedule.yaml: taverns: sponsor "the-sea" sets both week 1 and week 2');
    expect(failureOf(() => loadSchedule('stranger', root))).toBe(
      'seasons/stranger/schedule.yaml: taverns: week 1 names sponsor "nobody", which is not listed',
    );
    makeSeason(root, 'crowd', {
      managers: { commissioner: { login: 'boss', githubId: 1 }, gm: { login: 'boss', githubId: 1 }, managers: ['a', 'b'].map((id) => ({ id, account: { bot: 'value' } })) },
    });
    expect(failureOf(() => loadSeason('crowd', root))).toBe(
      'seasons/crowd/managers.yaml: managers: 2 managers, but schedule.yaml has only 1 tavern(s) to choose from',
    );
    makeSeason(root, 'seven', { taverns: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((x) => ({ id: `inn-${x}`, name: x, god: `god-${x}` })) });
    expect(failureOf(() => loadSchedule('seven', root))).toBe('seasons/seven/schedule.yaml: taverns: has 7 taverns; a league has at most 6 (D-01)');
  });

  it('loadSeason combines the failures from every file', () => {
    const lines = failureOf(() => loadSeason('clash', root)).split('\n');
    expect(lines.filter((l) => l.startsWith('seasons/clash/managers.yaml'))).toHaveLength(3);
    expect(lines.filter((l) => l.startsWith('seasons/clash/schedule.yaml'))).toHaveLength(1);
  });
});

describe('validateSeason', () => {
  let root: string;
  beforeAll(() => {
    root = makeRoot('lot-validate-', ['ogre', 'mage']);
    makeSeason(root, 'bad-missions');
    const mission = {
      schemaVersion: 1,
      id: 'mage-tower',
      season: 'other-season',
      environment: 'tower',
      nodes: [
        { id: 'start', rank: 0, kind: 'start' },
        { id: 'climb', rank: 1, kind: 'check', check: { type: 'skill', skill: 'athletics', dc: 25 }, loot: 100 },
        { id: 'duel', rank: 2, kind: 'battle', encounter: { creatures: [{ ref: 'mage', count: 1 }] } },
        { id: 'done', rank: 3, kind: 'end' },
      ],
      edges: [
        { from: 'start', to: 'climb', on: 'always' },
        { from: 'climb', to: 'duel', on: 'always' },
        { from: 'duel', to: 'done', on: 'win' },
      ],
    };
    write(join(root, 'seasons/bad-missions/missions/selected/tower.yaml'), toYaml(mission));
    write(join(root, 'seasons/bad-missions/missions/candidates/broken.yaml'), toYaml({ ...mission, nodes: 'nope' }));
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('reports every mission problem with its file', () => {
    const { issues } = validateSeason('bad-missions', root);
    const selected = 'seasons/bad-missions/missions/selected/tower.yaml';
    expect(issues).toEqual([
      expect.stringMatching(/^seasons\/bad-missions\/missions\/candidates\/broken\.yaml: nodes: /),
      expect.stringMatching(new RegExp(`^${selected}: climb: \\[dc\\] `)),
      `${selected}: [season] season is "other-season", but this is season "bad-missions"`,
      `${selected}: [file] id is "mage-tower", but the file is named "tower": name it mage-tower.yaml`,
      `${selected}: [environment] environment "tower" is not used by any week in the schedule (forest)`,
      expect.stringMatching(
        new RegExp(`^${selected}: duel: \\[encounter\\.caster\\] 1 spellcaster \\(1 × mage\\), over config\\.yaml spellcasters\\.maxPerEncounter of 0`),
      ),
    ]);
  });
});
