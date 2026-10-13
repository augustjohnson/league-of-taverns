/**
 * The recruiting bundle: everything a recruiting page needs about a season's
 * characters, packaged as plain files for a UI built elsewhere. It is
 * derived from committed files but committed itself, at
 * seasons/<season>/recruiting/, so the UI can read it from the repo; rerun
 * package-characters after changing a character.
 *
 *   <out>/characters.json          the manifest (RecruitingBundle below)
 *   <out>/portraits/<id>.png       web-sized painted portrait (docs/images.md § Post-processing)
 *   <out>/portraits/<id>.<view>.png  each pixel view, at the size the stage draws the figure
 *
 * A season's characters are those whose `debut` is the season, plus any in
 * its pool.yaml. Stats come from the season's pinned snapshot, untouched; the
 * story is the character's backstory.md without the repo's chrome-only note.
 * Format: docs/schema.md § Recruiting bundle.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { indexSnapshot } from '@league-of-taverns/engine';
import type { Open5eMonster } from '@league-of-taverns/engine';
import { characterFileSchema } from './character-schema';
import { pixelView, webImage } from './images/postprocess';
import { decodePng, encodeIndexedPng } from './images/png';
import { placeOnStage } from './images/stage';
import type { Placement } from './images/stage';
import { creatureSize, loadImageStyle, pixelViewOptions } from './images/style';
import type { CreatureSize } from './images/style';
import { ValidationFailure } from './main';
import { REPO_ROOT, loadSnapshot, readYaml, rootDir } from './repo';
import type { RepoRoot } from './repo';
import { charactersRootDir, loadPool, loadSeasonConfig } from './season';

export const RECRUITING_FORMAT = 1;

/** Web copies: longest side and colour budget. */
const WEB = { longSide: 640, colors: 256 } as const;

export interface RecruitingImage {
  /** Path inside the bundle. */
  readonly file: string;
  readonly width: number;
  readonly height: number;
}

export interface RecruitingCharacter {
  readonly id: string;
  readonly name: string;
  readonly epithet?: string;
  readonly tagline?: string;
  readonly pronouns?: { readonly subject: string; readonly object: string; readonly possessive: string };
  /** Paragraphs separated by a blank line, each on one line; may hold markdown emphasis. */
  readonly story?: string;
  readonly heightFt?: number;
  /** In this season's pool.yaml (drafting can't start until every recruit is). */
  readonly pooled: boolean;
  /** Season modifiers from pool.yaml, as written there. */
  readonly modifiers: ReadonlyArray<unknown>;
  /** The base creature, from the season's snapshot. */
  readonly base: {
    readonly slug: string;
    readonly name: string;
    readonly size: string;
    readonly type: string;
    readonly subtype: string;
    readonly alignment: string;
    /** Display form, e.g. "1/2". */
    readonly cr: string;
    readonly crValue: number;
    readonly armorClass: number;
    readonly hitPoints: number;
    readonly hitDice: string;
    readonly speed: Readonly<Record<string, unknown>>;
    readonly abilities: { readonly str: number; readonly dex: number; readonly con: number; readonly int: number; readonly wis: number; readonly cha: number };
    readonly skills: Readonly<Record<string, number>>;
    readonly senses: string;
    readonly languages: string;
  };
  readonly portrait?: {
    /** The committed painted original, repo-relative. */
    readonly original: string;
    readonly web: RecruitingImage;
    /** Pixel views (style painted.views), keyed by view name, at the size the stage draws the figure. */
    readonly views: Readonly<Record<string, RecruitingImage & { readonly pxPerFt: number }>>;
    readonly translucent: boolean;
    /** Where the figure stands behind the bar (scripts/src/lib/images/stage.ts). Absent without a height. */
    readonly stage?: Placement;
  };
}

export interface RecruitingBundle {
  readonly format: typeof RECRUITING_FORMAT;
  readonly season: string;
  readonly snapshot: string;
  /** The stage every placement assumes: feet above the floor and how much of the room the frame shows. */
  readonly stage: { readonly barFt: number; readonly frameFt: number };
  readonly characters: ReadonlyArray<RecruitingCharacter>;
}

/** The chrome-only note every backstory.md ends with; it's for repo readers, not the page. */
const CHROME_NOTE = /\n*\*Chrome only\.[^*]*\*\s*$/;

