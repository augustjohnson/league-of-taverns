/**
 * Season file loaders (T3.4): config.yaml, pool.yaml, managers.yaml and
 * schedule.yaml, each loaded into engine types and fully validated.
 *
 * - A season is named by id (`seasons/<id>/` under the repo root) or by a
 *   `SeasonLocation`, for fixtures that live elsewhere (the mock season in
 *   sims/fixtures/mock-season/ pools the repo's own characters).
 * - Every loader collects all the issues it finds and throws one
 *   `ValidationFailure` with a line per issue: `<file>: <field>: <message>`.
 * - Each public loader reads only what it needs. `loadSeason` loads everything
 *   once, for callers that want all of it (validate, sims).
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BOT_IDS } from '@league-of-taverns/bots';
import type { BotId } from '@league-of-taverns/bots';
import {
  PoolEntrySchema,
  REGISTRY_VERSION,
  TRAITS,
  indexSnapshot,
  kebabIdSchema,
  parseCr,
  payloadSchemas,
  seasonConfigSchema,
  toSchemaIssues,
  validateModifiers,
  validateSponsors,
} from '@league-of-taverns/engine';
import type {
  CrEighths,
  Open5eMonster,
  PooledCharacter,
  SchemaIssue,
  SeasonConfig,
  Sponsor,
} from '@league-of-taverns/engine';
import { z } from 'zod';
import { ValidationFailure } from './main';
import { REPO_ROOT, displayPath, issuesFailure, loadCharacterRef, loadSnapshot, readYaml, rootDir } from './repo';
import type { RepoRoot } from './repo';

// ── where a season lives ───────────────────────────────────────────────────

/** A season outside seasons/<id>/, such as a test or sim fixture. */
export interface SeasonLocation {
  /** Directory holding config.yaml. Relative to the root, or absolute. */
  readonly dir: string;
  /**
   * Directory whose characters/<id>/character.yaml files the pool resolves.
   * Relative to the root, or absolute. Defaults to the root.
   */
  readonly charactersRoot?: string;
}

/** A season id (seasons/<id>/ under the root) or an explicit location. */
export type SeasonSource = string | SeasonLocation;

/** The mock season used by sims (T5.5). Its pool is drawn from the repo's own characters/. */
export const MOCK_SEASON: SeasonLocation = { dir: 'sims/fixtures/mock-season' };

interface SeasonContext {
  readonly root: RepoRoot;
  /** Absolute season directory. */
  readonly dir: string;
  /** Absolute directory containing characters/. */
  readonly charactersRoot: string;
  /** The id the folder implies, when the season was named by id. */
  readonly expectedId?: string;
}

function seasonContext(season: SeasonSource, root: RepoRoot): SeasonContext {
  const base = rootDir(root);
  if (typeof season === 'string') {
    if (!kebabIdSchema.safeParse(season).success) {
      throw new ValidationFailure(`invalid season id ${JSON.stringify(season)}: expected a kebab-case folder name under seasons/`);
    }
    return { root, dir: join(base, 'seasons', season), charactersRoot: base, expectedId: season };
  }
  return { root, dir: resolve(base, season.dir), charactersRoot: resolve(base, season.charactersRoot ?? '.') };
}

/** Absolute path to the season directory a source names. */
export function seasonDir(season: SeasonSource, root: RepoRoot = REPO_ROOT): string {
  return seasonContext(season, root).dir;
}

/** Absolute directory whose characters/ folder a source's pool resolves against. */
export function charactersRootDir(season: SeasonSource, root: RepoRoot = REPO_ROOT): string {
  return seasonContext(season, root).charactersRoot;
}

// ── shared helpers ─────────────────────────────────────────────────────────

const text = z.string().min(1);
const count = z.number().int().nonnegative();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Issue lines as `<file>: <field>: <message>`, or `<file>: <message>` with no field. */
class Issues {
  readonly lines: string[] = [];
  constructor(private readonly label: string) {}
  add(path: string | undefined, message: string): void {
    this.lines.push(path === undefined ? `${this.label}: ${message}` : `${this.label}: ${path}: ${message}`);
  }
  addAll(issues: ReadonlyArray<SchemaIssue>): void {
    for (const issue of issues) this.add(issue.path, issue.message);
  }
  failure(): ValidationFailure {
    return new ValidationFailure(this.lines.join('\n'));
  }
  throwIfAny(): void {
    if (this.lines.length > 0) throw this.failure();
  }
}

/** Parse `value` with `schema`, or throw a failure listing every field issue. */
function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw issuesFailure(label, toSchemaIssues(result.error));
  return result.data;
}

