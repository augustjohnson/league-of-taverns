/**
 * The workshop: the playground's tools for checking the contest by hand, out
 * of the game's way. A bot run (any seed, every seat a bot, audited against
 * the CLI), or your finished season, in Standings, Episodes, Draft board and
 * Cast; and the Event log and a Batch of seasons with the balance numbers
 * (docs/survivor-format.md §7).
 *
 * The bot run starts the first time the workshop opens, so the game loads
 * without it.
 */
import { applyEpisode, castMap, episodeOdds, initialContest, lineHash } from '@league-of-taverns/engine';
import type { ContestState, EpisodeOdds } from '@league-of-taverns/engine';
import { ODDS_SAMPLES, aggregate, runSeason, runSeed, type RunSummary, type SeasonResult } from '../season-runner';
import { $, bannerAttr, challengeChrome, charCard, charName, config, esc, flagOf, input, num, ordinal, portrait, storageGet, storageSet, tavernName, VOTES } from './shared';
import { actorLabel, aggregateRows, checkLabel, draftBoard, eventSummary, pct, strategyName } from './view';

// ── page state ─────────────────────────────────────────────────────────────

type Tab = 'standings' | 'episodes' | 'draft' | 'cast' | 'events' | 'batch';
const TABS: ReadonlyArray<Tab> = ['standings', 'episodes', 'draft', 'cast', 'events', 'batch'];

interface Run {
  readonly seed: string;
  readonly result: SeasonResult;
  readonly ms: number;
  readonly sha256: string;
  /** True for a season you played in the game rather than run from a seed. */
  readonly played?: boolean;
}

let run: Run | null = null;
let tab: Tab = (TABS as ReadonlyArray<string>).includes(storageGet('lot-playground-tab') ?? '') ? (storageGet('lot-playground-tab') as Tab) : 'standings';
const episodesUi = { episode: 1 };
const eventsUi = { type: 'all', text: '', open: new Set<number>() };
const batchUi = { n: 30, running: false, done: 0, total: 0, seed: '', summaries: [] as RunSummary[], ms: 0, token: 0, error: null as string | null };

const botOf = (id: string): string => run?.result.summary.taverns.find((t) => t.tavern === id)?.bot ?? '?';

// ── run bar ────────────────────────────────────────────────────────────────

function renderStatus(error: string | null, ms: number): void {
  const status = $('status');
  const errBox = $('run-error');
  if (error !== null || run === null) {
    status.innerHTML = `<span class="chip fail"><span class="dot"></span>Run failed</span><span class="chip">${num(ms.toFixed(0))} ms</span>`;
    errBox.hidden = false;
    errBox.textContent = error ?? 'No run.';
    return;
  }
  errBox.hidden = true;
  const { audit, summary } = run.result;
  const replayChip = audit.replayMatches
    ? `<span class="chip ok" title="replayLog(ndjson) deep-equals the state built event by event"><span class="dot"></span>Replay matches</span>`
    : `<span class="chip fail"><span class="dot"></span>Replay differs</span>`;
  const verifyChip =
    audit.mismatches.length === 0
      ? `<span class="chip ok" title="verifyContest recomputed every challenge, vote and the finale from the seed"><span class="dot"></span>Seed audit: 0 mismatches</span>`
      : `<span class="chip fail"><span class="dot"></span>Seed audit: ${audit.mismatches.length} mismatches</span>`;
  status.innerHTML =
    (run.played === true ? `<span class="chip brass" title="Played in the game: your moves plus seed ${esc(run.seed)}">Your season</span>` : '') +
    `<span class="chip">${num(summary.events)} events</span>${replayChip}${verifyChip}` +
    `<span class="chip">${num(run.ms.toFixed(0))} ms</span>` +
    `<span class="chip" title="sha256 of events.ndjson. Matches the CLI's events-1.ndjson for the same seed.">ndjson ${num(run.sha256.slice(0, 12))}</span>` +
    `<span class="chip brass">Assistant: <b>${esc(charName(summary.winner))}</b></span>` +
    `<span class="chip brass">${summary.champions.length === 1 ? 'Champion' : 'Co-champions'}: ${summary.champions.map((c) => `<b>${esc(tavernName(c.tavern))}</b> <span class="muted">${esc(c.bot)}</span>`).join(', ')}</span>`;
}

