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

/** Milliseconds for each beat of a week's race: a rival's step, the pause before your run, your checks and battles, an ending line. */
const BEAT = { pip: 230, gap: 700, step: 380, check: 800, battle: 1400, tail: 900, count: 450, curse: 1500 } as const;
const BRASS = Color.fromHex('#d5aa4c');

/** Count `el` up (or down) to `target` over `ms`, eased; stops early if `stop()` says so. */
function countUp(el: HTMLElement | null, from: number, target: number, stop: () => boolean, ms = BEAT.count): void {
  if (el === null || Number.isNaN(target)) return;
  const start = performance.now();
  const tick = (now: number): void => {
    if (stop() || !el.isConnected) return;
    const t = Math.min(1, (now - start) / ms);
    el.textContent = String(Math.round(from + (target - from) * (1 - (1 - t) ** 3)));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Move `items` into `order` inside their parent, sliding each from where it stood (FLIP). */
function reorder(items: ReadonlyArray<HTMLElement>, order: ReadonlyArray<HTMLElement>, animate: boolean): void {
  const parent = items[0]?.parentElement;
  if (parent == null) return;
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
  for (const el of order) parent.append(el);
  if (!animate) return;
  for (const el of order) {
    const dy = (before.get(el) ?? 0) - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    el.style.transition = 'none';
    el.style.transform = `translateY(${dy}px)`;
  }
  void parent.offsetHeight;
  order.forEach((el, i) => {
    if (el.style.transform === '') return;
    el.style.transition = `transform 0.6s cubic-bezier(0.2, 0.7, 0.2, 1) ${0.04 * i}s`;
    el.style.transform = '';
    window.setTimeout(() => (el.style.transition = ''), 900);
  });
}

/**
 * A week's race in the Common Room (play.ts resultsHtml): every tavern's run
 * as a strip of steps, green for a pass or a win and red for a fail or a
 * loss, ending home, turned back or beaten.
 *
 * The lanes start in draft order with yours last, so the order gives nothing
 * away. The rivals' strips fill in together, a step a beat, each tavern's
 * loot landing as its strip ends. Then the scrying ball plays your run back
 * line by line: the die tumbles before it settles, the outcome lands, your
 * strip grows and the loot counter climbs; a DNF drains it to 0. Last, the
 * ranks show and the lanes slide into the week's order.
 *
 * The message already holds the whole result: this only holds pieces back
 * (while it is `.racing`) and brings them in, so a reload, a skip or reduced
 * motion shows the same thing. Resolves when it ends, skipped or not.
 */
export async function raceWeek(msg: HTMLElement, pace: Pacer): Promise<void> {
  const race = msg.querySelector<HTMLElement>('.race');
  if (race === null || reducedMotion()) return;
  // Watching again starts from nothing: whatever the last race showed is held back again.
  for (const el of msg.querySelectorAll('.shown')) el.classList.remove('shown');
  const { sleep } = pace;
  const lanes = [...race.querySelectorAll<HTMLElement>(':scope > .lane')];
  const num = (el: HTMLElement, key: string): number => Number(el.dataset[key] ?? 0);
  const ranked = [...lanes].sort((a, b) => num(a, 'rank') - num(b, 'rank') || num(a, 'order') - num(b, 'order'));
  const stop = (): boolean => pace.skipped || !msg.isConnected;

  const land = (lane: HTMLElement): void => {
    lane.querySelector('.run-end')?.classList.add('shown');
    const pts = lane.querySelector<HTMLElement>('.pts');
    if (pts === null) return;
    pts.classList.add('shown');
    countUp(pts, 0, num(pts, 'pts'), stop);
  };
  const finish = (): void => {
    if (!msg.isConnected) return;
    for (const el of msg.querySelectorAll('.rolling')) el.classList.remove('rolling');
    for (const pts of msg.querySelectorAll<HTMLElement>('.pts[data-pts]')) pts.textContent = pts.dataset.pts ?? pts.textContent;
    const counter = msg.querySelector<HTMLElement>('[data-loot]');
    if (counter !== null) counter.textContent = counter.dataset.loot ?? counter.textContent;
    msg.classList.remove('racing');
    reorder(lanes, ranked, !pace.skipped);
  };

  reorder(lanes, [...lanes].sort((a, b) => num(a, 'order') - num(b, 'order')), false);
  msg.classList.add('racing');

  // The rivals, together.
  const rivals = lanes.filter((l) => !l.classList.contains('mine'));
  const pips = new Map(rivals.map((l) => [l, [...l.querySelectorAll<HTMLElement>('.strip .pip')]]));
  const steps = Math.max(0, ...[...pips.values()].map((p) => p.length));
  for (const lane of rivals) if (pips.get(lane)!.length === 0) land(lane);
  for (let i = 0; i < steps && !stop(); i++) {
    for (const lane of rivals) {
      const row = pips.get(lane)!;
      row[i]?.classList.add('shown');
      if (i === row.length - 1) land(lane);
    }
    await sleep(BEAT.pip);
  }

  // Yours, in the scrying ball.
  const mine = lanes.find((l) => l.classList.contains('mine'));
  if (mine !== undefined && !stop()) {
    await sleep(BEAT.gap);
    const details = mine.querySelector('details');
    if (details !== null) details.open = true;
    const myPips = [...mine.querySelectorAll<HTMLElement>('.strip .pip')];
    const counter = msg.querySelector<HTMLElement>('[data-loot]');
    let shown = 0;
    if (counter !== null) counter.textContent = '0';
    const countTo = (target: number): void => {
      countUp(counter, shown, target, stop);
      shown = target;
    };
    /** Tumble the die for `ms`, then show what it really rolled. */
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
    for (const line of mine.querySelectorAll<HTMLElement>('.tale > li')) {
      if (stop()) break;
      line.classList.add('shown');
      line.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      if (line.dataset.head === 'curse') {
        micron(line, 'flicker', { duration: 0.8, delay: 0.2 });
        await sleep(BEAT.curse);
        continue;
      }
      if (line.dataset.tail !== undefined) {
        countTo(Number(line.dataset.total));
        if (line.dataset.tail === 'dnf') micron(counter, 'shake', { duration: 0.6 });
        if (line.dataset.tail === 'injury') micron(line.querySelector('[data-hurt]'), 'flicker', { duration: 0.7 });
        await sleep(BEAT.tail);
        continue;
      }
      line.classList.add('rolling');
      const die = line.querySelector<HTMLElement>('[data-roll]');
      await roll(die, line.dataset.kind === 'battle' ? BEAT.battle : BEAT.check);
      line.classList.remove('rolling');
      myPips[Number(line.dataset.step)]?.classList.add('shown');
      countTo(Number(line.dataset.total));
      // Small nods for good news: the loot tag pops, and a natural 20 throws a few sparks.
      micron(line.querySelector('[data-bank]'), 'pop', { duration: 0.4 });
      if (!stop() && die?.dataset.roll === 'd20' && die.textContent === '20') {
        sparkles(die, { count: variation.range(8, 12), size: variation.range(0.4, 0.8), speed: variation.range(60, 140), color: BRASS });
      }
      await sleep(BEAT.step);
    }
    for (const pip of myPips) pip.classList.add('shown');
    land(mine);
    await sleep(BEAT.count + 250);
  }
  finish();
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
 * The clock comes back to you: the rivals have picked (or chosen, or readied)
 * and it is your move, so the action bar glows once and its call to you
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
 * The CR meter answers a change to the lineup: a jelly when it still fits the
 * budget, a shake when it no longer does. Only the meter moves; the engine's
 * reason shows below it as before. A nod.
 */
export function nodMeter(meter: Element | null, result: 'fits' | 'over'): void {
  micron(meter, result === 'over' ? 'shake' : 'jelly', { duration: result === 'over' ? 0.5 : 0.45 });
}

/**
 * The table moves: each row starts where it stood last week (`data-was`)
 * and slides to where it stands now, a little after the one above it, so a
 * climb or a fall is felt every week and not only at the season's end. The
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
