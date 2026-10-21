import { indexSnapshot, toBaseStats, cardTags } from '@league-of-taverns/engine';
import { describe, expect, it } from 'vitest';
import { loadCharacterChrome } from '../src/lib/repo';
import { LICH_SEASON, abilityMix, loadSeason } from '../src/lib/season';
import { validateSeason } from '../src/lib/validate-season';

// The lich season in sims/fixtures/lich-season/: what sims and the playground play.
const season = loadSeason(LICH_SEASON);

describe('the lich season', () => {
  it('passes every validate check', { timeout: 60_000 }, () => {
    expect(validateSeason(LICH_SEASON).issues).toEqual([]);
  });

  it('is a cast of 12 from a pool of 48, four bot taverns of 3, 9 votes', () => {
    expect(season.config.contest).toMatchObject({ castSize: 12, finalists: 3 });
    expect(season.pool.characters).toHaveLength(48);
    expect(season.managers.managers.every((m) => 'bot' in m.account)).toBe(true);
    expect(season.taverns).toHaveLength(4);
    expect(season.challenges).toHaveLength(9);
  });

  it('tests every ability about as often (no more than half again the rarest)', () => {
    const mix = Object.values(abilityMix(season.challenges.map((c) => c.challenge)));
    expect(Math.max(...mix)).toBeLessThanOrEqual(1.5 * Math.min(...mix));
  });

  it('uses every strategy, and every loyal tag is carried by someone else too', () => {
    const kinds = new Set([...season.pool.strategies.values()].map((s) => s.kind));
    expect(kinds).toEqual(new Set(['loyal', 'threat', 'coattails', 'grudge', 'floater']));
    const bySlug = indexSnapshot(season.snapshot);
    const tags = season.pool.characters.map((c) => cardTags(toBaseStats(bySlug.get(c.ref.base)!).stats));
    for (const [id, s] of season.pool.strategies) {
      if (s.kind !== 'loyal') continue;
      expect(tags.filter((t) => t.includes(s.tag)).length, `${id} loyal to ${s.tag}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('gives every pooled character a portrait, and every check a line', () => {
    for (const c of season.pool.characters) expect(loadCharacterChrome(c.ref.id).portrait?.path, c.ref.id).toBeTruthy();
    for (const c of season.challenges) expect(c.chrome.lines).toHaveLength(c.challenge.checks.length);
  });
});
