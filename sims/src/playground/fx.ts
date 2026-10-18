/**
 * Moments: the small effects that give a move emotional weight. They live in
 * the page only (DOM), play once after the render a move caused, and never
 * under prefers-reduced-motion, where the page simply shows the new state.
 *
 * Effects come in tiers so the big ones stay rare and keep meaning something:
 * a nod (one micron interaction on one element), a cheer (one burst of
 * party.js sparkles) and a fanfare (confetti), which only winning a
 * head-to-head round or the season earns.
 * The CSS half is page.html § Moments, with micron's CSS vendored below it.
 */
import { Color, Rect, confetti, settings, sparkles, variation } from 'party-js';
import type { Banner } from '@league-of-taverns/scripts/lib/banner';

// party.js's own default, set here so it holds even if the default changes: it must be set before the first effect.
settings.respectReducedMotion = true;

export function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** micron's interactions (https://github.com/webkul/micron); page.html vendors their CSS. */
export type MicronInteraction = 'shake' | 'fade' | 'jelly' | 'bounce' | 'tada' | 'groove' | 'swing' | 'squeeze' | 'flicker' | 'jerk' | 'blink' | 'pop';

export interface MicronOptions {
  /** Seconds. micron's default is 0.45. */
  readonly duration?: number;
  readonly timing?: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out';
  /** Seconds before it starts. */
  readonly delay?: number;
}

/**
 * Play one micron interaction on `el`, as micron's own
 * `getEle().interaction().duration().timing()` would, but take its classes
 * off again when it ends, so the element can play it again. A nod.
 */
export function micron(el: Element | null, interaction: MicronInteraction, { duration = 0.45, timing = 'ease-in-out', delay = 0 }: MicronOptions = {}): void {
  if (!(el instanceof HTMLElement) || reducedMotion()) return;
  const classes = [`mjs-${interaction}`, `mjs-${timing}`];
  el.classList.remove(...classes);
  void el.offsetWidth; // restart it if it was already playing
  el.style.animationDuration = `${duration}s`;
  el.style.animationDelay = `${delay}s`;
  el.classList.add(...classes);
  const done = (e: AnimationEvent): void => {
    if (e.target !== el) return;
    el.removeEventListener('animationend', done);
    el.classList.remove(...classes);
    el.style.animationDuration = '';
    el.style.animationDelay = '';
  };
  el.addEventListener('animationend', done);
}

/**
 * Choosing your tavern: its banner goes up. The pennant unfurls, the card
 * glows and the regulars' toast rises in (the `.raised` animations), the tavern
 * sign swings, and one burst of sparkles leaves the pennant in the banner's
 * colours: its mark twice as often as its charge. The field is left out: it
 * is the card's own colour, so it would vanish against it. A cheer, once a
 * season.
 */
export function raiseBanner(card: HTMLElement | null, banner: Banner): void {
  if (card === null || reducedMotion()) return;
  card.classList.add('raised');
  micron(card.querySelector('.flag'), 'swing', { duration: 1.1, delay: 0.55, timing: 'ease-out' });
  const colours = [banner.mark, banner.mark, banner.charge].map((hex) => Color.fromHex(hex));
  window.setTimeout(() => {
    // The person may have moved on (another click re-renders the panel).
    if (!card.isConnected) return;
    sparkles(card.querySelector<HTMLElement>('.pennant') ?? card, {
      count: variation.range(28, 40),
      size: variation.range(0.7, 1.4),
      speed: variation.range(90, 220),
      color: colours,
    });
  }, 300);
}

/** The clock for a paced reveal: every wait goes through `sleep`, so one `skip` (the Skip button, or Esc) cuts all of them short at once. */
export interface Pacer {
  sleep: (ms: number) => Promise<void>;
  readonly skipped: boolean;
  skip: () => void;
}

export function pacer(): Pacer {
  let skipped = false;
  const cancels = new Set<() => void>();
  return {
    sleep: (ms) =>
      new Promise((resolve) => {
        if (skipped || ms <= 0) return resolve();
        const cancel = (): void => {
          window.clearTimeout(timer);
          cancels.delete(cancel);
          resolve();
        };
        const timer = window.setTimeout(cancel, ms);
        cancels.add(cancel);
      }),
    get skipped() {
      return skipped;
    },
    skip: () => {
      skipped = true;
      for (const cancel of [...cancels]) cancel();
    },
  };
}

