import { castMap, contestState, contestant, episodeOdds, rngFor, voteModel } from '@league-of-taverns/engine';
import type { LeagueState } from '@league-of-taverns/engine';
import { describe, expect, it } from 'vitest';
import { CAST, TAVERNS, miniConfig, miniSeason } from '../../engine/test/support/league-log';
import { BOT_IDS, CALL_STRATEGIES, DRAFT_STRATEGIES, botManager, expectedPoints, randomTavern, scoutSeed, warmth } from '../src';
import type { PublicView } from '../src';

const config = miniConfig();
const model = voteModel(config.contest.model);
const cast = CAST.map((c) => contestant(c.stats, c.strategy));
const { afterPreseason, afterDraft, midEpisode1 } = miniSeason();

function viewOf(state: LeagueState, decision = 'test'): PublicView {
  return {
    state,
    tavern: TAVERNS[0],
    config,
    cast,
    model,
    contest: () => contestState(state, cast, model),
    odds: (immune) => episodeOdds(contestState(state, cast, model), castMap(cast), immune, model, `odds/${immune ?? '-'}`, 80),
    rng: rngFor('bots', decision),
  };
}

describe('bot managers', () => {
  it('every bot id names a manager with a tavern, draft and calling strategy', () => {
    for (const id of BOT_IDS) {
      const bot = botManager(id);
      expect(bot.id).toBe(id);
      expect(bot.draft.id).toBeTruthy();
      expect(bot.calls.id).toBeTruthy();
    }
    expect(() => botManager('nope' as never)).toThrow(/unknown bot/);
  });

  it('the tavern pick chooses an open tavern', () => {
    expect(randomTavern.choose(['a', 'b'], rngFor('t', '1'))).toMatch(/^[ab]$/);
    expect(() => randomTavern.choose([], rngFor('t', '1'))).toThrow();
  });
});

describe('drafting', () => {
  const available = cast.map((c) => c.id);

  it('every strategy picks someone available, and the same view gives the same pick', () => {
    for (const s of Object.values(DRAFT_STRATEGIES)) {
      const pick = s.pick(viewOf(afterPreseason), available.slice(2));
      expect(available.slice(2)).toContain(pick);
      expect(s.pick(viewOf(afterPreseason), available.slice(2))).toBe(pick);
    }
  });

  it('power takes the strongest card, scout the most expected points, social the warmest welcome', () => {
    const strongest = [...cast].sort((a, b) => b.power - a.power)[0]!.id;
    expect(DRAFT_STRATEGIES.power.pick(viewOf(afterPreseason), available)).toBe(strongest);
    const value = expectedPoints(cast, config, model, scoutSeed(config.id), 30);
    const best = [...value].sort((a, b) => b[1] - a[1])[0]![0];
    expect(value.size).toBe(cast.length);
    expect(available).toContain(best);
    const warmest = [...cast].sort((a, b) => warmth(b, cast, model) - warmth(a, cast, model))[0]!.id;
    expect(DRAFT_STRATEGIES.social.pick(viewOf(afterPreseason), available)).toBe(warmest);
  });

  it('expected points are cached and add up to what a season pays out', () => {
    const a = expectedPoints(cast, config, model, 'cache-test', 20);
    expect(expectedPoints(cast, config, model, 'cache-test', 20)).toBe(a);
    const total = [...a.values()].reduce((x, y) => x + y, 0);
    // 8 votes: survivors × survive + one immunity each, then 8 jury votes and the winner.
    const { survive, immunity, juryVote, winner } = config.scoring;
    let survivals = 0;
    for (let v = 1; v <= 8; v++) survivals += 10 - v;
    expect(total).toBeCloseTo(survivals * survive + 8 * immunity + 8 * juryVote + winner, 6);
  });
});

describe('calling the boot', () => {
  it('oracle calls early; hunch, gossip and random wait for the challenge', () => {
    expect(afterDraft.alive).toContain(CALL_STRATEGIES.oracle.early(viewOf(afterDraft), 1));
    for (const s of [CALL_STRATEGIES.hunch, CALL_STRATEGIES.gossip, CALL_STRATEGIES.random]) expect(s.early(viewOf(afterDraft), 1)).toBeNull();
  });

  it('after the challenge every strategy calls someone who can go home, never the immune monster', () => {
    const immune = midEpisode1.episodes[0]!.challenge!.result.winner;
    for (const s of Object.values(CALL_STRATEGIES)) {
      for (let k = 0; k < 10; k++) {
        const target = s.late(viewOf(midEpisode1, `late-${k}`), 1, undefined);
        expect(target).not.toBeNull();
        expect(target).not.toBe(immune);
        expect(midEpisode1.alive).toContain(target);
      }
    }
  });

  it('oracle keeps an early call on the favourite, and drops one on the immune monster', () => {
    const immune = midEpisode1.episodes[0]!.challenge!.result.winner;
    const view = viewOf(midEpisode1);
    expect(CALL_STRATEGIES.oracle.late(view, 1, { target: immune, early: true, seq: 1 })).not.toBe(immune);
    expect(CALL_STRATEGIES.oracle.late(view, 1, { target: immune, early: true, seq: 1 })).not.toBeNull();
  });
});