function seasonFile(ctx: SeasonContext, name: string): { readonly file: string; readonly label: string } {
  const file = resolve(ctx.dir, name);
  return { file, label: displayPath(file, ctx.root) };
}

// ── config.yaml ────────────────────────────────────────────────────────────

/** D-43: how many spellcasters a season allows. Not in `SeasonConfig` yet (T3.7, T5.6). */
export interface SpellcasterLimits {
  readonly maxInPool: number;
  readonly maxPerEncounter: number;
}

/** config.yaml, split into the engine's `SeasonConfig` and the keys only the file carries. */
export interface LoadedSeasonConfig {
  readonly config: SeasonConfig;
  /** Display name, e.g. "Season One". */
  readonly name: string;
  /** The other season files, as written: paths relative to the season directory. */
  readonly files: { readonly schedule: string; readonly pool: string; readonly managers: string };
  readonly spellcasters: SpellcasterLimits;
}

/** Keys config.yaml has that `SeasonConfig` does not. */
const FILE_ONLY_KEYS = ['name', 'schedule', 'pool', 'managers', 'spellcasters'] as const;

const configFileOnlySchema = z.looseObject({
  name: text,
  schedule: text,
  pool: text,
  managers: text,
  spellcasters: z.strictObject({ maxInPool: count, maxPerEncounter: count }),
});

/**
 * Load seasons/<season>/config.yaml (or `<dir>/config.yaml`) as the engine's
 * `SeasonConfig`: `budget.partyCr` converted from human CR (`12`, `"1/2"`) to
 * eighths, file-only keys split out, the rest checked by the engine's
 * `seasonConfigSchema`. A season named by id must have `id` equal to its
 * folder name.
 */
export function loadSeasonConfig(season: SeasonSource, root: RepoRoot = REPO_ROOT): LoadedSeasonConfig {
  return readConfig(seasonContext(season, root));
}

function readConfig(ctx: SeasonContext): LoadedSeasonConfig {
  const { file, label } = seasonFile(ctx, 'config.yaml');
  const raw = readYaml(file, label);
  if (!isRecord(raw)) throw new ValidationFailure(`${label}: expected a mapping of config keys`);
  const issues = new Issues(label);

  const fileOnly = configFileOnlySchema.safeParse(raw);
  if (!fileOnly.success) issues.addAll(toSchemaIssues(fileOnly.error));

  // Engine view: drop the file-only keys and convert B to eighths.
  const engineInput: Record<string, unknown> = { ...raw };
  for (const key of FILE_ONLY_KEYS) delete engineInput[key];
  let partyCrBad = false;
  if (isRecord(raw.budget) && 'partyCr' in raw.budget) {
    const partyCr = raw.budget.partyCr;
    try {
      if (typeof partyCr !== 'string' && typeof partyCr !== 'number') throw new Error('not a string or number');
      engineInput.budget = { ...raw.budget, partyCr: parseCr(partyCr) };
    } catch {
      partyCrBad = true;
      issues.add('budget.partyCr', `${JSON.stringify(partyCr)} is not a CR: expected 0, "1/8", "1/4", "1/2" or a whole number up to 30`);
    }
  }
  const engine = seasonConfigSchema.safeParse(engineInput);
  if (!engine.success) {
    issues.addAll(toSchemaIssues(engine.error).filter((issue) => !(partyCrBad && issue.path === 'budget.partyCr')));
  }
  // Every failed parse has added at least one issue.
  if (!fileOnly.success || !engine.success) throw issues.failure();

  const config: SeasonConfig = engine.data;
  if (ctx.expectedId !== undefined && config.id !== ctx.expectedId) {
    issues.add('id', `${JSON.stringify(config.id)} does not match its folder name ${JSON.stringify(ctx.expectedId)}`);
  }
  issues.throwIfAny();
  const { name, schedule, pool, managers, spellcasters } = fileOnly.data;
  return { config, name, files: { schedule, pool, managers }, spellcasters };
}

// ── snapshot helpers ───────────────────────────────────────────────────────

const SPELLCASTING_NAMES = new Set(['spellcasting', 'innate spellcasting', 'shared spellcasting']);

/**
 * D-43: a spellcaster has a special ability or action named "Spellcasting",
 * "Innate Spellcasting" or "Shared Spellcasting", ignoring a trailing
 * parenthetical such as "(1/Day)" or "(Coven Only)". That flags 37 of the 322
 * SRD records, including the mephits and the sea hag.
 *
 * Local until T1.5 adds `BaseStats.spellcaster` in the adapter.
 */
