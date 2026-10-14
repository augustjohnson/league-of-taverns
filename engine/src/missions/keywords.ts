/**
 * Schedule keywords (docs/decisions.md D-42): the public, readable summary of
 * what a week's mission tests, written by the GM next to its title,
 * environment and theme. Once missions are hidden until the lock (D-08),
 * keywords are what managers plan from, so they must be honest: a keyword
 * may leave things out, but never name something the mission doesn't test.
 *
 * The vocabulary, all lowercase:
 * - a skill check: the skill, with spaces (`survival`, `sleight of hand`);
 * - a saving throw: `<ability> save` (`con save`);
 * - a raw ability check: `<ability> check` (`dex check`);
 * - a gate (D-39): the speed or sense it needs (`fly`, `darkvision`);
 * - a battle: its lead creature, the first in the encounter, with spaces,
 *   then `fight` (`giant frog fight`).
 */
import type { CheckSpec, Mission } from './types';

/** The keyword for what a check tests. */
export function checkKeyword(check: CheckSpec): string {
  switch (check.type) {
    case 'skill':
      return check.skill.replaceAll('_', ' ');
    case 'save':
      return `${check.ability} save`;
    case 'ability':
      return `${check.ability} check`;
  }
}

/** Every keyword `mission` supports, in node order without repeats. */
export function missionKeywords(mission: Mission): ReadonlyArray<string> {
  const out = new Set<string>();
  for (const node of mission.nodes) {
    if (node.kind === 'check') {
      out.add(checkKeyword(node.check));
      const requires = node.check.requires;
      if (requires !== undefined) out.add('speed' in requires ? requires.speed : requires.sense);
    }
    if (node.kind === 'battle') {
      const lead = node.encounter.creatures[0];
      if (lead !== undefined) out.add(`${lead.ref.replaceAll('-', ' ')} fight`);
    }
  }
  return [...out];
}

/** The keywords that name nothing in `mission` (D-42: no red herrings), in the order given. Empty when all are honest. */
export function dishonestKeywords(mission: Mission, keywords: ReadonlyArray<string>): ReadonlyArray<string> {
  const valid = new Set(missionKeywords(mission));
  return keywords.filter((k) => !valid.has(k));
}