function doRun(seed: string): void {
  $('status').innerHTML = `<span class="chip">Running ${esc(seed)}…</span>`;
  const started = performance.now();
  let error: string | null = null;
  try {
    if (seed.length === 0 || seed.includes('/')) throw new Error('A seed must be non-empty and contain no "/".');
    const result = runSeason(input, { seed });
    run = { seed, result, ms: performance.now() - started, sha256: lineHash(result.ndjson) };
    eventsUi.open.clear();
    oddsCache.clear();
  } catch (e) {
    run = null;
    error = e instanceof Error ? e.message : String(e);
  }
  renderStatus(error, performance.now() - started);
  renderTab();
}

// ── tabs ───────────────────────────────────────────────────────────────────

function setTab(next: Tab, focus = false): void {
  tab = next;
  storageSet('lot-playground-tab', next);
  markTabs(focus);
  renderTab();
}

function markTabs(focus = false): void {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#ws-tabs button')) {
    const on = b.dataset.tab === tab;
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
    if (on && focus) b.focus();
  }
  panel.setAttribute('aria-labelledby', `tab-${tab}`);
}

function renderTab(): void {
  if (tab === 'batch') {
    panel.innerHTML = renderBatch();
    return;
  }
  if (run === null) {
    panel.innerHTML = '<p class="muted">No season loaded. Fix the seed and press Run.</p>';
    return;
  }
  switch (tab) {
    case 'standings':
      panel.innerHTML = renderStandings(run);
      break;
    case 'episodes':
      panel.innerHTML = renderEpisodes(run);
      break;
    case 'draft':
      panel.innerHTML = renderDraft(run);
      break;
    case 'cast':
      panel.innerHTML = renderCast(run);
      break;
    case 'events':
      panel.innerHTML = renderEvents(run);
      break;
  }
}

// ── standings ──────────────────────────────────────────────────────────────

function renderStandings(r: Run): string {
  const { summary } = r.result;
  const rows = summary.standings
    .map(
      (row) =>
        `<tr class="${row.rank === 1 ? 'champ' : ''}"${bannerAttr(row.tavern)}><td class="n">${row.rank}</td><td>${flagOf(row.tavern)} <b>${esc(tavernName(row.tavern))}</b></td><td class="small">${esc(row.bot)}</td>` +
        `<td class="n"><b>${row.wins}–${row.losses}${row.ties > 0 ? `–${row.ties}` : ''}</b></td><td class="n">${row.points}</td><td class="n">${row.callPoints}</td>` +
        `<td><span class="faces">${(summary.taverns.find((t) => t.tavern === row.tavern)?.roster ?? []).map((id) => `<span title="${esc(charName(id))}, ${ordinal(summary.cast.find((c) => c.id === id)?.place ?? 0)}">${portrait(id, 'sm')}</span>`).join('')}</span></td></tr>`,
    )
    .join('');
  const perEpisode = summary.episodes
    .map((e) => {
      const cells = summary.standings.map((s) => {
        const t = e.taverns.find((x) => x.tavern === s.tavern)!;
        return `<td class="n ${t.right ? 'win' : 'muted'}" title="${t.call === null ? 'no call' : `called ${charName(t.call)}${t.early ? ' early' : ''}`}">${t.points}${t.right ? '✓' : ''}</td>`;
      });
      return `<tr class="click" data-action="goto-episode" data-episode="${e.episode}"><td class="n">${e.episode}</td><td>${esc(charName(e.immune))}</td><td><b>${esc(charName(e.boot))}</b>${e.revote ? ' <span class="tag">revote</span>' : ''}${e.draw ? ' <span class="tag bad">draw</span>' : ''}</td><td class="small ${e.favourite === e.boot ? 'pass' : 'muted'}">${esc(charName(e.favourite))} ${pct(e.favouriteChance, 0)}</td>${cells.join('')}</tr>`;
    })
    .join('');
  return (
    `<section class="card"><h2>Standings</h2><div class="scroll"><table><thead><tr><th class="n">#</th><th>tavern</th><th>bot</th><th class="n">W–L</th><th class="n">pts</th><th class="n">from calls</th><th>candidates</th></tr></thead><tbody>${rows}</tbody></table></div></section>` +
    `<section class="card"><h2>Episode by episode</h2><p class="hint">Points each tavern scored at each vote (✓ = called it). The favourite is the most likely boot by the public odds once immunity was known.</p>` +
    `<div class="scroll"><table><thead><tr><th class="n">ep</th><th>immune</th><th>boot</th><th>favourite</th>${summary.standings.map((s) => `<th class="n" title="${esc(tavernName(s.tavern))}">${flagOf(s.tavern) || esc(tavernName(s.tavern).slice(4, 9))}</th>`).join('')}</tr></thead><tbody>${perEpisode}</tbody></table></div></section>`
  );
}