const BRASS = Color.fromHex('#d5aa4c');

/** Milliseconds for each beat of the reveals: a challenge round, the drop-outs, a ballot, the boot, the calls. */
const BEAT = { round: 900, out: 700, replay: 900, winner: 1400, ballot: 750, tie: 1200, boot: 1800, calls: 500, jury: 1300 } as const;

/** Show `el` (it was held back by its message's `.revealing`), with a nod. */
function show(el: Element | null, nod: MicronInteraction | null = null): void {
  if (!(el instanceof HTMLElement)) return;
  el.classList.add('shown');
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  if (nod !== null) micron(el, nod, { duration: 0.45 });
}

/** End a reveal: everything held back shows, at once. */
function finishReveal(msg: HTMLElement): void {
  if (!msg.isConnected) return;
  msg.classList.remove('revealing');
  for (const el of msg.querySelectorAll('.tally [data-count]')) el.textContent = (el as HTMLElement).dataset.count ?? el.textContent;
}

/**
 * The scrying ball shows a challenge (play.ts challengeHtml): round by round,
 * the check, then who drops out (their faces fade from the field), the
 * count of those left, and at last the winner, immune tonight, in a burst
 * of sparks (your banner's colours when the winner is yours).
 *
 * The message already holds the whole result; this only holds pieces back
 * while it is `.revealing`, so a reload, a skip or reduced motion shows the
 * same thing. Resolves when it ends, skipped or not.
 */
export async function revealChallenge(msg: HTMLElement, pace: Pacer, banner?: Banner): Promise<void> {
  if (reducedMotion()) return;
  const stop = (): boolean => pace.skipped || !msg.isConnected;
  for (const el of msg.querySelectorAll('.shown')) el.classList.remove('shown');
  for (const el of msg.querySelectorAll('.field .out')) el.classList.remove('out');
  msg.classList.add('revealing');
  const field = new Map([...msg.querySelectorAll<HTMLElement>('.field [data-id]')].map((el) => [el.dataset.id!, el]));
  for (const round of msg.querySelectorAll<HTMLElement>('.rounds > li')) {
    if (stop()) break;
    show(round);
    await pace.sleep(round.dataset.replay === '1' ? BEAT.replay : BEAT.round);
    if (stop()) break;
    const outs = (round.dataset.out ?? '').split(' ').filter((x) => x !== '');
    show(round.querySelector('.dropped'));
    for (const id of outs) field.get(id)?.classList.add('out');
    if (outs.length > 0) await pace.sleep(BEAT.out);
  }
  if (!stop()) {
    const winner = msg.querySelector<HTMLElement>('[data-winner]');
    show(winner, 'tada');
    const face = winner?.querySelector<HTMLElement>('.pt') ?? winner;
    if (face !== null && face !== undefined) {
      const colours = (banner === undefined ? ['#d5aa4c', '#ecdfb9'] : [banner.mark, banner.charge]).map((hex) => Color.fromHex(hex));
      sparkles(face, { count: variation.range(14, 22), size: variation.range(0.5, 1), speed: variation.range(70, 170), color: winner?.dataset.mine === '1' ? colours : BRASS });
    }
    await pace.sleep(BEAT.winner);
  }
  finishReveal(msg);
}

/**
 * The Lich reads the votes (play.ts voteHtml), one parchment at a time,
 * Survivor style: each name lands, its tally climbs, a tie holds its breath.
 * Then the revote and the draw if there were any, then the boot leaves for
 * the jury, and last the calls are unsealed with what each tavern scored.
 * Calling it right with your own call throws a few sparks in your colours.
 */
