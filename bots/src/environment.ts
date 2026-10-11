/**
 * Environment fit: what a week's public schedule entry (environment and
 * theme) suggests the mission will test, for when the mission itself is not
 * known. A hand-written, legible table, not a model of any real mission.
 */
import {
  ABILITIES,
  SKILLS,
  checkTargetKey,
  passChance,
  type Ability,
  type EffectiveStats,
  type Requirement,
  type Skill,
} from '@league-of-taverns/engine';

/** What an environment or theme word hints at. */
interface Hint {
  readonly skills?: ReadonlyArray<Skill>;
  readonly saves?: ReadonlyArray<Ability>;
  readonly requires?: ReadonlyArray<Requirement>;
}

/** By `schedule.environment`, lowercase. */
export const ENVIRONMENT_HINTS: Readonly<Record<string, Hint>> = {
  swamp: { skills: ['survival', 'stealth', 'athletics', 'nature'], saves: ['con'], requires: [{ speed: 'swim' }] },
  underground: { skills: ['perception', 'investigation', 'athletics', 'stealth'], requires: [{ sense: 'darkvision' }, { speed: 'climb' }] },
  forest: { skills: ['survival', 'stealth', 'perception', 'nature', 'animal_handling'] },
  mountain: { skills: ['athletics', 'survival', 'acrobatics'], saves: ['con', 'str'], requires: [{ speed: 'climb' }, { speed: 'fly' }] },
  coast: { skills: ['athletics', 'perception', 'insight', 'survival'], saves: ['dex'], requires: [{ speed: 'swim' }] },
  urban: { skills: ['persuasion', 'deception', 'insight', 'investigation', 'sleight_of_hand', 'stealth'] },
  desert: { skills: ['survival', 'perception'], saves: ['con'] },
  arctic: { skills: ['survival', 'athletics'], saves: ['con'] },
  grassland: { skills: ['survival', 'animal_handling', 'perception'] },
  water: { skills: ['athletics', 'perception'], requires: [{ speed: 'swim' }] },
  ruins: { skills: ['history', 'investigation', 'arcana', 'religion', 'perception'] },
};

/** Theme keywords (lowercase substrings) and what they hint at. */
export const THEME_HINTS: ReadonlyArray<readonly [ReadonlyArray<string>, Hint]> = [
  [['dark', 'night', 'lantern', 'shadow'], { skills: ['perception'], requires: [{ sense: 'darkvision' }] }],
  [['mine', 'cave', 'tunnel', 'deep'], { skills: ['athletics'], requires: [{ sense: 'darkvision' }] }],
  [['flood', 'drown', 'river', 'sea', 'ship', 'wreck', 'tide', 'salt'], { skills: ['athletics'], requires: [{ speed: 'swim' }] }],
  [['toll', 'pay', 'bargain', 'prize', 'trade', 'merchant'], { skills: ['persuasion', 'insight'] }],
  [['tavern', 'bar', 'city', 'crowd', 'feast', 'court'], { skills: ['persuasion', 'deception', 'insight'] }],
  [['false', 'lie', 'trick', 'swindl', 'wrecker'], { skills: ['insight', 'deception'] }],
  [['cliff', 'peak', 'pass', 'climb'], { skills: ['athletics'], requires: [{ speed: 'climb' }] }],
  [['beast', 'eats', 'hunt', 'wolf', 'prey'], { skills: ['survival', 'nature', 'animal_handling', 'stealth'] }],
  [['fruit', 'orchard', 'garden', 'grove'], { skills: ['nature'] }],
  [['ghost', 'haunt', 'curse', 'undead', 'temple'], { skills: ['religion', 'arcana'], saves: ['wis'] }],
  [['magic', 'arcane', 'rune', 'wizard'], { skills: ['arcana'] }],
  [['ash', 'fire', 'volcan', 'waking'], { saves: ['dex', 'con'] }],
  [['ancient', 'ruin', 'forgot', 'lore', 'years'], { skills: ['history'] }],
  [['stranded', 'lost', 'wild', 'caravan'], { skills: ['survival', 'animal_handling'] }],
  [['sneak', 'thief', 'heist'], { skills: ['stealth', 'sleight_of_hand'] }],
];

/** Weight of every skill and save before hints, and what each hint adds. */
const BASE_WEIGHT = 1;
const ENVIRONMENT_WEIGHT = 3;
const THEME_WEIGHT = 2;
/** A representative mid-band DC for scoring fit (the season-1 band is 8 to 20). */
export const REFERENCE_DC = 13;

/** Check weights for one week: every skill and save, plus capability gates. */
export interface FitWeights {
  readonly skills: Readonly<Record<Skill, number>>;
  readonly saves: Readonly<Record<Ability, number>>;
  /** Gates hinted at, keyed "speed:swim" / "sense:darkvision". */
  readonly requires: ReadonlyMap<string, { readonly requirement: Requirement; readonly weight: number }>;
}

export function fitWeights(entry: { readonly environment: string; readonly theme: string } | undefined): FitWeights {
  const skills = Object.fromEntries(SKILLS.map((s) => [s, BASE_WEIGHT])) as Record<Skill, number>;
  const saves = Object.fromEntries(ABILITIES.map((a) => [a, BASE_WEIGHT])) as Record<Ability, number>;
  const requires = new Map<string, { requirement: Requirement; weight: number }>();
  const apply = (hint: Hint, weight: number): void => {
    for (const s of hint.skills ?? []) skills[s] += weight;
    for (const a of hint.saves ?? []) saves[a] += weight;
    for (const r of hint.requires ?? []) {
      const key = 'speed' in r ? `speed:${r.speed}` : `sense:${r.sense}`;
      const prior = requires.get(key);
      requires.set(key, { requirement: r, weight: (prior?.weight ?? 0) + weight });
    }
  };
  if (entry !== undefined) {
    const env = ENVIRONMENT_HINTS[entry.environment.toLowerCase()];
    if (env !== undefined) apply(env, ENVIRONMENT_WEIGHT);
    const theme = entry.theme.toLowerCase();
    for (const [words, hint] of THEME_HINTS) if (words.some((w) => theme.includes(w))) apply(hint, THEME_WEIGHT);
  }
  return { skills, saves, requires };
}

function meets(member: EffectiveStats, requirement: Requirement): boolean {
  if ('speed' in requirement) return (member.speeds[requirement.speed] ?? 0) > 0;
  return (member.senses[requirement.sense] ?? 0) > 0;
}

/**
 * How well `members` fit the weights, in [0, 1]: the weighted mean, over
 * every skill and save, of the best starter's pass chance at REFERENCE_DC
 * (advantage counted, as best fit does), with each hinted gate counted as a
 * pass if any starter meets it.
 */
export function checkFit(members: ReadonlyArray<EffectiveStats>, weights: FitWeights): number {
  let total = 0;
  let got = 0;
  for (const skill of SKILLS) {
    const w = weights.skills[skill];
    const p = Math.max(0, ...members.map((m) => passChance(m.skills[skill], REFERENCE_DC, m.advantages.has(checkTargetKey({ type: 'skill', skill })))));
    total += w;
    got += w * p;
  }
  for (const ability of ABILITIES) {
    const w = weights.saves[ability];
    const p = Math.max(0, ...members.map((m) => passChance(m.saves[ability], REFERENCE_DC, m.advantages.has(checkTargetKey({ type: 'save', ability })))));
    total += w;
    got += w * p;
  }
  for (const { requirement, weight } of weights.requires.values()) {
    total += weight;
    if (members.some((m) => meets(m, requirement))) got += weight;
  }
  return total === 0 ? 0 : got / total;
}
