import { InvalidEventError, freeAgents } from '@league-of-taverns/engine';
import { describe, expect, it } from 'vitest';
import { loadMockSeason } from '../src/load';
import { SeasonSession, runMockSeason, type HumanSeat } from '../src/season-runner';

// Player vs bots: one tavern managed by a person, a step at a time, through
// the same engine checks as the all-bot season.

const input = loadMockSeason();
const tavern = input.taverns[0]!.id;
const human: HumanSeat = { tavern, login: 'you', githubId: 1 };

/** Play a whole season, letting the advisor make every human decision. */
function playWithAdvisor(seed: string): SeasonSession {
  const session = new SeasonSession(input, { seed, human });
  for (session.advanceDraft(); session.stage.kind === 'draft'; session.advanceDraft()) session.draftPick(session.suggestPick());
  while (session.stage.kind === 'week') {
    const lineup = session.suggestLineup();
    if (lineup !== null) session.setLineup(lineup);
    if (session.stage.week < input.config.weeks) for (const { add, drop } of session.suggestClaims()) session.claimWaiver(add, drop);
    session.playWeek();
  }
  return session;
}

describe('a season with a human seat', () => {
  it('stops the draft when the person is on the clock', () => {
    const session = new SeasonSession(input, { seed: 'pvb-1', human });
    session.advanceDraft();
    const stage = session.stage;
    expect(stage.kind).toBe('draft');
    if (stage.kind === 'draft') expect(stage.tavern).toBe(tavern);
  });

  it('rejects an illegal pick and leaves the session unchanged', () => {
    const session = new SeasonSession(input, { seed: 'pvb-1', human });
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
    expect(new Set(mine.map((e) => e.type))).toEqual(new Set(['draft.pick', 'lineup.set', ...(mine.some((e) => e.type === 'waiver.claimed') ? ['waiver.claimed'] : [])]));
    expect(result.summary.taverns.find((t) => t.tavern === tavern)?.bot).toBe('human');
    for (let i = 1; i < result.events.length; i++) expect(result.events[i]!.at >= result.events[i - 1]!.at).toBe(true);
  });

  it('carries a lineup over when the person sets none', () => {
    const session = new SeasonSession(input, { seed: 'pvb-3', human });
    for (session.advanceDraft(); session.stage.kind === 'draft'; session.advanceDraft()) session.draftPick(session.suggestPick());
    while (session.stage.kind === 'week') session.playWeek();
    const result = session.finish();
    const sources = result.summary.weeks.map((w) => w.results.find((r) => r.tavern === tavern)?.source);
    expect(sources.every((s) => s === 'fallback' || s === 'carried')).toBe(true);
  });

  it('lets the person replace a lineup before the lock', () => {
    const session = new SeasonSession(input, { seed: 'pvb-4', human });
    for (session.advanceDraft(); session.stage.kind === 'draft'; session.advanceDraft()) session.draftPick(session.suggestPick());
    const lineup = session.suggestLineup()!;
    session.setLineup(lineup);
    const swapped = { captain: lineup.allies[0]!, allies: [lineup.captain, ...lineup.allies.slice(1)] } as unknown as typeof lineup;
    session.setLineup(swapped);
    expect(session.pendingLineup()).toEqual(swapped);
    session.playWeek();
    expect(session.state.lockedLineups.get(1)?.find((l) => l.tavern === tavern)).toMatchObject({ source: 'submitted', lineup: swapped });
  });

  it('refuses waiver claims in the last week', () => {
    const session = new SeasonSession(input, { seed: 'pvb-5', human });
    for (session.advanceDraft(); session.stage.kind === 'draft'; session.advanceDraft()) session.draftPick(session.suggestPick());
    while (session.stage.kind === 'week' && session.stage.week < input.config.weeks) session.playWeek();
    const free = freeAgents(session.state)[0]!;
    const drop = session.state.taverns.get(tavern)!.roster[0]!;
    expect(() => session.claimWaiver(free, drop)).toThrow('no waivers after the last week');
  });

  it('matches runMockSeason exactly when nobody is seated', () => {
    const session = new SeasonSession(input, { seed: 'sim-1' });
    session.advanceDraft();
    while (session.stage.kind === 'week') session.playWeek();
    expect(session.finish().ndjson).toBe(runMockSeason(input, { seed: 'sim-1' }).ndjson);
  });
});