/** Build the bundle into `outDir` (its portraits/ is replaced). Returns the manifest. */
export function buildRecruitingBundle(season: string, outDir: string, root: RepoRoot = REPO_ROOT): RecruitingBundle {
  const style = loadImageStyle(root);
  if (style.mode !== 'painted') throw new ValidationFailure('the recruiting bundle needs painted portraits (content/images/style.yaml mode: painted)');
  const { config } = loadSeasonConfig(season, root);
  const bySlug = indexSnapshot(loadSnapshot(config.snapshot, root));
  const pooled = new Map(loadPool(season, root).characters.map((c) => [c.ref.id, c.modifiers]));
  const charactersRoot = charactersRootDir(season, root);
  const charactersDir = join(charactersRoot, 'characters');

  const ids = readdirSync(charactersDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(charactersDir, d.name, 'character.yaml')))
    .map((d) => d.name)
    .sort();
  const files = new Map(ids.map((id) => [id, readCharacter(join(charactersDir, id, 'character.yaml'), root)]));
  const recruits = ids.filter((id) => pooled.has(id) || (files.get(id)!.debut === season && files.get(id)!.status === 'active'));

  mkdirSync(outDir, { recursive: true });
  rmSync(join(outDir, 'portraits'), { recursive: true, force: true });
  mkdirSync(join(outDir, 'portraits'));

  const characters = recruits.map((id): RecruitingCharacter => {
    const file = files.get(id)!;
    const { chrome } = file;
    const record = bySlug.get(file.base);
    if (record === undefined) throw new ValidationFailure(`characters/${id}: base ${JSON.stringify(file.base)} is not in snapshot ${config.snapshot}`);
    const size = creatureSize(record.size);
    const story = chrome.backstory === undefined ? undefined : readStory(join(charactersDir, id, chrome.backstory));
    return {
      id,
      name: chrome.name,
      ...(chrome.epithet === undefined ? {} : { epithet: chrome.epithet }),
      ...(chrome.tagline === undefined ? {} : { tagline: chrome.tagline }),
      ...(chrome.pronouns === undefined ? {} : { pronouns: chrome.pronouns }),
      ...(story === undefined ? {} : { story }),
      ...(chrome.height === undefined ? {} : { heightFt: chrome.height }),
      pooled: pooled.has(id),
      modifiers: pooled.get(id) ?? [],
      base: baseOf(record),
      ...(chrome.portrait?.path === undefined || size === undefined
        ? {}
        : { portrait: packagePortrait(id, join(charactersDir, id, chrome.portrait.path), chrome.portrait.translucent === true, size, chrome.height) }),
    };
  });

  function packagePortrait(id: string, path: string, translucent: boolean, size: CreatureSize, heightFt: number | undefined): NonNullable<RecruitingCharacter['portrait']> {
    const original = decodePng(readFileSync(path));
    const write = (name: string, image: ReturnType<typeof webImage>): RecruitingImage => {
      const file = `portraits/${name}`;
      writeFileSync(join(outDir, file), encodeIndexedPng(image));
      return { file, width: image.width, height: image.height };
    };
    const web = write(`${id}.png`, webImage(original, WEB.longSide, WEB.colors));
    const stage = heightFt === undefined ? undefined : placeOnStage(style, size, heightFt);
    const views: Record<string, RecruitingImage & { pxPerFt: number }> = {};
    if (stage !== undefined) {
      for (const [name, view] of Object.entries(style.painted.views)) {
        views[name] = { ...write(`${id}.${name}.png`, pixelView(original, pixelViewOptions(style, name, stage.shownFt, translucent))), pxPerFt: view.pxPerFt };
      }
    }
    return { original: relative(rootDir(root), path), web, views, translucent, ...(stage === undefined ? {} : { stage }) };
  }

  const bundle: RecruitingBundle = {
    format: RECRUITING_FORMAT,
    season,
    snapshot: config.snapshot,
    stage: { barFt: style.stage.barFt, frameFt: style.stage.frameFt },
    characters,
  };
  writeFileSync(join(outDir, 'characters.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function readCharacter(file: string, root: RepoRoot) {
  const label = relative(rootDir(root), file);
  const parsed = characterFileSchema.safeParse(readYaml(file, label));
  if (!parsed.success) throw new ValidationFailure(`${label}: not a valid character file; run validate`);
  return parsed.data;
}

/** The story as paragraphs separated by one blank line, each on a single line (markdown kept, hard wraps removed). */
function readStory(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(CHROME_NOTE, '')
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .join('\n\n');
}

function baseOf(record: Open5eMonster): RecruitingCharacter['base'] {
  return {
    slug: record.slug,
    name: record.name,
    size: record.size,
    type: record.type,
    subtype: record.subtype,
    alignment: record.alignment,
    cr: record.challenge_rating,
    crValue: record.cr,
    armorClass: record.armor_class,
    hitPoints: record.hit_points,
    hitDice: record.hit_dice,
    speed: record.speed as Readonly<Record<string, unknown>>,
    abilities: { str: record.strength, dex: record.dexterity, con: record.constitution, int: record.intelligence, wis: record.wisdom, cha: record.charisma },
    skills: record.skills,
    senses: record.senses,
    languages: record.languages,
  };
}
