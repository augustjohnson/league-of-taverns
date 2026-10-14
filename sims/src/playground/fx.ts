/**
 * Moments: the small effects that give a move emotional weight. They live in
 * the page only (DOM), play once after the render a move caused, and never
 * under prefers-reduced-motion, where the page simply shows the new state.
 *
 * Effects come in tiers so the big ones stay rare and keep meaning something:
 * a nod (one micron interaction on one element), a cheer (one burst of
 * party.js sparkles) and, kept for the season's end, a fanfare (confetti).
 * The CSS half is page.html § Moments, with micron's CSS vendored below it.
 */
import { Color, settings, sparkles, variation } from 'party-js';
import type { Banner } from '@league-of-taverns/scripts/lib/god-schema';

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
 * glows and the god's call rises in (the `.raised` animations), the tavern
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

/** Milliseconds for each beat of the week reveal: a node with no roll, a check's roll, a battle's, and an ending line. */
const BEAT = { step: 380, check: 800, battle: 1400, tail: 900, count: 450 } as const;
const BRASS = Color.fromHex('#d5aa4c');

/**
 * The week reveal: the scrying ball plays your run back over the result card
 * (app.ts renderPlayResult). Node by node the path lights up; at each check
 * or battle the die tumbles before it settles, the outcome lands and the
 * loot counter climbs. A DNF drains the counter to 0 with a shake. Until it
 * ends, the card is `.revealing` and page.html hides the path, the outcomes,
 * every `[data-spoiler]` and the sections below the card, so nothing gives
 * the result away. Skip (or Esc) shows it all at once.
 *
 * The card already holds the whole result: this only holds pieces back and
 * brings them in, so a reload, a skip or reduced motion shows the same thing.
 */
export function revealWeek(card: HTMLElement): void {
  if (reducedMotion()) return;
  let path: ReadonlyArray<string>;
  try {
    path = JSON.parse(card.dataset.path ?? '[]') as ReadonlyArray<string>;
  } catch {
    return;
  }
  const attr = (name: string, value: string): string => `[${name}="${CSS.escape(value)}"]`;
  const graphNode = (id: string): Element | null => card.querySelector(`.graph ${attr('data-node', id)}`);
  const taleLine = (id: string): HTMLElement | null => card.querySelector<HTMLElement>(`.tale ${attr('data-node', id)}`);
  const counter = card.querySelector<HTMLElement>('[data-loot]');
  const skipButton = card.querySelector<HTMLButtonElement>('[data-reveal-skip]');
  const frame = card.querySelector<HTMLElement>('.graph');
  /** A wide mission scrolls in its frame: keep the party's node in view. */
  const follow = (node: Element | null): void => {
    if (frame === null || node === null) return;
    const f = frame.getBoundingClientRect();
    const n = node.getBoundingClientRect();
    if (n.left < f.left + 24 || n.right > f.right - 24) frame.scrollBy({ left: n.left + n.width / 2 - (f.left + f.width / 2), behavior: 'smooth' });
  };

  // Every wait goes through sleep, so a skip cuts all of them short at once.
  let skipped = false;
  const cancels = new Set<() => void>();
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      if (skipped) return resolve();
      const cancel = (): void => {
        window.clearTimeout(timer);
        cancels.delete(cancel);
        resolve();
      };
      const timer = window.setTimeout(cancel, ms);
      cancels.add(cancel);
    });
  const skip = (): void => {
    skipped = true;
    for (const cancel of [...cancels]) cancel();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') skip();
  };

  let shown = 0;
  const countTo = (target: number): void => {
    if (counter === null || Number.isNaN(target)) return;
    const from = shown;
    shown = target;
    const start = performance.now();
    const tick = (now: number): void => {
      if (skipped || !counter.isConnected) return;
      const t = Math.min(1, (now - start) / BEAT.count);
      counter.textContent = String(Math.round(from + (target - from) * (1 - (1 - t) ** 3)));
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };

  /** Tumble the die for `ms`, then show what it really rolled. Its colour waits too: a 20 or a 1 shows in its border. */
  const roll = async (die: HTMLElement | null, ms: number): Promise<void> => {
    if (die === null) return sleep(ms);
    const final = die.textContent ?? '';
    const unit = die.dataset.roll === 'unit';
    die.classList.add('rolling');
    const spin = window.setInterval(() => {
      die.textContent = unit ? Math.random().toFixed(3) : String(1 + Math.floor(Math.random() * 20));
    }, 70);
    await sleep(ms);
    window.clearInterval(spin);
    die.textContent = final;
    die.classList.remove('rolling');
  };

  const finish = (): void => {
    document.removeEventListener('keydown', onKey);
    if (!card.isConnected) return;
    const hadFocus = document.activeElement === skipButton;
    for (const el of card.querySelectorAll('.current, .rolling')) el.classList.remove('current', 'rolling');
    if (counter !== null) counter.textContent = counter.dataset.loot ?? counter.textContent;
    card.classList.remove('revealing');
    card.classList.add('revealed');
    if (hadFocus) card.focus({ preventScroll: true });
  };

  card.classList.add('revealing');
  if (counter !== null) counter.textContent = '0';
  if (frame !== null) frame.scrollLeft = 0;
  skipButton?.addEventListener('click', skip);
  document.addEventListener('keydown', onKey);
  // The Play button that started this is gone, so keyboard focus goes to Skip.
  if (document.activeElement === null || document.activeElement === document.body) skipButton?.focus({ preventScroll: true });
  card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  void (async () => {
    let previous: Element | null = null;
    for (const [i, id] of path.entries()) {
      if (skipped || !card.isConnected) break;
      const node = graphNode(id);
      if (i > 0) for (const el of card.querySelectorAll(`.graph ${attr('data-edge', `${path[i - 1]}>${id}`)}`)) el.classList.add('shown');
      previous?.classList.remove('current');
      node?.classList.add('current');
      follow(node);
      previous = node;
      const line = taleLine(id);
      if (line === null) {
        await sleep(BEAT.step);
        node?.classList.add('shown');
        continue;
      }
      line.classList.add('shown', 'rolling');
      const die = line.querySelector<HTMLElement>('[data-roll]');
      await roll(die, line.dataset.kind === 'battle' ? BEAT.battle : BEAT.check);
      line.classList.remove('rolling');
      node?.classList.add('shown');
      countTo(Number(line.dataset.total));
      // Small nods for good news: the loot tag pops, and a natural 20 throws a few sparks.
      micron(line.querySelector('[data-bank]'), 'pop', { duration: 0.4 });
      if (!skipped && die?.dataset.roll === 'd20' && die.textContent === '20') {
        sparkles(die, { count: variation.range(8, 12), size: variation.range(0.4, 0.8), speed: variation.range(60, 140), color: BRASS });
      }
      await sleep(BEAT.step);
    }
    previous?.classList.remove('current');
    for (const line of card.querySelectorAll<HTMLElement>('.tale [data-tail]')) {
      if (skipped || !card.isConnected) break;
      line.classList.add('shown');
      countTo(Number(line.dataset.total));
      if (line.dataset.tail === 'dnf') micron(counter, 'shake', { duration: 0.6 });
      await sleep(BEAT.tail);
    }
    finish();
  })();
}
