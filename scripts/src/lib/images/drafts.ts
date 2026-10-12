/**
 * Where image drafts come from and where accepted images go.
 *
 * - Portraits: subject is characters/<id>/character.yaml chrome.portrait.prompt.
 *   Accepted to characters/<id>/portrait.png, recorded in the YAML.
 * - Covers: subject is seasons/<s>/chrome/<mission>.yaml imagePrompts.cover.
 *   Accepted to seasons/<s>/chrome/<mission>.cover.png.
 *
 * Candidates are staged under .image-drafts/ (git-ignored) with an index.html
 * to compare them. Nothing staged is used until a human accepts it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { kebabIdSchema } from '@league-of-taverns/engine';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { ValidationFailure } from '../main';
import { REPO_ROOT, loadCharacterChrome, loadCharacterRef, loadSnapshot, readYaml, rootDir } from '../repo';
import type { RepoRoot } from '../repo';
import { seasonDir } from '../season';
import { framingProblems } from './framing';
import { checkPainted, paintedProblems } from './paint';
import { pixelView } from './postprocess';
import { checkSprite } from './pixelate';
import { decodePng, encodeIndexedPng, pngSize } from './png';
import type { RgbaImage } from './png';
import { placeOnStage } from './stage';
import type { Placement } from './stage';
import { creatureSize, framingRules, glassAlpha, outputSize, paintedRules, paletteOf, pixelViewOptions } from './style';
import type { BodyPlan } from './body-plans';
import type { CreatureSize, ImageKind, ImageStyle, PortraitShape } from './style';

export interface DraftTarget {
  readonly kind: ImageKind;
  /** Character id, or mission id for covers. */
  readonly id: string;
  /** Covers only: the season the mission belongs to. */
  readonly season?: string;
  /** Portraits only: the base's creature size, which sets the canvas. */
  readonly size?: CreatureSize;
  /** Portraits only: the character's body plan. */
  readonly bodyPlan?: BodyPlan;
  /** Portraits only: see-through parts become glass. */
  readonly translucent?: boolean;
  /** Portraits only: standing height in feet, from chrome.height. */
  readonly heightFt?: number;
  readonly subject: string;
  /** Where an accepted image goes, absolute. */
  readonly destination: string;
}

export const DRAFTS_DIR = '.image-drafts';

// ── targets ────────────────────────────────────────────────────────────────

/**
 * Creature size by base slug, from a pinned snapshot: the one named, else the
 * newest in data/open5e/manifest.json (entries are appended in order).
 */
export function snapshotSizes(snapshotId?: string, root: RepoRoot = REPO_ROOT): (base: string) => CreatureSize | undefined {
  let id = snapshotId;
  if (id === undefined) {
    const manifest = JSON.parse(readFileSync(join(rootDir(root), 'data', 'open5e', 'manifest.json'), 'utf8')) as { snapshots?: Array<{ id: string }> };
    id = manifest.snapshots?.at(-1)?.id;
    if (id === undefined) throw new ValidationFailure('data/open5e/manifest.json lists no snapshots, so creature sizes are unknown');
  }
  const sizes = new Map(loadSnapshot(id, root).map((record) => [record.slug, creatureSize(record.size)]));
  return (base) => sizes.get(base);
}

/**
 * Portrait targets. Named characters are drafted whatever their status (an
 * explicit redo of a final portrait is allowed); `all` takes every character
 * whose portrait is at `prompt` or `draft`.
 */
