/**
 * What the game and the workshop share: the season data, the character and
 * banner chrome, the character card, the mission graph and the roll log, and
 * the small HTML helpers. Imports the inlined season (`__PLAYGROUND_DATA__`)
 * once and adds the banner and card-art stylesheets to the page.
 */
import { projectMission, projectedPoints, runPoints } from '@league-of-taverns/engine';
import type { Ability, CrEighths, Mission, NodeRecord, Party, RetreatOrder, RunResult } from '@league-of-taverns/engine';
import { seasonInputFromData, type PlaygroundChrome, type PlaygroundData } from './data';
import {
  artCss,
  bannerCss,
  bannerGods,
  checkLabel,
  formatCr,
  formatCrTotal,
  layoutMission,
  pct,
  retreatChoices,
  retreatLabel,
  retreatValue,
  scoreFraction,
  signed,
  topSkills,
  type GraphLayout,
} from './view';

declare const __PLAYGROUND_DATA__: PlaygroundData;

// ── season data ────────────────────────────────────────────────────────────

export const data = __PLAYGROUND_DATA__;
export const input = seasonInputFromData(data);
export const { config } = input;
export const SCALE = config.scoring.pointsScale;
export const BUDGET = config.budget.partyCr;
export const WEEKS = [...input.missions.keys()].sort((a, b) => a - b);
export const poolIds = input.pool.map((p) => p.character.ref.id);
export const crById = new Map(input.pool.map((p) => [p.character.ref.id, p.cr]));
export const crOf = (id: string): CrEighths => {
  const cr = crById.get(id);
  if (cr === undefined) throw new Error(`"${id}" is not pooled`);
  return cr;
};
/** A character's display name (chrome, carried by the build for the page only), else its id. */
export const tavernById = new Map(input.taverns.map((t) => [t.id, t]));
export const tavernName = (id: string): string => tavernById.get(id)?.name ?? id;

export const layouts = new Map<number, GraphLayout>(WEEKS.map((w) => [w, layoutMission(missionOf(w))]));

// Banners: each tavern fights under its god's colours (chrome from gods/<id>/god.yaml). One generated rule per god sets
// its colours as custom properties; page.html § Banners does the rest.
export const godOf = new Map(input.sponsors.map((s) => [s.tavern, s.id]));
export const BANNERED = bannerGods(data.gods);
const bannerStyle = document.createElement('style');
bannerStyle.textContent = bannerCss(data.gods);
document.head.append(bannerStyle);
// Card art: each character's face crop and thumbnail as custom properties, once, out of the card markup.
const artStyle = document.createElement('style');
artStyle.textContent = artCss(data.chrome);
document.head.append(artStyle);
/** The god whose banner a tavern fights under, if its god has one. */
export const bannerOf = (tavern: string): string | null => {
  const god = godOf.get(tavern);
  return god !== undefined && BANNERED.has(god) ? god : null;
};
/** ` data-banner="<god>"` for a tavern with a banner, else nothing. */
export const bannerAttr = (tavern: string): string => {
  const god = bannerOf(tavern);
  return god === null ? '' : ` data-banner="${esc(god)}"`;
};
/** A god's display name (chrome), else its id. */
export const godName = (god: string): string => data.gods[god]?.name ?? god;

export function missionOf(week: number): Mission {
  const m = input.missions.get(week);
  if (m === undefined) throw new Error(`no mission for week ${week}`);
  return m.mission;
}
export function environmentOf(week: number): string {
  return input.schedule.find((s) => s.week === week)?.environment ?? '';
}

/** The week's public keywords (D-42) as a line, or nothing when the GM listed none. */
export function keywordsLine(week: number): string {
  const keywords = input.schedule.find((s) => s.week === week)?.keywords ?? [];
  return keywords.length === 0 ? '' : `<p class="small"><span class="label">Tests</span> ${keywords.map((k) => `<span class="tag">${esc(k)}</span>`).join(' ')}</p>`;
}

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

// ── mission graph ──────────────────────────────────────────────────────────