// ── episodes ───────────────────────────────────────────────────────────────

const oddsCache = new Map<string, { pre: EpisodeOdds; post: EpisodeOdds }>();

/** The contest as it stood before `episode`, and the public odds then: before and after its challenge. */
function oddsAt(r: Run, episode: number): { readonly state: ContestState; readonly pre: EpisodeOdds; readonly post: EpisodeOdds } {
  const cards = r.result.events.flatMap((e) => (e.type === 'character.pooled' ? [input.cardOf(e.payload.character)] : []));
  const map = castMap(cards);
  let s = initialContest(cards, input.model);
  for (const e of r.result.state.episodes) {
    if (e.episode >= episode) break;
    s = applyEpisode(s, { episode: e.episode, immune: e.challenge!.result.winner, vote: e.vote! }, input.model);
  }
  const key = `${r.sha256}:${episode}`;
  let odds = oddsCache.get(key);
  if (odds === undefined) {
    const immune = r.result.state.episodes[episode - 1]!.challenge!.result.winner;
    odds = { pre: episodeOdds(s, map, null, input.model, `workshop/${episode}/pre`, ODDS_SAMPLES), post: episodeOdds(s, map, immune, input.model, `workshop/${episode}/post`, ODDS_SAMPLES) };
    oddsCache.set(key, odds);
  }
  return { state: s, ...odds };
}

