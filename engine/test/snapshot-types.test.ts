/**
 * T1.2: every record in the pinned snapshot matches `Open5eMonster` at
 * runtime, and the fixtures are verbatim copies of snapshot records.
 *
 * The check is structural and covers every typed field, so a type change that
 * the data doesn't back (or new data the type doesn't allow) fails here.
 */
import { describe, expect, it } from 'vitest';
import { FIXTURE_SLUGS, loadFixture, loadSnapshot } from './fixtures/open5e';

type Check = (value: unknown) => boolean;

const str: Check = (v) => typeof v === 'string';
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const nullable =
  (check: Check): Check =>
  (v) =>
    v === null || check(v);
const optional =
  (check: Check): Check =>
  (v) =>
    v === undefined || check(v);
const arrayOf =
  (check: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(check);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const recordOf =
  (check: Check): Check =>
  (v) =>
    isObject(v) && Object.values(v).every(check);

const ACTION_FIELDS: Readonly<Record<string, Check>> = {
  name: str,
  desc: str,
  attack_bonus: optional(num),
  damage_dice: optional(str),
  damage_bonus: optional(num),
};
const action: Check = (v) => isObject(v) && Object.entries(ACTION_FIELDS).every(([k, check]) => check(v[k]));

const SPEED_FIELDS: Readonly<Record<string, Check>> = {
  walk: optional(num),
  fly: optional(num),
  swim: optional(num),
  climb: optional(num),
  burrow: optional(num),
  hover: optional((v) => typeof v === 'boolean'),
  notes: optional(str),
};
const speed: Check = (v) =>
  isObject(v) &&
  Object.entries(SPEED_FIELDS).every(([k, check]) => check(v[k])) &&
  Object.values(v).every((x) => ['number', 'boolean', 'string'].includes(typeof x));

/** Mirrors `Open5eMonster` field by field. */
const MONSTER_FIELDS: Readonly<Record<string, Check>> = {
  slug: str,
  desc: str,
  name: str,
  size: str,
  type: str,
  subtype: str,
  group: nullable(str),
  alignment: str,
  armor_class: num,
  armor_desc: nullable(str),
  hit_points: num,
  hit_dice: str,
  speed,
  strength: num,
  dexterity: num,
  constitution: num,
  intelligence: num,
  wisdom: num,
  charisma: num,
  strength_save: nullable(num),
  dexterity_save: nullable(num),
  constitution_save: nullable(num),
  intelligence_save: nullable(num),
  wisdom_save: nullable(num),
  charisma_save: nullable(num),
  perception: nullable(num),
  skills: recordOf(num),
  damage_vulnerabilities: str,
  damage_resistances: str,
  damage_immunities: str,
  condition_immunities: str,
  senses: str,
  languages: str,
  challenge_rating: str,
  cr: num,
  actions: nullable(arrayOf(action)),
  bonus_actions: nullable(arrayOf(action)),
  reactions: nullable(arrayOf(action)),
  legendary_desc: str,
  legendary_actions: nullable(arrayOf(action)),
  special_abilities: nullable(arrayOf(action)),
  spell_list: arrayOf(str),
  page_no: num,
  environments: arrayOf(str),
  img_main: nullable(str),
  document__slug: str,
  document__title: str,
  document__license_url: str,
  document__url: str,
  v2_converted_path: str,
};

function problems(record: unknown): string[] {
  if (!isObject(record)) return ['not an object'];
  return Object.entries(MONSTER_FIELDS)
    .filter(([k, check]) => !check(record[k]))
    .map(([k]) => `${k}: ${JSON.stringify(record[k])?.slice(0, 80) ?? 'undefined'}`);
}

const snapshot = loadSnapshot();

describe('Open5eMonster against the pinned snapshot', () => {
  it('has all 322 records', () => {
    expect(snapshot).toHaveLength(322);
  });

  it('every record satisfies the type at runtime', () => {
    const bad = snapshot.map((r) => ({ slug: (r as { slug?: unknown }).slug, problems: problems(r) })).filter((r) => r.problems.length > 0);
    expect(bad).toEqual([]);
  });

  it('documents the data quirks the adapter relies on', () => {
    // These are the facts the type comments state. If a new snapshot breaks
    // one, revisit the adapter before relaxing the assertion.
    expect(snapshot.filter((r) => r.actions === null).map((r) => r.slug)).toEqual(['frog', 'sea-horse']);
    expect(snapshot.every((r) => r.special_abilities === null || r.special_abilities.length > 0)).toBe(true);
    expect(snapshot.every((r) => r.legendary_actions === null || r.legendary_actions.length > 0)).toBe(true);
    expect(snapshot.every((r) => r.perception === null || r.perception === r.skills['perception'])).toBe(true);
    expect(snapshot.every((r) => /passive Perception \d+$/.test(r.senses))).toBe(true);
    expect(snapshot.filter((r) => typeof r.speed.notes === 'string').map((r) => r.slug)).toEqual([
      'werebear',
      'wereboar',
      'weretiger',
      'werewolf',
    ]);
  });
});

describe('fixtures', () => {
  const bySlug = new Map(snapshot.map((r) => [r.slug, r]));

  it('include the records other workstreams rely on', () => {
    for (const slug of ['ogre', 'crocodile', 'giant-frog', 'lizardfolk', 'giant-crocodile', 'frog', 'purple-worm', 'black-bear']) {
      expect(FIXTURE_SLUGS).toContain(slug);
    }
    expect(FIXTURE_SLUGS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(FIXTURE_SLUGS)('%s is a verbatim copy of its snapshot record', (slug) => {
    expect(loadFixture(slug)).toStrictEqual(bySlug.get(slug));
  });
});
