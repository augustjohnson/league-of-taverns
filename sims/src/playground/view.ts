/**
 * Pure view-model helpers for the playground: the draft board and the
 * crier's draft notes, how a card's strategy and a challenge's checks read,
 * the order the votes are read in, the banner and card-art stylesheets, and
 * the small formatters the page uses. No DOM, so tests run them in Node.
 */
import { SKILLS } from '@league-of-taverns/engine';
import type { Actor, Ballot, ChallengeCheck, EffectiveStats, LeagueEvent, Modifier, Skill, VotingStrategy } from '@league-of-taverns/engine';
import type { Aggregate } from '../season-runner';
import type { Banner } from '@league-of-taverns/scripts/lib/banner';
import type { TavernChrome } from './data';

// ── draft board ────────────────────────────────────────────────────────────

export interface DraftCell {
  readonly pick: number;
  readonly tavern: string;
  readonly character: string;
}

export interface DraftRow {
  readonly round: number;
  /** Snake direction across the slots: left to right on even rounds (0-based). */
  readonly direction: 'ltr' | 'rtl';
  /** One cell per slot of `order`, null where no pick was made. */
  readonly cells: ReadonlyArray<DraftCell | null>;
}

/** Rounds × draft slots. Slot s is `order[s]`; pick p is round ⌊p/n⌋, slot p mod n, reversed on odd rounds. */
export function draftBoard(order: ReadonlyArray<string>, picks: ReadonlyArray<DraftCell>): ReadonlyArray<DraftRow> {
  const n = order.length;
  if (n === 0) return [];
  const rounds = Math.ceil(picks.length / n);
  const rows: Array<{ round: number; direction: 'ltr' | 'rtl'; cells: Array<DraftCell | null> }> = [];
  for (let r = 0; r < rounds; r++) rows.push({ round: r + 1, direction: r % 2 === 0 ? 'ltr' : 'rtl', cells: order.map(() => null) });
  for (const p of picks) {
    const round = Math.floor(p.pick / n);
    const i = p.pick % n;
    const slot = round % 2 === 0 ? i : n - 1 - i;
    rows[round]!.cells[slot] = p;
  }
  return rows;
}

/**
 * The crier's notes on a pick: each pick against where the scouts rank the
 * monster (0-based, best first). A steal is taken `STEAL_PICKS` or more
 * picks after its rank, a reach `REACH_PICKS` or more before it.
 */
export type DraftNote = 'steal' | 'reach';

export const STEAL_PICKS = 4;
export const REACH_PICKS = 6;

export interface DraftCall extends DraftCell {
  /** The scouts' rank (0-based), or null when `ranks` has no entry. */
  readonly rank: number | null;
  readonly notes: ReadonlyArray<DraftNote>;
}

export function draftCalls(picks: ReadonlyArray<DraftCell>, ranks: ReadonlyMap<string, number>): ReadonlyArray<DraftCall> {
  return picks.map((p) => {
    const at = ranks.get(p.character) ?? null;
    const notes: DraftNote[] = [];
    if (at !== null && p.pick - at >= STEAL_PICKS) notes.push('steal');
    if (at !== null && at - p.pick >= REACH_PICKS) notes.push('reach');
    return { ...p, rank: at, notes };
  });
}

/** Ranks (0-based, best first) from values, ties by the given order. */
export function ranksOf(values: ReadonlyMap<string, number>): ReadonlyMap<string, number> {
  return new Map(
    [...values]
      .map(([id, v], i) => ({ id, v, i }))
      .sort((a, b) => b.v - a.v || a.i - b.i)
      .map(({ id }, rank) => [id, rank]),
  );
}

// ── the card ───────────────────────────────────────────────────────────────

const ARTICLE_NOUNS: Readonly<Record<string, string>> = {
  aberration: 'an aberration',
  beast: 'a beast',
  construct: 'a construct',
  dragon: 'a dragon',
  elemental: 'an elemental',
  fey: 'one of the fey',
  fiend: 'a fiend',
  giant: 'a giant',
  humanoid: 'a humanoid',
  monstrosity: 'a monstrosity',
  ooze: 'an ooze',
  plant: 'a plant',
  undead: 'one of the dead',
};