export function portraitTargets(
  ids: ReadonlyArray<string> | 'all',
  sizeOf: (base: string) => CreatureSize | undefined,
  root: RepoRoot = REPO_ROOT,
): DraftTarget[] {
  const charactersDir = join(rootDir(root), 'characters');
  const all = ids === 'all';
  const names = all ? readdirSync(charactersDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : ids;
  const targets: DraftTarget[] = [];
  for (const id of names) {
    const chrome = loadCharacterChrome(id, root);
    const portrait = chrome.portrait;
    if (all && portrait?.status !== 'prompt' && portrait?.status !== 'draft') continue;
    if (portrait?.prompt === undefined) {
      throw new ValidationFailure(`characters/${id}/character.yaml: chrome.portrait.prompt is not set, so there is nothing to draw`);
    }
    const { base } = loadCharacterRef(id, root);
    const size = sizeOf(base);
    if (size === undefined) throw new ValidationFailure(`characters/${id}/character.yaml: base ${JSON.stringify(base)} is not in the snapshot, so its size is unknown`);
    targets.push({
      kind: 'portrait',
      id,
      size,
      bodyPlan: portrait.bodyPlan ?? 'humanoid',
      translucent: portrait.translucent === true,
      ...(chrome.height === undefined ? {} : { heightFt: chrome.height }),
      subject: portrait.prompt, destination: join(charactersDir, id, 'portrait.png') });
  }
  return targets;
}

const coverChromeSchema = z.looseObject({
  mission: kebabIdSchema,
  imagePrompts: z.looseObject({ cover: z.string().min(1).optional() }).optional(),
});

/** Cover targets: every mission chrome file in the season with an imagePrompts.cover, optionally filtered. */
export function coverTargets(season: string, missions: ReadonlyArray<string> = [], root: RepoRoot = REPO_ROOT): DraftTarget[] {
  const dir = join(seasonDir(season, root), 'chrome');
  const targets: DraftTarget[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml') && f !== 'throughlines.yaml').sort()) {
    const label = relative(rootDir(root), join(dir, file));
    const parsed = coverChromeSchema.safeParse(readYaml(join(dir, file), label));
    if (!parsed.success) throw new ValidationFailure(`${label}: not a mission chrome file (needs mission: <id>)`);
    const { mission, imagePrompts } = parsed.data;
    if (missions.length > 0 && !missions.includes(mission)) continue;
    if (imagePrompts?.cover === undefined) {
      if (missions.includes(mission)) throw new ValidationFailure(`${label}: imagePrompts.cover is not set, so there is nothing to draw`);
      continue;
    }
    targets.push({ kind: 'cover', id: mission, season, subject: imagePrompts.cover, destination: join(dir, `${mission}.cover.png`) });
  }
  const unknown = missions.filter((m) => !targets.some((t) => t.id === m));
  if (unknown.length > 0) throw new ValidationFailure(`no chrome with an imagePrompts.cover for ${unknown.join(', ')} in ${relative(rootDir(root), dir)}`);
  return targets;
}

/** A portrait target's shape, for canvas size, framing and checks. */
export function shapeOfTarget(target: DraftTarget): PortraitShape | undefined {
  if (target.size === undefined) return undefined;
  return {
    size: target.size,
    ...(target.bodyPlan === undefined ? {} : { plan: target.bodyPlan }),
    ...(target.heightFt === undefined ? {} : { heightFt: target.heightFt }),
  };
}

// ── seeds and staging ──────────────────────────────────────────────────────

type TargetKey = Pick<DraftTarget, 'kind' | 'id' | 'season'>;

/** Staging folder segments: portrait/<id> or cover/<season>/<mission>. */
function stagingSegments(target: TargetKey): string[] {
  return target.kind === 'portrait' ? ['portrait', target.id] : ['cover', target.season ?? '_', target.id];
}

/** A stable starting seed per target, so re-running gives the same candidates unless --seed says otherwise. */
export function defaultSeed(target: TargetKey): number {
  let hash = 0x811c9dc5;
  for (const ch of stagingSegments(target).join(':')) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 1_000_000_000;
}

export function stagedPaths(target: TargetKey, seed: number, root: RepoRoot = REPO_ROOT): { sprite: string; render: string; framing: string } {
  const dir = join(rootDir(root), DRAFTS_DIR, ...stagingSegments(target));
  return { sprite: join(dir, `s${seed}.png`), render: join(dir, `s${seed}.render.png`), framing: join(dir, `s${seed}.framing.json`) };
}

/**
 * Problems that would stop a staged candidate from going on the stage (none
 * for covers). Pixel: the card's framing (./framing.ts). Painted: the cut-out
 * render, before trimming, must hold one whole figure (./paint.ts).
 */
export function candidateProblems(target: DraftTarget, sprite: Uint8Array, style: ImageStyle, render: Uint8Array): string[] {
  if (target.kind !== 'portrait' || target.size === undefined) return [];
  if (style.mode === 'painted') return paintedProblems(decodePng(render), paintedRules(style));
  return framingProblems(decodePng(sprite), framingRules(style, shapeOfTarget(target)!));
}

/** What the review page needs about a staged candidate. */
interface StagedFraming {
  readonly problems: ReadonlyArray<string>;
  /** Pixel portraits: rows the bar hides; 0 means the card stands on top of the bar. */
  readonly counter?: number;
  /** Painted portraits with a height: where the figure stands on the stage, and the height it stands for. */
  readonly placement?: Placement & { readonly heightFt: number };
}

/** Stage a candidate with its framing problems, for the review page. Returns the problems. */
export function stage(target: DraftTarget, seed: number, render: Uint8Array, sprite: Uint8Array, style: ImageStyle, root: RepoRoot = REPO_ROOT): string[] {
  const paths = stagedPaths(target, seed, root);
  const problems = candidateProblems(target, sprite, style, render);
  const portrait = target.kind === 'portrait' && target.size !== undefined;
  const framing: StagedFraming = !portrait
    ? { problems }
    : style.mode === 'pixel'
      ? { problems, counter: framingRules(style, shapeOfTarget(target)!).counter }
      : target.heightFt === undefined
        ? { problems }
        : { problems, placement: { ...placeOnStage(style, target.size!, target.heightFt), heightFt: target.heightFt } };
  mkdirSync(dirname(paths.sprite), { recursive: true });
  writeFileSync(paths.render, render);
  writeFileSync(paths.sprite, sprite);
  writeFileSync(paths.framing, `${JSON.stringify(framing)}\n`);
  // Post-processed views of a painted portrait, at the size the stage draws it, for the review page.
  if (framing.placement !== undefined && problems.length === 0) {
    const original = decodePng(sprite);
    for (const name of Object.keys(style.painted.views)) {
      const view = pixelView(original, pixelViewOptions(style, name, framing.placement.shownFt, target.translucent));
      writeFileSync(viewPath(paths.sprite, name), encodeIndexedPng(view));
    }
  }
  return problems;
}

/** A staged view of a candidate: s<seed>.<view>.png beside s<seed>.png. */
function viewPath(sprite: string, name: string): string {
  return sprite.replace(/\.png$/, `.${name}.png`);
}

/** Stage an imported image as a candidate, remembering its source file for accept. */
export function stageImport(
  target: DraftTarget,
  seed: number,
  from: string,
  render: Uint8Array,
  sprite: Uint8Array,
  style: ImageStyle,
  root: RepoRoot = REPO_ROOT,
): string[] {
  const problems = stage(target, seed, render, sprite, style, root);
  writeFileSync(importRecord(stagedPaths(target, seed, root).sprite), `${JSON.stringify({ from })}\n`);
  return problems;
}

function importRecord(sprite: string): string {
  return sprite.replace(/\.png$/, '.import.json');
}

// ── accept ─────────────────────────────────────────────────────────────────

/**
 * Copy a staged candidate into the repo. For a portrait, also record it in
 * character.yaml (status draft, path, seed), keeping the file's comments.
 * Returns the destination, relative to the root.
 */
export function accept(target: DraftTarget, seed: number, style: ImageStyle, root: RepoRoot = REPO_ROOT, force = false): string {
  const staged = stagedPaths(target, seed, root).sprite;
  if (!existsSync(staged)) {
    throw new ValidationFailure(`no staged ${target.kind} for ${target.id} with seed ${seed} (looked for ${relative(rootDir(root), staged)})`);
  }
  const problems = storedImageProblems(decodePng(readFileSync(staged)), target.kind, shapeOfTarget(target), target.translucent, style);
  if (problems.length > 0) throw new ValidationFailure(`${relative(rootDir(root), staged)} ${problems.join('; ')}`);
  const render = stagedPaths(target, seed, root).render;
  const framing = candidateProblems(target, readFileSync(staged), style, existsSync(render) ? readFileSync(render) : new Uint8Array());
  if (framing.length > 0 && !force) {
    throw new ValidationFailure(
      `${relative(rootDir(root), staged)} can't be layered cleanly: it ${framing.join('; ')}. Pick another seed, or pass --force to accept it anyway.`,
    );
  }
  copyFileSync(staged, target.destination);

  if (target.kind === 'portrait') {
    const yamlFile = join(dirname(target.destination), 'character.yaml');
    const doc = parseDocument(readFileSync(yamlFile, 'utf8'));
    doc.setIn(['chrome', 'portrait', 'status'], 'draft');
    doc.setIn(['chrome', 'portrait', 'path'], basename(target.destination));
    const record = importRecord(staged);
    if (existsSync(record)) {
      doc.setIn(['chrome', 'portrait', 'imported'], (JSON.parse(readFileSync(record, 'utf8')) as { from: string }).from);
      doc.deleteIn(['chrome', 'portrait', 'seed']);
    } else {
      doc.setIn(['chrome', 'portrait', 'seed'], seed);
      doc.deleteIn(['chrome', 'portrait', 'imported']);
    }
    writeFileSync(yamlFile, doc.toString({ lineWidth: 0 }));
  }
  return relative(rootDir(root), target.destination);
}

/**
 * Whether a stored image is what the style makes. Pixel: a palette sprite of
 * the canvas size. Painted: a portrait trimmed to one figure, or an opaque
 * cover of the output size.
 */
export function storedImageProblems(
  image: RgbaImage,
  kind: ImageKind,
  shape: PortraitShape | undefined,
  translucent: boolean | undefined,
  style: ImageStyle,
): string[] {
  if (style.mode === 'painted') {
    return kind === 'cover' ? checkPainted(image, style.painted.cover.render) : checkPainted(image, 'portrait', paintedRules(style));
  }
  return checkSprite(image, outputSize(style, kind, shape), paletteOf(style, kind), glassAlpha(style, kind, translucent));
}

// ── review page ────────────────────────────────────────────────────────────

/** Rewrite .image-drafts/index.html: every staged candidate, scaled up, with the command that accepts it. */
export function writeReviewPage(style: ImageStyle, root: RepoRoot = REPO_ROOT): string {
  const base = join(rootDir(root), DRAFTS_DIR);
  const staged: TargetKey[] = [];
  const subdirs = (...segments: string[]): string[] => {
    const dir = join(base, ...segments);
    return existsSync(dir)
      ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && kebabIdSchema.safeParse(d.name).success).map((d) => d.name).sort()
      : [];
  };
  for (const id of subdirs('portrait')) staged.push({ kind: 'portrait', id });
  for (const season of subdirs('cover')) for (const id of subdirs('cover', season)) staged.push({ kind: 'cover', id, season });

  const sections = staged.map((target) => {
    const segments = stagingSegments(target);
    const seeds = readdirSync(join(base, ...segments))
      .map((f) => /^s(\d+)\.png$/.exec(f)?.[1])
      .filter((seed): seed is string => seed !== undefined)
      .sort((a, b) => Number(a) - Number(b));
    const scale = style.mode === 'painted' ? 1 : target.kind === 'portrait' ? 3 : 4;
    const which = target.kind === 'portrait' ? `--character ${target.id}` : `--season ${target.season} --mission ${target.id}`;
    const cards = seeds.map((seed) => {
      const src = `${segments.join('/')}/s${seed}`;
      const framing = readFraming(join(base, `${src}.framing.json`));
      const alt = `${target.kind} ${target.id} seed ${seed}`;
      const card = framing?.placement !== undefined ? stageCard(`${src}.png`, alt, framing.placement, style) : spriteCard(`${src}.png`, alt, join(base, `${src}.png`), framing?.counter, scale, style);
      const views = Object.keys(style.mode === 'painted' ? style.painted.views : {})
        .filter((name) => existsSync(viewPath(join(base, `${src}.png`), name)))
        .map((name) => {
          const { width, height } = pngSize(readFileSync(viewPath(join(base, `${src}.png`), name)));
          const zoom = Math.max(1, Math.floor(Math.min(160 / width, 240 / height)));
          return `<img class="sprite pixel" src="${viewPath(`${src}.png`, name)}" width="${width * zoom}" height="${height * zoom}" alt="${name} view" title="${name}">`;
        });
      return `<figure>
  ${card}
  ${views.length > 0 ? `<div class="views">${views.join('')}</div>` : ''}
  <img class="render" src="${src}.render.png" alt="raw render">
  ${framingNote(framing)}
  <figcaption>seed ${seed}<code>pnpm draft-images accept ${which} --seed ${seed}</code></figcaption>
</figure>`;
    });
    return `<section><h2>${target.kind}: ${target.season === undefined ? '' : `${target.season} / `}${target.id}</h2><div class="row">${cards.join('\n')}</div></section>`;
  });
  return writePage(base, sections);
}

