/**
 * Thin adapter from a verbatim Open5e record to the engine's `BaseStats`.
 *
 * Responsibilities:
 * - Read only what the engine needs: CR (exact, in eighths), abilities, skill
 *   and save modifiers with ability-mod fallback, speeds, senses, AC, HP,
 *   damage modifiers, and attack lines for the battle model.
 * - Parse Open5e's free-text fields (senses, damage resistances) into
 *   closed-vocabulary values. Text that cannot be parsed is ignored, never
 *   guessed, and reported in `warnings`.
 * - Never read or produce chrome. The creature's `name` is its type name
 *   ("Ogre"), which the story layer may show as `{battle_creature}`.
 *
 * Interpretation rules, in brief (details on each helper):
 * - Speeds: only positive numeric `walk`/`fly`/`swim`/`climb`/`burrow`. A
 *   speed of 0 is omitted. `hover` is ignored silently (it only qualifies
 *   `fly`). `notes` (lycanthrope alternate forms) is ignored with a warning.
 * - Senses: "<kind> <N> ft." per comma-separated part. The first number wins
 *   when the text offers alternatives. Any trailing qualifier is dropped with
 *   a warning. "passive Perception N" is skipped (the perception skill covers it).
 * - Damage: see `parseDamageList`.
 * - Attacks: the action `desc` is the source of truth, not the structured
 *   fields. See `attackProfiles` and `parseMultiattack`.
 *
 * This replaces the reshaped "lean" snapshot schema in docs/specs/02.
 * See docs/decisions.md Δ-04.
 */
import {
  ABILITIES,
  SENSES,
  SKILL_ABILITY,
  SKILLS,
  SPEEDS,
  type Ability,
  type CrEighths,
  type SenseKind,
  type Skill,
  type SpeedKind,
} from '../../vocabulary';
import type { Open5eAction, Open5eMonster } from './types';

export type { Open5eMonster, Open5eAction, Open5eSpeed, SnapshotManifestEntry } from './types';

/**
 * One attack line, reduced to what an expected-value battle model needs.
 *
 * The `attacks` list on `BaseStats` describes one standard turn:
 * expected damage per turn = Σ perTurn × P(hit with attackBonus) × averageDamage.
 */
export interface AttackProfile {
  readonly name: string;
  /** From the "+N to hit" in the action text. */
  readonly attackBonus: number;
  /** Mean damage per hit: every damage clause in the hit text summed (dice average + bonus). */
  readonly averageDamage: number;
  /**
   * Times this attack is made in the creature's standard turn: its parsed
   * Multiattack routine, or else one use of its best attack. 0 means the
   * attack exists but isn't part of that routine.
   */
  readonly perTurn: number;
}

/** Mechanical view of an Open5e creature before season modifiers. */
export interface BaseStats {
  readonly slug: string;
  /** Type name from the stat block, e.g. "Ogre". Not chrome: it is SRD data. */
  readonly typeName: string;
  readonly cr: CrEighths;
  /** Lowercase, e.g. "large". */
  readonly size: string;
  /** Lowercase, e.g. "giant". */
  readonly creatureType: string;
  /** Lowercase, e.g. "goblinoid", or "" when the stat block has none. Contest votes read it. */
  readonly subtype: string;
  /** Lowercase, as the stat block gives it, e.g. "chaotic evil", "unaligned", "any alignment". */
  readonly alignment: string;
  /** Ability scores (not modifiers). */
  readonly abilities: Readonly<Record<Ability, number>>;
  /** Every skill, proficient or not (unproficient = ability modifier). */
  readonly skills: Readonly<Record<Skill, number>>;
  /** Every save, proficient or not. */
  readonly saves: Readonly<Record<Ability, number>>;
  /** Feet. A kind is present only when its speed is above 0. */
  readonly speeds: Readonly<Partial<Record<SpeedKind, number>>>;
  /** Feet. A kind is present only when the stat block lists it. */
  readonly senses: Readonly<Partial<Record<SenseKind, number>>>;
  readonly ac: number;
  readonly hp: number;
  /** Every action that is a weapon or spell attack, in stat-block order. */
  readonly attacks: ReadonlyArray<AttackProfile>;
  /** Tokens per `parseDamageList`. */
  readonly damage: {
    readonly resist: ReadonlyArray<string>;
    readonly immune: ReadonlyArray<string>;
    readonly vulnerable: ReadonlyArray<string>;
  };
}