export interface Overlay {
  readonly path?: ReadonlyArray<string>;
  readonly reach?: Readonly<Record<string, number>>;
  readonly outcomes?: ReadonlyMap<string, string>;
}

export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function graphSvg(layout: GraphLayout, overlay: Overlay = {}): string {
  const onPath = new Set(overlay.path ?? []);
  const pathEdges = new Set<string>();
  const path = overlay.path ?? [];
  for (let i = 1; i < path.length; i++) pathEdges.add(`${path[i - 1]}>${path[i]}`);
  const lost = path.length > 0 && overlay.outcomes?.get(path[path.length - 1]!) === 'lose' ? path[path.length - 1] : undefined;

  const edges = layout.edges
    .map((e) => {
      const on = pathEdges.has(`${e.from}>${e.to}`) ? ' on' : '';
      return `<path class="edge${on}" data-edge="${esc(`${e.from}>${e.to}`)}" d="${e.d}"/>`;
    })
    .join('');
  const labels = layout.edges
    .filter((e) => e.on !== 'always')
    .map((e) => {
      const on = pathEdges.has(`${e.from}>${e.to}`) ? ' on' : '';
      return `<text class="elabel${on}" data-edge="${esc(`${e.from}>${e.to}`)}" x="${e.lx}" y="${e.ly + 3}" text-anchor="middle">${esc(e.on)}</text>`;
    })
    .join('');
  const nodes = layout.nodes
    .map((n) => {
      const cls = [n.kind, onPath.has(n.id) ? 'on' : '', n.id === lost ? 'lost' : ''].filter(Boolean).join(' ');
      const reach = overlay.reach?.[n.id];
      const outcome = overlay.outcomes?.get(n.id);
      const reachText = reach === undefined ? '' : `<text class="reach" x="${n.x + n.w - 6}" y="${n.y + 14}" text-anchor="end">${reach >= 0.9995 ? '100' : (100 * reach).toFixed(reach < 0.1 ? 1 : 0)}%</text>`;
      const outText = outcome === undefined ? '' : `<text class="out ${outcome}" x="${n.x + n.w - 6}" y="${n.y + n.h - 7}" text-anchor="end">${esc(outcome)}</text>`;
      const rx = n.kind === 'start' || n.kind === 'end' ? 18 : 3;
      return (
        `<g class="node ${cls}" data-node="${esc(n.id)}"><title>${esc(n.id)}: ${esc(n.detail)}${reach === undefined ? '' : ` (reach ${pct(reach)})`}</title>` +
        `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="${rx}"/>` +
        `<text class="id" x="${n.x + 8}" y="${n.y + 18}">${esc(clip(n.id, reach === undefined ? 19 : 14))}</text>` +
        `<text class="detail" x="${n.x + 8}" y="${n.y + 35}">${esc(clip(n.detail, outcome === undefined ? 24 : 18))}</text>` +
        reachText +
        outText +
        `</g>`
      );
    })
    .join('');
  return (
    // Fit the card's width, shrinking to at most 80% before the frame scrolls, so the end nodes usually stay in view.
    `<div class="graph"><svg width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}" style="width:100%;max-width:${layout.width}px;min-width:${Math.round(0.8 * layout.width)}px" role="img" aria-label="Mission graph">` +
    `${edges}${labels}${nodes}</svg></div>`
  );
}

export function graphLegend(overlay: Overlay): string {
  const parts = ['columns are ranks; dashed boxes are battles'];
  if (overlay.path !== undefined) parts.unshift('<span><i></i>path taken</span>');
  if (overlay.reach !== undefined) parts.push('% = projected chance to reach the node');
  return `<div class="legend">${parts.map((p) => `<span>${p}</span>`).join('')}</div>`;
}

// ── roll log ───────────────────────────────────────────────────────────────

