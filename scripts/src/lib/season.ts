/**
 * Season file loaders for the Lich's contest: config.yaml, pool.yaml,
 * managers.yaml, taverns.yaml and challenges/*.yaml, each loaded into
 * engine types and fully validated.
 *
 * - A season is named by id (`seasons/<id>/` under the repo root) or by a
 *   `SeasonLocation`, for fixtures that live elsewhere (the lich season in
 *   sims/fixtures/lich-season/ pools the repo's own characters).
 * - Every loader collects all the issues it finds and throws one
 *   `ValidationFailure` with a line per issue: `<file>: <field>: <message>`.
 * - Chrome (a tavern's banner, a challenge's title, story and lines) is
 *   split off here and never reaches the engine.
 */
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BOT_IDS } from '@league-of-taverns/bots';
import type { BotId } from '@league-of-taverns/bots';
import {
  ABILITIES,
  MAX_TAVERNS,
  PoolEntrySchema,
  REGISTRY_VERSION,
  TRAITS,
  challengeCheckSchema,
  checkAbility,
  configIssues,
  indexSnapshot,
  kebabIdSchema,
  parseCr,
  seasonConfigSchema,
  toSchemaIssues,
  validateModifiers,
  votesIn,
} from '@league-of-taverns/engine';
import type { Ability, Challenge, CrEighths, Open5eMonster, PooledCharacter, SchemaIssue, SeasonConfig, VotingStrategy } from '@league-of-taverns/engine';
import { z } from 'zod';
import { bannerSchema, type Banner } from './banner';
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

/** The season sims and the playground use. Its pool is drawn from the repo's own characters/. */
export const LICH_SEASON: SeasonLocation = { dir: 'sims/fixtures/lich-season' };

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

/** config.yaml, split into the engine's `SeasonConfig` and the keys only the file carries. */
export interface LoadedSeasonConfig {
  readonly config: SeasonConfig;
  /** Display name, e.g. "Season One". */
  readonly name: string;
  /** The other season files, as written: paths relative to the season directory. */
  readonly files: { readonly pool: string; readonly managers: string; readonly taverns: string; readonly challenges: string };
}

/** Keys config.yaml has that `SeasonConfig` does not. */
const FILE_ONLY_KEYS = ['name', 'pool', 'managers', 'taverns', 'challenges'] as const;

const configFileOnlySchema = z.looseObject({ name: text, pool: text, managers: text, taverns: text, challenges: text });

/**
 * Load config.yaml as the engine's `SeasonConfig`, with the file-only keys
 * split out. A config whose `model` is missing gets `{}` (no overrides). A
 * season named by id must have `id` equal to its folder name.
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
  const engineInput: Record<string, unknown> = { ...raw };
  for (const key of FILE_ONLY_KEYS) delete engineInput[key];
  if (isRecord(engineInput.contest) && engineInput.contest.model === undefined) engineInput.contest = { ...engineInput.contest, model: {} };
  const engine = seasonConfigSchema.safeParse(engineInput);
  if (!engine.success) issues.addAll(toSchemaIssues(engine.error));
  if (!fileOnly.success || !engine.success) throw issues.failure();
  const config: SeasonConfig = engine.data;
  if (ctx.expectedId !== undefined && config.id !== ctx.expectedId) {
    issues.add('id', `${JSON.stringify(config.id)} does not match its folder name ${JSON.stringify(ctx.expectedId)}`);
  }
  issues.throwIfAny();
  const { name, pool, managers, taverns, challenges } = fileOnly.data;
  return { config, name, files: { pool, managers, taverns, challenges } };
}

// ── pool.yaml ──────────────────────────────────────────────────────────────

export interface SeasonPool {
  readonly season: string;
  readonly registry: number;
  /** In file order. */
  readonly characters: ReadonlyArray<PooledCharacter>;
  /** Base CR in eighths, by character id. Modifiers never change CR. */
  readonly cr: ReadonlyMap<string, CrEighths>;
  /** Each character's voting strategy, by id. */
  readonly strategies: ReadonlyMap<string, VotingStrategy>;
}

const poolFileSchema = z.strictObject({
  season: kebabIdSchema,
  registry: z.number().int().positive(),
  characters: z.array(PoolEntrySchema),
});