function renderEpisodes(r: Run): string {
  const { state } = r.result;
  const n = state.episodes.length;
  const episode = Math.min(Math.max(1, episodesUi.episode), n);
  const e = state.episodes[episode - 1]!;
  const challenge = input.challenges[episode - 1]!.challenge;
  const chrome = challengeChrome(episode);
  const result = e.challenge!.result;
  const vote = e.vote!;
  const { pre, post } = oddsAt(r, episode);
  const owner = (id: string): string => {
    const t = state.owner.get(id);
    return t === undefined ? '' : flagOf(t);
  };
  const rounds = result.rounds
    .map((round, i) => {
      const check = challenge.checks[round.check]!;
      const rolls = round.rolls
        .map((roll) => `<span class="roll ${roll.pass ? 'pass' : 'fail'}" title="${esc(charName(roll.id))}">${portrait(roll.id, 'sm')}<span class="die">${roll.d20}</span>${roll.advantage ? '<span class="tag brass">adv</span>' : ''}${roll.modifier >= 0 ? '+' : ''}${roll.modifier}</span>`)
        .join('');
      return `<tr><td class="n">${i + 1}</td><td class="small wrap-ok"><b>${esc(chrome.lines[round.check] ?? '')}</b><div class="muted">${esc(checkLabel(check, round.dc))}</div></td><td class="wrap-ok"><div class="rolls">${rolls}</div></td><td class="small">${round.replay ? '<span class="muted">replay</span>' : `${round.out.length} out`}</td></tr>`;
    })
    .join('');
  const oddsRows = [...post.boot]
    .sort((a, b) => b[1] - a[1])
    .map(([id, p]) => {
      const votes = vote.ballots.filter((b) => b.target === id).length;
      const before = pre.boot.get(id) ?? 0;
      return (
        `<tr class="${id === vote.boot ? 'sel' : ''}"><td>${portrait(id, 'sm')} ${esc(charName(id))} ${owner(id)}${id === result.winner ? ' <span class="tag good">immune</span>' : ''}</td>` +
        `<td class="small">${esc(strategyName(input.cardOf(id).strategy))}</td><td class="n">${pct(before, 0)}</td><td class="n">${pct(pre.immunity.get(id) ?? 0, 0)}</td><td class="n"><b>${pct(p, 0)}</b></td><td class="n">${votes || ''}</td></tr>`
      );
    })
    .join('');
  const ballots = vote.ballots.map((b) => `<li>${portrait(b.voter, 'sm')} ${esc(charName(b.voter))} <span class="muted small">${esc(strategyName(input.cardOf(b.voter).strategy))}</span> → <b>${esc(charName(b.target))}</b></li>`).join('');
  return (
    `<section class="card"><div class="row"><label class="label" for="ep-pick">Episode</label><select id="ep-pick" data-action="ep-pick">${state.episodes
      .map((x) => `<option value="${x.episode}" ${x.episode === episode ? 'selected' : ''}>${x.episode}: ${esc(challengeChrome(x.episode).title)}</option>`)
      .join('')}</select></div>` +
    `<h2>${esc(chrome.title)}</h2><p class="lich-says">"${esc(chrome.story)}"</p>` +
    `<div class="scroll"><table><thead><tr><th class="n">#</th><th>check</th><th>rolls</th><th></th></tr></thead><tbody>${rounds}</tbody></table></div>` +
    `<p><b>${esc(charName(result.winner))}</b> wins immunity.</p></section>` +
    `<section class="card"><h2>The vote</h2><p class="hint">The public odds, by ${ODDS_SAMPLES} samples of the vote's noise: before the challenge (with stand-in challenges for immunity) and after it. The row in brass went home.</p>` +
    `<div class="scroll"><table><thead><tr><th>monster</th><th>strategy</th><th class="n">boot (pre)</th><th class="n">immunity (pre)</th><th class="n">boot (post)</th><th class="n">votes</th></tr></thead><tbody>${oddsRows}</tbody></table></div>` +
    (vote.revote === null ? '' : `<p>A tie between ${vote.revote.tied.map((id) => esc(charName(id))).join(' and ')}: revote ${vote.revote.ballots.map((b) => `${esc(charName(b.voter))} → ${esc(charName(b.target))}`).join(', ') || '(nobody could vote)'}.</p>`) +
    (vote.draw === null ? '' : `<p>Still tied: the Lich drew ${esc(charName(vote.boot))} (roll ${vote.draw.roll.toFixed(3)}).</p>`) +
    `<details><summary>Every ballot</summary><ul class="ballots">${ballots}</ul></details></section>`
  );
}

// ── draft board ────────────────────────────────────────────────────────────

function renderDraft(r: Run): string {
  const { state } = r.result;
  const picks = r.result.events.flatMap((e) => (e.type === 'draft.pick' ? [e.payload] : []));
  const board = draftBoard(state.draft.order, picks)
    .map(
      (row) =>
        `<tr class="${row.direction}"><td class="rd">R${row.round}</td>${row.cells
          .map((c) => (c === null ? '<td></td>' : `<td><span class="face">${portrait(c.character, 'sm')}<span><span class="pk">#${c.pick + 1}</span> <span class="ch">${esc(charName(c.character))}</span> <span class="muted small">${ordinal(r.result.summary.cast.find((x) => x.id === c.character)?.place ?? 0)}</span></span></span></td>`))
          .join('')}</tr>`,
    )
    .join('');
  return (
    `<section class="card"><h2>Draft board</h2><p class="hint">Each pick with where it finished in the contest (1st = the assistant).</p><div class="scroll"><table class="draft"><thead><tr><th>round</th>${state.draft.order
      .map((t) => `<th>${flagOf(t)} ${esc(tavernName(t))}<div class="muted small">${esc(botOf(t))}</div></th>`)
      .join('')}</tr></thead><tbody>${board}</tbody></table></div></section>`
  );
}

// ── the cast ───────────────────────────────────────────────────────────────

function renderCast(r: Run): string {
  const { summary } = r.result;
  const cards = [...summary.cast]
    .sort((a, b) => a.place - b.place)
    .map((c) => charCard(c.id, { owner: c.owner, foot: `<span class="small"><b>${ordinal(c.place)}</b>${c.owner === null ? ' · nobody\'s' : ` · ${esc(tavernName(c.owner))}`}</span>` }))
    .join('');
  return `<section class="card"><h2>The cast, by finish</h2><p class="hint">${summary.cast.length} of the pool's ${input.pool.length}, drawn by the seed. ${VOTES} votes, then the jury.</p><div class="deck">${cards}</div></section>`;
}