export function rollLog(mission: Mission, run: RunResult, home = false): string {
  const byId = new Map(mission.nodes.map((n) => [n.id, n]));
  const rows = run.nodes.map((r: NodeRecord, i) => {
    const node = byId.get(r.node);
    if (r.kind === 'check') {
      const total = r.d20 + r.modifier;
      const meets = total >= r.dc;
      // A gated check nobody qualifies for fails whatever the die says (D-39).
      const gated = node?.kind === 'check' && node.check.requires !== undefined && meets && r.outcome === 'fail';
      const what = node?.kind === 'check' ? checkLabel(node.check) : '';
      return (
        `<tr><td class="n">${i + 1}</td><td>${esc(r.node)}<div class="muted small">${esc(what)}</div></td><td>${charChip(r.actor)}</td>` +
        `<td><span class="die ${r.d20 === 20 ? 'hi' : r.d20 === 1 ? 'lo' : ''}">${r.d20}</span>${r.advantage ? ' <span class="tag brass">adv</span>' : ''}${r.disadvantage ? ' <span class="tag bad" title="Hexed: the lower of two d20s">dis</span>' : ''}</td>` +
        `<td class="sum">${signed(r.modifier)} = <b>${total}</b> ${meets ? '≥' : '<'} DC ${r.dc}</td>` +
        `<td class="${r.outcome}">${r.outcome}${gated ? ' <span class="tag bad">gate</span>' : ''}</td></tr>`
      );
    }
    const what = node?.kind === 'battle' ? node.encounter.creatures.map((c) => `${c.count}× ${c.ref}`).join(', ') : '';
    const won = r.roll < r.pWin;
    const bounty = node?.kind === 'battle' && won && (node.loot ?? 0) > 0 ? ` <span class="tag brass">+${node.loot} loot</span>` : '';
    return (
      `<tr><td class="n">${i + 1}</td><td>${esc(r.node)}<div class="muted small">${esc(what)}</div></td><td class="muted">party</td>` +
      `<td><span class="die">${r.roll.toFixed(3)}</span></td>` +
      `<td class="sum">roll ${won ? '<' : '≥'} win chance ${r.pWin.toFixed(3)}</td><td class="${r.outcome === 'win' ? 'pass' : 'fail'}">${r.outcome}${bounty}</td></tr>`
    );
  });
  if (run.injury !== null) {
    rows.push(
      `<tr><td class="n">${rows.length + 1}</td><td>injury</td><td>${esc(charName(run.injury.character))}</td><td><span class="die">${run.injury.roll.toFixed(3)}</span></td>` +
        `<td class="sum">the roll picks one of the four starters</td><td class="fail">hurt: sits out next week</td></tr>`,
    );
  }
  if (run.retreatedBefore !== null) {
    rows.push(
      `<tr><td class="n">${rows.length + 1}</td><td>${esc(run.retreatedBefore)}</td><td class="muted">party</td><td></td>` +
        `<td class="sum">the retreat order says turn back with ${run.loot} loot banked</td><td class="muted">turned back</td></tr>`,
    );
  }
  const checks = `${run.checksPassed} of ${run.checksAttempted} checks passed`;
  const score = run.dnf
    ? `DNF after ${checks}: everything banked is lost, score ${scoreFraction(run.score)}`
    : run.retreatedBefore !== null
      ? `Turned back before ${run.retreatedBefore} after ${checks}, keeping ${run.loot} loot: score ${scoreFraction(run.score)}`
      : `${checks}: score ${scoreFraction(run.score)}`;
  return (
    `<div class="scroll"><table><thead><tr><th class="n">#</th><th>node</th><th>actor</th><th>die</th><th>sum</th><th>outcome</th></tr></thead>` +
    `<tbody>${rows.join('') || '<tr><td colspan="6" class="muted">No checks or battles.</td></tr>'}</tbody></table></div>` +
    `<p class="small"><b>${esc(score)}</b> → ${num(Math.round(run.score * SCALE))} points` +
    (home ? ` × ${config.scoring.homeBonus} home bonus = <b>${num(runPoints(run.score, config.scoring, true))}</b> points` : '') +
    `</p>` +
    `<p class="hint">Checks pass when d20 + modifier ≥ DC (no natural-20 rule; with advantage the higher of two d20s is shown). Battles are won when the roll is below the party's win chance, and a win banks the battle's bounty. Just before a battle, the retreat order may turn the party back with what it has: not a DNF.</p>`
  );
}

