/**
 * Moments: the small effects that give a move emotional weight. They live in
 * the page only (DOM), play once after the render a move caused, and never
 * under prefers-reduced-motion, where the page simply shows the new state.
 *
 * Effects come in tiers so the big ones stay rare and keep meaning something:
 * a nod (one micron interaction on one element), a cheer (one burst of
 * party.js sparkles) and a fanfare (confetti), which only topping a week
 * earns. A week's result picks its tier by how it went (`weekMoment`).
 * The CSS half is page.html § Moments, with micron's CSS vendored below it.
 */
import { Color, Rect, confetti, settings, sparkles, variation } from 'party-js';
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
const BEAT = { step: 380, check: 800, battle: 1400, tail: 900, count: 450, curse: 1500 } as const;
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
 * When it ends, skipped or not, the week's moment plays in `banner`'s colours,
 * or `finale` in its place (the last week ends the season).
 */
export function revealWeek(card: HTMLElement, banner?: Banner, finale?: () => void): void {
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
    if (finale === undefined) weekMoment(card, banner);
    else finale();
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
    // A rival's hex falls first, in their colours, and the run waits a beat under it.
    const curse = card.querySelector<HTMLElement>('.tale [data-head="curse"]');
    if (curse !== null) {
      curse.classList.add('shown');
      micron(curse, 'flicker', { duration: 0.8, delay: 0.2 });
      await sleep(BEAT.curse);
    }
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
      if (line.dataset.tail === 'injury') micron(line.querySelector('[data-hurt]'), 'flicker', { duration: 0.7 });
      await sleep(BEAT.tail);
    }
    finish();
  })();
}

/**
 * Declaring your hex: spite, once a season. The new hex in the list jolts
 * (micron's jerk) and throws a few embers in your banner's mark. A cheer,
 * kept small: a curse is mischief, not a party.
 */
export function layCurse(row: HTMLElement | null, banner?: Banner): void {
  if (row === null || reducedMotion()) return;
  row.classList.add('laid');
  micron(row, 'jerk', { duration: 0.6 });
  sparkles(row.querySelector<HTMLElement>('.flag') ?? row, {
    count: variation.range(10, 14),
    size: variation.range(0.4, 0.8),
    speed: variation.range(50, 120),
    color: Color.fromHex(banner?.mark ?? '#a8352a'),
    shapes: 'circle',
  });
}

/**
 * The end of a week's reveal, sized to how the week went (`data-outcome`,
 * from view.ts weekOutcome):
 *
 * | outcome | feeling      | effect                                                          |
 * |---------|--------------|-----------------------------------------------------------------|
 * | top     | triumph      | confetti from the headline in your banner's colours; it tadas   |
 * | good    | satisfaction | a few sparkles off the loot counter                             |
 * | retreat | relief       | the counter breathes out (micron fade); the kept loot is marked |
 * | dnf     | loss         | (the drain and shake happen in the reveal) the run dims         |
 * | quiet   | none         | nothing                                                         |
 *
 * The marks that stay (the dimmed run, the kept loot) are page.html CSS on
 * `data-outcome`, so a reload shows them too.
 */
export function weekMoment(card: HTMLElement, banner?: Banner): void {
  if (reducedMotion() || !card.isConnected) return;
  const outcome = card.dataset.outcome;
  const counter = card.querySelector('[data-loot]');
  const colours = (banner === undefined ? ['#d5aa4c', '#24704a'] : [banner.mark, banner.mark, banner.charge, banner.field]).map((hex) => Color.fromHex(hex));
  if (outcome === 'top') {
    const headline = card.querySelector<HTMLElement>('[data-headline]');
    micron(headline, 'tada', { duration: 0.8 });
    confetti(headline ?? card, { count: variation.range(45, 65), size: variation.range(0.7, 1.1), color: colours });
  } else if (outcome === 'good' && counter instanceof HTMLElement) {
    sparkles(counter, { count: variation.range(10, 16), size: variation.range(0.5, 0.9), speed: variation.range(70, 160), color: colours.slice(0, 3) });
  } else if (outcome === 'retreat') {
    micron(counter, 'fade', { duration: 0.9 });
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
 * nods. The champion's colours show because they won the league, which acts
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
 * The clock comes back to you: once your pick has turned over, the bots have
 * picked and it is your turn again, so the draft card glows once and its
 * heading bounces. A nod, after each of your picks only; bot picks stay
 * quiet. The playground's bots pick at once, so a pulse that ran the whole
 * time you are on the clock would run the whole draft and mean nothing.
 */
export function clockBack(card: HTMLElement | null): void {
  if (card === null || reducedMotion()) return;
  window.setTimeout(() => {
    if (!card.isConnected) return;
    card.classList.add('clock-back');
    micron(card.querySelector('h2'), 'bounce', { duration: 0.6 });
  }, 600);
}

/**
 * The CR meter answers a change to the lineup: a jelly when it still fits the
 * budget, a shake when it no longer does. Only the meter moves; the engine's
 * reason shows below it as before. A nod.
 */
export function nodMeter(meter: Element | null, result: 'fits' | 'over'): void {
  micron(meter, result === 'over' ? 'shake' : 'jelly', { duration: result === 'over' ? 0.5 : 0.45 });
}