/** A tag as a phrase: `type:undead` → "one of the dead", `law:lawful` → "someone lawful", `subtype:goblinoid` → "a goblinoid". */
export function tagPhrase(tag: string): string {
  const [axis, value = ''] = tag.split(':');
  switch (axis) {
    case 'type':
      return ARTICLE_NOUNS[value] ?? `a ${value}`;
    case 'subtype':
      return `${/^[aeiou]/.test(value) ? 'an' : 'a'} ${value}`;
    case 'law':
    case 'moral':
    case 'size':
      return `someone ${value}`;
    default:
      return tag;
  }
}

/** A tag as a short label: `type:undead` → "undead", `law:lawful` → "lawful". */
export function tagLabel(tag: string): string {
  return tag.split(':')[1] ?? tag;
}

/** A strategy's name. */
export function strategyName(strategy: VotingStrategy): string {
  switch (strategy.kind) {
    case 'loyal':
      return 'Loyal';
    case 'threat':
      return 'Threat hunter';
    case 'coattails':
      return 'Coattails';
    case 'grudge':
      return 'Grudge';
    case 'floater':
      return 'Floater';
  }
}

/** What a strategy does, in a line, as the card says it. `betrayAt` is when coattails riders turn (`VoteModel.betrayAt`). */
export function strategyLine(strategy: VotingStrategy, betrayAt?: number): string {
  switch (strategy.kind) {
    case 'loyal':
      return `wants ${tagPhrase(strategy.tag)} to win`;
    case 'threat':
      return 'cuts down whoever looks strongest';
    case 'coattails':
      return betrayAt === undefined ? 'flatters the strong, votes out the weak, then turns on them' : `flatters the strong, votes out the weak; at the final ${betrayAt}, turns on the strongest`;
    case 'grudge':
      return 'goes after whoever voted against it';
    case 'floater':
      return 'votes with the biggest bloc';
  }
}

/** A check's target in words: "Athletics", "Con save", "Int check". */
export function checkName(check: Pick<ChallengeCheck, 'type'> & ({ readonly skill: Skill } | { readonly ability: string })): string {
  if ('skill' in check) return check.skill.replaceAll('_', ' ').replace(/^\w/, (c) => c.toUpperCase());
  const ability = check.ability.charAt(0).toUpperCase() + check.ability.slice(1);
  return check.type === 'save' ? `${ability} save` : `${ability} check`;
}

/** A challenge check in full: "Athletics DC 12, swim speed: advantage". */
export function checkLabel(check: ChallengeCheck, dc = check.dc): string {
  const req = (r: ChallengeCheck['advantage']): string => (r === undefined ? '' : 'speed' in r ? `${r.speed} speed` : r.sense);
  const extras = [check.advantage === undefined ? '' : `${req(check.advantage)}: advantage`, check.requires === undefined ? '' : `needs ${req(check.requires)}`].filter((x) => x !== '');
  return `${checkName(check as never)} DC ${dc}${extras.length === 0 ? '' : `, ${extras.join(', ')}`}`;
}

/** The six ability modifiers as a compact list: [["Str", +3], ...]. */
export function abilityLine(stats: EffectiveStats): ReadonlyArray<readonly [string, number]> {
  return (['str', 'dex', 'con', 'int', 'wis', 'cha'] as const).map((a) => [a.charAt(0).toUpperCase() + a.slice(1), stats.abilityMods[a]] as const);
}

// ── the vote, read aloud ───────────────────────────────────────────────────

/**
 * The order the Lich reads the ballots in, Survivor style: the boot's votes
 * spread through the reading so the count stays close, a rival's vote in
 * between, and the boot's last vote read last. Every ballot appears once.
 */