export function outcomesOf(run: RunResult): Map<string, string> {
  return new Map(run.nodes.map((n) => [n.node, n.outcome]));
}

/**
 * Each tavern's series colour: its god's banner mark, lightened in the dark theme as banner lines are, so a tavern is
 * the same colour in every table and chart. A tavern without a banner falls back to `--s1`…`--s8` by package order.
 * Never follows rank.
 */
export function seriesVar(tavern: string): string {
  const god = bannerOf(tavern);
  if (god !== null) return `oklch(from var(--mark-${god}) clamp(var(--bn-line-lo), l, 1) c h)`;
  const i = input.taverns.findIndex((t) => t.id === tavern);
  return `var(--s${(i < 0 ? 0 : i % 8) + 1})`;
}

export function swatch(tavern: string): string {
  return `<i class="swatch" style="background:${seriesVar(tavern)}"></i>`;
}

/** Lineup violations in words; the engine's code stays as a tooltip. */
export function violationList(violations: ReadonlyArray<{ readonly code: string; readonly message: string }>): string {
  return `<ul class="violations">${violations.map((v) => `<li title="${esc(v.code)}">${esc(v.message)}</li>`).join('')}</ul>`;
}

export function crMeter(total: number): string {
  const over = total > BUDGET;
  return `<div class="meter ${over ? 'over' : ''}" title="CR ${formatCrTotal(total)} of ${formatCrTotal(BUDGET)}"><div style="width:${Math.min(100, (100 * total) / BUDGET).toFixed(1)}%"></div></div>`;
}

/**
 * Expected points, chance of DNF and chance of turning back for every retreat
 * order on offer, the current one marked: the projection informs the choice
 * without making it (D-49).
 */
export function retreatTable(party: Party, mission: Mission, current: RetreatOrder, home: boolean): string {
  const rows = retreatChoices(config.missions.haul).map((order) => {
    const p = projectMission(party, mission, input.baseOf, input.battleModel, { retreat: order });
    const on = retreatValue(order) === retreatValue(current);
    return (
      `<tr class="${on ? 'sel' : ''}"><td>${esc(retreatLabel(order))}${on ? ' <span class="tag">yours</span>' : ''}</td>` +
      `<td class="n">${projectedPoints(p.expectedScore, config.scoring, home).toFixed(1)}</td><td class="n">${pct(p.pDnf)}</td><td class="n">${pct(p.pRetreat)}</td></tr>`
    );
  });
  return (
    `<details><summary>Expected points by retreat order</summary><div class="scroll"><table class="small"><thead><tr><th>retreat order</th><th class="n">exp. pts</th><th class="n">DNF</th><th class="n">turn back</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` +
    `<p class="hint">The highest expected points is not always the right call: a tavern that is behind may need the big fight.</p></details>`
  );
}

/** A `<select>` of retreat orders (D-49). */
export function retreatSelect(id: string, action: string, retreat: RetreatOrder): string {
  const current = retreatValue(retreat);
  const options = retreatChoices(config.missions.haul)
    .map((r) => `<option value="${esc(retreatValue(r))}" ${retreatValue(r) === current ? 'selected' : ''}>${esc(retreatLabel(r))}</option>`)
    .join('');
  return `<label class="label" for="${id}">Retreat order</label><select id="${id}" data-action="${action}" title="Checked just before each battle: turn back with the loot banked instead of fighting. Turning back is not a DNF.">${options}</select>`;
}