export interface AdaptResult {
  readonly stats: BaseStats;
  /**
   * Fields the adapter could not interpret. Surfaced by `scripts/validate`.
   * Each is "<kind>: <detail>", where kind is "<field>.<reason>", e.g.
   * "senses.qualifier: …". `warningKind` extracts it.
   */
  readonly warnings: ReadonlyArray<string>;
}

/** The "<field>.<reason>" prefix of an adapter warning. */
export function warningKind(warning: string): string {
  const i = warning.indexOf(':');
  return i < 0 ? warning : warning.slice(0, i);
}

/**
 * Interpret one verbatim record. Pure. Throws only on a malformed CR; every
 * other oddity becomes a warning.
 */
export function toBaseStats(record: Open5eMonster): AdaptResult {
  const warnings: string[] = [];
  const warn = (kind: string, detail: string): void => {
    warnings.push(`${kind}: ${detail}`);
  };

  const cr = parseCr(record.challenge_rating);
  if (typeof record.cr === 'number' && parseCr(record.cr) !== cr) {
    warn('cr.mismatch', `challenge_rating "${record.challenge_rating}" disagrees with cr ${record.cr}; using challenge_rating`);
  }

  const abilities: Record<Ability, number> = {
    str: record.strength,
    dex: record.dexterity,
    con: record.constitution,
    int: record.intelligence,
    wis: record.wisdom,
    cha: record.charisma,
  };
  const mods = abilityModifiers(abilities);

  const stats: BaseStats = {
    slug: record.slug,
    typeName: record.name,
    cr,
    size: record.size.toLowerCase(),
    creatureType: record.type.toLowerCase(),
    subtype: record.subtype.trim().toLowerCase(),
    alignment: record.alignment.trim().toLowerCase(),
    abilities,
    skills: parseSkills(record, mods, warn),
    saves: parseSaves(record, mods),
    speeds: parseSpeeds(record.speed, warn),
    senses: parseSenses(record.senses, warn),
    ac: record.armor_class,
    hp: record.hit_points,
    attacks: attackProfiles(record.actions ?? [], warn),
    damage: {
      resist: parseDamageList(record.damage_resistances, 'damage_resistances', warn),
      immune: parseDamageList(record.damage_immunities, 'damage_immunities', warn),
      vulnerable: parseDamageList(record.damage_vulnerabilities, 'damage_vulnerabilities', warn),
    },
  };
  return { stats, warnings };
}

/**
 * Parse Open5e's CR forms ("1/4", 0.25, "10") to exact eighths. Accepts the
 * 5e values only: 0, 1/8, 1/4, 1/2 and whole numbers 1 to 30. Throws on
 * anything else.
 */
export function parseCr(value: string | number): CrEighths {
  if (typeof value === 'number') {
    const fraction = CR_FRACTIONS_NUMERIC.get(value);
    if (fraction !== undefined) return fraction as CrEighths;
    if (Number.isInteger(value) && value >= 0 && value <= MAX_CR) return (value * 8) as CrEighths;
  } else if (typeof value === 'string') {
    const s = value.trim();
    const fraction = CR_FRACTIONS_TEXT.get(s);
    if (fraction !== undefined) return fraction as CrEighths;
    if (/^\d+$/.test(s) && Number(s) <= MAX_CR) return (Number(s) * 8) as CrEighths;
  }
  throw new Error(`malformed CR ${JSON.stringify(value)}: expected 0, 1/8, 1/4, 1/2 or a whole number up to ${MAX_CR}`);
}

