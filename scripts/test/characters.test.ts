import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CharacterRef } from '@league-of-taverns/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CharacterChrome } from '../src/lib/character-schema';
import { ValidationFailure } from '../src/lib/main';
import { loadCharacterChrome, loadCharacterRef } from '../src/lib/repo';

// Type-level: CharacterRef has exactly `id` and `base`, so no chrome field can be typed onto it.
type Keys = keyof CharacterRef;
const _refKeys: [Keys] extends ['id' | 'base'] ? (['id' | 'base'] extends [Keys] ? true : never) : never = true;

let root: string;

/** Write characters/<folder>/character.yaml under the temp root. */
function fixture(folder: string, yaml: string): void {
  mkdirSync(join(root, 'characters', folder), { recursive: true });
  writeFileSync(join(root, 'characters', folder, 'character.yaml'), yaml);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lot-characters-'));
  fixture('minimal-mimic', 'id: minimal-mimic\nbase: mimic\nstatus: retired\nchrome:\n  name: Mim\n');
  fixture('wrong-folder', 'id: right-name\nbase: ogre\nstatus: active\nchrome:\n  name: Oops\n');
  fixture('nameless', 'id: nameless\nbase: ogre\nstatus: active\nchrome:\n  epithet: the Unnamed\n');
  fixture('bad-status', 'id: bad-status\nbase: ogre\nstatus: benched\nchrome:\n  name: Benny\n  nickname: B\n');
  fixture('not-yaml', 'id: [unclosed\n');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('character files', () => {
  it('loads Bruno as mechanical identity only', () => {
    const ref = loadCharacterRef('bruno-the-bruiser');
    expect(ref).toEqual({ id: 'bruno-the-bruiser', base: 'ogre' });
    expect(Object.keys(ref).sort()).toEqual(['base', 'id']);
    expect(_refKeys).toBe(true);
  });

  it("loads Bruno's chrome separately", () => {
    const chrome: CharacterChrome = loadCharacterChrome('bruno-the-bruiser');
    expect(chrome.name).toBe('Bruno');
    expect(chrome.epithet).toBe('the Bruiser');
    expect(chrome.pronouns).toEqual({ subject: 'he', object: 'him', possessive: 'his' });
    expect(chrome.portrait?.status).toBe('none');
    expect(chrome.history).toEqual([]);
  });

  it('accepts a file with only the required fields', () => {
    expect(loadCharacterRef('minimal-mimic', root)).toEqual({ id: 'minimal-mimic', base: 'mimic' });
    expect(loadCharacterChrome('minimal-mimic', root)).toEqual({ name: 'Mim' });
  });

  it('rejects a folder name that differs from the id', () => {
    expect(() => loadCharacterRef('wrong-folder', root)).toThrow(ValidationFailure);
    expect(() => loadCharacterRef('wrong-folder', root)).toThrow(
      'characters/wrong-folder/character.yaml: id: "right-name" does not match its folder name "wrong-folder"',
    );
    expect(() => loadCharacterChrome('wrong-folder', root)).toThrow('does not match its folder name');
  });

  it('rejects a missing chrome.name, naming the file and field', () => {
    expect(() => loadCharacterRef('nameless', root)).toThrow(/^characters\/nameless\/character\.yaml: chrome\.name: /);
  });

  it('reports every bad field, including unknown keys', () => {
    let message = '';
    try {
      loadCharacterChrome('bad-status', root);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split('\n')).toEqual([
      expect.stringMatching(/^characters\/bad-status\/character\.yaml: status: /),
      expect.stringMatching(/^characters\/bad-status\/character\.yaml: chrome: .*nickname/),
    ]);
  });

  it('rejects missing files, bad YAML and non-kebab ids', () => {
    expect(() => loadCharacterRef('nobody', root)).toThrow('characters/nobody/character.yaml: file not found');
    expect(() => loadCharacterRef('not-yaml', root)).toThrow('characters/not-yaml/character.yaml: invalid YAML');
    expect(() => loadCharacterRef('../escape', root)).toThrow('invalid character id "../escape"');
  });
});
