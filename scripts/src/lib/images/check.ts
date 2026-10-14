/**
 * Checks for committed images (D-10: PNGs in plain git, capped per file).
 *
 * - A pooled character's portrait at `draft` or `final` must name a `path`.
 * - Any named portrait, and any seasons/<s>/chrome/<mission>.cover.png, must
 *   exist, be what the style's mode makes, and stay under its byte cap.
 *   Painted: a full-resolution portrait trimmed to one figure, or an opaque
 *   cover of the render size. Pixel: the canvas for
 *   the base's creature size, palette colours only, no partial transparency,
 *   and a card that layers cleanly (./framing.ts).
 * - A cover must sit next to its mission's chrome file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ValidationFailure } from '../main';
import { REPO_ROOT, loadCharacterChrome, rootDir } from '../repo';
import type { RepoRoot } from '../repo';
import { charactersRootDir, seasonDir } from '../season';
import type { SeasonSource } from '../season';
import { storedImageProblems } from './drafts';
import { framingProblems } from './framing';
import { PngError, decodePng } from './png';
import { framingRules, loadImageStyle } from './style';
import type { BodyPlan } from './body-plans';
import type { CreatureSize, ImageKind, ImageMode, ImageStyle, PortraitShape } from './style';

/**
 * Byte caps by mode and kind. A pixel sprite is a few KB. A painted original
 * is kept at full resolution and colour: about 0.9 MB a portrait and 1.4 MB a
 * cover. Anything over didn't come from draft-images.
 */
export const MAX_IMAGE_BYTES: Readonly<Record<ImageMode, Readonly<Record<ImageKind, number>>>> = {
  pixel: { portrait: 32 * 1024, cover: 32 * 1024 },
  painted: { portrait: 1536 * 1024, cover: 2048 * 1024 },
};

/** A pooled character and its base's creature size (undefined when the base isn't in the snapshot). */
export interface PooledPortrait {
  readonly id: string;
  readonly size: CreatureSize | undefined;
}

export function checkSeasonImages(season: SeasonSource, characters: ReadonlyArray<PooledPortrait>, root: RepoRoot = REPO_ROOT): string[] {
  const issues: string[] = [];
  const images: Array<{ readonly file: string; readonly kind: ImageKind; readonly size?: CreatureSize; readonly translucent?: boolean; readonly plan?: BodyPlan; readonly heightFt?: number }> = [];
  const label = (file: string): string => relative(rootDir(root), file);

  const charactersRoot = charactersRootDir(season, root);
  for (const { id, size } of characters) {
    let portrait;
    let heightFt: number | undefined;
    try {
      const chrome = loadCharacterChrome(id, charactersRoot);
      portrait = chrome.portrait;
      heightFt = chrome.height;
    } catch (error) {
      if (error instanceof ValidationFailure) continue; // the pool check already reports unreadable characters
      throw error;
    }
    const yamlLabel = label(join(charactersRoot, 'characters', id, 'character.yaml'));
    if (portrait === undefined) continue;
    if ((portrait.status === 'draft' || portrait.status === 'final') && portrait.path === undefined) {
      issues.push(`${yamlLabel}: chrome.portrait: status is ${portrait.status} but no path is set`);
    }
    // An unknown base is already reported by the pool check; its size can't be checked.
    if (portrait.path !== undefined && size !== undefined) {
      images.push({ file: join(charactersRoot, 'characters', id, portrait.path), kind: 'portrait', size, translucent: portrait.translucent === true, plan: portrait.bodyPlan ?? 'humanoid', ...(heightFt === undefined ? {} : { heightFt }) });
    }
  }

  const chromeDir = join(seasonDir(season, root), 'chrome');
  if (existsSync(chromeDir)) {
    for (const file of readdirSync(chromeDir).filter((f) => f.endsWith('.cover.png')).sort()) {
      const mission = file.slice(0, -'.cover.png'.length);
      if (!existsSync(join(chromeDir, `${mission}.yaml`))) {
        issues.push(`${label(join(chromeDir, file))}: no ${mission}.yaml chrome file next to it`);
      }
      images.push({ file: join(chromeDir, file), kind: 'cover' });
    }
  }
  if (images.length === 0) return issues;

  // Only now load the style: a season without images doesn't need one.
  let style: ImageStyle;
  try {
    style = loadImageStyle(root);
  } catch (error) {
    if (!(error instanceof ValidationFailure)) throw error;
    return [...issues, ...error.message.split('\n')];
  }
  for (const { file, kind, size, translucent, plan, heightFt } of images) {
    const shape = size === undefined ? undefined : { size, ...(plan === undefined ? {} : { plan }), ...(heightFt === undefined ? {} : { heightFt }) };
    issues.push(...checkImageFile(file, kind, shape, translucent, style, label));
  }
  return issues;
}

function checkImageFile(
  file: string,
  kind: ImageKind,
  shape: PortraitShape | undefined,
  translucent: boolean | undefined,
  style: ImageStyle,
  label: (file: string) => string,
): string[] {
  if (!existsSync(file)) return [`${label(file)}: file not found`];
  const bytes = statSync(file).size;
  const cap = MAX_IMAGE_BYTES[style.mode][kind];
  if (bytes > cap) {
    return [`${label(file)}: ${Math.round(bytes / 1024)} KB, over the ${cap / 1024} KB limit for a ${style.mode} ${kind}; images must come from draft-images`];
  }
  try {
    const image = decodePng(readFileSync(file));
    const problems = storedImageProblems(image, kind, shape, translucent, style);
    if (style.mode === 'pixel' && shape !== undefined && problems.length === 0) problems.push(...framingProblems(image, framingRules(style, shape)));
    return problems.map((p) => `${label(file)}: ${p}`);
  } catch (error) {
    if (error instanceof PngError) return [`${label(file)}: ${error.message}`];
    throw error;
  }
}