/**
 * Index a snapshot by slug for lookups from character bases and encounters.
 * Throws on a duplicate slug, since lookups would be ambiguous.
 */
export function indexSnapshot(records: ReadonlyArray<Open5eMonster>): ReadonlyMap<string, Open5eMonster> {
  const index = new Map<string, Open5eMonster>();
  for (const record of records) {
    if (index.has(record.slug)) throw new Error(`duplicate slug "${record.slug}" in snapshot`);
    index.set(record.slug, record);
  }
  return index;
}

/**
 * Split one damage field into tokens.
 *
 * Format: the field is split into groups on `;`. Each group is lowercased with
 * whitespace collapsed. A group made only of plain damage types ("acid, cold,
 * and fire") becomes one token per type ("acid", "cold", "fire"). Any other
 * group is kept whole as one qualified token, e.g.
 * "bludgeoning, piercing, and slashing from nonmagical attacks not made with
 * silvered weapons". Qualified tokens using the standard "nonmagical" phrasing
 * pass silently. Others ("damage from spells") are kept and warned about.
 */
export function parseDamageList(text: string, field = 'damage', warn?: (kind: string, detail: string) => void): ReadonlyArray<string> {
  const tokens: string[] = [];
  for (const raw of text.split(';')) {
    const group = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (group === '') continue;
    const pieces = group.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).filter((p) => p !== '');
    if (pieces.length > 0 && pieces.every((p) => DAMAGE_TYPES.has(p))) {
      tokens.push(...pieces);
    } else {
      tokens.push(group);
      if (!group.includes('nonmagical')) warn?.('damage.qualified', `${field}: kept "${group}" as one unrecognized token`);
    }
  }
  return tokens;
}

/** floor((score − 10) / 2) for each ability. */
export function abilityModifiers(abilities: Readonly<Record<Ability, number>>): Readonly<Record<Ability, number>> {
  return Object.fromEntries(ABILITIES.map((a) => [a, Math.floor((abilities[a] - 10) / 2)])) as Record<Ability, number>;
}

// ── internals ──────────────────────────────────────────────────────────────

type Warn = (kind: string, detail: string) => void;

const MAX_CR = 30;
const CR_FRACTIONS_TEXT = new Map<string, number>([
  ['1/8', 1],
  ['1/4', 2],
  ['1/2', 4],
]);
const CR_FRACTIONS_NUMERIC = new Map<number, number>([
  [0.125, 1],
  [0.25, 2],
  [0.5, 4],
]);

const DAMAGE_TYPES = new Set([
  'acid',
  'bludgeoning',
  'cold',
  'fire',
  'force',
  'lightning',
  'necrotic',
  'piercing',
  'poison',
  'psychic',
  'radiant',
  'slashing',
  'thunder',
]);

const SAVE_FIELDS: Readonly<Record<Ability, keyof Open5eMonster>> = {
  str: 'strength_save',
  dex: 'dexterity_save',
  con: 'constitution_save',
  int: 'intelligence_save',
  wis: 'wisdom_save',
  cha: 'charisma_save',
};

/** Skill keys compared without separators, so "animalhandling" and "Animal Handling" both find `animal_handling`. */
const SKILL_BY_COMPACT_KEY = new Map<string, Skill>(SKILLS.map((s) => [s.replace(/_/g, ''), s]));

function normalizeSkillKey(key: string): Skill | undefined {
  return SKILL_BY_COMPACT_KEY.get(key.toLowerCase().replace(/[^a-z]/g, ''));
}