// ── events ─────────────────────────────────────────────────────────────────

function renderEvents(r: Run): string {
  const types = [...new Set(r.result.events.map((e) => e.type))];
  return (
    `<section class="card"><div class="row" style="justify-content:space-between"><h2>Event log</h2>` +
    `<div class="row"><button type="button" class="primary" data-action="copy-ndjson">Copy events.ndjson</button><span id="copy-msg" class="small muted" aria-live="polite"></span></div></div>` +
    `<p class="hint">Copies the NDJSON (${r.result.ndjson.length.toLocaleString()} bytes) to your clipboard. Paste it into a file to diff against the CLI's events-1.ndjson.</p>` +
    `<textarea id="ndjson-fallback" readonly hidden></textarea>` +
    `<div class="row"><label class="label" for="ev-type">Type</label><select id="ev-type" data-action="ev-type"><option value="all">all (${r.result.events.length})</option>${types
      .map((t) => `<option value="${esc(t)}" ${eventsUi.type === t ? 'selected' : ''}>${esc(t)} (${r.result.events.filter((e) => e.type === t).length})</option>`)
      .join('')}</select>` +
    `<input type="text" id="ev-text" placeholder="Filter text, e.g. a tavern or character" value="${esc(eventsUi.text)}" data-action="ev-text"></div>` +
    `<div id="ev-list" class="scroll">${renderEventList(r)}</div></section>`
  );
}

function renderEventList(r: Run): string {
  const q = eventsUi.text.trim().toLowerCase();
  const rows = r.result.events
    .filter((e) => eventsUi.type === 'all' || e.type === eventsUi.type)
    .map((e) => ({ e, summary: eventSummary(e), actor: actorLabel(e.actor) }))
    .filter(({ e, summary, actor }) => q === '' || `${e.type} ${actor} ${summary}`.toLowerCase().includes(q) || JSON.stringify(e.payload).toLowerCase().includes(q))
    .map(({ e, summary, actor }) => {
      const open = eventsUi.open.has(e.seq);
      return (
        `<tr class="click ${open ? 'sel' : ''}" data-action="ev-toggle" data-seq="${e.seq}"><td class="n">${e.seq}</td><td class="mono small">${esc(e.type)}</td><td class="small muted">${esc(actor)}</td><td class="small wrap-ok">${esc(summary)}</td><td class="small muted mono">${esc(e.at)}</td></tr>` +
        (open ? `<tr><td colspan="5"><pre class="json">${esc(JSON.stringify(e, null, 2))}</pre></td></tr>` : '')
      );
    })
    .join('');
  return `<table><thead><tr><th class="n">seq</th><th>type</th><th>actor</th><th>summary</th><th>at</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="muted">No events match.</td></tr>'}</tbody></table>`;
}

function copyNdjson(): void {
  if (run === null) return;
  const text = run.result.ndjson;
  const msg = $('copy-msg');
  const fallback = (): void => {
    const area = $<HTMLTextAreaElement>('ndjson-fallback');
    area.hidden = false;
    area.value = text;
    area.focus();
    area.select();
    msg.textContent = 'Clipboard unavailable: the log is selected below, press Ctrl+C or Cmd+C.';
  };
  try {
    navigator.clipboard.writeText(text).then(() => {
      msg.textContent = `Copied ${run?.result.events.length ?? 0} events to your clipboard.`;
    }, fallback);
  } catch {
    fallback();
  }
}

// ── batch ──────────────────────────────────────────────────────────────────

