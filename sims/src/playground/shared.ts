/**
 * What the game and the workshop share: the season data, the character and
 * banner chrome, the character card, and the small HTML helpers. Imports the
 * inlined season (`__PLAYGROUND_DATA__`) once and adds the banner and
 * card-art stylesheets to the page.
 */
import type { Ability, CrEighths, VotingStrategy } from '@league-of-taverns/engine';
import { seasonInputFromData, type ChallengeChrome, type PlaygroundChrome, type PlaygroundData, type TavernChrome } from './data';
import { abilityLine, artCss, bannerCss, banneredTaverns, formatCr, signed, strategyLine, strategyName, tagLabel } from './view';

declare const __PLAYGROUND_DATA__: PlaygroundData;

// ── season data ────────────────────────────────────────────────────────────

export const data = __PLAYGROUND_DATA__;
export const input = seasonInputFromData(data);
export const { config } = input;
/** Votes in the season: one per episode. */
export const VOTES = config.contest.castSize - config.contest.finalists;
export const crById = new Map(input.pool.map((p) => [p.character.ref.id, p.cr]));
export const crOf = (id: string): CrEighths => {
  const cr = crById.get(id);
  if (cr === undefined) throw new Error(`"${id}" is not pooled`);
  return cr;
};
export const tavernById = new Map<string, { readonly id: string; readonly name: string }>(input.taverns.map((t) => [t.id, t]));
export const tavernName = (id: string): string => tavernById.get(id)?.name ?? id;
/** Each tavern's chrome: the season's, plus the player's own tavern once there is one (`setPlayerTavern`). */
export const tavernChrome: Record<string, TavernChrome> = { ...data.tavernChrome };

/** A challenge's chrome, or a plain stand-in from its id. */
export function challengeChrome(episode: number): ChallengeChrome {
  const c = data.challengeChrome[episode];
  if (c !== undefined) return c;
  const id = input.challenges[episode - 1]?.challenge.id ?? `episode-${episode}`;
  return { title: id.replaceAll('-', ' '), story: '', lines: [] };
}

// Banners: each tavern flies its own colours (taverns.yaml). One generated rule per tavern sets its colours as custom
// properties; page.html § Banners does the rest.
export const BANNERED = new Set(banneredTaverns(data.tavernChrome));
const bannerStyle = document.createElement('style');
bannerStyle.textContent = bannerCss(data.tavernChrome);
document.head.append(bannerStyle);
const playerBannerStyle = document.createElement('style');
document.head.append(playerBannerStyle);
let playerTavern: string | null = null;

/** Name the player's own tavern and fly its banner, replacing any earlier one. It must not reuse a season tavern's id. */
export function setPlayerTavern(tavern: { readonly id: string; readonly name: string }, chrome: TavernChrome): void {
  if (input.taverns.some((t) => t.id === tavern.id)) throw new Error(`"${tavern.name}" is a rival's tavern`);
  if (playerTavern !== null) {
    tavernById.delete(playerTavern);
    delete tavernChrome[playerTavern];
    BANNERED.delete(playerTavern);
  }
  playerTavern = tavern.id;
  tavernById.set(tavern.id, tavern);
  tavernChrome[tavern.id] = chrome;
  for (const id of banneredTaverns({ [tavern.id]: chrome })) BANNERED.add(id);
  playerBannerStyle.textContent = bannerCss({ [tavern.id]: chrome });
}
// Card art: each character's face crop and thumbnail as custom properties, once, out of the card markup.
const artStyle = document.createElement('style');
artStyle.textContent = artCss(data.chrome);
document.head.append(artStyle);
/** The tavern's id when it has a banner, else null. */
export const bannerOf = (tavern: string): string | null => (BANNERED.has(tavern) ? tavern : null);
/** ` data-banner="<tavern>"` for a tavern with a banner, else nothing. */
export const bannerAttr = (tavern: string): string => (bannerOf(tavern) === null ? '' : ` data-banner="${esc(tavern)}"`);
/** A tavern's flag, in its own colours wherever it sits. Nothing for a tavern without a banner. */
export const flagOf = (tavern: string): string => (bannerOf(tavern) === null ? '' : `<i class="flag"${bannerAttr(tavern)} aria-hidden="true"></i>`);