function parseSkills(record: Open5eMonster, mods: Readonly<Record<Ability, number>>, warn: Warn): Record<Skill, number> {
  const skills = Object.fromEntries(SKILLS.map((s) => [s, mods[SKILL_ABILITY[s]]])) as Record<Skill, number>;
  const seen = new Set<Skill>();
  for (const [key, value] of Object.entries(record.skills)) {
    const skill = normalizeSkillKey(key);
    if (skill === undefined) {
      warn('skills.unknown_key', `ignored skill "${key}"`);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      warn('skills.invalid', `${key}: ${JSON.stringify(value)} is not a number`);
      continue;
    }
    if (seen.has(skill)) warn('skills.duplicate', `"${key}" repeats ${skill}; using the later value`);
    seen.add(skill);
    skills[skill] = value;
  }
  if (typeof record.perception === 'number') {
    if (!seen.has('perception')) skills.perception = record.perception;
    else if (skills.perception !== record.perception) {
      warn('skills.perception_mismatch', `perception ${record.perception} disagrees with skills.perception ${skills.perception}; using skills`);
    }
  }
  return skills;
}

function parseSaves(record: Open5eMonster, mods: Readonly<Record<Ability, number>>): Record<Ability, number> {
  return Object.fromEntries(
    ABILITIES.map((a) => {
      const value = record[SAVE_FIELDS[a]];
      return [a, typeof value === 'number' ? value : mods[a]];
    }),
  ) as Record<Ability, number>;
}

function isOneOf<T extends string>(values: ReadonlyArray<T>, x: string): x is T {
  return (values as ReadonlyArray<string>).includes(x);
}

function parseSpeeds(speed: Open5eMonster['speed'], warn: Warn): Partial<Record<SpeedKind, number>> {
  const speeds: Partial<Record<SpeedKind, number>> = {};
  for (const [key, value] of Object.entries(speed)) {
    if (value === undefined) continue;
    if (isOneOf(SPEEDS, key)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        if (value > 0) speeds[key] = value;
      } else {
        warn('speed.invalid', `${key}: ${JSON.stringify(value)} is not a speed in feet`);
      }
    } else if (key === 'hover') {
      // Ignored: hovering only qualifies a fly speed, which we already record.
    } else if (key === 'notes') {
      warn('speed.notes', `ignored notes ${JSON.stringify(value)}`);
    } else {
      warn('speed.unknown_kind', `ignored ${key}: ${JSON.stringify(value)}`);
    }
  }
  return speeds;
}

const SENSE_RE = /^([a-z]+)\s+(\d+)\s*ft\.?\s*(.*)$/i;

function parseSenses(text: string, warn: Warn): Partial<Record<SenseKind, number>> {
  const senses: Partial<Record<SenseKind, number>> = {};
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (part === '' || /^passive perception \d+$/i.test(part)) continue;
    const m = SENSE_RE.exec(part);
    const kind = m?.[1]?.toLowerCase();
    if (m === null || kind === undefined || !isOneOf(SENSES, kind)) {
      warn('senses.unparsed', `ignored "${part}"`);
      continue;
    }
    const feet = Number(m[2]);
    const qualifier = (m[3] ?? '').trim();
    if (qualifier !== '') warn('senses.qualifier', `${kind} ${feet} ft.: ignored qualifier "${qualifier}"`);
    const existing = senses[kind];
    if (existing !== undefined) warn('senses.duplicate', `${kind} listed twice; using the larger`);
    senses[kind] = Math.max(existing ?? 0, feet);
  }
  return senses;
}

// ── attacks ───────────────────────────────────────────────────────────────

const ATTACK_RE = /\b(?:Weapon|Spell) Attack:/i;
const TO_HIT_RE = /([+-])\s*(\d+)\s+to hit/i;
/** "13 (2d8 + 4) bludgeoning damage" or "1 piercing damage" at the start of the hit text. */
const PRIMARY_DAMAGE_RE = /^(\d+)\s*(?:\([^)]*\))?\s*[a-z]+(?:\s+or\s+[a-z]+)?\s+damage\b/i;
/** "plus 7 (2d6) fire damage". */
const PLUS_DAMAGE_RE = /\bplus\s+(\d+)\s*(?:\([^)]*\))?\s*[a-z]+(?:\s+or\s+[a-z]+)?\s+damage\b/gi;

interface ParsedAttack {
  readonly name: string;
  readonly desc: string;
  readonly attackBonus: number;
  readonly averageDamage: number;
}