export async function readVotes(msg: HTMLElement, pace: Pacer, banner?: Banner): Promise<void> {
  if (reducedMotion()) return;
  const stop = (): boolean => pace.skipped || !msg.isConnected;
  for (const el of msg.querySelectorAll('.shown')) el.classList.remove('shown');
  msg.classList.add('revealing');
  const tallies = new Map([...msg.querySelectorAll<HTMLElement>('.tally [data-target]')].map((el) => [el.dataset.target!, el]));
  for (const el of tallies.values()) {
    const n = el.querySelector<HTMLElement>('[data-count]');
    if (n !== null) n.textContent = '0';
  }
  for (const step of msg.querySelectorAll<HTMLElement>('[data-step]')) {
    if (stop()) break;
    const kind = step.dataset.step;
    if (kind === 'ballot') {
      show(step, 'pop');
      const chip = tallies.get(step.dataset.target ?? '');
      const n = chip?.querySelector<HTMLElement>('[data-count]');
      if (chip !== undefined && n !== null && n !== undefined) {
        chip.classList.add('shown');
        n.textContent = step.dataset.tally ?? n.textContent;
        micron(chip, 'bounce', { duration: 0.4 });
      }
      await pace.sleep(step.dataset.tie === '1' ? BEAT.tie : BEAT.ballot);
    } else if (kind === 'boot') {
      await pace.sleep(400);
      show(step, 'squeeze');
      await pace.sleep(BEAT.boot);
    } else {
      show(step);
      await pace.sleep(kind === 'calls' ? BEAT.calls : BEAT.ballot);
    }
  }
  if (!stop()) {
    const right = msg.querySelector<HTMLElement>('.calls-out li.mine.right');
    if (right !== null && banner !== undefined) {
      sparkles(right, { count: variation.range(12, 18), size: variation.range(0.5, 0.9), speed: variation.range(60, 150), color: [banner.mark, banner.charge].map((hex) => Color.fromHex(hex)) });
    }
  }
  finishReveal(msg);
}

/**
 * The jury's votes (play.ts finaleHtml): each juror's ballot, then the
 * Lich names his new assistant.
 */
export async function readJury(msg: HTMLElement, pace: Pacer): Promise<void> {
  if (reducedMotion()) return;
  const stop = (): boolean => pace.skipped || !msg.isConnected;
  for (const el of msg.querySelectorAll('.shown')) el.classList.remove('shown');
  msg.classList.add('revealing');
  const tallies = new Map([...msg.querySelectorAll<HTMLElement>('.tally [data-target]')].map((el) => [el.dataset.target!, el]));
  for (const el of tallies.values()) {
    const n = el.querySelector<HTMLElement>('[data-count]');
    if (n !== null) n.textContent = '0';
  }
  for (const step of msg.querySelectorAll<HTMLElement>('[data-step]')) {
    if (stop()) break;
    show(step, step.dataset.step === 'winner' ? 'tada' : 'pop');
    const chip = tallies.get(step.dataset.target ?? '');
    const n = chip?.querySelector<HTMLElement>('[data-count]');
    if (step.dataset.step === 'ballot' && n !== null && n !== undefined) {
      n.textContent = step.dataset.tally ?? n.textContent;
      micron(chip ?? null, 'bounce', { duration: 0.4 });
    }
    await pace.sleep(step.dataset.step === 'winner' ? BEAT.boot : BEAT.jury);
  }
  if (!stop()) {
    const winner = msg.querySelector<HTMLElement>('[data-step="winner"]');
    if (winner !== null) confetti(winner, { count: variation.range(40, 60), size: variation.range(0.7, 1.1), color: [BRASS, Color.fromHex('#ecdfb9')] });
  }
  finishReveal(msg);
}

/** The table after a vote: confetti in your colours if you just took the lead, a nod if you climbed. */
export function tableMoment(msg: HTMLElement, outcome: 'lead' | 'rose' | 'none', banner?: Banner): void {
  if (reducedMotion() || !msg.isConnected) return;
  const line = msg.querySelector<HTMLElement>('.mini-table tr.mine');
  if (outcome === 'lead') {
    const colours = (banner === undefined ? ['#d5aa4c', '#24704a'] : [banner.mark, banner.mark, banner.charge, banner.field]).map((hex) => Color.fromHex(hex));
    micron(line, 'tada', { duration: 0.8 });
    confetti(line ?? msg, { count: variation.range(25, 35), size: variation.range(0.6, 1), color: colours });
  } else if (outcome === 'rose') {
    micron(line, 'jelly', { duration: 0.6 });
  }
}

/**
 * The season ends and you won: the fanfare, the only full-screen confetti in
 * the app. Your banner goes up over the final card (the `.raised`
 * animations), its title tadas, and two waves of confetti in your banner's
 * colours rise from the bottom of the screen, then one from the card.
 */
