/**
 * You: your name and your tavern, under its banner. The site asks for them on
 * your first visit, before anything else, and the header's chip opens them
 * again at any time. A season in play keeps the tavern it started with.
 *
 * There is no sign-in yet: the profile is kept in this browser. The rest of
 * the page reads it through `getProfile()` and hears of changes through the
 * `lot:profile` event, so an account can take its place later.
 */
import { $, cryptoRand, esc, input, SITE_NAME, storageGet, storageSet } from './shared';
import { BANNER_CHOICES, KEEPER_NAME_MAX, TAVERN_WORD_MAX, bannerCss, checkProfile, tavernWord, tavernWords, type Profile } from './view';

const PROFILE_KEY = 'lot-player';

export const bannerChoice = (id: string): (typeof BANNER_CHOICES)[number] => BANNER_CHOICES.find((b) => b.id === id) ?? BANNER_CHOICES[0]!;
/** A profile's banner as a `data-banner` attribute: the `choice-<id>` banners below. */
export const choiceAttr = (p: Pick<Profile, 'banner'>): string => ` data-banner="choice-${esc(bannerChoice(p.banner).id)}"`;

// The banner choices' colours, once, as `choice-<id>` banners for the swatches, the preview and your chip.
const choiceStyle = document.createElement('style');
choiceStyle.textContent = bannerCss(Object.fromEntries(BANNER_CHOICES.map((b) => [`choice-${b.id}`, { banner: b.banner }])));
document.head.append(choiceStyle);

function loadProfile(): Profile | null {
  try {
    const p = JSON.parse(storageGet(PROFILE_KEY) ?? 'null') as Partial<Profile> | null;
    if (p === null || typeof p.name !== 'string' || typeof p.adjective !== 'string' || typeof p.noun !== 'string' || typeof p.banner !== 'string') return null;
    return checkProfile(p as Profile, input.taverns).profile ?? null;
  } catch {
    return null;
  }
}

let profile = loadProfile();

/** You, or null before your first visit is through. */
export const getProfile = (): Profile | null => profile;

// ── the sheet ──────────────────────────────────────────────────────────────

/** The sheet's form as typed, and what went wrong with it. */
const sheet = { form: profile ?? freshForm(), error: null as string | null };

/** A line for the sheet about the season in play, if any: the game sets it. */
let seasonNote: () => string | null = () => null;
export function noteSeason(note: () => string | null): void {
  seasonNote = note;
}

/** A blank form: a suggested tavern under a random banner. */
function freshForm(): Profile {
  return { name: '', ...tavernWords(cryptoRand), banner: BANNER_CHOICES[Math.floor(cryptoRand() * BANNER_CHOICES.length)]!.id };
}

/** Your tavern as the form has it, for the preview: its name (or a stand-in while a word is missing) and keeper. */
function previewOf(form: Profile): { readonly name: string; readonly keeper: string } {
  const word = (raw: string, stand: string): string => tavernWord(raw) ?? (raw.trim() === '' ? stand : raw.trim());
  return { name: `The ${word(form.adjective, '…')} ${word(form.noun, '…')}`, keeper: form.name.trim() === '' ? 'kept by you' : `kept by ${form.name.trim()}` };
}

function sheetHtml(): string {
  const f = sheet.form;
  const first = profile === null;
  const preview = previewOf(f);
  const note = first ? null : seasonNote();
  const banners = BANNER_CHOICES.map(
    (b) =>
      `<label class="bpick" data-banner="choice-${esc(b.id)}"><input type="radio" name="p-banner" value="${esc(b.id)}"${b.id === f.banner ? ' checked' : ''}>` +
      `<i class="flag" data-banner="choice-${esc(b.id)}" aria-hidden="true"></i><span>${esc(b.label)}</span></label>`,
  ).join('');
  return (
    `<form class="setup sheet-body" id="p-form" novalidate>` +
    (first
      ? `<div class="sheet-head"><p class="label">${esc(SITE_NAME)}</p><h2 id="p-title">Pull up a stool</h2></div>` +
        `<p>Every keeper here runs a tavern. Tell the regulars your name and your tavern's, and choose a banner to fly. You can change them later.</p>`
      : `<div class="sheet-head"><h2 id="p-title">You and your tavern</h2></div>`) +
    `<div class="field"><label class="label" for="p-name">Your name</label><input type="text" id="p-name" name="name" value="${esc(f.name)}" maxlength="${KEEPER_NAME_MAX}" autocomplete="nickname" spellcheck="false" placeholder="What the regulars call you"></div>` +
    `<div class="field"><span class="label" id="p-tavern-label">Your tavern</span><div class="tavern-name" role="group" aria-labelledby="p-tavern-label">` +
    `<span class="the">The</span>` +
    `<input type="text" id="p-adj" name="adjective" value="${esc(f.adjective)}" maxlength="${TAVERN_WORD_MAX}" aria-label="Adjective" placeholder="Adjective" spellcheck="false" autocomplete="off" autocapitalize="words">` +
    `<input type="text" id="p-noun" name="noun" value="${esc(f.noun)}" maxlength="${TAVERN_WORD_MAX}" aria-label="Noun" placeholder="Noun" spellcheck="false" autocomplete="off" autocapitalize="words">` +
    `<button type="button" class="small" id="p-suggest" title="Suggest a name">Suggest</button></div></div>` +
    `<fieldset class="field"><legend class="label">Your banner</legend><div class="bpicks">${banners}</div></fieldset>` +
    `<div class="you banner-card" id="p-preview"${choiceAttr(f)}><div class="pennant" aria-hidden="true"></div>` +
    `<div class="you-line"><i class="flag" aria-hidden="true"></i><b class="you-name" id="p-preview-name">${esc(preview.name)}</b><span class="small" id="p-preview-keeper">${esc(preview.keeper)}</span></div></div>` +
    (note === null ? '' : `<p class="hint">${esc(note)}</p>`) +
    (sheet.error === null ? '' : `<div class="error" role="alert">${esc(sheet.error)}</div>`) +
    `<div class="sheet-actions">` +
    (first ? '' : `<button type="button" id="p-cancel">Cancel</button>`) +
    `<button type="submit" class="primary">${first ? 'Take your seat' : 'Save'}</button></div>` +
    `<p class="hint">There are no accounts yet: your name and tavern are kept in this browser.</p>` +
    `</form>`
  );
}

