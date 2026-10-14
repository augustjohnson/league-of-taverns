import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BANNER_TEXTURES, PALE_LUMINANCE, luminance } from '../src/lib/god-schema';
import { ValidationFailure } from '../src/lib/main';
import { loadGodChrome } from '../src/lib/repo';

let root: string;

/** Write gods/<folder>/god.yaml under the temp root. */
function fixture(folder: string, yaml: string): void {
  mkdirSync(join(root, 'gods', folder), { recursive: true });
  writeFileSync(join(root, 'gods', folder, 'god.yaml'), yaml);
}

const banner = (fields: string): string => `  banner:\n${fields}`;
const okBanner = banner("    field: '#d4e6f7'\n    charge: '#f5e9a8'\n    mark: '#2a78d6'\n    texture: rain\n");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lot-gods-'));
  fixture('the-gull', `id: the-gull\nchrome:\n  name: The Gull\n${okBanner}`);
  fixture('wrong-folder', `id: right-name\nchrome:\n  name: Oops\n${okBanner}`);
  fixture('the-murk', `id: the-murk\nchrome:\n  name: The Murk\n${banner("    field: '#30402a'\n    charge: '#F5E9A8'\n    mark: '#2a78d6'\n    texture: plaid\n")}`);
  fixture('the-blank', 'id: the-blank\nchrome:\n  name: The Blank\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('god files', () => {
  it("loads season-01's god", () => {
    const chrome = loadGodChrome('the-drowned-saint');
    expect(chrome.name).toBe('The Drowned Saint');
    expect(chrome.banner.texture).toBe('waves');
  });

  it('loads every mock-season god, each with its own mark', () => {
    const dir = 'sims/fixtures/mock-season';
    const gods = readdirSync(join(dir, 'gods'));
    expect(gods).toHaveLength(6);
    const marks = gods.map((god) => loadGodChrome(god, dir).banner.mark);
    expect(new Set(marks).size).toBe(gods.length);
  });

  it('accepts a file without a call', () => {
    expect(loadGodChrome('the-gull', root)).toEqual({
      name: 'The Gull',
      banner: { field: '#d4e6f7', charge: '#f5e9a8', mark: '#2a78d6', texture: 'rain' },
    });
  });

  it('rejects a folder name that differs from the id', () => {
    expect(() => loadGodChrome('wrong-folder', root)).toThrow(ValidationFailure);
    expect(() => loadGodChrome('wrong-folder', root)).toThrow('gods/wrong-folder/god.yaml: id: "right-name" does not match its folder name "wrong-folder"');
  });

  it('reports a dark fill, an uppercase colour and an unknown texture', () => {
    let message = '';
    try {
      loadGodChrome('the-murk', root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split('\n')).toEqual([
      expect.stringMatching(/^gods\/the-murk\/god\.yaml: chrome\.banner\.field: too dark/),
      expect.stringMatching(/^gods\/the-murk\/god\.yaml: chrome\.banner\.charge: expected a lowercase colour/),
      expect.stringMatching(/^gods\/the-murk\/god\.yaml: chrome\.banner\.texture: /),
    ]);
  });

  it('requires a banner', () => {
    expect(() => loadGodChrome('the-blank', root)).toThrow(/^gods\/the-blank\/god\.yaml: chrome\.banner: /);
  });

  it('measures luminance on the WCAG scale', () => {
    expect(luminance('#000000')).toBe(0);
    expect(luminance('#ffffff')).toBeCloseTo(1, 10);
    expect(luminance('#d4e6f7')).toBeGreaterThan(PALE_LUMINANCE);
    expect(BANNER_TEXTURES).toContain('rain');
  });
});
