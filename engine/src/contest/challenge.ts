/**
 * Challenges: the Lich's task for an episode, run as elimination rounds.
 *
 * Everyone still in makes the next check; those who fail drop out. If
 * everyone fails, nobody drops and the next check is tried (the round is
 * replayed). The checks repeat in order, `lapDc` harder each time round,
 * until one contestant is left: the winner, immune at this episode's vote.
 */
import { checkTargetKey } from '../characters';
import { modifierFor, passChance } from '../checks';
import { rollD20, type Rng } from '../rng';
import { SKILLS, ABILITIES } from '../vocabulary';
import type { Challenge, ChallengeCheck, ChallengeResult, ChallengeRoll, ChallengeRound, Contestant, Requirement } from './types';

/** After this many rounds the rest settle it in one roll-off: highest total wins, the first in order on a tie. */
export const MAX_CHALLENGE_ROUNDS = 60;

/** True when `c` has the speed or sense `req` names (above 0 feet). */
export function meets(c: Contestant, req: Requirement): boolean {
  return 'speed' in req ? (c.stats.speeds[req.speed] ?? 0) > 0 : (c.stats.senses[req.sense] ?? 0) > 0;
}

/** Whether `c` rolls `check` with advantage: from the check's `advantage` requirement, or a modifier on the card. */
export function hasAdvantage(c: Contestant, check: ChallengeCheck): boolean {
  if (check.advantage !== undefined && meets(c, check.advantage)) return true;
  return c.stats.advantages.has(checkTargetKey(check));
}

/** `c`'s chance to pass `check` at `dc`: 0 when it `requires` something `c` lacks. */
export function checkChance(c: Contestant, check: ChallengeCheck, dc = check.dc): number {
  if (check.requires !== undefined && !meets(c, check.requires)) return 0;
  return passChance(modifierFor(c.stats, check), dc, hasAdvantage(c, check));
}

/** One contestant's roll: one d20 from `rng`, two with advantage (the higher kept). */
function rollFor(c: Contestant, check: ChallengeCheck, dc: number, rng: Rng): ChallengeRoll {
  const modifier = modifierFor(c.stats, check);
  const advantage = hasAdvantage(c, check);
  const first = rollD20(rng);
  const d20 = advantage ? Math.max(first, rollD20(rng)) : first;
  const eligible = check.requires === undefined || meets(c, check.requires);
  return { id: c.id, d20, modifier, advantage, eligible, pass: eligible && d20 + modifier >= dc };
}

/**
 * Run `challenge` among `field` (in cast order) with dice from `rng`.
 * Throws if the field is empty or the challenge has no checks.
 */
export function runChallenge(field: ReadonlyArray<Contestant>, challenge: Challenge, rng: Rng, lapDc = 1): ChallengeResult {
  if (field.length === 0) throw new Error(`runChallenge: "${challenge.id}" has nobody to run it`);
  const n = challenge.checks.length;
  if (n === 0) throw new Error(`runChallenge: "${challenge.id}" has no checks`);
  let left = [...field];
  const rounds: ChallengeRound[] = [];
  for (let i = 0; left.length > 1; i++) {
    const check = challenge.checks[i % n]!;
    const lap = Math.floor(i / n);
    const dc = check.dc + lap * lapDc;
    const rolls = left.map((c) => rollFor(c, check, dc, rng));
    if (i + 1 >= MAX_CHALLENGE_ROUNDS) {
      // The roll-off: the highest total stays, everyone else is out.
      const total = (r: ChallengeRoll): number => (r.eligible ? r.d20 + r.modifier : -Infinity);
      const best = rolls.reduce((a, b) => (total(b) > total(a) ? b : a));
      rounds.push({ check: i % n, lap, dc, rolls, out: rolls.filter((r) => r !== best).map((r) => r.id), replay: false });
      left = left.filter((c) => c.id === best.id);
      break;
    }
    const failed = rolls.filter((r) => !r.pass).map((r) => r.id);
    const replay = failed.length === left.length;
    rounds.push({ check: i % n, lap, dc, rolls, out: replay ? [] : failed, replay });
    if (!replay) left = left.filter((c) => !failed.includes(c.id));
  }
  return { rounds, winner: left[0]!.id };
}

/**
 * A plain challenge drawn at random: `size` checks, each a skill or a save
 * picked evenly, at DC `dc`. Bots and odds use it to stand in for a challenge
 * they can't see yet.
 */
export function genericChallenge(rng: Rng, size = 4, dc = 12): Challenge {
  const pool: ChallengeCheck[] = [
    ...SKILLS.map((skill): ChallengeCheck => ({ type: 'skill', skill, dc })),
    ...ABILITIES.map((ability): ChallengeCheck => ({ type: 'save', ability, dc })),
  ];
  const checks: ChallengeCheck[] = [];
  for (let i = 0; i < size; i++) checks.push(pool[Math.floor(rng() * pool.length)]!);
  return { id: 'generic', checks };
}
