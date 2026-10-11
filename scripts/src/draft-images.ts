/**
 * Draft pixel-art images on a local ComfyUI, then accept the ones to keep.
 *
 * Usage:
 *   draft-images portraits (--character <id>... | --all) [--snapshot <id>] [--candidates 4] [--seed <n>]
 *   draft-images covers --season <id> [--mission <id>...] [--candidates 4] [--seed <n>]
 *   draft-images accept --character <id> --seed <n> [--force]
 *   draft-images accept --season <id> --mission <id> --seed <n>
 *
 * A portrait's canvas follows its base's creature size, looked up in
 * `--snapshot` (default: the newest pinned snapshot).
 *
 * `portraits` and `covers` render `--candidates` images per target with
 * consecutive seeds (from `--seed`, else a stable per-target seed), pixelate
 * them (lib/images/pixelate.ts), and stage them in .image-drafts/ with an
 * index.html to compare. Each portrait is checked against the framing rules
 * (lib/images/framing.ts: no clipping, no floating) and the page marks the
 * failures; `accept` refuses them without --force. `accept` copies one candidate into the repo and, for
 * a portrait, records path and seed in character.yaml with status draft.
 *
 * Needs a running ComfyUI (COMFYUI_URL, default http://127.0.0.1:8188).
 * Offline and human-triggered; never in CI. Setup and style: docs/images.md.
 */
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { ComfyUi } from './lib/images/comfyui';
import { accept, coverTargets, defaultSeed, portraitTargets, snapshotSizes, stage, writeReviewPage } from './lib/images/drafts';
import type { DraftTarget } from './lib/images/drafts';
import { pixelate } from './lib/images/pixelate';
import { decodePng, encodeIndexedPng } from './lib/images/png';
import { loadImageStyle, pixelateOptions } from './lib/images/style';
import { ValidationFailure, runMain } from './lib/main';
import { REPO_ROOT, rootDir } from './lib/repo';

const USAGE = `Usage:
  draft-images portraits (--character <id>... | --all) [--snapshot <id>] [--candidates 4] [--seed <n>]
  draft-images covers --season <id> [--mission <id>...] [--candidates 4] [--seed <n>]
  draft-images accept --character <id> --seed <n> [--force]
  draft-images accept --season <id> --mission <id> --seed <n>`;

function parse(argv: ReadonlyArray<string>) {
  const { values, positionals } = parseArgs({
    args: argv.filter((arg) => arg !== '--'),
    options: {
      character: { type: 'string', multiple: true },
      all: { type: 'boolean' },
      season: { type: 'string' },
      mission: { type: 'string', multiple: true },
      snapshot: { type: 'string' },
      candidates: { type: 'string' },
      seed: { type: 'string' },
      force: { type: 'boolean' },
    },
    strict: true,
    allowPositionals: true,
  });
  const [command, ...rest] = positionals;
  if (rest.length > 0 || (command !== 'portraits' && command !== 'covers' && command !== 'accept')) throw new ValidationFailure(USAGE);
  const integer = (name: string, raw: string | undefined, min: number): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new ValidationFailure(`--${name} must be an integer of at least ${min}, got ${JSON.stringify(raw)}`);
    return n;
  };
  return {
    command,
    characters: values.character ?? [],
    all: values.all === true,
    season: values.season,
    missions: values.mission ?? [],
    snapshot: values.snapshot,
    candidates: integer('candidates', values.candidates, 1) ?? 4,
    seed: integer('seed', values.seed, 0),
    force: values.force === true,
  };
}

type Args = ReturnType<typeof parse>;

function targetsFor(args: Args): DraftTarget[] {
  if (args.command === 'covers' || (args.command === 'accept' && args.season !== undefined)) {
    if (args.season === undefined) throw new ValidationFailure(`covers needs --season <id>.\n\n${USAGE}`);
    if (args.characters.length > 0 || args.all) throw new ValidationFailure(`--character and --all are for portraits.\n\n${USAGE}`);
    return coverTargets(args.season, args.missions);
  }
  if (args.season !== undefined || args.missions.length > 0) throw new ValidationFailure(`--season and --mission are for covers.\n\n${USAGE}`);
  if (args.all === args.characters.length > 0) throw new ValidationFailure(`Pass --character <id> (repeatable) or --all.\n\n${USAGE}`);
  return portraitTargets(args.all ? 'all' : args.characters, snapshotSizes(args.snapshot));
}

async function draft(args: Args): Promise<void> {
  const style = loadImageStyle();
  const targets = targetsFor(args);
  if (targets.length === 0) {
    console.log('Nothing to draw: no target has a prompt at status prompt or draft.');
    return;
  }
  const comfy = new ComfyUi();
  await comfy.checkReady(style);

  const jobs = targets.flatMap((target) => {
    const first = args.seed ?? defaultSeed(target);
    return Array.from({ length: args.candidates }, (_, i) => ({ target, seed: first + i }));
  });
  console.log(`Rendering ${jobs.length} image${jobs.length === 1 ? '' : 's'} on ${comfy.baseUrl} …`);
  const started = Date.now();
  let done = 0;
  const renders = await comfy.render(
    style,
    jobs.map(({ target, seed }) => ({
      kind: target.kind,
      ...(target.size === undefined ? {} : { size: target.size }),
      subject: target.subject,
      seed,
      prefix: `league-of-taverns/${target.kind}/${target.id}-s${seed}`,
    })),
    (request) => console.log(`  ${++done}/${jobs.length} ${request.kind} ${request.prefix.split('/').pop()}`),
  );

  const clean = new Map<string, number>();
  jobs.forEach(({ target, seed }, i) => {
    const render = renders[i]!;
    const sprite = encodeIndexedPng(pixelate(decodePng(render), pixelateOptions(style, target.kind)));
    const problems = stage(target, seed, render, sprite, style);
    clean.set(target.id, (clean.get(target.id) ?? 0) + (problems.length === 0 ? 1 : 0));
  });
  for (const target of targets) {
    if (target.kind === 'portrait') console.log(`  ${target.id}: ${clean.get(target.id) ?? 0}/${args.candidates} layer cleanly`);
  }
  const page = writeReviewPage(style);
  console.log(`Done in ${Math.round((Date.now() - started) / 1000)}s. Compare them in ${relative(rootDir(REPO_ROOT), page)}, then run its accept command.`);
}

function acceptOne(args: Args): void {
  if (args.seed === undefined) throw new ValidationFailure(`accept needs --seed <n>.\n\n${USAGE}`);
  const targets = targetsFor(args);
  if (targets.length !== 1) throw new ValidationFailure(`accept takes exactly one --character, or one --season with one --mission.\n\n${USAGE}`);
  const written = accept(targets[0]!, args.seed, loadImageStyle(), REPO_ROOT, args.force);
  console.log(`Wrote ${written}.${targets[0]!.kind === 'portrait' ? ' Portrait status is draft: set it to final in review.' : ''}`);
}

runMain(async (argv) => {
  const args = parse(argv);
  if (args.command === 'accept') acceptOne(args);
  else await draft(args);
});