/**
 * Load pool.yaml. Checks, all reported together: the file's shape; `season`
 * and `registry` against config.yaml and the engine's registry; unique ids;
 * every id has a character folder; every base is in the snapshot; modifiers
 * pass `validateModifiers`. Whether it holds a whole cast is `loadSeason`'s
 * check, so a pool still being built (for its art) loads.
 */
export function loadPool(season: SeasonSource, root: RepoRoot = REPO_ROOT): SeasonPool {
  const ctx = seasonContext(season, root);
  const loaded = readConfig(ctx);
  return readPool(ctx, loaded, loadSnapshot(loaded.config.snapshot, ctx.root));
}

function readPool(ctx: SeasonContext, loaded: LoadedSeasonConfig, snapshot: ReadonlyArray<Open5eMonster>): SeasonPool {
  const { config } = loaded;
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
  const strategies = new Map<string, VotingStrategy>();
  const firstIndex = new Map<string, number>();
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
      for (const line of error.message.split('\n')) issues.add(at, line);
      return;
    }
    const character: PooledCharacter = { ref, modifiers: entry.modifiers };
    for (const issue of validateModifiers(character, config.budget.modifierPointsPerCharacter, TRAITS)) issues.add(at, `[${issue.code}] ${issue.message}`);
    const record = bySlug.get(ref.base);
    if (record === undefined) {
      issues.add(at, `base ${JSON.stringify(ref.base)} is not in snapshot ${JSON.stringify(config.snapshot)}`);
      return;
    }
    characters.push(character);
    cr.set(ref.id, parseCr(record.challenge_rating));
    strategies.set(ref.id, entry.strategy);
  });
  issues.throwIfAny();
  return { season: pool.season, registry: pool.registry, characters, cr, strategies };
}

// ── managers.yaml ──────────────────────────────────────────────────────────

export interface Person {
  readonly login: string;
  /** GitHub numeric user id. Null until filled in. */
  readonly githubId: number | null;
}

export type ManagerAccountEntry = Person | { readonly bot: BotId };

/** A manager: chooses a tavern in reverse draft order, then runs it. */
export interface ManagerEntry {
  readonly id: string;
  readonly account: ManagerAccountEntry;
}

export interface SeasonManagers {
  readonly commissioner: Person;
  readonly gm: Person;
  /** In join order. At most `MAX_TAVERNS`. */
  readonly managers: ReadonlyArray<ManagerEntry>;
}

const personSchema = z.strictObject({ login: text, githubId: z.number().int().positive().nullable() });

const managersFileSchema = z.strictObject({
  commissioner: personSchema,
  gm: personSchema,
  managers: z.array(z.strictObject({ id: kebabIdSchema, account: z.union([personSchema, z.strictObject({ bot: z.enum(BOT_IDS) })]) })).min(1),
});

/**
 * Load managers.yaml. Manager ids are unique, there are at most
 * `MAX_TAVERNS`, and among human managers GitHub ids (where not null) and
 * logins (case-insensitive) are unique.
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
  if (managers.managers.length > MAX_TAVERNS) issues.add('managers', `has ${managers.managers.length} managers; a league has at most ${MAX_TAVERNS}`);
  managers.managers.forEach((manager, i) => {
    const at = `managers[${i}]`;
    const firstId = seen.id.get(manager.id);
    if (firstId !== undefined) issues.add(`${at}.id`, `duplicate manager id ${JSON.stringify(manager.id)} (also managers[${firstId}])`);
    else seen.id.set(manager.id, i);
    if ('bot' in manager.account) return;
    const { githubId, login } = manager.account;
    if (githubId !== null) {
      const first = seen.githubId.get(githubId);
      if (first !== undefined) issues.add(`${at}.account.githubId`, `GitHub id ${githubId} is already managers[${first}]`);
      else seen.githubId.set(githubId, i);
    }
    const key = login.toLowerCase();
    const first = seen.login.get(key);
    if (first !== undefined) issues.add(`${at}.account.login`, `${JSON.stringify(login)} is already managers[${first}]`);
    else seen.login.set(key, i);
  });
  issues.throwIfAny();
  return managers;
}

// ── taverns.yaml ───────────────────────────────────────────────────────────

/** One of the season's taverns: a team name, a banner, and the regulars' toast. The banner and toast are chrome. */
export interface TavernEntry {
  readonly id: string;
  readonly name: string;
  readonly banner: Banner;
  /** What the regulars say when a keeper takes the tavern. */
  readonly toast?: string;
}