export function isSpellcaster(record: Open5eMonster): boolean {
  return [...(record.special_abilities ?? []), ...(record.actions ?? [])].some((ability) =>
    SPELLCASTING_NAMES.has(ability.name.replace(/\s*\([^)]*\)\s*$/, '').trim().toLowerCase()),
  );
}

/** CR in eighths for each snapshot slug, for `validateMission`'s `crOf`. */
export function snapshotCrIndex(records: ReadonlyArray<Open5eMonster>): ReadonlyMap<string, CrEighths> {
  return new Map([...indexSnapshot(records)].map(([slug, record]) => [slug, parseCr(record.challenge_rating)]));
}

// ── pool.yaml ──────────────────────────────────────────────────────────────

export interface SeasonPool {
  readonly season: string;
  readonly registry: number;
  /** In file order. */
  readonly characters: ReadonlyArray<PooledCharacter>;
  /** Base CR in eighths, by character id. Modifiers never change CR. */
  readonly cr: ReadonlyMap<string, CrEighths>;
  /** Ids of pooled characters whose base is a spellcaster (D-43), in file order. */
  readonly spellcasters: ReadonlyArray<string>;
}

const poolFileSchema = z.strictObject({
  season: kebabIdSchema,
  registry: z.number().int().positive(),
  characters: z.array(PoolEntrySchema),
});

/**
 * Load pool.yaml. Checks, all reported together: the file's shape; `season`
 * and `registry` against config.yaml and the engine's registry; unique ids;
 * every id has a character folder; every base is in the season's snapshot;
 * modifiers pass `validateModifiers` against the budget; and the number of
 * spellcaster bases is within `spellcasters.maxInPool`.
 */
export function loadPool(season: SeasonSource, root: RepoRoot = REPO_ROOT): SeasonPool {
  const ctx = seasonContext(season, root);
  const loaded = readConfig(ctx);
  return readPool(ctx, loaded, loadSnapshot(loaded.config.snapshot, ctx.root));
}

function readPool(ctx: SeasonContext, loaded: LoadedSeasonConfig, snapshot: ReadonlyArray<Open5eMonster>): SeasonPool {
  const { config, spellcasters: limits } = loaded;
  const { file, label } = seasonFile(ctx, loaded.files.pool);
  const pool = parseOrThrow(poolFileSchema, readYaml(file, label), label);
  const issues = new Issues(label);

  if (pool.season !== config.id) issues.add('season', `${JSON.stringify(pool.season)} does not match config.yaml id ${JSON.stringify(config.id)}`);
  if (pool.registry !== config.modifierRegistryVersion) {
    issues.add('registry', `${pool.registry} does not match config.yaml modifierRegistryVersion ${config.modifierRegistryVersion}`);
  }
  if (config.modifierRegistryVersion !== REGISTRY_VERSION) {
    issues.add('registry', `the season pins modifier registry ${config.modifierRegistryVersion}, but the engine has only registry ${REGISTRY_VERSION}`);
  }

  const bySlug = indexSnapshot(snapshot);
  const characters: PooledCharacter[] = [];
  const cr = new Map<string, CrEighths>();
  const casters: string[] = [];
  const firstIndex = new Map<string, number>();
  const budget = config.budget.modifierPointsPerCharacter;

  pool.characters.forEach((entry, i) => {
    const at = `characters[${i}] (${entry.id})`;
    const first = firstIndex.get(entry.id);
    if (first !== undefined) {
      issues.add(at, `duplicate id: already pooled at characters[${first}]`);
      return;
    }
    firstIndex.set(entry.id, i);

    let ref;
    try {
      ref = loadCharacterRef(entry.id, ctx.charactersRoot);
    } catch (error) {
      if (!(error instanceof ValidationFailure)) throw error;
      // The character loader names its own file relative to the characters root.
      for (const line of error.message.split('\n')) issues.add(at, line);
      return;
    }
    const character: PooledCharacter = { ref, modifiers: entry.modifiers };
    for (const issue of validateModifiers(character, budget, TRAITS)) issues.add(at, `[${issue.code}] ${issue.message}`);

    const record = bySlug.get(ref.base);
    if (record === undefined) {
      issues.add(at, `base ${JSON.stringify(ref.base)} is not in snapshot ${JSON.stringify(config.snapshot)}`);
      return;
    }
    characters.push(character);
    cr.set(ref.id, parseCr(record.challenge_rating));
    if (isSpellcaster(record)) casters.push(ref.id);
  });

  if (casters.length > limits.maxInPool) {
    issues.add(
      'characters',
      `${casters.length} spellcasters, over config.yaml spellcasters.maxInPool of ${limits.maxInPool} (D-43): ` +
        casters.map((id) => `${id} (${characters.find((c) => c.ref.id === id)?.ref.base ?? '?'})`).join(', '),
    );
  }
  issues.throwIfAny();
  return { season: pool.season, registry: pool.registry, characters, cr, spellcasters: casters };
}

