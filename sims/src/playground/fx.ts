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
