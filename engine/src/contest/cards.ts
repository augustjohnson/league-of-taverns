/**
 * The monster card's mechanical half: the tags voting strategies read, and
 * challenge power, the one-number summary of how a monster does in
 * challenges. Both are derived from public stats, so every manager can
 * work them out.
 */
import type { BaseStats } from '../adapters/open5e';
import type { EffectiveStats } from '../characters';
import { checkTargetKey } from '../characters';
import { ABILITIES, SKILLS } from '../vocabulary';
import type { Contestant, VotingStrategy } from './types';

/**
 * Tags from a stat block, as `<axis>:<value>`:
 *
 * - `type:<creature type>`, e.g. `type:undead`
 * - `subtype:<subtype>` when the stat block has a real one (not "any race"),
 *   e.g. `subtype:goblinoid`
 * - `law:lawful` or `law:chaotic`, and `moral:good` or `moral:evil`, from the
 *   alignment. Neutral, unaligned and "any" alignments give no tag on that
 *   axis, except "any chaotic alignment" (`law:chaotic`) and the like.
 * - `size:<size>`
 */
export function cardTags(base: BaseStats): ReadonlyArray<string> {
  const tags = [`type:${base.creatureType}`];
  const subtype = base.subtype;
  if (subtype !== '' && !subtype.startsWith('any')) tags.push(`subtype:${subtype}`);
  const alignment = base.alignment;
  const anyOf = alignment.startsWith('any');
  // "any chaotic alignment" names an axis; "any alignment" and "any non-lawful alignment" don't pin one.
  if (!anyOf || !alignment.includes('non-')) {
    if (/\blawful\b/.test(alignment)) tags.push('law:lawful');
    if (/\bchaotic\b/.test(alignment)) tags.push('law:chaotic');
    if (/\bgood\b/.test(alignment)) tags.push('moral:good');
    if (/\bevil\b/.test(alignment)) tags.push('moral:evil');
  }
  tags.push(`size:${base.size}`);
  return tags;
}

/**
 * Challenge power: the mean modifier over every skill and every save, with
 * advantage on one of them worth +3. A balanced season tests skills and
 * saves about evenly, so this is roughly the modifier a monster brings to a
 * challenge.
 */
export function challengePower(stats: EffectiveStats): number {
  let total = 0;
  let n = 0;
  for (const skill of SKILLS) {
    total += stats.skills[skill] + (stats.advantages.has(checkTargetKey({ type: 'skill', skill })) ? 3 : 0);
    n++;
  }
  for (const ability of ABILITIES) {
    total += stats.saves[ability] + (stats.advantages.has(checkTargetKey({ type: 'save', ability })) ? 3 : 0);
    n++;
  }
  return total / n;
}

/** A contestant from its stats and strategy. */
export function contestant(stats: EffectiveStats, strategy: VotingStrategy): Contestant {
  return { id: stats.characterId, stats, strategy, tags: cardTags(stats.base), power: challengePower(stats) };
}

/** True when `c` carries `tag`. */
export function hasTag(c: Contestant, tag: string): boolean {
  return c.tags.includes(tag);
}