// ── managers.yaml ──────────────────────────────────────────────────────────

export interface Person {
  readonly login: string;
  /** GitHub numeric user id (D-35). Null until filled in. */
  readonly githubId: number | null;
}

export type TavernManager = Person | { readonly bot: BotId };

export interface TavernEntry {
  readonly id: string;
  readonly name: string;
  readonly manager: TavernManager;
}

export interface SeasonManagers {
  readonly commissioner: Person;
  readonly gm: Person;
  readonly taverns: ReadonlyArray<TavernEntry>;
}

const personSchema = z.strictObject({ login: text, githubId: z.number().int().positive().nullable() });

const managersFileSchema = z.strictObject({
  commissioner: personSchema,
  gm: personSchema,
  taverns: z
    .array(
      z.strictObject({
        id: kebabIdSchema,
        name: text,
        manager: z.union([personSchema, z.strictObject({ bot: z.enum(BOT_IDS) })]),
      }),
    )
    .min(1),
});

/**
 * Load managers.yaml: the commissioner, the GM, and the taverns. Tavern ids
 * are unique, and among human tavern managers so are GitHub ids (where not
 * null) and logins (case-insensitive, as on GitHub). The commissioner and GM
 * may also manage a tavern (D-09), so they are not part of the uniqueness check.
 */
export function loadManagers(season: SeasonSource, root: RepoRoot = REPO_ROOT): SeasonManagers {
  const ctx = seasonContext(season, root);
  return readManagers(ctx, readConfig(ctx));
}

function readManagers(ctx: SeasonContext, loaded: LoadedSeasonConfig): SeasonManagers {
  const { file, label } = seasonFile(ctx, loaded.files.managers);
  const managers: SeasonManagers = parseOrThrow(managersFileSchema, readYaml(file, label), label);
  const issues = new Issues(label);
  const seen = { id: new Map<string, number>(), githubId: new Map<number, number>(), login: new Map<string, number>() };
  managers.taverns.forEach((tavern, i) => {
    const at = `taverns[${i}]`;
    const firstId = seen.id.get(tavern.id);
    if (firstId !== undefined) issues.add(`${at}.id`, `duplicate tavern id ${JSON.stringify(tavern.id)} (also taverns[${firstId}])`);
    else seen.id.set(tavern.id, i);
    if ('bot' in tavern.manager) return;
    const { githubId, login } = tavern.manager;
    if (githubId !== null) {
      const first = seen.githubId.get(githubId);
      if (first !== undefined) issues.add(`${at}.manager.githubId`, `GitHub id ${githubId} already manages taverns[${first}]`);
      else seen.githubId.set(githubId, i);
    }
    const key = login.toLowerCase();
    const first = seen.login.get(key);
    if (first !== undefined) issues.add(`${at}.manager.login`, `${JSON.stringify(login)} already manages taverns[${first}]`);
    else seen.login.set(key, i);
  });
  issues.throwIfAny();
  return managers;
}

// ── schedule.yaml ──────────────────────────────────────────────────────────

/** One public schedule entry, the same shape `season.created` records. */
export type ScheduleWeek = z.infer<typeof scheduleWeekSchema>;

export interface SeasonSchedule {
  readonly season: string;
  /** The GM's gods and the tavern each sponsors (D-44). Names and voice live in chrome. */
  readonly sponsors: ReadonlyArray<Sponsor>;
  readonly weeks: ReadonlyArray<ScheduleWeek>;
}

const scheduleWeekSchema = payloadSchemas['season.created'].shape.schedule.element;
const sponsorSchema = payloadSchemas['season.created'].shape.sponsors.element;

const scheduleFileSchema = z.strictObject({ season: kebabIdSchema, sponsors: z.array(sponsorSchema), weeks: z.array(scheduleWeekSchema) });

/**
 * Load schedule.yaml, the GM's public plan for the season. `season` matches
 * config.yaml, the weeks are numbered 1..N in order with N equal to
 * config.yaml `weeks`, and `sponsors` passes `validateSponsors` (each week's
 * `sponsor` is listed, one week per sponsor, one sponsor per tavern).
 * `loadSeason` also checks every sponsored tavern is in managers.yaml.
 */
