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
import { checkSprite } from './pixelate';
import { decodePng, pngSize } from './png';
import { creatureSize, framingRules, glassAlpha, outputSize, paletteOf } from './style';
import type { BodyPlan } from './body-plans';
import type { CreatureSize, ImageKind, ImageStyle } from './style';

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
    const portrait = loadCharacterChrome(id, root).portrait;
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

/** Problems that would stop a staged candidate from being layered cleanly (none for covers). */
export function candidateProblems(target: DraftTarget, sprite: Uint8Array, style: ImageStyle): string[] {
  return target.kind === 'portrait' && target.size !== undefined ? framingProblems(decodePng(sprite), framingRules(style, target.size)) : [];
}

/** What the review page needs about a staged candidate. */
interface StagedFraming {
  readonly problems: ReadonlyArray<string>;
  /** Rows the bar hides; 0 means the card stands on top of the bar. Absent for covers. */
  readonly counter?: number;
}

/** Stage a candidate with its framing problems, for the review page. Returns the problems. */
export function stage(target: DraftTarget, seed: number, render: Uint8Array, sprite: Uint8Array, style: ImageStyle, root: RepoRoot = REPO_ROOT): string[] {
  const paths = stagedPaths(target, seed, root);
  const problems = candidateProblems(target, sprite, style);
  const framing: StagedFraming =
    target.kind === 'portrait' && target.size !== undefined ? { problems, counter: framingRules(style, target.size).counter } : { problems };
  mkdirSync(dirname(paths.sprite), { recursive: true });
  writeFileSync(paths.render, render);
  writeFileSync(paths.sprite, sprite);
  writeFileSync(paths.framing, `${JSON.stringify(framing)}\n`);
  return problems;
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
  const problems = checkSprite(
    decodePng(readFileSync(staged)),
    outputSize(style, target.kind, target.size),
    paletteOf(style),
    glassAlpha(style, target.kind, target.translucent),
  );
  if (problems.length > 0) throw new ValidationFailure(`${relative(rootDir(root), staged)} ${problems.join('; ')}`);
  const framing = candidateProblems(target, readFileSync(staged), style);
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
    doc.setIn(['chrome', 'portrait', 'seed'], seed);
    writeFileSync(yamlFile, doc.toString({ lineWidth: 0 }));
  }
  return relative(rootDir(root), target.destination);
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
    const scale = target.kind === 'portrait' ? 3 : 4;
    const which = target.kind === 'portrait' ? `--character ${target.id}` : `--season ${target.season} --mission ${target.id}`;
    const cards = seeds.map((seed) => {
      const src = `${segments.join('/')}/s${seed}`;
      // Portraits differ in size by creature size; show each at its own size so they compare as they'll appear.
      const { width, height } = pngSize(readFileSync(join(base, `${src}.png`)));
      // Portraits show the bar as the scene will: in front of the card, or under a card standing on it.
      const framing = readFraming(join(base, `${src}.framing.json`));
      const counter = framing?.counter;
      const bar =
        counter === undefined
          ? ''
          : counter > 0
            ? `<div class="bar" style="height:${counter * scale}px"></div>`
            : `<div class="bar under" style="height:${style.portrait.counter * scale}px"></div>`;
      return `<figure>
  <div class="card"><img class="sprite" src="${src}.png" width="${width * scale}" height="${height * scale}" alt="${target.kind} ${target.id} seed ${seed}">${bar}</div>
  <img class="render" src="${src}.render.png" alt="raw render">
  ${framingNote(framing)}
  <figcaption>seed ${seed}<code>pnpm draft-images accept ${which} --seed ${seed}</code></figcaption>
</figure>`;
    });
    return `<section><h2>${target.kind}: ${target.season === undefined ? '' : `${target.season} / `}${target.id}</h2><div class="row">${cards.join('\n')}</div></section>`;
  });
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
  .sprite { image-rendering: pixelated; background: var(--tavern); display: block; }
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