/**
 * Attack profiles from a creature's actions. An action is an attack when its
 * desc has "Weapon Attack:" or "Spell Attack:" and "+N to hit". Special
 * abilities, reactions and legendary actions are not part of a standard turn
 * and are not read.
 */
function attackProfiles(actions: ReadonlyArray<Open5eAction>, warn: Warn): AttackProfile[] {
  const attacks: ParsedAttack[] = [];
  for (const action of actions) {
    const parsed = parseAttack(action, warn);
    if (parsed !== undefined) attacks.push(parsed);
  }
  if (attacks.length === 0) {
    warn('attack.none', actions.length === 0 ? 'no actions' : 'no weapon or spell attacks among the actions');
    return [];
  }

  const multiattack = actions.find((a) => /^multiattack\b/i.test(a.name.trim()));
  let routine: ReadonlyMap<number, number> | undefined;
  if (multiattack !== undefined) {
    const parsed = parseMultiattack(multiattack.desc, attacks);
    if (typeof parsed === 'string') {
      warn('multiattack.unparsed', `${parsed}; using one attack per turn with the best attack ("${multiattack.desc}")`);
    } else {
      routine = parsed;
    }
  }
  routine ??= new Map([[bestOf(attacks.map((_, i) => i), attacks), 1]]);

  return attacks.map((a, i) => ({
    name: a.name,
    attackBonus: a.attackBonus,
    averageDamage: a.averageDamage,
    perTurn: routine.get(i) ?? 0,
  }));
}

function parseAttack(action: Open5eAction, warn: Warn): ParsedAttack | undefined {
  const desc = action.desc;
  const toHit = TO_HIT_RE.exec(desc);
  if (!ATTACK_RE.test(desc) || toHit === null) return undefined;
  const attackBonus = (toHit[1] === '-' ? -1 : 1) * Number(toHit[2]);
  const name = action.name.trim();

  if (typeof action.attack_bonus === 'number' && action.attack_bonus !== attackBonus) {
    warn('attack.bonus_mismatch', `${name}: desc says ${signed(attackBonus)} to hit, attack_bonus is ${action.attack_bonus}; using the desc`);
  }

  const hitAt = desc.search(/\bHit:/);
  const hitText = hitAt < 0 ? '' : desc.slice(hitAt + 'Hit:'.length).trim();
  // Only the first sentence of the hit text: later sentences are riders
  // (saving throws, grapples, conditional extra damage).
  const firstSentence = hitText.split(/\.(?:\s|$)/)[0] ?? '';
  const primary = PRIMARY_DAMAGE_RE.exec(firstSentence);
  let averageDamage: number | undefined;
  if (primary !== null) {
    averageDamage = Number(primary[1]);
    for (const extra of firstSentence.matchAll(PLUS_DAMAGE_RE)) averageDamage += Number(extra[1]);
  } else {
    const fromFields = averageFromFields(action);
    if (fromFields !== undefined) {
      averageDamage = fromFields;
      warn('attack.damage_from_fields', `${name}: no damage in the hit text; using damage_dice ${action.damage_dice} + ${action.damage_bonus ?? 0}`);
    } else if (/\bdamage\b/i.test(hitText)) {
      warn('attack.no_damage', `${name}: could not read damage from "${hitText.slice(0, 80)}"; using 0`);
    }
  }
  return { name, desc, attackBonus, averageDamage: averageDamage ?? 0 };
}

/** Average of `damage_dice` (possibly compound, "2d10+1d8") plus `damage_bonus`. */
function averageFromFields(action: Open5eAction): number | undefined {
  const dice = action.damage_dice?.replace(/\s+/g, '');
  if (dice === undefined || dice === '') return undefined;
  let total = 0;
  for (const term of dice.split('+')) {
    const m = /^(\d+)d(\d+)$/i.exec(term);
    if (m !== null) total += (Number(m[1]) * (Number(m[2]) + 1)) / 2;
    else if (/^\d+$/.test(term)) total += Number(term);
    else return undefined;
  }
  return total + (action.damage_bonus ?? 0);
}