/**
 * A staged image at its own size. Pixel portraits differ in size by creature
 * size, and show the bar as the scene will: in front of the card, or under a
 * card standing on it.
 */
function spriteCard(src: string, alt: string, file: string, counter: number | undefined, scale: number, style: ImageStyle): string {
  const { width, height } = pngSize(readFileSync(file));
  const bar =
    counter === undefined
      ? ''
      : counter > 0
        ? `<div class="bar" style="height:${counter * scale}px"></div>`
        : `<div class="bar under" style="height:${style.portrait.counter * scale}px"></div>`;
  const pixel = style.mode === 'pixel' ? ' pixel' : '';
  return `<div class="card"><img class="sprite${pixel}" src="${src}" width="${width * scale}" height="${height * scale}" alt="${alt}">${bar}</div>`;
}

/** Review-page pixels per foot on the painted stage. */
const FT = 32;
const BAR = 26;

/**
 * A painted portrait on a slice of the stage, at its true height
 * (./stage.ts): behind the bar, standing on it, or looming in from the left.
 */
function stageCard(src: string, alt: string, placement: NonNullable<StagedFraming['placement']>, style: ImageStyle): string {
  const { frameFt } = style.stage;
  const { where, shownFt, topFt, heightFt } = placement;
  const top = Math.round((frameFt - topFt) * FT);
  return `<div class="stage ${where}" style="height:${Math.round(frameFt * FT) + BAR}px">
    <img src="${src}" alt="${alt}" style="top:${top}px;height:${Math.round(shownFt * FT)}px">
    <div class="bar" style="height:${BAR}px"></div><span class="ft">${heightFt} ft</span>
  </div>`;
}