export function readingOrder(ballots: ReadonlyArray<Ballot>, boot: string): ReadonlyArray<Ballot> {
  const bootVotes = ballots.filter((b) => b.target === boot);
  const groups = new Map<string, Ballot[]>();
  for (const b of ballots) if (b.target !== boot) groups.set(b.target, [...(groups.get(b.target) ?? []), b]);
  const out: Ballot[] = [];
  const last = bootVotes.at(-1);
  const bootLeft = bootVotes.slice(0, -1);
  let turn = 0;
  for (;;) {
    const others = [...groups.values()].filter((g) => g.length > 0).sort((a, b) => b.length - a.length);
    if (bootLeft.length === 0 && others.length === 0) break;
    if (bootLeft.length > 0 && (turn % 2 === 1 || others.length === 0)) out.push(bootLeft.shift()!);
    else if (others.length > 0) out.push(others[0]!.shift()!);
    turn++;
  }
  if (last !== undefined) out.push(last);
  return out;
}

/** The running tally after each ballot in `order`: how many votes each target has once it is read. */
export function runningTally(order: ReadonlyArray<Ballot>): ReadonlyArray<number> {
  const count = new Map<string, number>();
  return order.map((b) => {
    const n = (count.get(b.target) ?? 0) + 1;
    count.set(b.target, n);
    return n;
  });
}

/**
 * How many ballots in `order` the Lich has to read before nobody can catch
 * `boot`: once the boot leads every other target by more than the ballots
 * left, the rest can't change it. `order.length` when it is only settled at
 * the end (or never: a tie).
 */
export function decidedAfter(order: ReadonlyArray<Ballot>, boot: string): number {
  const count = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    count.set(order[i]!.target, (count.get(order[i]!.target) ?? 0) + 1);
    const left = order.length - i - 1;
    const b = count.get(boot) ?? 0;
    const rival = Math.max(0, ...[...count].filter(([t]) => t !== boot).map(([, n]) => n));
    if (rival + left < b) return i + 1;
  }
  return order.length;
}

const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];

/** "First vote", "Second vote", …, then "Vote 11". */
export function voteOrdinal(i: number): string {
  return ORDINALS[i] === undefined ? `Vote ${i + 1}` : `${ORDINALS[i]} vote`;
}

// ── formatting ─────────────────────────────────────────────────────────────