/** Follow the form as you type, without re-rendering it. */
function updatePreview(): void {
  const p = previewOf(sheet.form);
  $('p-preview').dataset.banner = `choice-${bannerChoice(sheet.form.banner).id}`;
  $('p-preview-name').textContent = p.name;
  $('p-preview-keeper').textContent = p.keeper;
}

/** Open the sheet: your profile to change, or, on your first visit, a fresh one to fill in before anything else. */
export function openProfile(): void {
  const dialog = $<HTMLDialogElement>('profile');
  sheet.form = profile ?? sheet.form;
  sheet.error = null;
  dialog.innerHTML = sheetHtml();
  if (!dialog.open) dialog.showModal();
  if (profile === null) $('p-name').focus();
}

function save(): void {
  const { profile: next, error } = checkProfile(sheet.form, input.taverns);
  const dialog = $<HTMLDialogElement>('profile');
  if (next === undefined) {
    sheet.error = error ?? 'Your tavern is not ready.';
    dialog.innerHTML = sheetHtml();
    dialog.querySelector<HTMLElement>('[role="alert"]')?.scrollIntoView({ block: 'nearest' });
    return;
  }
  profile = next;
  sheet.form = next;
  storageSet(PROFILE_KEY, JSON.stringify(next));
  dialog.close();
  renderChip();
  document.dispatchEvent(new CustomEvent('lot:profile'));
}

/** The header's chip: your banner and your name, or an invitation before you have either. */
function renderChip(): void {
  const chip = $('me');
  chip.innerHTML =
    profile === null
      ? '<span>Take a seat</span>'
      : `<i class="flag"${choiceAttr(profile)} aria-hidden="true"></i><span>${esc(profile.name)}</span>`;
  chip.setAttribute('aria-label', profile === null ? 'Set up your profile' : `${profile.name}, The ${profile.adjective} ${profile.noun}: change your profile`);
}

/** Wire the sheet and the chip. On a first visit the sheet opens at once, and stays until it is filled in. */
export function initProfile(): void {
  const dialog = $<HTMLDialogElement>('profile');
  $('me').addEventListener('click', openProfile);
  dialog.addEventListener('submit', (ev) => {
    ev.preventDefault();
    save();
  });
  dialog.addEventListener('click', (ev) => {
    const id = (ev.target as HTMLElement).closest('button')?.id;
    if (id === 'p-cancel') dialog.close();
    if (id === 'p-suggest') {
      sheet.form = { ...sheet.form, ...tavernWords(cryptoRand) };
      $<HTMLInputElement>('p-adj').value = sheet.form.adjective;
      $<HTMLInputElement>('p-noun').value = sheet.form.noun;
      updatePreview();
    }
  });
  // Esc closes the sheet only once there is a profile to go back to.
  dialog.addEventListener('cancel', (ev) => {
    if (profile === null) ev.preventDefault();
  });
  dialog.addEventListener('input', (ev) => {
    const target = ev.target as HTMLInputElement;
    if (target.name === 'name' || target.name === 'adjective' || target.name === 'noun') sheet.form = { ...sheet.form, [target.name]: target.value };
    if (target.name === 'p-banner') sheet.form = { ...sheet.form, banner: target.value };
    updatePreview();
  });
  renderChip();
  if (profile === null) openProfile();
}