function writePage(base: string, sections: ReadonlyArray<string>): string {
  const page = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Image drafts</title>
<style>
  :root { color-scheme: dark; --tavern: #2b3a67; }
  body { margin: 0; padding: 16px; background: #141414; color: #ddd; font: 14px system-ui, sans-serif; }
  h2 { font-weight: 600; margin: 24px 0 8px; }
  .row { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; }
  figure { margin: 0; display: grid; gap: 6px; justify-items: start; }
  .sprite { background: var(--tavern); display: block; }
  .pixel { image-rendering: pixelated; }
  .stage { position: relative; width: 300px; overflow: hidden; background: var(--tavern); }
  .stage img { position: absolute; left: 50%; transform: translateX(-50%); }
  .stage.loom img { left: 0; transform: none; }
  .stage .bar { z-index: 1; }
  .stage.bar img { z-index: 2; }
  .views { display: flex; gap: 8px; align-items: flex-end; }
  .ft { position: absolute; z-index: 3; right: 6px; bottom: 4px; font-size: 12px; color: #f3d9a4; }
  .card { position: relative; }
  .bar { position: absolute; left: 0; right: 0; bottom: 0; background: #5a3a22; border-top: 3px solid #8a5a32; }
  .bar.under { position: static; }
  .render { width: 120px; opacity: 0.8; }
  .ok { color: #8c8; } .bad { color: #e88; max-width: 360px; }
  code { display: block; font-size: 11px; color: #9ab; user-select: all; max-width: 360px; overflow-wrap: anywhere; }
  label { position: sticky; top: 0; display: block; background: #141414; padding: 4px 0; }
</style>
<label>Backdrop <input type="color" value="#2b3a67" oninput="document.documentElement.style.setProperty('--tavern', this.value)"></label>
${sections.join('\n') || '<p>No drafts staged.</p>'}
`;
  const file = join(base, 'index.html');
  mkdirSync(base, { recursive: true });
  writeFileSync(file, page);
  return file;
}

function readFraming(file: string): StagedFraming | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as StagedFraming) : undefined;
}

function framingNote(framing: StagedFraming | undefined): string {
  if (framing === undefined) return '';
  const { problems } = framing;
  return problems.length === 0 ? '<span class="ok">layers cleanly</span>' : `<span class="bad">${problems.map((p) => `✗ ${p}`).join('<br>')}</span>`;
}