/** Human CR from eighths: 4 → "1/2", 100 → "12 1/2". */
export function formatCr(eighths: number): string {
  const whole = Math.floor(eighths / 8);
  let num = eighths % 8;
  if (num === 0) return String(whole);
  let den = 8;
  while (num % 2 === 0) {
    num /= 2;
    den /= 2;
  }
  return whole === 0 ? `${num}/${den}` : `${whole} ${num}/${den}`;
}

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`;
}

export function pct(x: number, digits = 1): string {
  return `${(100 * x).toFixed(digits)}%`;
}

export function formatModifier(m: Modifier): string {
  switch (m.kind) {
    case 'trait':
      return `trait ${m.trait}`;
    case 'skill_bonus':
      return `${m.skill.replaceAll('_', ' ')} ${signed(m.value)}`;
    case 'save_bonus':
      return `${m.ability} save ${signed(m.value)}`;
    case 'advantage':
      return `adv. ${m.on.type === 'skill' ? m.on.skill.replaceAll('_', ' ') : `${m.on.type} ${m.on.ability}`}`;
    case 'grant_speed':
      return `${m.speed} ${m.feet} ft`;
    case 'grant_sense':
      return `${m.sense} ${m.feet} ft`;
  }
}

/** The `n` highest effective skill modifiers, ties in vocabulary order. */
export function topSkills(stats: EffectiveStats, n = 3): ReadonlyArray<{ readonly skill: Skill; readonly modifier: number }> {
  return SKILLS.map((skill, i) => ({ skill, modifier: stats.skills[skill], i }))
    .sort((a, b) => b.modifier - a.modifier || a.i - b.i)
    .slice(0, n)
    .map(({ skill, modifier }) => ({ skill, modifier }));
}

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case 'bot':
      return `bot:${actor.strategy}`;
    case 'system':
      return `system:${actor.workflow}`;
    default:
      return `${actor.kind}:${actor.login}`;
  }
}

/** One line per event for the log list. */
export function eventSummary(event: LeagueEvent): string {
  switch (event.type) {
    case 'season.created':
      return `${event.payload.config.id}: cast ${event.payload.config.contest.castSize}, ${event.payload.challenges.length} episodes, roster ${event.payload.config.roster.size}`;
    case 'character.pooled':
      return `${event.payload.character} (${event.payload.base}, CR ${formatCr(event.payload.cr)}) ${event.payload.strategy.kind}${event.payload.strategy.kind === 'loyal' ? ` ${event.payload.strategy.tag}` : ''}`;
    case 'manager.joined':
      return `${event.payload.manager} (${'bot' in event.payload.account ? event.payload.account.bot : event.payload.account.login})`;
    case 'tavern.chosen':
      return `${event.payload.manager} chooses ${event.payload.tavern}`;
    case 'draft.pick':
      return `#${event.payload.pick + 1} ${event.payload.tavern} takes ${event.payload.character}`;
    case 'call.made':
      return `ep ${event.payload.episode} ${event.payload.tavern} calls ${event.payload.target}`;
    case 'challenge.resolved':
      return `ep ${event.payload.episode} ${event.payload.challenge.id}: ${event.payload.result.winner} wins in ${event.payload.result.rounds.length} rounds`;
    case 'vote.resolved': {
      const v = event.payload.vote;
      return `ep ${event.payload.episode}: ${v.boot} out${v.revote === null ? '' : ' (revote)'}${v.draw === null ? '' : ' (draw)'}`;
    }
    case 'finale.resolved':
      return `the jury chooses ${event.payload.result.winner}`;
  }
}

/** The CLI's per-bot table (sim.ts `print`), as rows of cells. */
export function aggregateRows(totals: Aggregate): { readonly header: ReadonlyArray<string>; readonly rows: ReadonlyArray<ReadonlyArray<string>> } {
  const header = ['bot', 'seats', 'titles', 'titles/seat', 'mean pts', 'calls right', 'early'];
  const rows = Object.entries(totals.byBot).map(([bot, a]) => [
    bot,
    String(a.seats),
    Number.isInteger(a.titles) ? String(a.titles) : a.titles.toFixed(1),
    a.titlesPerSeat.toFixed(3),
    a.meanPoints.toFixed(1),
    pct(a.callRate),
    pct(a.earlyShare),
  ]);
  return { header, rows };
}

// ── seeds ──────────────────────────────────────────────────────────────────

const SEED_ADJECTIVES = ['amber', 'brassy', 'crooked', 'drowsy', 'gilded', 'hollow', 'mossy', 'rusty', 'salty', 'smoky', 'sodden', 'tarnished', 'thorny', 'wobbly'];
const SEED_NOUNS = ['ale', 'anvil', 'barrel', 'candle', 'flagon', 'goblet', 'hearth', 'kettle', 'lantern', 'mug', 'stool', 'tankard', 'trencher', 'wick'];

/** "mossy-flagon-37": two words and a number from `rand` (any [0, 1) source). Never contains "/". */
export function seedWords(rand: () => number): string {
  const pick = <T>(list: ReadonlyArray<T>): T => list[Math.floor(rand() * list.length)]!;
  return `${pick(SEED_ADJECTIVES)}-${pick(SEED_NOUNS)}-${Math.floor(rand() * 100)}`;
}

// ── your tavern ────────────────────────────────────────────────────────────