function renderBatch(): string {
  const b = batchUi;
  const seed = run?.seed ?? (($('seed') as HTMLInputElement).value || 'sim-1');
  let results = '';
  if (b.error !== null) results = `<div class="error">${esc(b.error)}</div>`;
  else if (b.summaries.length > 0 && !b.running) {
    const totals = aggregate(b.summaries);
    const { header, rows } = aggregateRows(totals);
    results =
      `<div class="scroll"><table><thead><tr>${header.map((h, i) => `<th class="${i === 0 ? '' : 'n'}">${esc(h)}</th>`).join('')}</tr></thead><tbody>` +
      rows.map((r) => `<tr>${r.map((c, i) => `<td class="${i === 0 ? '' : 'n'}">${esc(c)}</td>`).join('')}</tr>`).join('') +
      `</tbody></table></div>` +
      `<h3>The contest</h3><div class="kv">` +
      `<div><span class="label">favourite went home</span><span class="v">${pct(totals.favouriteRate)}</span><span class="small muted">target 60–70%</span></div>` +
      `<div><span class="label">power vs finish</span><span class="v">${totals.powerPlacement.toFixed(2)}</span><span class="small muted">r, + is stronger lasts</span></div>` +
      `<div><span class="label">different winners</span><span class="v">${totals.distinctWinners}</span></div>` +
      `<div><span class="label">points from calls</span><span class="v">${pct(totals.callPointShare)}</span></div>` +
      `<div><span class="label">matchups calls decided</span><span class="v">${pct(totals.callDecidedShare)}</span></div></div>` +
      `<p class="small">Win rate by strategy (par ${pct(1 / config.contest.castSize)}): ${Object.entries(totals.strategyWins)
        .map(([k, s]) => `${esc(k)} ${pct(s.rate)}`)
        .join(', ')}.</p>` +
      `<p class="small">Most wins: ${totals.topWinners.map((w) => `${esc(charName(w.id))} ${w.wins}`).join(', ')}.</p>` +
      `<p class="hint">${totals.runs} seasons from seed ${esc(b.seed)} in ${(b.ms / 1000).toFixed(1)} s. Same as <span class="mono">pnpm sim -- --runs ${totals.runs} --seed ${esc(b.seed)}</span>.</p>`;
  }
  const progress = b.total === 0 ? 0 : (100 * b.done) / b.total;
  return (
    `<section class="card"><div class="row"><h2>Batch</h2><span class="muted small">Many seasons with the CLI's report</span></div>` +
    `<div class="row"><label class="label" for="batch-n">Seasons</label><input type="number" id="batch-n" min="5" max="200" step="5" value="${b.n}" style="width:6em" data-action="batch-n">` +
    `<span class="small muted">seeds ${esc(seed)}, ${esc(runSeed(seed, 2))}, …</span>` +
    `<button type="button" class="primary" data-action="batch-run" ${b.running ? 'disabled' : ''}>Run batch</button>` +
    `<button type="button" data-action="batch-cancel" ${b.running ? '' : 'disabled'}>Cancel</button></div>` +
    `<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${b.total}" aria-valuenow="${b.done}"><div id="batch-bar" style="width:${progress.toFixed(1)}%"></div></div>` +
    `<p class="small muted" id="batch-msg">${b.running ? `${b.done} of ${b.total} seasons…` : b.total === 0 ? 'Not run yet. About a second a season.' : `${b.done} of ${b.total} seasons.`}</p>` +
    `<div id="batch-results" class="stack">${results}</div></section>`
  );
}

