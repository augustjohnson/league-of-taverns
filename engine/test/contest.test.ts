import { describe, expect, it } from 'vitest';
import { cardTags, challengePower } from '../src/contest/cards';
import { checkChance, genericChallenge, MAX_CHALLENGE_ROUNDS, runChallenge } from '../src/contest/challenge';
import { challengeProblem, finaleProblem, voteProblem } from '../src/contest/check';
import { VOTE_MODEL, voteModel } from '../src/contest/model';
import { castMap, episodeOdds, runContest } from '../src/contest/run';
import { applyEpisode, initialContest, startingAffinity, threats } from '../src/contest/state';
import type { Challenge, VoteResult } from '../src/contest/types';
import { betraying, castVotes, choose, juryVote, strategyScore } from '../src/contest/vote';
import { rngFor } from '../src/rng';
import { baseOf, card, castOf } from './support/builders';

const model = voteModel();

describe('cards', () => {
  it('tags a stat block by type, subtype, law, morals and size', () => {
    expect(cardTags(baseOf('ogre'))).toEqual(['type:giant', 'law:chaotic', 'moral:evil', 'size:large']);
    expect(cardTags(baseOf('lizardfolk'))).toEqual(['type:humanoid', 'subtype:lizardfolk', 'size:medium']);
    expect(cardTags(baseOf('bat'))).toEqual(['type:beast', 'size:tiny']);
  });

  it('challenge power is the mean skill and save modifier, advantage worth +3', () => {
    expect(card('a', { all: 2 }).power).toBe(2);
    const adv = card('b', { all: 0, advantages: ['skill:stealth'] });
    expect(adv.power).toBeCloseTo(3 / 24, 10);
    expect(challengePower(card('c', { all: -1 }).stats)).toBe(-1);
  });
});

describe('challenges', () => {
  const task: Challenge = { id: 'swim', checks: [{ type: 'skill', skill: 'athletics', dc: 12, advantage: { speed: 'swim' } }, { type: 'save', ability: 'con', dc: 12 }] };

  it('eliminates down to one winner, every round among those still in', () => {
    const field = castOf(12);
    for (let k = 0; k < 40; k++) {
      const result = runChallenge(field, task, rngFor('t', `c${k}`));
      expect(challengeProblem(field.map((c) => c.id), result)).toBeNull();
      expect(result.rounds.length).toBeLessThanOrEqual(MAX_CHALLENGE_ROUNDS);
    }
  });

  it('is deterministic for a stream, and replays a round nobody passes', () => {
    const field = castOf(6);
    const a = runChallenge(field, task, rngFor('t', 'same'));
    expect(runChallenge(field, task, rngFor('t', 'same'))).toEqual(a);
    const hopeless: Challenge = { id: 'hopeless', checks: [{ type: 'save', ability: 'cha', dc: 30 }, { type: 'save', ability: 'cha', dc: 2 }] };
    const r = runChallenge(castOf(3), hopeless, rngFor('t', 'h'));
    expect(r.rounds[0]!.replay).toBe(true);
    expect(r.rounds[0]!.out).toEqual([]);
  });

  it('gives advantage for the named speed, and fails anyone without a required one', () => {
    const swimmer = card('swimmer', { speeds: { swim: 30 } });
    const walker = card('walker');
    expect(checkChance(swimmer, task.checks[0]!)).toBeCloseTo(1 - 0.55 * 0.55, 10);
    expect(checkChance(walker, task.checks[0]!)).toBeCloseTo(0.45, 10);
    expect(checkChance(walker, { type: 'skill', skill: 'perception', dc: 5, requires: { sense: 'darkvision' } })).toBe(0);
  });

  it('stronger fields win more often', () => {
    const strong = card('strong', { all: 6 });
    const weak = card('weak', { all: -2 });
    let wins = 0;
    for (let k = 0; k < 200; k++) if (runChallenge([weak, strong], genericChallenge(rngFor('g', `${k}`)), rngFor('r', `${k}`)).winner === 'strong') wins++;
    expect(wins).toBeGreaterThan(160);
  });
});

