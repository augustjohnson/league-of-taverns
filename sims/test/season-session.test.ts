import { describe, expect, it } from 'vitest';
import { loadSeasonInput } from '../src/load';
import { ContestSession, runSeason } from '../src/season-runner';

const input = loadSeasonInput();
const human = { manager: input.managers[0]!.id, login: 'you', githubId: 1 };

/** A session with a person, past the tavern pick and the draft (always the first free monster). */
function drafted(seed: string): ContestSession {
  const s = new ContestSession(input, { seed, human });
  s.advanceDraft();
  for (let stage = s.stage; stage.kind === 'tavern' || stage.kind === 'draft'; stage = s.stage) {
    if (stage.kind === 'tavern') s.chooseTavern(s.openTaverns()[0]!);
    else s.draftPick([...s.state.pool.keys()].find((id) => !s.state.owner.has(id))!);
    s.advanceDraft();
  }
  return s;
}

describe('a season with a person', () => {
  it("stops the tavern pick on the person's turn, then the draft when they are on the clock", () => {
    const s = new ContestSession(input, { seed: 'person-1', human });
    s.advanceDraft();
    expect(s.stage).toEqual({ kind: 'tavern', manager: human.manager });
    s.chooseTavern(s.openTaverns()[0]!);
    s.advanceDraft();
    expect(s.stage.kind).toBe('draft');
    expect(s.stage.kind === 'draft' && s.stage.tavern).toBe(s.humanTavern);
  });

  it('gives the person the tavern they bring on their turn, and no bot takes it', () => {
    const mine = input.taverns.at(-1)!.id;
    for (const seed of ['bring-1', 'bring-2', 'bring-3']) {
      const s = new ContestSession(input, { seed, human: { ...human, tavern: mine } });
      s.advanceDraft();
      expect(s.humanTavern).toBe(mine);
      expect(s.openTaverns()).not.toContain(mine);
      expect(s.stage.kind).toBe('draft');
    }
    expect(() => new ContestSession(input, { seed: 'bring-4', human: { ...human, tavern: 'no-such-tavern' } })).toThrow(/no tavern/);
  });

  it('rejects an illegal pick and leaves the session unchanged', () => {
    const s = new ContestSession(input, { seed: 'person-2', human });
    s.advanceDraft();
    s.chooseTavern(s.openTaverns()[0]!);
    s.advanceDraft();
    const before = s.events.length;
    expect(() => s.draftPick('nobody-at-all')).toThrow();
    expect(s.events).toHaveLength(before);
  });

  it('calls early and late: a call before the challenge is early, a change after it is late, the immune can\'t be called', () => {
    const s = drafted('person-3');
    expect(s.stage).toEqual({ kind: 'challenge', episode: 1 });
    const me = s.humanTavern!;
    s.call(s.state.alive[0]!);
    expect(s.callsFor(1).get(me)).toMatchObject({ target: s.state.alive[0], early: true });
    s.runChallenge();
    expect(s.stage).toEqual({ kind: 'vote', episode: 1 });
    const immune = s.state.episodes[0]!.challenge!.result.winner;
    expect(() => s.call(immune)).toThrow(/immunity/);
    const other = s.state.alive.find((id) => id !== immune && id !== s.state.alive[0])!;
    s.call(other);
    expect(s.callsFor(1).get(me)).toMatchObject({ target: other, early: false });
    s.runVote();
    expect(s.stage).toEqual({ kind: 'challenge', episode: 2 });
  });

  it('plays to the end, replays and verifies, with the person as a manager actor', () => {
    const s = drafted('person-4');
    s.playToEnd();
    const result = s.finish();
    expect(result.audit).toEqual({ replayMatches: true, mismatches: [] });
    expect(result.events.some((e) => e.actor.kind === 'manager')).toBe(true);
    expect(result.summary.standings.some((r) => r.bot === 'human')).toBe(true);
  });

  it('matches the all-bot season exactly when nobody is seated', () => {
    const s = new ContestSession(input, { seed: 'same-1' });
    s.playToEnd();
    expect(s.finish().ndjson).toBe(runSeason(input, { seed: 'same-1' }).ndjson);
  });

  it('the scouts rate every cast member, the same every time', () => {
    const s = new ContestSession(input, { seed: 'scouts' });
    const a = s.scouting();
    expect([...a.keys()].sort()).toEqual(s.cast.map((c) => c.id).sort());
    expect(s.scouting()).toBe(a);
  });
});