/** The banners a player can fly: the six from the old gods, named for their colours. Each has its own texture. */
export const BANNER_CHOICES: ReadonlyArray<{ readonly id: string; readonly label: string; readonly banner: Banner }> = [
  { id: 'moss', label: 'Moss and peat', banner: { field: '#d9e0b8', charge: '#e8dcc4', mark: '#008300', texture: 'stipple' } },
  { id: 'ember', label: 'Slate and ember', banner: { field: '#dde1e6', charge: '#f7cfae', mark: '#eb6834', texture: 'crosshatch' } },
  { id: 'sea', label: 'Sea-glass and pearl', banner: { field: '#cdeae2', charge: '#f4efe2', mark: '#1baf7a', texture: 'waves' } },
  { id: 'dusk', label: 'Dusk and candle', banner: { field: '#e0dbf2', charge: '#f8e2a6', mark: '#4a3aa7', texture: 'rays' } },
  { id: 'storm', label: 'Sky and lightning', banner: { field: '#d4e6f7', charge: '#f5e9a8', mark: '#2a78d6', texture: 'rain' } },
  { id: 'rose', label: 'Sage and rose', banner: { field: '#dfe8d0', charge: '#f4cfd8', mark: '#e87ba4', texture: 'thorns' } },
];

/** The longest word a tavern name takes, and a keeper's name. */
export const TAVERN_WORD_MAX = 14;
export const KEEPER_NAME_MAX = 24;

/**
 * One word of a tavern name, tidied: trimmed, first letter capitalised. Null
 * unless it is a single word of letters, with at most an inner apostrophe or
 * hyphen ("Hog's", "Half-Drunk"), at most `TAVERN_WORD_MAX` long.
 */