export const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is missing`);
  return el as T;
};

// ── small helpers ──────────────────────────────────────────────────────────

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export const num = (v: string | number, cls = ''): string => `<span class="num ${cls}">${esc(v)}</span>`;

export function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage is a convenience only */
  }
}
export function storageRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* storage is a convenience only */
  }
}

/** A fresh random seed from the page's crypto, outside the engine. */
export function cryptoSeed(prefix: string): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
export function cryptoRand(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0]! / 2 ** 32;
}


// ── character chrome ───────────────────────────────────────────────────────

export const chromeOf = (id: string): PlaygroundChrome | undefined => data.chrome[id];
/** The chrome name, or the id when the season has no chrome for the character. */
export const charName = (id: string): string => chromeOf(id)?.name ?? id;

/** Name in bold, then the epithet, muted. */
export function charTitle(id: string): string {
  const epithet = chromeOf(id)?.epithet;
  return `<b>${esc(charName(id))}</b>${epithet === undefined ? '' : ` <span class="muted">${esc(epithet)}</span>`}`;
}

/** The portrait in a square frame (sm 28 px, md 44, lg 80), feet on the frame's floor; the name's initial when there is none. */
export function portrait(id: string, size: 'sm' | 'md' | 'lg'): string {
  const src = chromeOf(id)?.portrait;
  return src === undefined
    ? `<span class="pt ${size} none" aria-hidden="true">${esc(charName(id).charAt(0).toUpperCase())}</span>`
    : `<img class="pt ${size}" src="${esc(src)}" alt="" title="${esc(charName(id))}">`;
}

/** Portrait, name and base on one line, for lists. */
export function charLabel(id: string): string {
  const s = input.statsOf(id);
  return `<span class="face">${portrait(id, 'sm')}<span>${charTitle(id)} <span class="muted small">${esc(s.base.typeName)} · CR ${formatCr(crOf(id))}</span></span></span>`;
}

/** Portrait and name, compact, for inline mentions. */
export function charChip(id: string): string {
  return `<span class="face">${portrait(id, 'sm')}<span>${esc(charName(id))}</span></span>`;
}

/** Several characters as chips that wrap. */
export function charList(ids: ReadonlyArray<string>): string {
  return `<span class="faces">${ids.map(charChip).join('')}</span>`;
}

/** A draft board cell's contents: pick number, portrait and name. */
export function draftPick(pick: number, id: string): string {
  return `<span class="face">${portrait(id, 'sm')}<span><span class="pk">#${pick + 1}</span> <span class="ch">${esc(charName(id))}</span></span></span>`;
}

/**
 * Each tavern's series colour: its banner mark, lightened in the dark theme as banner lines are, so a tavern is
 * the same colour in every table and chart. A tavern without a banner falls back to `--s1`…`--s8` by package order.
 * Never follows rank.
 */
export function seriesVar(tavern: string): string {
  if (bannerOf(tavern) !== null) return `oklch(from var(--mark-${tavern}) clamp(var(--bn-line-lo), l, 1) c h)`;
  const i = input.taverns.findIndex((t) => t.id === tavern);
  return `var(--s${(i < 0 ? 0 : i % 8) + 1})`;
}

export function swatch(tavern: string): string {
  return `<i class="swatch" style="background:${seriesVar(tavern)}"></i>`;
}

/** A head-and-shoulders outline: the card's art until the character has a portrait. */
export const SILHOUETTE =
  '<svg class="silhouette" viewBox="0 0 100 80" aria-hidden="true"><circle cx="50" cy="30" r="17"/><path d="M14 80c2-20 17-30 36-30s34 10 36 30z"/></svg>';

