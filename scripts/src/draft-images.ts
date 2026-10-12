/**
 * Draft pixel-art images on a local ComfyUI, then accept the ones to keep.
 *
 * Usage:
 *   draft-images portraits (--character <id>... | --all) [--snapshot <id>] [--candidates 4] [--seed <n>]
 *   draft-images covers --season <id> [--mission <id>...] [--candidates 4] [--seed <n>]
 *   draft-images import --character <id> <image.png>
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
 * `import` stages an outside image (Gemini, a drawing) as a portrait
 * candidate: ComfyUI cuts out its background, it is scaled to fit the
 * character's canvas, then pixelated and checked like any render. Accepting
 * it records `imported: <file name>` instead of a seed.
 *
 * Needs a running ComfyUI (COMFYUI_URL, default http://127.0.0.1:8188).
 * Offline and human-triggered; never in CI. Setup and style: docs/images.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { ComfyUi } from './lib/images/comfyui';
import { accept, coverTargets, defaultSeed, portraitTargets, shapeOfTarget, snapshotSizes, stage, stageImport, stagedPaths, writeReviewPage } from './lib/images/drafts';
import type { DraftTarget } from './lib/images/drafts';
import { pixelate } from './lib/images/pixelate';
import { decodePng, encodeIndexedPng, encodeRgbaPng } from './lib/images/png';
import { fitToCanvas } from './lib/images/resample';
import { loadImageStyle, pixelateOptions, renderSize } from './lib/images/style';
import { ValidationFailure, runMain } from './lib/main';
import { REPO_ROOT, rootDir } from './lib/repo';

const USAGE = `Usage:
  draft-images portraits (--character <id>... | --all) [--snapshot <id>] [--candidates 4] [--seed <n>]
  draft-images covers --season <id> [--mission <id>...] [--candidates 4] [--seed <n>]
  draft-images import --character <id> <image.png>
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
  const commands = ['portraits', 'covers', 'accept', 'import'];
  if (!commands.includes(command ?? '') || rest.length > (command === 'import' ? 1 : 0)) throw new ValidationFailure(USAGE);
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
    file: rest[0],
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

  const all = targets.flatMap((target) => {
    const first = args.seed ?? defaultSeed(target);
    return Array.from({ length: args.candidates }, (_, i) => ({ target, seed: first + i }));
  });
  // Already-staged candidates are kept, so an interrupted batch resumes where it stopped.
  const jobs = all.filter(({ target, seed }) => !existsSync(stagedPaths(target, seed).sprite));
  if (jobs.length < all.length) console.log(`Skipping ${all.length - jobs.length} already staged.`);
  if (jobs.length === 0) {
    console.log(`Nothing left to render. Compare them in ${relative(rootDir(REPO_ROOT), writeReviewPage(style))}.`);
    return;
  }
  console.log(`Rendering ${jobs.length} image${jobs.length === 1 ? '' : 's'} on ${comfy.baseUrl} …`);
  const started = Date.now();
  const clean = new Map<string, number>();
  let done = 0;
  // Stage each image as it arrives (and refresh the review page every so often),
  // so a crash part-way keeps everything finished so far.
  await comfy.render(
    style,
    jobs.map(({ target, seed }) => ({
      kind: target.kind,
      ...(target.size === undefined ? {} : { size: target.size }),
      ...(target.bodyPlan === undefined ? {} : { bodyPlan: target.bodyPlan }),
      ...(target.heightFt === undefined ? {} : { heightFt: target.heightFt }),
      subject: target.subject,
      seed,
      prefix: `league-of-taverns/${target.kind}/${target.id}-s${seed}`,
    })),
    (_request, render) => {
      const { target, seed } = jobs[done]!;
      const sprite = encodeIndexedPng(pixelate(decodePng(render), pixelateOptions(style, target.kind, target.translucent, shapeOfTarget(target))));
      const problems = stage(target, seed, render, sprite, style);
      clean.set(target.id, (clean.get(target.id) ?? 0) + (problems.length === 0 ? 1 : 0));
      done++;
      const eta = Math.round(((Date.now() - started) / done) * (jobs.length - done) / 60_000);
      console.log(`  ${done}/${jobs.length} ${target.id} s${seed}: ${problems.length === 0 ? 'layers cleanly' : problems.join('; ')}${done < jobs.length ? ` (about ${eta} min left)` : ''}`);
      if (done % 16 === 0) writeReviewPage(style);
    },
  );

  for (const target of targets) {
    if (target.kind === 'portrait' && clean.has(target.id)) console.log(`  ${target.id}: ${clean.get(target.id)} new candidate(s) layer cleanly`);
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

/** Margins kept around an imported figure, in art pixels: room on the sides and above the head. */
const IMPORT_MARGINS = { side: 4, top: 8 } as const;

async function importOne(args: Args): Promise<void> {
  if (args.file === undefined) throw new ValidationFailure(`import needs an image file.\n\n${USAGE}`);
  if (!existsSync(args.file)) throw new ValidationFailure(`No image at ${args.file}. Save the file there first (a PNG), then run this again.`);
  const targets = targetsFor(args);
  const target = targets[0];
  if (targets.length !== 1 || target?.kind !== 'portrait') throw new ValidationFailure(`import takes exactly one --character.\n\n${USAGE}`);
  const style = loadImageStyle();
  const comfy = new ComfyUi();
  await comfy.checkReady(style);
  const original = readFileSync(args.file);
  const cut = decodePng(await comfy.cutout(style, original, basename(args.file)));
  const { cell } = style.pixelate;
  const { width: rw, height: rh } = renderSize(style, 'portrait', shapeOfTarget(target));
  const render = fitToCanvas(cut, rw, rh, {
    side: IMPORT_MARGINS.side * cell,
    top: IMPORT_MARGINS.top * cell,
  });
  const sprite = encodeIndexedPng(pixelate(render, pixelateOptions(style, 'portrait', target.translucent, shapeOfTarget(target))));
  const seed = createHash('sha256').update(original).digest().readUInt32BE(0) % 1_000_000_000;
  const problems = stageImport(target, seed, basename(args.file), encodeRgbaPng(render), sprite, style);
  console.log(`Staged ${target.id} s${seed} from ${basename(args.file)}: ${problems.length === 0 ? 'layers cleanly' : problems.join('; ')}`);
  console.log(`Compare it in ${relative(rootDir(REPO_ROOT), writeReviewPage(style))}, then: pnpm draft-images accept --character ${target.id} --seed ${seed}`);
}

runMain(async (argv) => {
  const args = parse(argv);
  if (args.command === 'accept') acceptOne(args);
  else if (args.command === 'import') await importOne(args);
  else await draft(args);
});