describe('the vote', () => {
  it('casts legal ballots and follows them to the boot, whatever the dice', () => {
    const cast = castOf(10);
    const s = initialContest(cast, model);
    for (let k = 0; k < 60; k++) {
      const vote = castVotes(s, castMap(cast), 'm3', rngFor('v', `${k}`), model);
      expect(voteProblem(s.alive, 'm3', vote)).toBeNull();
      expect(vote.boot).not.toBe('m3');
    }
  });

  it('a threat hunter targets the strongest, coattails the weakest, until coattails turn on the strong', () => {
    const cast = castOf(10);
    const s = initialContest(cast, model);
    const t = threats(s, castMap(cast), model);
    const hunter = card('h', {}, { kind: 'threat' });
    const rider = card('r', {}, { kind: 'coattails' });
    expect(strategyScore(s, hunter, cast[9]!, t, model)).toBeGreaterThan(strategyScore(s, hunter, cast[0]!, t, model));
    expect(strategyScore(s, rider, cast[0]!, t, model)).toBeGreaterThan(strategyScore(s, rider, cast[9]!, t, model));
    const late = { ...s, alive: s.alive.slice(0, model.betrayAt) };
    expect(betraying(s, model)).toBe(false);
    expect(betraying(late, model)).toBe(true);
    const tLate = threats(late, castMap(cast), model);
    expect(strategyScore(late, rider, cast[6]!, tLate, model)).toBeGreaterThan(strategyScore(late, rider, cast[0]!, tLate, model));
  });

  it('a loyal voter protects its tag, and starts out liking those who share it', () => {
    const loyal = card('l', {}, { kind: 'loyal', tag: 'type:undead' }, ['type:fiend']);
    const ghoul = card('g', {}, { kind: 'floater' }, ['type:undead']);
    const imp = card('i', {}, { kind: 'floater' }, ['type:fiend']);
    const s = initialContest([loyal, ghoul, imp], model);
    expect(strategyScore(s, loyal, ghoul, threats(s, castMap([loyal, ghoul, imp]), model), model)).toBe(-model.loyalProtect);
    expect(startingAffinity(loyal, ghoul, model)).toBe(model.loyalAffinity);
    expect(startingAffinity(loyal, imp, model)).toBe(model.shareType);
  });

  it('the strong start out liking the riders who flatter them', () => {
    const rider = card('r', {}, { kind: 'coattails' });
    const strong = card('s', { all: 5 });
    expect(startingAffinity(strong, rider, model, 2)).toBe(2 * model.flattery);
    expect(startingAffinity(strong, rider, model, -1)).toBe(0);
  });

  it('a vote moves affinity and grudges, and the boot joins the jury', () => {
    const cast = castOf(4);
    const s = initialContest(cast, model);
    const vote: VoteResult = {
      ballots: [
        { voter: 'm1', target: 'm4' },
        { voter: 'm2', target: 'm4' },
        { voter: 'm3', target: 'm1' },
        { voter: 'm4', target: 'm1' },
      ],
      revote: { tied: ['m1', 'm4'], ballots: [{ voter: 'm2', target: 'm4' }, { voter: 'm3', target: 'm4' }] },
      draw: null,
      boot: 'm4',
    };
    expect(voteProblem(s.alive, 'm2', vote)).toBeNull();
    const next = applyEpisode(s, { episode: 1, immune: 'm2', vote }, model);
    expect(next.alive).toEqual(['m1', 'm2', 'm3']);
    expect(next.jury).toEqual(['m4']);
    expect(next.wins).toEqual({ m2: 1 });
    expect(next.affinity.m1!.m2).toBe(model.coVote);
    expect(next.grudges.m1!.m3).toBe(1);
    expect(next.affinity.m1!.m3).toBe(-model.targetResents);
    expect(next.votedOut.m4).toEqual(['m2', 'm3']);
  });

  it('flags a recorded vote that breaks the rules', () => {
    const alive = ['a', 'b', 'c'];
    const legal: VoteResult = { ballots: [{ voter: 'a', target: 'b' }, { voter: 'b', target: 'a' }, { voter: 'c', target: 'b' }], revote: null, draw: null, boot: 'b' };
    expect(voteProblem(alive, 'c', legal)).toBeNull();
    expect(voteProblem(alive, 'c', { ...legal, boot: 'a' })).toMatch(/send b home/);
    expect(voteProblem(alive, 'b', legal)).toMatch(/immune/);
    expect(voteProblem(alive, 'c', { ...legal, ballots: legal.ballots.slice(1) })).toMatch(/voters/);
    const tie: VoteResult = { ballots: [{ voter: 'a', target: 'b' }, { voter: 'b', target: 'a' }, { voter: 'c', target: 'a' }, { voter: 'd', target: 'b' }], revote: null, draw: null, boot: 'a' };
    expect(voteProblem([...alive, 'd'], 'c', tie)).toMatch(/no revote/);
  });

  it('choose strays from the best only with the noise', () => {
    const options = [
      { target: 'x', score: 3 },
      { target: 'y', score: 2 },
      { target: 'z', score: 1 },
    ];
    for (let k = 0; k < 20; k++) expect(choose(options, rngFor('n', `${k}`), 0)).toBe('x');
    const picks = new Set(Array.from({ length: 60 }, (_, k) => choose(options, rngFor('n', `${k}`), 1)));
    expect(picks).toEqual(new Set(['y', 'z']));
  });
});