export function loadSchedule(season: SeasonSource, root: RepoRoot = REPO_ROOT): SeasonSchedule {
  const ctx = seasonContext(season, root);
  return readSchedule(ctx, readConfig(ctx));
}

function readSchedule(ctx: SeasonContext, loaded: LoadedSeasonConfig): SeasonSchedule {
  const { file, label } = seasonFile(ctx, loaded.files.schedule);
  const schedule: SeasonSchedule = parseOrThrow(scheduleFileSchema, readYaml(file, label), label);
  const issues = new Issues(label);
  const { config } = loaded;
  if (schedule.season !== config.id) {
    issues.add('season', `${JSON.stringify(schedule.season)} does not match config.yaml id ${JSON.stringify(config.id)}`);
  }
  schedule.weeks.forEach((entry, i) => {
    if (entry.week !== i + 1) issues.add(`weeks[${i}].week`, `is ${entry.week}, expected ${i + 1}: weeks run 1..N in order with no gaps`);
  });
  if (schedule.weeks.length !== config.weeks) {
    issues.add('weeks', `has ${schedule.weeks.length} entries, but config.yaml weeks is ${config.weeks}`);
  }
  for (const issue of validateSponsors(schedule.sponsors, schedule.weeks)) issues.add('sponsors', issue.message);
  issues.throwIfAny();
  return schedule;
}

// ── missions ───────────────────────────────────────────────────────────────

export type MissionStatus = 'candidate' | 'selected';

export interface MissionFile {
  /** Absolute path. */
  readonly file: string;
  readonly status: MissionStatus;
}

/**
 * Mission YAML files for a season: missions/candidates/*.yaml are candidates;
 * missions/selected/*.yaml, and any *.yaml directly in missions/ (the mock
 * season's layout), are selected. Sorted by path. Missing folders are empty.
 */
export function missionFiles(season: SeasonSource, root: RepoRoot = REPO_ROOT): ReadonlyArray<MissionFile> {
  const dir = join(seasonContext(season, root).dir, 'missions');
  const yamlIn = (folder: string): string[] => {
    try {
      return readdirSync(folder)
        .filter((name) => /\.ya?ml$/.test(name))
        .map((name) => join(folder, name))
        .filter((path) => statSync(path).isFile())
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  };
  return [
    ...yamlIn(dir).map((file) => ({ file, status: 'selected' as const })),
    ...yamlIn(join(dir, 'candidates')).map((file) => ({ file, status: 'candidate' as const })),
    ...yamlIn(join(dir, 'selected')).map((file) => ({ file, status: 'selected' as const })),
  ];
}

// ── everything at once ─────────────────────────────────────────────────────

export interface LoadedSeason extends LoadedSeasonConfig {
  /** Absolute season directory. */
  readonly dir: string;
  readonly snapshot: ReadonlyArray<Open5eMonster>;
  readonly pool: SeasonPool;
  readonly managers: SeasonManagers;
  readonly schedule: SeasonSchedule;
}

/**
 * Load and validate config, snapshot, pool, managers and schedule, reading
 * each file once. Failures from every file are combined into one
 * `ValidationFailure`. A config or snapshot failure stops early, since the
 * other files are checked against them.
 */
export function loadSeason(season: SeasonSource, root: RepoRoot = REPO_ROOT): LoadedSeason {
  const ctx = seasonContext(season, root);
  const loaded = readConfig(ctx);
  const snapshot = loadSnapshot(loaded.config.snapshot, ctx.root);
  const failures: string[] = [];
  const attempt = <T>(load: () => T): T | undefined => {
    try {
      return load();
    } catch (error) {
      if (!(error instanceof ValidationFailure)) throw error;
      failures.push(error.message);
      return undefined;
    }
  };
  const pool = attempt(() => readPool(ctx, loaded, snapshot));
  const managers = attempt(() => readManagers(ctx, loaded));
  const schedule = attempt(() => readSchedule(ctx, loaded));
  if (managers !== undefined && schedule !== undefined) {
    const label = seasonFile(ctx, loaded.files.schedule).label;
    const taverns = new Set(managers.taverns.map((t) => t.id));
    schedule.sponsors.forEach((sponsor, i) => {
      if (!taverns.has(sponsor.tavern)) {
        failures.push(`${label}: sponsors[${i}].tavern: ${JSON.stringify(sponsor.tavern)} is not a tavern in ${loaded.files.managers}`);
      }
    });
  }
  if (pool === undefined || managers === undefined || schedule === undefined || failures.length > 0) throw new ValidationFailure(failures.join('\n'));
  return { ...loaded, dir: ctx.dir, snapshot, pool, managers, schedule };
}