function signed(n: number): string {
  return n < 0 ? `${n}` : `+${n}`;
}

/** Index of the attack with the highest average damage. Ties go to the earlier attack. */
function bestOf(indices: ReadonlyArray<number>, attacks: ReadonlyArray<ParsedAttack>): number {
  let best = indices[0] ?? 0;
  for (const i of indices) if ((attacks[i]?.averageDamage ?? 0) > (attacks[best]?.averageDamage ?? 0)) best = i;
  return best;
}

// ── multiattack ───────────────────────────────────────────────────────────

const COUNT_WORDS: ReadonlyMap<string, number> = new Map([
  ['one', 1],
  ['two', 2],
  ['three', 3],
  ['four', 4],
  ['five', 5],
  ['six', 6],
  ['seven', 7],
  ['eight', 8],
  ['nine', 9],
  ['ten', 10],
  ['once', 1],
  ['twice', 2],
  ['thrice', 3],
]);
const COUNT_ALTS = 'one|two|three|four|five|six|seven|eight|nine|ten|\\d+';
/** A count, captured. */
const COUNT = `(${COUNT_ALTS})`;
/**
 * An "or" that starts a new option ("… or two ranged attacks", "… or uses its
 * Hurl Flame twice"), not one between names ("claws or harpoon").
 */
const OPTION_SPLIT = new RegExp(`,?\\s+or\\s+(?=(?:makes?\\s+)?(?:${COUNT_ALTS})\\b|uses?\\b)`);
/** "two melee attacks", "four attacks with its tendrils". */
const SEG_COUNT_ATTACKS = new RegExp(`^${COUNT} (?:(melee|ranged) )?attacks?(?: with (?:its |a )?(.+))?$`);
/** "one with its bite", "one to constrict". */
const SEG_COUNT_WITH = new RegExp(`^${COUNT} (?:with (?:its |a )?|to )(.+)$`);
/** "two slam attacks". */
const SEG_COUNT_NAMED = new RegExp(`^${COUNT} (.+?) attacks?$`);
/** "uses its hurl flame twice". */
const SEG_USES = new RegExp(`^uses? (?:its )?(.+?) (?:(once|twice|thrice)|${COUNT} times)$`);

type Range = 'melee' | 'ranged';

/** One "N attacks with X" piece of a routine. `count` is undefined when it comes from the header. */
type Slot =
  | { readonly kind: 'named'; readonly count: number | undefined; readonly names: string }
  | { readonly kind: 'any'; readonly count: number; readonly range: Range | undefined };

interface ParsedOption {
  readonly slots: Slot[];
  /** "each one with a different weapon" */
  distinct: boolean;
  /** "only one of which can be a bite" */
  limitOne: string | undefined;
}

/**
 * Parse a Multiattack desc into attacks per turn, keyed by index into
 * `attacks`. Returns a reason string when the text can't be read reliably.
 *
 * Reads the first sentence that says the creature "makes … attack(s)". Later
 * sentences (optional extras, substitutions) are ignored. Handles:
 * - "makes three attacks: one with its bite and two with its claws"
 * - "makes two slam attacks", "makes three claw attacks and one bite attack"
 * - "makes two melee attacks" (no names): that many uses of the best eligible attack
 * - "makes three attacks, either with its longsword or its longbow": the better one
 * - "each one with a different weapon", "only one of which can be a bite"
 * - alternatives ("… or two ranged attacks", "… or uses its Hurl Flame twice"):
 *   the option with the most total average damage
 * Counts that aren't fixed numbers ("1d4", "as many … as it has heads") fail.
 */