describe('the contest', () => {
  const cast = castOf(10);
  const challenges = Array.from({ length: 8 }, (_, i) => genericChallenge(rngFor('c', `${i}`)));

  it('runs to the finalists and a jury winner, the same every time for a seed', () => {
    const run = runContest(cast, challenges, 'seed-1', { finalists: 2, model });
    expect(run.episodes).toHaveLength(8);
    expect(run.state.alive).toHaveLength(2);
    expect(run.state.jury).toHaveLength(8);
    expect(run.finale.finalists).toEqual(run.state.alive);
    expect(finaleProblem(run.state.alive, run.state.jury, run.finale)).toBeNull();
    expect(runContest(cast, challenges, 'seed-1', { finalists: 2, model })).toEqual(run);
    expect(runContest(cast, challenges, 'seed-2', { finalists: 2, model }).finale).not.toEqual(run.finale);
  });

  it('the jury votes for a finalist', () => {
    const run = runContest(cast, challenges, 'seed-3', { finalists: 3, model });
    const finale = juryVote(run.state, castMap(cast), rngFor('j', 'x'), model);
    expect(finale.ballots.every((b) => finale.finalists.includes(b.finalist))).toBe(true);
  });

  it('the odds sum to one, and the immune monster never goes home', () => {
    const s = initialContest(cast, model);
    const odds = episodeOdds(s, castMap(cast), 'm5', model, 'odds', 60);
    const total = [...odds.boot.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
    expect(odds.boot.get('m5')).toBe(0);
    expect(odds.immunity.get('m5')).toBe(1);
    const pre = episodeOdds(s, castMap(cast), null, model, 'odds', 60);
    expect([...pre.immunity.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('a season overrides the model dial by dial', () => {
    expect(voteModel({ noise: 0 })).toEqual({ ...VOTE_MODEL, noise: 0 });
  });

  it('challengeProblem rejects a winner the rounds do not leave', () => {
    const run = runChallenge(castOf(4), genericChallenge(rngFor('p', 'x')), rngFor('p', 'y'));
    const other = ['m1', 'm2', 'm3', 'm4'].find((id) => id !== run.winner)!;
    expect(challengeProblem(['m1', 'm2', 'm3', 'm4'], { ...run, winner: other })).toMatch(/the winner is/);
  });
});