const tavernsFileSchema = z.strictObject({
  season: kebabIdSchema,
  taverns: z.array(z.strictObject({ id: kebabIdSchema, name: text, banner: bannerSchema, toast: text.exactOptional() })).min(1),
});

/** Load taverns.yaml: unique ids and marks, at most `MAX_TAVERNS`, `season` matching config.yaml. */
export function loadTaverns(season: SeasonSource, root: RepoRoot = REPO_ROOT): ReadonlyArray<TavernEntry> {
  const ctx = seasonContext(season, root);
  return readTaverns(ctx, readConfig(ctx));
}

function readTaverns(ctx: SeasonContext, loaded: LoadedSeasonConfig): ReadonlyArray<TavernEntry> {
  const { file, label } = seasonFile(ctx, loaded.files.taverns);
  const parsed = parseOrThrow(tavernsFileSchema, readYaml(file, label), label);
  const issues = new Issues(label);
  if (parsed.season !== loaded.config.id) issues.add('season', `${JSON.stringify(parsed.season)} does not match config.yaml id ${JSON.stringify(loaded.config.id)}`);
  if (parsed.taverns.length > MAX_TAVERNS) issues.add('taverns', `has ${parsed.taverns.length} taverns; a league has at most ${MAX_TAVERNS}`);
  const ids = new Set<string>();
  const marks = new Set<string>();
  parsed.taverns.forEach((t, i) => {
    if (ids.has(t.id)) issues.add(`taverns[${i}].id`, `duplicate tavern id ${JSON.stringify(t.id)}`);
    ids.add(t.id);
    if (marks.has(t.banner.mark)) issues.add(`taverns[${i}].banner.mark`, `${t.banner.mark} is another tavern's mark`);
    marks.add(t.banner.mark);
  });
  issues.throwIfAny();
  return parsed.taverns;
}

// ── challenges/*.yaml ──────────────────────────────────────────────────────

/** A challenge's chrome: never passed to the engine. */
export interface ChallengeChrome {
  /** e.g. "The Phylactery in the Moat". */
  readonly title: string;
  /** The Lich's words when he sets the task. */
  readonly story: string;
  /** One short line per check, in check order: what the contestants are doing, e.g. "swim the moat". */
  readonly lines: ReadonlyArray<string>;
}

export interface LoadedChallenge {
  readonly episode: number;
  readonly challenge: Challenge;
  readonly chrome: ChallengeChrome;
  /** Absolute path. */
  readonly file: string;
}

/** A check as authored is the engine's check plus its chrome `line`, which is split off before the check is parsed. */
const checkLineSchema = z.looseObject({ line: text });

const challengeFileSchema = z.strictObject({
  id: kebabIdSchema,
  episode: z.number().int().positive(),
  title: text,
  story: text,
  checks: z.array(z.unknown()).min(1),
});