function parseMultiattack(desc: string, attacks: ReadonlyArray<ParsedAttack>): ReadonlyMap<number, number> | string {
  const sentence = desc.split(/(?<=\.)\s+/).find((s) => /\bmakes?\b/i.test(s) && /\battacks?\b/i.test(s));
  if (sentence === undefined) return 'no sentence says which attacks it makes';
  const text = sentence
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/\beither\s+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .toLowerCase();
  const options = text.split(OPTION_SPLIT);

  let best: { routine: Map<number, number>; damage: number } | undefined;
  for (const option of options) {
    const routine = resolveOption(option, attacks);
    if (typeof routine === 'string') return routine;
    let damage = 0;
    for (const [i, n] of routine) damage += n * (attacks[i]?.averageDamage ?? 0);
    if (best === undefined || damage > best.damage) best = { routine, damage };
  }
  return best?.routine ?? 'no attack options';
}

function countOf(word: string | undefined): number | undefined {
  if (word === undefined) return undefined;
  if (/^\d+$/.test(word)) return Number(word);
  return COUNT_WORDS.get(word);
}

/** Parse one alternative ("makes three attacks: …") into slots, then resolve them to attacks. */
function resolveOption(option: string, attacks: ReadonlyArray<ParsedAttack>): Map<number, number> | string {
  const colon = option.indexOf(':');
  const headText = colon >= 0 ? option.slice(0, colon) : undefined;
  const body = colon >= 0 ? option.slice(colon + 1) : option;
  const parsed: ParsedOption = { slots: [], distinct: false, limitOne: undefined };

  let header: { count: number; range: Range | undefined } | undefined;
  if (headText !== undefined) {
    const h = parseSegment(headText, parsed);
    if (typeof h === 'string') return h;
    if (h === undefined || h.kind !== 'any') return `cannot read "${headText}"`;
    header = { count: h.count, range: h.range };
  }
  // Pieces are joined by commas and "and" (", and", "and,").
  for (const segment of body.split(/\s*,\s*(?:and\s+)?|\s+and\b,?\s*/)) {
    if (segment.trim() === '') continue;
    const slot = parseSegment(segment.trim(), parsed);
    if (typeof slot === 'string') return slot;
    if (slot !== undefined) parsed.slots.push(slot);
  }

  // "makes three melee attacks, one with its X and two with its Y": the
  // leading count-only slot is a header when anything else follows it.
  const first = parsed.slots[0];
  if (header === undefined && first?.kind === 'any' && (parsed.slots.length > 1 || parsed.distinct || parsed.limitOne !== undefined)) {
    header = { count: first.count, range: first.range };
    parsed.slots.shift();
  }

  let slots: Slot[] = parsed.slots;
  if (header !== undefined) {
    if (slots.length === 0) {
      slots = [{ kind: 'any', count: header.count, range: header.range }];
    } else if (slots.length === 1 && slots[0]?.kind === 'named' && slots[0].count === undefined) {
      slots = [{ ...slots[0], count: header.count }];
    } else {
      const sum = slots.reduce((n, s) => n + (s.count ?? Number.NaN), 0);
      if (sum !== header.count) return `the parts add up to ${sum}, not ${header.count}`;
    }
  }
  if (slots.length === 0) return 'no attacks named';
  if ((parsed.distinct || parsed.limitOne !== undefined) && (slots.length !== 1 || slots[0]?.kind !== 'any')) {
    return 'a constraint applies to a mixed routine';
  }

  const routine = new Map<number, number>();
  const add = (i: number, n: number): void => {
    routine.set(i, (routine.get(i) ?? 0) + n);
  };
  for (const slot of slots) {
    if (slot.count === undefined) return 'an attack has no count';
    if (slot.kind === 'named') {
      const matches: number[] = [];
      for (const name of slot.names.split(/\s+or\s+(?:its\s+)?/)) {
        const i = matchAttack(name, attacks);
        if (i === undefined) return `no attack matches "${name}"`;
        matches.push(i);
      }
      add(bestOf(matches, attacks), slot.count);
      continue;
    }
    const eligible = attacks
      .map((a, i) => ({ a, i }))
      // The range is in the attack's lead-in: "Melee or Ranged Weapon Attack:".
      .filter(({ a }) => slot.range === undefined || (a.desc.split(':')[0] ?? '').toLowerCase().includes(slot.range))
      .map(({ i }) => i);
    if (eligible.length === 0) return slot.range === undefined ? 'no attack to use' : `no ${slot.range} attack to use`;
    const ranked = [...eligible].sort((x, y) => (attacks[y]?.averageDamage ?? 0) - (attacks[x]?.averageDamage ?? 0) || x - y);
    if (parsed.distinct) {
      if (ranked.length < slot.count) return `needs ${slot.count} different attacks, has ${ranked.length}`;
      for (const i of ranked.slice(0, slot.count)) add(i, 1);
    } else if (parsed.limitOne !== undefined) {
      const limited = matchAttack(parsed.limitOne, attacks);
      if (limited === undefined) return `no attack matches "${parsed.limitOne}"`;
      const others = ranked.filter((i) => i !== limited);
      const top = ranked[0] ?? limited;
      if (top === limited && slot.count > 1) {
        const next = others[0];
        if (next === undefined) return `only "${parsed.limitOne}" is available`;
        add(limited, 1);
        add(next, slot.count - 1);
      } else {
        add(top, slot.count);
      }
    } else {
      add(ranked[0] ?? 0, slot.count);
    }
  }
  return routine;
}