export function charRow(id: string, action: string, extra = ''): string {
  const s = input.statsOf(id);
  const moves = Object.entries(s.speeds)
    .filter(([k]) => k !== 'walk')
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return (
    `<tr><td>${action}</td><td class="pt-cell">${portrait(id, 'md')}</td><td>${charTitle(id)}<div class="muted small">${esc(s.base.typeName)}</div></td><td class="n">${formatCr(crOf(id))}</td>` +
    `<td class="small skills">${topSkills(s)
      .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
      .join(', ')}</td><td class="small muted">${esc(moves || '-')}</td><td class="n small">${s.base.ac} / ${s.base.hp}</td>${extra}</tr>`
  );
}
export const CHAR_HEAD = '<th></th><th></th><th>character</th><th class="n">CR</th><th>best skills</th><th>moves</th><th class="n">AC / HP</th>';

/** A head-and-shoulders outline: the card's art until the character has a portrait. */
export const SILHOUETTE =
  '<svg class="silhouette" viewBox="0 0 100 80" aria-hidden="true"><circle cx="50" cy="30" r="17"/><path d="M14 80c2-20 17-30 36-30s34 10 36 30z"/></svg>';

/**
 * A character card: name, epithet and CR across the top, the art (the portrait's face crop over a blurred copy of the
 * portrait, or a silhouette for a character without one), the monster
 * line with its size in words ("Ape · Medium beast"), AC, HP and speed, and the best skills. Neutral until a tavern
 * owns the character; then it wears that tavern's banner. `foot` is the card's action or note; `dim` greys out a
 * character who can't play (injured).
 */
export function charCard(
  id: string,
  { owner = null, foot = '', dim = false }: { owner?: string | null; foot?: string; dim?: boolean } = {},
): string {
  const st = input.statsOf(id);
  const themed = owner !== null && bannerOf(owner) !== null;
  const speeds = Object.entries(st.speeds).filter(([k]) => k !== 'walk');
  const speed = speeds.length > 0 ? speeds.map(([k, v]) => `${k} ${v}`).join(' · ') : `walk ${st.speeds.walk ?? 0}`;
  const size = st.base.size.charAt(0).toUpperCase() + st.base.size.slice(1);
  const epithet = chromeOf(id)?.epithet;
  const face = chromeOf(id)?.face !== undefined;
  return (
    `<article class="lcard ${themed ? 'themed' : 'neutral'}${dim ? ' dim' : ''}" data-card="${esc(id)}"${themed ? bannerAttr(owner) : ''}>` +
    `<header><div class="who"><b>${esc(charName(id))}</b>${epithet === undefined ? '' : `<span>${esc(epithet)}</span>`}</div><span class="cr" title="Challenge rating">${formatCr(crOf(id))}</span></header>` +
    (face
      ? `<div class="art has-face" data-art="${esc(id)}"><span class="face" role="img" aria-label="${esc(charName(id))}"></span></div>`
      : `<div class="art">${SILHOUETTE}</div>`) +
    `<div class="typeline"><b>${esc(st.base.typeName)}</b><span class="sizeword">${esc(size)} ${esc(st.base.creatureType)}</span></div>` +
    `<div class="stats"><span>AC <b>${st.base.ac}</b></span><span>HP <b>${st.base.hp}</b></span><span>${esc(speed)}</span></div>` +
    `<div class="skills">${topSkills(st, 2)
      .map((t) => `${esc(t.skill.replaceAll('_', ' '))} ${signed(t.modifier)}`)
      .join(' · ')}</div>` +
    (foot === '' ? '' : `<div class="card-foot">${foot}</div>`) +
    `</article>`
  );
}

export function matchesFilter(id: string, q: string): boolean {
  if (q === '') return true;
  const s = input.statsOf(id);
  const c = chromeOf(id);
  const named = c !== undefined && `${c.name} ${c.epithet ?? ''}`.toLowerCase().includes(q);
  return named || id.includes(q) || s.base.slug.includes(q) || s.base.typeName.toLowerCase().includes(q) || topSkills(s).some((t) => t.skill.includes(q));
}

export function ordinal(n: number): string {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${tail}`;
}

export const ABILITY_NAMES: Readonly<Record<Ability, string>> = { str: 'Strength', dex: 'Dexterity', con: 'Constitution', int: 'Intelligence', wis: 'Wisdom', cha: 'Charisma' };