export function tavernWord(raw: string): string | null {
  const w = raw.trim();
  if (w.length === 0 || w.length > TAVERN_WORD_MAX || !/^\p{L}+(?:['\u2019-]\p{L}+)*$/u.test(w)) return null;
  return w.charAt(0).toLocaleUpperCase() + w.slice(1);
}

/** "The Salty Anvil" → "the-salty-anvil". Letters outside a–z are dropped (accents first lose their marks). */
export function tavernId(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** A suggested adjective and noun for a tavern name, from `rand` (any [0, 1) source). */
export function tavernWords(rand: () => number): { readonly adjective: string; readonly noun: string } {
  const pick = (list: ReadonlyArray<string>): string => tavernWord(list[Math.floor(rand() * list.length)]!)!;
  return { adjective: pick(SEED_ADJECTIVES), noun: pick(SEED_NOUNS) };
}

/**
 * The season's taverns that sit at the table beside yours: none flying your
 * banner's mark, and one fewer than the seats, so every tavern at the table
 * looks different and none goes unchosen. When more than enough remain,
 * `rand` picks which sit the season out.
 */
export function rivalTaverns<T>(taverns: ReadonlyArray<T>, markOf: (t: T) => string | undefined, mark: string, seats: number, rand: () => number): ReadonlyArray<T> {
  const rivals = taverns.filter((t) => markOf(t) !== mark);
  while (rivals.length > seats - 1) rivals.splice(Math.floor(rand() * rivals.length), 1);
  return rivals;
}

/** Who you are at the table: your name, your tavern's two words ("The <adjective> <noun>") and its banner, a `BANNER_CHOICES` id. */
export interface Profile {
  readonly name: string;
  readonly adjective: string;
  readonly noun: string;
  readonly banner: string;
}

/** Your tavern's name and id. */
export function tavernOf(p: Pick<Profile, 'adjective' | 'noun'>): { readonly id: string; readonly name: string } {
  const name = `The ${p.adjective} ${p.noun}`;
  return { id: tavernId(name), name };
}

/** A profile tidied, or why it can't be used. `rivals` are the season's own taverns, whose names are taken. */
export function checkProfile(form: Profile, rivals: ReadonlyArray<{ readonly id: string; readonly name: string }>): { readonly profile?: Profile; readonly error?: string } {
  const name = form.name.trim().replace(/\s+/g, ' ');
  if (name.length === 0) return { error: 'Tell the room your name.' };
  if (name.length > KEEPER_NAME_MAX) return { error: `Your name is ${name.length} characters; the ledger takes ${KEEPER_NAME_MAX}.` };
  const adjective = tavernWord(form.adjective);
  const noun = tavernWord(form.noun);
  if (adjective === null || noun === null) {
    return { error: `Your tavern is "The", then an adjective, then a noun: one word each, letters only, up to ${TAVERN_WORD_MAX} long.` };
  }
  const tavern = tavernOf({ adjective, noun });
  if (tavern.id === '' || tavern.id === 'the') return { error: "Your tavern's name needs letters a to z the ledger can file it under." };
  if (rivals.some((t) => t.id === tavern.id || t.name.toLowerCase() === tavern.name.toLowerCase())) return { error: `${tavern.name} is a rival's tavern. Name yours something else.` };
  if (!BANNER_CHOICES.some((b) => b.id === form.banner)) return { error: 'Choose a banner to fly.' };
  return { profile: { name, adjective, noun, banner: form.banner } };
}

// ── tables ─────────────────────────────────────────────────────────────────

/**
 * How each tavern moved in a table since the one before it: the row it was in
 * (0-based) and the places it rose (negative when it fell). A tavern missing
 * from `before` is taken to have stood still where it is now.
 */
export function tableMoves(
  before: ReadonlyArray<{ readonly tavern: string; readonly rank: number }>,
  after: ReadonlyArray<{ readonly tavern: string; readonly rank: number }>,
): ReadonlyMap<string, { readonly wasRow: number; readonly rose: number }> {
  const was = new Map(before.map((r, i) => [r.tavern, { row: i, rank: r.rank }]));
  return new Map(
    after.map((r, i) => {
      const w = was.get(r.tavern);
      return [r.tavern, w === undefined ? { wasRow: i, rose: 0 } : { wasRow: w.row, rose: w.rank - r.rank }];
    }),
  );
}

// ── banners ────────────────────────────────────────────────────────────────

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEX = /^#[0-9a-f]{6}$/;

/** The taverns that get a banner: those whose id, colours and texture name are well formed. */
export function banneredTaverns(taverns: Readonly<Record<string, TavernChrome>>): ReadonlySet<string> {
  return new Set(
    Object.entries(taverns)
      .filter(([id, { banner: b }]) => KEBAB.test(id) && HEX.test(b.field) && HEX.test(b.charge) && HEX.test(b.mark) && KEBAB.test(b.texture))
      .map(([id]) => id),
  );
}

/**
 * The banner stylesheet: per tavern, its mark as `--mark-<tavern>` on :root
 * and, on `[data-banner="<tavern>"]`, its colours and texture as custom
 * properties. page.html § Banners turns those into every banner surface.
 */
export function bannerCss(taverns: Readonly<Record<string, TavernChrome>>): string {
  return [...banneredTaverns(taverns)]
    .map((id) => {
      const b = taverns[id]!.banner;
      return `:root{--mark-${id}:${b.mark}}\n[data-banner="${id}"]{--banner-field:${b.field};--banner-charge:${b.charge};--banner-mark:${b.mark};--banner-pattern:var(--tex-${b.texture})}`;
    })
    .join('\n');
}

// ── card art ───────────────────────────────────────────────────────────────

const PNG_URI = /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * The card art stylesheet: per character with a face crop, its face and its
 * thumbnail as `--art-face` and `--art-thumb` on `[data-art="<id>"]`. Kept out
 * of the card markup, which the page rebuilds on every move, so each image is
 * parsed once. Ids and images that aren't well formed are skipped.
 */
export function artCss(chrome: Readonly<Record<string, { readonly face?: string; readonly portrait?: string }>>): string {
  return Object.entries(chrome)
    .filter(([id, c]) => KEBAB.test(id) && c.face !== undefined && PNG_URI.test(c.face) && (c.portrait === undefined || PNG_URI.test(c.portrait)))
    .map(([id, c]) => `[data-art="${id}"]{--art-face:url("${c.face}")${c.portrait === undefined ? '' : `;--art-thumb:url("${c.portrait}")`}}`)
    .join('\n');
}