/** A strategy as a short badge: its name, and the tag a loyal monster protects. */
export function strategyBadge(strategy: VotingStrategy): string {
  return `<span class="strat ${strategy.kind}" title="${esc(strategyName(strategy))}: ${esc(strategyLine(strategy, input.model.betrayAt))}">${esc(strategyName(strategy))}${strategy.kind === 'loyal' ? ` <b>${esc(tagLabel(strategy.tag))}</b>` : ''}</span>`;
}

/**
 * A character card: name, epithet and CR across the top, the art (the
 * portrait's face crop over a blurred copy of it, or a silhouette), the
 * monster line, the six ability modifiers, challenge power and moves, and
 * its voting strategy in words. Neutral until a tavern owns the character;
 * then it wears that tavern's banner. `foot` is the card's action or note;
 * `dim` greys out a monster who is out of the contest; `mark` adds a ribbon
 * across the art ("immune", "out").
 */
export function charCard(
  id: string,
  { owner = null, foot = '', dim = false, mark = '' }: { owner?: string | null; foot?: string; dim?: boolean; mark?: string } = {},
): string {
  const card = input.cardOf(id);
  const st = card.stats;
  const themed = owner !== null && bannerOf(owner) !== null;
  const speeds = Object.entries(st.speeds).filter(([k]) => k !== 'walk');
  const senses = Object.entries(st.senses).map(([k]) => k);
  const moves = [...speeds.map(([k]) => k), ...senses].join(' · ');
  const size = st.base.size.charAt(0).toUpperCase() + st.base.size.slice(1);
  const epithet = chromeOf(id)?.epithet;
  const face = chromeOf(id)?.face !== undefined;
  const abilities = abilityLine(st)
    .map(([a, m]) => `<span class="${m >= 3 ? 'hi' : m <= -1 ? 'lo' : ''}"><i>${a}</i>${signed(m)}</span>`)
    .join('');
  return (
    `<article class="lcard ${themed ? 'themed' : 'neutral'}${dim ? ' dim' : ''}" data-card="${esc(id)}"${themed ? bannerAttr(owner) : ''}>` +
    `<header><div class="who"><b>${esc(charName(id))}</b>${epithet === undefined ? '' : `<span>${esc(epithet)}</span>`}</div><span class="cr" title="Challenge rating">${formatCr(crOf(id))}</span></header>` +
    (face
      ? `<div class="art has-face" data-art="${esc(id)}"><span class="face" role="img" aria-label="${esc(charName(id))}"></span>${mark}</div>`
      : `<div class="art">${SILHOUETTE}${mark}</div>`) +
    `<div class="typeline"><b>${esc(st.base.typeName)}</b><span class="sizeword">${esc(size)} ${esc(st.base.creatureType)}${st.base.alignment === '' ? '' : `, ${esc(st.base.alignment)}`}</span></div>` +
    `<div class="abil" title="Ability modifiers">${abilities}</div>` +
    `<div class="stats"><span title="Challenge power: the mean modifier over every skill and save">power <b>${card.power >= 0 ? '+' : ''}${card.power.toFixed(1)}</b></span>${moves === '' ? '' : `<span title="Speeds and senses">${esc(moves)}</span>`}</div>` +
    `<div class="vote-line">${strategyBadge(card.strategy)}<span>${esc(strategyLine(card.strategy, input.model.betrayAt))}</span></div>` +
    (foot === '' ? '' : `<div class="card-foot">${foot}</div>`) +
    `</article>`
  );
}

export function matchesFilter(id: string, q: string): boolean {
  if (q === '') return true;
  const card = input.cardOf(id);
  const s = card.stats;
  const c = chromeOf(id);
  const named = c !== undefined && `${c.name} ${c.epithet ?? ''}`.toLowerCase().includes(q);
  const strategy = `${card.strategy.kind} ${card.strategy.kind === 'loyal' ? card.strategy.tag : ''}`;
  return named || id.includes(q) || s.base.slug.includes(q) || s.base.typeName.toLowerCase().includes(q) || card.tags.some((t) => t.includes(q)) || strategy.includes(q);
}

export function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${tail}`;
}

export const ABILITY_NAMES: Readonly<Record<Ability, string>> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