function startBatch(): void {
  const b = batchUi;
  const n = Math.max(5, Math.min(200, Math.round(b.n) || 30));
  Object.assign(b, { n, seed: run?.seed ?? ($('seed') as HTMLInputElement).value, total: n, done: 0, summaries: [], error: null, running: true, ms: 0 });
  const token = ++b.token;
  renderTab();
  const step = (): void => {
    if (token !== b.token) return;
    const sliceStart = performance.now();
    try {
      while (b.done < b.total && performance.now() - sliceStart < 40) {
        b.summaries.push(runSeason(input, { seed: runSeed(b.seed, b.done + 1) }).summary);
        b.done++;
      }
    } catch (e) {
      b.error = `Season ${b.done + 1} (seed ${runSeed(b.seed, b.done + 1)}) failed: ${e instanceof Error ? e.message : String(e)}`;
      b.running = false;
    }
    b.ms += performance.now() - sliceStart;
    if (b.done >= b.total) b.running = false;
    if (tab === 'batch') {
      if (b.running) {
        $('batch-bar').style.width = `${((100 * b.done) / b.total).toFixed(1)}%`;
        $('batch-msg').textContent = `${b.done} of ${b.total} seasons…`;
      } else renderTab();
    }
    if (b.running) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

// ── entry points ───────────────────────────────────────────────────────────

const panel = $('ws-panel');
let opened = false;
/** A season you played to the end, waiting for the workshop to open: loading it audits the whole log, so it waits until it's wanted. */
let played: { readonly seed: string; readonly finish: () => SeasonResult } | null = null;

/** Show the workshop. The first time, run the seed in the run bar (sim-1 unless your season is already loaded). */
export function openWorkshop(): void {
  markTabs();
  if (played !== null) {
    loadPlayed(played.seed, played.finish);
    played = null;
    opened = true;
    renderTab();
    return;
  }
  if (opened) {
    renderTab();
    return;
  }
  opened = true;
  if (run !== null) {
    renderStatus(null, run.ms);
    renderTab();
    return;
  }
  $('status').innerHTML = '<span class="chip">Running…</span>';
  requestAnimationFrame(() => setTimeout(() => doRun(($('seed') as HTMLInputElement).value.trim() || 'sim-1'), 0));
}

/** Load a season you played to the end into the workshop's tabs, like a seed run, the next time the workshop opens. */
export function loadPlayedSeason(seed: string, finish: () => SeasonResult): void {
  played = { seed, finish };
}

function loadPlayed(seed: string, finish: () => SeasonResult): void {
  const started = performance.now();
  let error: string | null = null;
  try {
    const result = finish();
    run = { seed, result, ms: performance.now() - started, sha256: lineHash(result.ndjson), played: true };
    eventsUi.open.clear();
    oddsCache.clear();
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  renderStatus(error, performance.now() - started);
}

// ── wiring ─────────────────────────────────────────────────────────────────

panel.addEventListener('click', (ev) => {
  const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (target === null) return;
  const { action } = target.dataset;
  switch (action) {
    case 'goto-episode':
      episodesUi.episode = Number(target.dataset.episode);
      setTab('episodes');
      break;
    case 'ev-toggle': {
      const seq = Number(target.dataset.seq);
      if (eventsUi.open.has(seq)) eventsUi.open.delete(seq);
      else eventsUi.open.add(seq);
      if (run !== null) $('ev-list').innerHTML = renderEventList(run);
      break;
    }
    case 'copy-ndjson':
      copyNdjson();
      break;
    case 'batch-run':
      startBatch();
      break;
    case 'batch-cancel':
      batchUi.token++;
      batchUi.running = false;
      renderTab();
      break;
  }
});

panel.addEventListener('change', (ev) => {
  const target = ev.target as HTMLInputElement | HTMLSelectElement;
  switch (target.dataset.action) {
    case 'ep-pick':
      episodesUi.episode = Number(target.value);
      renderTab();
      break;
    case 'ev-type':
      eventsUi.type = target.value;
      if (run !== null) $('ev-list').innerHTML = renderEventList(run);
      break;
    case 'batch-n':
      batchUi.n = Number(target.value);
      break;
  }
});

panel.addEventListener('input', (ev) => {
  const target = ev.target as HTMLInputElement;
  if (target.dataset.action === 'ev-text') {
    eventsUi.text = target.value;
    if (run !== null) $('ev-list').innerHTML = renderEventList(run);
  }
});

$('run-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  doRun(($('seed') as HTMLInputElement).value.trim());
});
$('new-seed').addEventListener('click', () => {
  const seed = `sim-${Math.floor(Math.random() * 1e6)}`;
  ($('seed') as HTMLInputElement).value = seed;
  doRun(seed);
});
$('ws-tabs').addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-tab]');
  if (b !== null) setTab(b.dataset.tab as Tab);
});
$('ws-tabs').addEventListener('keydown', (ev) => {
  const i = TABS.indexOf(tab);
  const next = ev.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length] : ev.key === 'ArrowLeft' ? TABS[(i - 1 + TABS.length) % TABS.length] : ev.key === 'Home' ? TABS[0] : ev.key === 'End' ? TABS.at(-1) : undefined;
  if (next === undefined) return;
  ev.preventDefault();
  setTab(next, true);
});
