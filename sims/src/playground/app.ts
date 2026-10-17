/**
 * The playground page: runs the real engine and bots in the browser.
 *
 * Plain TypeScript and DOM. The build script (../build-playground.ts) inlines
 * the season as `__PLAYGROUND_DATA__` ahead of this bundle. Every number on
 * the page comes from the engine or from the season runner, the same code
 * the CLI runs, so a seed here gives exactly the CLI's season.
 *
 * Two modes: the game (./play.ts), a season against the bots told in the
 * Common Room, which is what the page opens to; and the workshop
 * (./workshop.ts), the tools for checking the league by hand. Shared
 * rendering lives in ./shared.ts, pure helpers in ./view.ts and ./feed.ts.
 */
import { initGame, showGame } from './play';
import { $, config, esc, input, storageGet, storageSet } from './shared';
import { loadPlayedSeason, openWorkshop } from './workshop';

// Theme: auto → light → dark.
const THEMES = ['auto', 'light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
function applyTheme(theme: Theme): void {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  $('theme').textContent = `Theme: ${theme}`;
}
let theme: Theme = (THEMES as ReadonlyArray<string>).includes(storageGet('lot-playground-theme') ?? '') ? (storageGet('lot-playground-theme') as Theme) : 'auto';
applyTheme(theme);
$('theme').addEventListener('click', () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!;
  storageSet('lot-playground-theme', theme);
  applyTheme(theme);
});

// Mode: the game or the workshop.
type Mode = 'game' | 'workshop';
function showMode(mode: Mode): void {
  document.body.dataset.mode = mode;
  $('game').hidden = mode !== 'game';
  $('workshop').hidden = mode !== 'workshop';
  $('mode').textContent = mode === 'game' ? 'Workshop' : 'Back to the game';
  $('mode').title = mode === 'game' ? 'Tools for checking the league by hand' : 'Back to your season';
}
function setMode(mode: Mode): void {
  showMode(mode);
  storageSet('lot-playground-mode', mode);
  if (mode === 'workshop') openWorkshop();
  else showGame();
}
$('mode').addEventListener('click', () => setMode(document.body.dataset.mode === 'workshop' ? 'game' : 'workshop'));
document.addEventListener('lot:mode', (ev) => setMode((ev as CustomEvent<Mode>).detail));

$('subtitle').innerHTML =
  `<b>${esc(config.id)}</b> · ${config.weeks} weeks · ${input.managers.length} taverns · engine ${esc(input.engineVersion)}`;

// The game lays itself out in its own mode's frame, so the mode comes first. A finished season loads into the
// workshop's tabs, like a seed run.
const mode: Mode = storageGet('lot-playground-mode') === 'workshop' ? 'workshop' : 'game';
showMode(mode);
initGame({ onComplete: (s) => loadPlayedSeason(s.seed, () => s.finish()) });
if (mode === 'workshop') openWorkshop();