/**
 * One comma/"and"-separated piece. Returns a slot, undefined for prose that
 * isn't about attacks ("uses Reel", "if it can"), or a reason string when it
 * mentions attacks but can't be read.
 */
function parseSegment(raw: string, parsed: ParsedOption): Slot | undefined | string {
  const hadMakes = /\bmakes?\b/.test(raw);
  const s = raw.replace(/^.*?\bmakes?\s+/, '').trim();
  let m: RegExpExecArray | null;

  if ((m = SEG_COUNT_ATTACKS.exec(s)) !== null) {
    const count = countOf(m[1]) ?? 0;
    const range = m[2] as Range | undefined;
    return m[3] !== undefined ? { kind: 'named', count, names: m[3] } : { kind: 'any', count, range };
  }
  if ((m = SEG_COUNT_WITH.exec(s)) !== null) {
    return { kind: 'named', count: countOf(m[1]), names: m[2] ?? '' };
  }
  if ((m = SEG_COUNT_NAMED.exec(s)) !== null) {
    return { kind: 'named', count: countOf(m[1]), names: m[2] ?? '' };
  }
  if ((m = SEG_USES.exec(s)) !== null) {
    return { kind: 'named', count: countOf(m[2] ?? m[3]), names: m[1] ?? '' };
  }
  if ((m = /^with (?:its )?(.+)$/.exec(s)) !== null) {
    return { kind: 'named', count: undefined, names: m[1] ?? '' };
  }
  if (/^each(?: one)? with a different weapon$/.test(s)) {
    parsed.distinct = true;
    return undefined;
  }
  if ((m = /^only one of which can be (?:a |an |with its )?(.+?)(?: attacks?)?$/.exec(s)) !== null) {
    parsed.limitOne = m[1];
    return undefined;
  }
  if (hadMakes || /\battacks?\b/.test(s)) return `cannot read "${raw}"`;
  return undefined;
}

/** Lowercase, drop parentheticals and punctuation, and singularize each word ("Claws (Hybrid Form Only)" → "claw"). */
function normalizeAttackName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w !== '' && w !== 'its')
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .join(' ');
}

/** The attack a Multiattack phrase names: an exact normalized match, else a unique attack whose name ends or starts with it. */
function matchAttack(phrase: string, attacks: ReadonlyArray<ParsedAttack>): number | undefined {
  const ref = normalizeAttackName(phrase);
  if (ref === '') return undefined;
  const names = attacks.map((a) => normalizeAttackName(a.name));
  const exact = names.indexOf(ref);
  if (exact >= 0) return exact;
  const partial = names.flatMap((n, i) => (n.endsWith(` ${ref}`) || n.startsWith(`${ref} `) ? [i] : []));
  return partial.length === 1 ? partial[0] : undefined;
}
