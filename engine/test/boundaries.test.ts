/**
 * Enforces the README boundary rules that lint alone cannot see:
 * - engine/src imports only relative paths and a short allowlist of pure
 *   packages (zod, @noble/hashes): no Node built-ins, no I/O libraries.
 * - explorer/ never imports engine/.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

function filesUnder(dir: string, exts: ReadonlyArray<string>): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesUnder(path, exts);
    return exts.some((ext) => name.endsWith(ext)) ? [path] : [];
  });
}

/** Third-party packages the engine may import: pure JS, browser-safe, no I/O. */
const ENGINE_ALLOWED_PACKAGES = [/^zod(\/|$)/, /^@noble\/hashes(\/|$)/];

const IMPORT_RE = /(?:^|\s)(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? '');
}

describe('engine boundary', () => {
  const files = filesUnder(join(ROOT, 'engine', 'src'), ['.ts']);

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))('%s imports only relative modules or allowed pure packages', (_name, file) => {
    const external = importsOf(file).filter(
      (spec) => !spec.startsWith('.') && !ENGINE_ALLOWED_PACKAGES.some((re) => re.test(spec)),
    );
    expect(external).toEqual([]);
  });
});

describe('explorer boundary', () => {
  it('never imports the engine', () => {
    const files = filesUnder(join(ROOT, 'explorer'), ['.ts', '.tsx', '.js', '.jsx', '.mjs']);
    const offenders = files.filter((file) =>
      importsOf(file).some((spec) => spec.includes('engine') || spec.startsWith('@league-of-taverns/')),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