/** challenges/*.yaml, sorted by path. Missing folder → none. */
function challengeFiles(ctx: SeasonContext, loaded: LoadedSeasonConfig): ReadonlyArray<string> {
  const dir = resolve(ctx.dir, loaded.files.challenges);
  try {
    return readdirSync(dir)
      .filter((name) => /\.ya?ml$/.test(name))
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile())
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Load every challenge: each file's shape, one per episode 1..votes with no
 * gaps or repeats, unique ids, and every check with a `line`. Returned in
 * episode order, with chrome split off.
 */
export function loadChallenges(season: SeasonSource, root: RepoRoot = REPO_ROOT): ReadonlyArray<LoadedChallenge> {
  const ctx = seasonContext(season, root);
  return readChallenges(ctx, readConfig(ctx));
}

function readChallenges(ctx: SeasonContext, loaded: LoadedSeasonConfig): ReadonlyArray<LoadedChallenge> {
  const out: LoadedChallenge[] = [];
  const failures: string[] = [];
  for (const file of challengeFiles(ctx, loaded)) {
    const label = displayPath(file, ctx.root);
    const issues = new Issues(label);
    const parsed = challengeFileSchema.safeParse(readYaml(file, label));
    if (!parsed.success) {
      issues.addAll(toSchemaIssues(parsed.error));
      failures.push(...issues.lines);
      continue;
    }
    const checks: Challenge['checks'][number][] = [];
    const lines: string[] = [];
    parsed.data.checks.forEach((raw, i) => {
      const withLine = checkLineSchema.safeParse(raw);
      if (!withLine.success) {
        for (const issue of toSchemaIssues(withLine.error)) issues.add(`checks[${i}].${issue.path}`, issue.message);
        return;
      }
      const { line, ...mechanics } = withLine.data;
      const strict = challengeCheckSchema.safeParse(mechanics);
      if (!strict.success) {
        for (const issue of toSchemaIssues(strict.error)) issues.add(`checks[${i}].${issue.path}`, issue.message);
        return;
      }
      checks.push(strict.data);
      lines.push(line);
    });
    failures.push(...issues.lines);
    if (issues.lines.length > 0) continue;
    const { id, episode, title, story } = parsed.data;
    out.push({ episode, challenge: { id, checks }, chrome: { title, story: story.trim(), lines }, file });
  }
  const votes = votesIn(loaded.config);
  const dirLabel = displayPath(resolve(ctx.dir, loaded.files.challenges), ctx.root);
  out.sort((a, b) => a.episode - b.episode);
  const seenIds = new Map<string, number>();
  for (const c of out) {
    const other = seenIds.get(c.challenge.id);
    if (other !== undefined) failures.push(`${displayPath(c.file, ctx.root)}: id: ${JSON.stringify(c.challenge.id)} is also episode ${other}'s`);
    seenIds.set(c.challenge.id, c.episode);
  }
  if (failures.length === 0) {
    for (let e = 1; e <= votes; e++) {
      const n = out.filter((c) => c.episode === e).length;
      if (n !== 1) failures.push(`${dirLabel}: episode ${e} has ${n} challenges; every episode 1..${votes} needs exactly one`);
    }
    const extra = out.filter((c) => c.episode > votes);
    for (const c of extra) failures.push(`${displayPath(c.file, ctx.root)}: episode ${c.episode} is past the season's ${votes} votes`);
  }
  if (failures.length > 0) throw new ValidationFailure(failures.join('\n'));
  return out;
}

/** How many checks across `challenges` use each ability: the season's public hint. */
export function abilityMix(challenges: ReadonlyArray<Challenge>): Readonly<Record<Ability, number>> {
  const mix = Object.fromEntries(ABILITIES.map((a) => [a, 0])) as Record<Ability, number>;
  for (const c of challenges) for (const check of c.checks) mix[checkAbility(check)]++;
  return mix;
}

// ── everything at once ─────────────────────────────────────────────────────

export interface LoadedSeason extends LoadedSeasonConfig {
  /** Absolute season directory. */
  readonly dir: string;
  readonly snapshot: ReadonlyArray<Open5eMonster>;
  readonly pool: SeasonPool;
  readonly managers: SeasonManagers;
  readonly taverns: ReadonlyArray<TavernEntry>;
  readonly challenges: ReadonlyArray<LoadedChallenge>;
}

/**
 * Load and validate config, snapshot, pool, managers, taverns and
 * challenges, reading each file once. Failures from every file are combined
 * into one `ValidationFailure`. A config or snapshot failure stops early.
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
  const taverns = attempt(() => readTaverns(ctx, loaded));
  const challenges = attempt(() => readChallenges(ctx, loaded));
  if (pool !== undefined && pool.characters.length < loaded.config.contest.castSize) {
    failures.push(`${seasonFile(ctx, loaded.files.pool).label}: characters: ${pool.characters.length} characters, fewer than config.yaml contest.castSize ${loaded.config.contest.castSize}`);
  }
  if (managers !== undefined && taverns !== undefined) {
    const label = seasonFile(ctx, 'config.yaml').label;
    if (managers.managers.length > taverns.length) failures.push(`${label}: ${managers.managers.length} managers, but only ${taverns.length} tavern(s) to choose from`);
    for (const issue of configIssues(loaded.config, managers.managers.length)) failures.push(`${label}: ${issue}`);
  }
  if (pool === undefined || managers === undefined || taverns === undefined || challenges === undefined || failures.length > 0) {
    throw new ValidationFailure(failures.join('\n'));
  }
  return { ...loaded, dir: ctx.dir, snapshot, pool, managers, taverns, challenges };
}
