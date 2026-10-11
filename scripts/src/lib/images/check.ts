/**
 * Checks for committed images (D-10: small palette PNGs in plain git).
 *
 * - A pooled character's portrait at `draft` or `final` must name a `path`.
 * - Any named portrait, and any seasons/<s>/chrome/<mission>.cover.png, must
 *   exist, be the style's output size, use only palette colours with no
 *   partial transparency, and stay under MAX_IMAGE_BYTES.
 * - A cover must sit next to its mission's chrome file.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { ValidationFailure } from '../main';
import { REPO_ROOT, loadCharacterChrome, rootDir } from '../repo';
import type { RepoRoot } from '../repo';
import { charactersRootDir, seasonDir } from '../season';
import type { SeasonSource } from '../season';
import { checkSprite } from './pixelate';
import { PngError, decodePng } from './png';
import { loadImageStyle, paletteOf } from './style';
import type { ImageKind, ImageStyle } from './style';

/** A palette sprite at league sizes is a few KB; anything near this is not one. */
export const MAX_IMAGE_BYTES = 32 * 1024;

export function checkSeasonImages(season: SeasonSource, characterIds: ReadonlyArray<string>, root: RepoRoot = REPO_ROOT): string[] {
  const issues: string[] = [];
  const images: Array<{ readonly file: string; readonly kind: ImageKind }> = [];
  const label = (file: string): string => relative(rootDir(root), file);

  const charactersRoot = charactersRootDir(season, root);
  for (const id of characterIds) {
    let portrait;
    try {
      portrait = loadCharacterChrome(id, charactersRoot).portrait;
    } catch (error) {
      if (error instanceof ValidationFailure) continue; // the pool check already reports unreadable characters
      throw error;
    }
    const yamlLabel = label(join(charactersRoot, 'characters', id, 'character.yaml'));
    if (portrait === undefined) continue;
    if ((portrait.status === 'draft' || portrait.status === 'final') && portrait.path === undefined) {
      issues.push(`${yamlLabel}: chrome.portrait: status is ${portrait.status} but no path is set`);
    }
    if (portrait.path !== undefined) images.push({ file: join(charactersRoot, 'characters', id, portrait.path), kind: 'portrait' });
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
  for (const { file, kind } of images) issues.push(...checkImageFile(file, kind, style, label));
  return issues;
}

function checkImageFile(file: string, kind: ImageKind, style: ImageStyle, label: (file: string) => string): string[] {
  if (!existsSync(file)) return [`${label(file)}: file not found`];
  const bytes = statSync(file).size;
  if (bytes > MAX_IMAGE_BYTES) {
    return [`${label(file)}: ${Math.round(bytes / 1024)} KB, over the ${MAX_IMAGE_BYTES / 1024} KB limit for a ${kind}; images must come from draft-images`];
  }
  try {
    return checkSprite(decodePng(readFileSync(file)), style[kind].output, paletteOf(style)).map((p) => `${label(file)}: ${p}`);
  } catch (error) {
    if (error instanceof PngError) return [`${label(file)}: ${error.message}`];
    throw error;
  }
}