export function crownChampion(card: HTMLElement, banner?: Banner): void {
  if (reducedMotion() || !card.isConnected) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('raised');
  micron(card.querySelector('h2'), 'tada', { duration: 1, delay: 0.4 });
  const colours = (banner === undefined ? ['#d5aa4c', '#24704a', '#ecdfb9'] : [banner.mark, banner.mark, banner.charge, banner.field]).map((hex) => Color.fromHex(hex));
  const wave = (count: number): void => {
    // Speeds to clear the screen's height against party.js's gravity (800 px/s²).
    const lift = Math.sqrt(2 * 800 * window.innerHeight);
    confetti(new Rect(0, window.innerHeight, window.innerWidth, 1), {
      count,
      spread: variation.range(20, 30),
      speed: variation.range(0.75 * lift, 1.05 * lift),
      size: variation.range(0.8, 1.3),
      color: colours,
    });
  };
  window.setTimeout(() => wave(90), 500);
  window.setTimeout(() => wave(70), 1300);
  window.setTimeout(() => {
    if (card.isConnected) confetti(card.querySelector<HTMLElement>('h2') ?? card, { count: variation.range(40, 55), color: colours });
  }, 2100);
}

/**
 * The season ends and a rival won: no fanfare for you. The champion's flag
 * swings and throws a small burst in their colours, and your finish line
 * nods. The champion's colours show because they won the season, which acts
 * on everyone.
 */
export function hailChampion(card: HTMLElement, banner?: Banner): void {
  if (reducedMotion() || !card.isConnected) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const flag = card.querySelector<HTMLElement>('.champ-line .flag');
  micron(flag, 'swing', { duration: 1.1, timing: 'ease-out' });
  if (flag !== null && banner !== undefined) {
    sparkles(flag, { count: variation.range(12, 18), size: variation.range(0.5, 0.9), color: [banner.mark, banner.charge].map((hex) => Color.fromHex(hex)) });
  }
  micron(card.querySelector('.finish'), 'fade', { duration: 0.9, delay: 0.6 });
}

/**
 * A drafted card turns over: it lands in your roster in neutral chrome, turns
 * away, and comes back in your banner. A nod. Nothing for a card without a
 * banner, which stays neutral. Timers, not animationend, drive the turn, so a
 * tab that stops animating (hidden, or the animation cancelled) still ends
 * with the card face up in your colours.
 */
export function turnCard(card: HTMLElement | null): void {
  if (card === null || reducedMotion() || !card.classList.contains('themed')) return;
  card.classList.replace('themed', 'neutral');
  card.classList.add('turning-out');
  window.setTimeout(() => {
    card.classList.remove('turning-out');
    card.classList.replace('neutral', 'themed');
    card.classList.add('turning-in');
    window.setTimeout(() => card.classList.remove('turning-in'), 340);
  }, 230);
}

/**
 * The clock comes back to you: the rivals have picked (or chosen), or an
 * episode waits on you, so the action bar glows once and its call to you
 * (`[data-clock]`) bounces. A nod, once each time it comes back; it never
 * pulses the whole time you are on the clock.
 */
export function clockBack(bar: HTMLElement | null): void {
  if (bar === null || reducedMotion()) return;
  bar.classList.remove('clock-back');
  void bar.offsetWidth;
  bar.classList.add('clock-back');
  micron(bar.querySelector('[data-clock]'), 'bounce', { duration: 0.6 });
}

/**
 * The table moves: each row starts where it stood after the last round
 * (`data-was`) and slides to where it stands now, a little after the one
 * above it, so a climb or a fall is felt every round. The
 * ▲/▼ column says the same thing in words and stays put.
 */
export function slideStandings(table: HTMLTableElement | null): void {
  if (table === null || reducedMotion() || !table.isConnected) return;
  const rows = [...table.querySelectorAll<HTMLElement>('tbody tr[data-was]')];
  const height = rows[0]?.getBoundingClientRect().height ?? 0;
  const moved = rows.filter((row, i) => {
    const dy = (Number(row.dataset.was) - i) * height;
    if (dy === 0 || Number.isNaN(dy)) return false;
    row.style.transition = 'none';
    row.style.transform = `translateY(${dy}px)`;
    return true;
  });
  if (moved.length === 0) return;
  void table.offsetHeight; // lay the rows out where they were before letting them go
  moved.forEach((row, i) => {
    row.classList.add('sliding');
    row.style.transition = `transform 0.7s cubic-bezier(0.2, 0.7, 0.2, 1) ${0.25 + 0.06 * i}s`;
    row.style.transform = '';
  });
  window.setTimeout(() => {
    for (const row of moved) {
      row.classList.remove('sliding');
      row.style.transition = '';
    }
  }, 1600);
}
