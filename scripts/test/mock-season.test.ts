import { indexSnapshot, modifierCost, TRAITS, validateMission } from '@league-of-taverns/engine';
import type { BattleNode, Mission, MissionRules } from '@league-of-taverns/engine';
import { describe, expect, it } from 'vitest';
import { loadMission } from '../src/lib/repo';
import { MOCK_SEASON, isSpellcaster, loadSeason, missionFiles, snapshotCrIndex } from '../src/lib/season';
import { validateSeason } from '../src/lib/validate-season';

// T5.5: the hand-built mock season in sims/fixtures/mock-season/ loads cleanly
// through every loader, and each of its missions validates.

const season = loadSeason(MOCK_SEASON);
const { config, pool, managers, schedule, spellcasters } = season;
const bySlug = indexSnapshot(season.snapshot);
const crOf = snapshotCrIndex(season.snapshot);
const missions: ReadonlyArray<Mission> = missionFiles(MOCK_SEASON).map(({ file }) => loadMission(file));
const { battleModel: _battleModel, ...missionRules } = config.missions;
const rules: MissionRules = { ...missionRules, partyCr: config.budget.partyCr };

const battlesOf = (mission: Mission): BattleNode[] => mission.nodes.filter((n): n is BattleNode => n.kind === 'battle');

/** The D-43 list of spellcasters at CR 8 or below. */
const LOW_CR_CASTERS = [
  'acolyte', 'couatl', 'cult-fanatic', 'deep-gnome-svirfneblin', 'drider', 'drow', 'druid', 'dryad', 'dust-mephit',
  'green-hag', 'ice-mephit', 'lamia', 'mage', 'magma-mephit', 'night-hag', 'oni', 'priest', 'sea-hag', 'spirit-naga',
  'steam-mephit', 'unicorn',
];

describe('mock season config, managers and schedule', () => {
  it('is a 6-week, 6-tavern season with B = 12, roster 7 and no spellcasters', () => {
    expect(config.id).toBe('mock-season');
    expect(config.weeks).toBe(6);
    expect(config.budget.partyCr).toBe(96);
    expect(config.roster.size).toBe(7);
    expect(spellcasters).toEqual({ maxInPool: 0, maxPerEncounter: 0 });
    expect(managers.taverns).toHaveLength(6);
    expect(managers.commissioner.login).toBeTruthy();
  });

  it('seats only bots, covering every strategy', () => {
    const bots = managers.taverns.map((t) => ('bot' in t.manager ? t.manager.bot : null));
    expect(bots).not.toContain(null);
    expect(new Set(bots)).toEqual(new Set(['random', 'cr-greedy', 'skill-coverage', 'value']));
  });

  it('has six weeks with different environments', () => {
    expect(schedule.weeks.map((w) => w.week)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(schedule.weeks.map((w) => w.environment)).size).toBe(6);
  });

  it('gives every tavern exactly one home week (D-48)', () => {
    const homeOf = new Map(schedule.sponsors.map((s) => [s.id, s.tavern]));
    const homes = schedule.weeks.map((w) => homeOf.get(w.sponsor!));
    expect(homes.sort()).toEqual(managers.taverns.map((t) => t.id).sort());
  });
});

describe('mock season pool', () => {
  it('has enough characters to fill every roster, with spares', () => {
    expect(pool.characters.length).toBeGreaterThanOrEqual(managers.taverns.length * config.roster.size + 4);
    expect(pool.characters.every((c) => c.ref.id === `mock-${c.ref.base}`)).toBe(true);
  });

  it('spreads CR from 1/8 to 6', () => {
    const crs = [...pool.cr.values()];
    expect(Math.min(...crs)).toBe(1);
    expect(Math.max(...crs)).toBe(48);
    expect(new Set(crs).size).toBe(9); // 1/8, 1/4, 1/2, 1, 2, 3, 4, 5, 6
  });

  it('has no spellcasters, double-checked against the snapshot', () => {
    expect(pool.spellcasters).toEqual([]);
    for (const c of pool.characters) expect(isSpellcaster(bySlug.get(c.ref.base)!), c.ref.id).toBe(false);
    for (const slug of LOW_CR_CASTERS) expect(isSpellcaster(bySlug.get(slug)!), slug).toBe(true);
  });

  it('gives about a third of the pool modifiers, all within budget', () => {
    const modified = pool.characters.filter((c) => c.modifiers.length > 0);
    expect(modified.length / pool.characters.length).toBeCloseTo(1 / 3, 1);
    for (const c of modified) expect(modifierCost(c.modifiers, TRAITS)).toBeLessThanOrEqual(config.budget.modifierPointsPerCharacter);
  });

  it('includes flyers and swimmers', () => {
    const speeds = (kind: string): number =>
      pool.characters.filter((c) => (bySlug.get(c.ref.base)!.speed[kind] ?? 0) !== 0).length;
    expect(speeds('fly')).toBeGreaterThanOrEqual(8);
    expect(speeds('swim')).toBeGreaterThanOrEqual(8);
  });
});

describe('mock season missions', () => {
  it('passes every validate check', () => {
    const report = validateSeason(MOCK_SEASON);
    expect(report.issues).toEqual([]);
    expect(report.checked.missions).toHaveLength(6);
  });

  it('has one mission per week, matched by environment, each valid for its week', () => {
    for (const week of schedule.weeks) {
      const matching = missions.filter((m) => m.environment === week.environment);
      expect(matching, `week ${week.week}`).toHaveLength(1);
      expect(validateMission(matching[0]!, rules, (slug) => crOf.get(slug), { expectedEnvironment: week.environment })).toEqual([]);
    }
  });

  it('varies the shape: five with one battle, one with two, one with a single gate', () => {
    const battleCounts = missions.map((m) => battlesOf(m).length).sort();
    expect(battleCounts).toEqual([1, 1, 1, 1, 1, 2]);
    const gated = missions.map((m) => m.nodes.filter((n) => n.kind === 'check' && n.check.requires !== undefined).length);
    expect(gated.sort()).toEqual([0, 0, 0, 0, 0, 1]);
  });

  it('keeps encounters between 0.25 and 0.75 of B, with no spellcasters', () => {
    for (const mission of missions) {
      for (const battle of battlesOf(mission)) {
        const total = battle.encounter.creatures.reduce((sum, c) => sum + c.count * crOf.get(c.ref)!, 0);
        expect(total, `${mission.id}/${battle.id}`).toBeGreaterThanOrEqual(0.25 * config.budget.partyCr);
        expect(total, `${mission.id}/${battle.id}`).toBeLessThanOrEqual(0.75 * config.budget.partyCr);
        for (const c of battle.encounter.creatures) expect(isSpellcaster(bySlug.get(c.ref)!), c.ref).toBe(false);
      }
    }
  });
});
