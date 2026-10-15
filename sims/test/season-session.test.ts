import { InvalidEventError, freeAgents } from '@league-of-taverns/engine';
import { describe, expect, it } from 'vitest';
import { loadMockSeason } from '../src/load';
import { SeasonSession, averageDraftPositions, runMockSeason, type HumanSeat } from '../src/season-runner';

// Player vs bots: one tavern managed by a person, a step at a time, through
// the same engine checks as the all-bot season.

const input = loadMockSeason();
const human: HumanSeat = { manager: input.managers[0]!.id, login: 'you', githubId: 1 };

/** The tavern pick and the draft, letting the advisor make every human decision. */
function draftWithAdvisor(session: SeasonSession): void {
  for (session.advanceDraft(); session.stage.kind === 'tavern' || session.stage.kind === 'draft'; session.advanceDraft()) {
    if (session.stage.kind === 'tavern') session.chooseTavern(session.suggestTavern());
    else session.draftPick(session.suggestPick());
  }
}

/** Play a whole season, letting the advisor make every human decision. */
function playWithAdvisor(seed: string): SeasonSession {
  const session = new SeasonSession(input, { seed, human });
  draftWithAdvisor(session);
  while (session.stage.kind === 'week') {
    const lineup = session.suggestLineup();
    if (lineup !== null) session.setLineup(lineup);
    if (session.stage.week < input.config.weeks) for (const { add, drop } of session.suggestClaims()) session.claimWaiver(add, drop);
    session.playWeek();
  }
  return session;
}

describe('a season with a human seat', () => {
  it('stops the tavern pick on the person\'s turn, then the draft when they are on the clock (D-52)', () => {
    const session = new SeasonSession(input, { seed: 'pvb-1', human });
    session.advanceDraft();
    expect(session.stage).toEqual({ kind: 'tavern', manager: human.manager });
    expect(session.humanTavern).toBeNull();
    expect(() => session.draftPick('mock-ogre')).toThrow(/not on the clock/);
    const open = session.openTaverns();
    expect(open.length).toBe(input.taverns.length - session.state.taverns.size);
    expect(() => session.chooseTavern('the-nowhere-inn')).toThrow(InvalidEventError);
    session.chooseTavern(open.at(-1)!);
    expect(session.humanTavern).toBe(open.at(-1));
    session.advanceDraft();
    const stage = session.stage;
    expect(stage.kind).toBe('draft');
    if (stage.kind === 'draft') expect(stage.tavern).toBe(session.humanTavern);
    // Everyone chose, in reverse draft order.
    expect([...session.state.taverns.values()].map((t) => t.managerId)).toEqual([...session.state.draft.managerOrder].reverse());
  });

  it('rejects an illegal pick and leaves the session unchanged', () => {
    const session = new SeasonSession(input, { seed: 'pvb-1', human });
    session.advanceDraft();
    session.chooseTavern(session.suggestTavern());
    session.advanceDraft();
    const before = session.events.length;
    const owned = [...session.state.owner.keys()][0];
    if (owned !== undefined) expect(() => session.draftPick(owned)).toThrow(InvalidEventError);
    expect(() => session.draftPick('nobody-at-all')).toThrow(InvalidEventError);
    expect(session.events.length).toBe(before);
    session.draftPick(freeAgents(session.state)[0]!);
    expect(session.events.length).toBe(before + 1);
  });

  it('plays to completion, replays and verifies, with the person as a manager actor', () => {
    const session = playWithAdvisor('pvb-2');
    expect(session.stage.kind).toBe('complete');
    const result = session.finish();
    expect(result.audit.replayMatches).toBe(true);
    expect(result.audit.mismatches).toEqual([]);
    const mine = result.events.filter((e) => e.actor.kind === 'manager');
    expect(new Set(mine.map((e) => e.type))).toEqual(new Set(['tavern.chosen', 'draft.pick', 'lineup.set', ...(mine.some((e) => e.type === 'waiver.claimed') ? ['waiver.claimed'] : [])]));
    expect(result.summary.taverns.find((t) => t.tavern === session.humanTavern)?.bot).toBe('human');
    for (let i = 1; i < result.events.length; i++) expect(result.events[i]!.at >= result.events[i - 1]!.at).toBe(true);
  });

  it('carries a lineup over when the person sets none', () => {
    const session = new SeasonSession(input, { seed: 'pvb-3', human });
    draftWithAdvisor(session);
    while (session.stage.kind === 'week') session.playWeek();
    const result = session.finish();
    const sources = result.summary.weeks.map((w) => w.results.find((r) => r.tavern === session.humanTavern)?.source);
    expect(sources.every((s) => s === 'fallback' || s === 'carried')).toBe(true);
  });

  it('lets the person replace a lineup before the lock', () => {
    const session = new SeasonSession(input, { seed: 'pvb-4', human });
    draftWithAdvisor(session);
    const lineup = session.suggestLineup()!;
    session.setLineup(lineup);
    const [a, b, c, d] = lineup.starters;
    const swapped: typeof lineup = { starters: [b, a, c, d], retreat: { bank: 50 } };
    session.setLineup(swapped);
    expect(session.pendingLineup()).toEqual(swapped);
    session.playWeek();
    expect(session.state.lockedLineups.get(1)?.find((l) => l.tavern === session.humanTavern)).toMatchObject({ source: 'submitted', lineup: swapped });
  });

  it('refuses waiver claims in the last week', () => {
    const session = new SeasonSession(input, { seed: 'pvb-5', human });
    draftWithAdvisor(session);
    while (session.stage.kind === 'week' && session.stage.week < input.config.weeks) session.playWeek();
    const free = freeAgents(session.state)[0]!;
    const drop = session.state.taverns.get(session.humanTavern!)!.roster[0]!;
    expect(() => session.claimWaiver(free, drop)).toThrow('no waivers after the last week');
  });

  it('matches runMockSeason exactly when nobody is seated', () => {
    const session = new SeasonSession(input, { seed: 'sim-1' });
    session.advanceDraft();
    while (session.stage.kind === 'week') session.playWeek();
    expect(session.finish().ndjson).toBe(runMockSeason(input, { seed: 'sim-1' }).ndjson);
  });
});

describe('average draft positions', () => {
  it('places every pooled character between the first pick and one past the last, the same every time', () => {
    const picks = input.config.draft.rounds * input.managers.length;
    const adp = averageDraftPositions(input, 5);
    expect([...adp.keys()].sort()).toEqual(input.pool.map((p) => p.character.ref.id).sort());
    for (const at of adp.values()) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(picks);
    }
    // Each draft fills every pick once, and each of the pool's leftovers counts as the pick after the last.
    const sum = [...adp.values()].reduce((t, x) => t + x, 0);
    const leftovers = input.pool.length - picks;
    expect(sum).toBeCloseTo((picks * (picks - 1)) / 2 + leftovers * picks, 6);
    expect(averageDraftPositions(input, 5)).toEqual(adp);
  });
});
