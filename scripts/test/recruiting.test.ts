import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodePng, encodeRgbaPng } from '../src/lib/images/png';
import { loadImageStyle, stylePath } from '../src/lib/images/style';
import { buildRecruitingBundle } from '../src/lib/recruiting';
import type { RecruitingBundle } from '../src/lib/recruiting';
import { REPO_ROOT, rootDir } from '../src/lib/repo';

const repo = rootDir(REPO_ROOT);
const style = loadImageStyle();

/** A painted original: an opaque rust figure filling a w×h canvas. */
const figure = (w: number, h: number) => encodeRgbaPng({ width: w, height: h, data: Uint8Array.from({ length: w * h * 4 }, (_, i) => [180, 70, 40, 255][i % 4]!) });

describe('recruiting bundle', () => {
  let root: string;
  let out: string;

  const character = (id: string, base: string, debut: string, chrome: string, portrait = true) => {
    mkdirSync(join(root, 'characters', id), { recursive: true });
    writeFileSync(join(root, 'characters', id, 'character.yaml'), `id: ${id}\nbase: ${base}\nstatus: active\ndebut: ${debut}\nchrome:\n${chrome}`);
    if (portrait) writeFileSync(join(root, 'characters', id, 'portrait.png'), figure(60, 180));
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lot-recruiting-'));
    out = join(root, 'dist', 'recruiting', 's1');
    mkdirSync(join(root, 'content', 'images'), { recursive: true });
    writeFileSync(join(root, 'content', 'images', 'style.yaml'), readFileSync(stylePath(), 'utf8').replace(/^mode: \w+$/m, 'mode: painted'));
    cpSync(join(repo, 'data', 'open5e'), join(root, 'data', 'open5e'), { recursive: true });
    mkdirSync(join(root, 'seasons', 's1'), { recursive: true });
    writeFileSync(join(root, 'seasons', 's1', 'config.yaml'), readFileSync(join(repo, 'seasons', 'season-01', 'config.yaml'), 'utf8').replace(/^id: .*$/m, 'id: s1'));
    writeFileSync(join(root, 'seasons', 's1', 'pool.yaml'), 'season: s1\nregistry: 1\ncharacters:\n  - id: ogre-one\n    strategy: { kind: floater }\n    modifiers:\n      - { kind: trait, trait: thick-skull }\n');

    character(
      'ogre-one',
      'ogre',
      's1',
      '  name: One\n  epithet: the First\n  pronouns: { subject: he, object: him, possessive: his }\n  tagline: Uses doors.\n  backstory: backstory.md\n  height: 9\n  portrait:\n    status: draft\n    path: portrait.png\n',
    );
    writeFileSync(join(root, 'characters', 'ogre-one', 'backstory.md'), 'One walks in.\nThrough the door.\n\nEvery time.\n\n*Chrome only. Nothing in this file affects play.*\n');
    character('sprite-two', 'sprite', 's1', '  name: Two\n  height: 0.4\n  portrait:\n    status: draft\n    path: portrait.png\n    translucent: true\n');
    character('old-three', 'ogre', 's0', '  name: Three\n', false);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("packages the season's debuts and pool with stories, stats, portraits and placement", () => {
    const bundle = buildRecruitingBundle('s1', out, root);
    expect(bundle).toMatchObject({ format: 1, season: 's1', stage: { barFt: style.stage.barFt, frameFt: style.stage.frameFt } });
    expect(bundle.characters.map((c) => c.id)).toEqual(['ogre-one', 'sprite-two']);

    const [ogre, sprite] = bundle.characters;
    expect(ogre).toMatchObject({
      name: 'One',
      epithet: 'the First',
      tagline: 'Uses doors.',
      pronouns: { subject: 'he' },
      // Hard wraps go, paragraphs stay, the repo's chrome-only note is dropped.
      story: 'One walks in. Through the door.\n\nEvery time.',
      heightFt: 9,
      pooled: true,
      modifiers: [{ kind: 'trait', trait: 'thick-skull' }],
      base: { slug: 'ogre', name: 'Ogre', size: 'Large', cr: '2', crValue: 2 },
    });
    expect(ogre!.portrait).toMatchObject({ original: 'characters/ogre-one/portrait.png', web: { file: 'portraits/ogre-one.png' }, stage: { where: 'floor', shownFt: 9 } });
    expect(sprite).toMatchObject({ pooled: false, modifiers: [], portrait: { translucent: true, stage: { where: 'bar' } } });
    expect(sprite!.story).toBeUndefined();

    // Every file the manifest names exists, at the size it says; views are drawn at the stage's height.
    const manifest = JSON.parse(readFileSync(join(out, 'characters.json'), 'utf8')) as RecruitingBundle;
    expect(manifest).toEqual(bundle);
    for (const { portrait } of bundle.characters) {
      for (const image of [portrait!.web, ...Object.values(portrait!.views)]) {
        const png = decodePng(readFileSync(join(out, image.file)));
        expect([png.width, png.height]).toEqual([image.width, image.height]);
      }
    }
    for (const [name, view] of Object.entries(style.painted.views)) expect(ogre!.portrait!.views[name]!.height).toBe(9 * view.pxPerFt + 2);
    expect(existsSync(join(out, 'portraits', 'old-three.png'))).toBe(false);
  }, 30_000); // decodes painted portraits; slow while the suite runs other image work in parallel
});
