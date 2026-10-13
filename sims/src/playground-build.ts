/**
 * Build the browser playground: one self-contained HTML file.
 *
 * 1. Load the mock season in Node with the scripts loaders (./load.ts).
 * 2. Serialize what the page needs (./playground/data.ts).
 * 3. Bundle ./playground/app.ts with esbuild as a minified browser IIFE.
 * 4. Inline the data and the bundle into ./playground/page.html as one
 *    `<script>`.
 *
 * The page is an Artifact body: no doctype, html, head or body tags (they are
 * added at publish time), and it opens fine straight from disk too.
 * ./build-playground.ts is the CLI.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { REPO_ROOT, loadCharacterChrome, rootDir } from '@league-of-taverns/scripts/lib/repo';
import { DEFAULT_SEASON_DIR, loadMockSeasonParts } from './load';
import { serializeSeason, type PlaygroundData } from './playground/data';

const PLAYGROUND_SRC = join(dirname(fileURLToPath(import.meta.url)), 'playground');

/** Bundle the page script: app.ts with the engine and bots, as a minified IIFE for browsers. */
export async function bundleApp(): Promise<string> {
  const result = await build({
    entryPoints: [join(PLAYGROUND_SRC, 'app.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    legalComments: 'none',
    // ASCII output (non-ASCII escaped), so the page reads right from disk with no charset declared.
    charset: 'ascii',
    logLevel: 'silent',
  });
  const out = result.outputFiles[0];
  if (out === undefined) throw new Error('esbuild produced no output');
  return out.text;
}

/**
 * JSON that is safe inside an inline `<script>` and pure ASCII: `<` and every
 * non-ASCII character become `\uXXXX` escapes, so no `</script>` or `<!--`
 * can appear and the encoding never matters.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Template markup with every non-ASCII character as a numeric entity. */
function asciiMarkup(template: string): string {
  return template.replace(/[\u007f-￿]/g, (c) => `&#x${c.charCodeAt(0).toString(16)};`);
}

/**
 * The page template with the data and bundle inlined as one trailing
 * `<script>`. The result is pure ASCII: the published wrapper declares UTF-8,
 * but a file opened straight from disk may have no charset at all.
 */
export function renderPage(template: string, data: PlaygroundData, bundle: string): string {
  if (/<\/script/i.test(bundle)) throw new Error('the bundle contains "</script" and cannot be inlined');
  if (/<(!doctype|html|head|body)\b/i.test(template)) throw new Error('page.html must not have doctype, html, head or body tags');
  const style = /<style>[\s\S]*?<\/style>/.exec(template)?.[0] ?? '';
  if (/[^\t\n\r -~]/.test(style)) throw new Error('page.html: keep the <style> block ASCII (entities do not work in CSS)');
  const html = `${asciiMarkup(template.trimEnd())}\n<script>\nvar __PLAYGROUND_DATA__=${scriptSafeJson(data)};\n${bundle.trimEnd()}\n</script>\n`;
  const bad = /[^\t\n\r -~]/.exec(html);
  if (bad !== null) throw new Error(`the page has a non-ASCII character U+${bad[0].charCodeAt(0).toString(16)} at ${bad.index}`);
  return html;
}

/** Load the season in `dir`, bundle the app and return the page. */
export async function buildPlaygroundHtml(dir: string = DEFAULT_SEASON_DIR): Promise<{ readonly html: string; readonly data: PlaygroundData }> {
  const parts = loadMockSeasonParts(dir);
  // The season folder keeps its own characters/ (load.ts): read each pooled character's chrome name there, for display only.
  const charactersRoot = resolve(rootDir(REPO_ROOT), dir);
  const names = Object.fromEntries(parts.pool.map(({ character }) => [character.ref.id, loadCharacterChrome(character.ref.id, charactersRoot).name]));
  const data = serializeSeason(parts, dir, names);
  const template = readFileSync(join(PLAYGROUND_SRC, 'page.html'), 'utf8');
  const html = renderPage(template, data, await bundleApp());
  return { html, data };
}

/** Build the page and write it to `outFile`. Returns its size in bytes. */
export async function writePlayground(outFile: string, dir: string = DEFAULT_SEASON_DIR): Promise<{ readonly bytes: number; readonly data: PlaygroundData }> {
  const { html, data } = await buildPlaygroundHtml(dir);
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html);
  return { bytes: Buffer.byteLength(html), data };
}
