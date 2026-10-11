/**
 * The raw Open5e monster record, exactly as stored in data/open5e/.
 *
 * We store records verbatim and never reshape them on disk. Only the adapter
 * (./index.ts) interprets them. Unknown fields are preserved because the
 * record is opaque to everything else.
 *
 * Checked against every record in snapshot `open5e-v1-2026-10` (Open5e v1
 * `/monsters/`, 322 records) by engine/test/snapshot-types.test.ts. Notes on
 * that data are on each field. API version choice: docs/decisions.md D-17.
 */
export interface Open5eMonster {
  readonly slug: string;
  /** Flavor text. `""` for every SRD record. */
  readonly desc: string;
  readonly name: string;
  readonly size: string;
  readonly type: string;
  /** `""` when there is none. */
  readonly subtype: string;
  /** e.g. "Dragons, Chromatic". */
  readonly group: string | null;
  readonly alignment: string;
  readonly armor_class: number;
  /** e.g. "natural armor". */
  readonly armor_desc: string | null;
  readonly hit_points: number;
  readonly hit_dice: string;
  readonly speed: Open5eSpeed;
  readonly strength: number;
  readonly dexterity: number;
  readonly constitution: number;
  readonly intelligence: number;
  readonly wisdom: number;
  readonly charisma: number;
  /** Null when the creature isn't proficient. The adapter falls back to the ability modifier. */
  readonly strength_save: number | null;
  readonly dexterity_save: number | null;
  readonly constitution_save: number | null;
  readonly intelligence_save: number | null;
  readonly wisdom_save: number | null;
  readonly charisma_save: number | null;
  /** Equals `skills.perception` when proficient, else null. */
  readonly perception: number | null;
  /**
   * Proficient skills only, with proficiency already applied. `{}` when none.
   * Keys are lowercase single words in this snapshot (no multi-word skill
   * appears). The adapter normalizes other spellings defensively.
   */
  readonly skills: Readonly<Record<string, number>>;
  /**
   * Free text, `""` when empty, never null. Groups are separated by `;`, e.g.
   * "cold; bludgeoning, piercing, and slashing from nonmagical attacks".
   */
  readonly damage_vulnerabilities: string;
  readonly damage_resistances: string;
  readonly damage_immunities: string;
  readonly condition_immunities: string;
  /** Free text always ending in "passive Perception N", e.g. "darkvision 60 ft., passive Perception 8". */
  readonly senses: string;
  readonly languages: string;
  /** Display form: "0" to "30", or "1/8", "1/4", "1/2". Always agrees with `cr`. */
  readonly challenge_rating: string;
  /** Numeric form: 0, 0.125, 0.25, 0.5 or a whole number. */
  readonly cr: number;
  /** Null for creatures with no actions (`frog`, `sea-horse`). */
  readonly actions: ReadonlyArray<Open5eAction> | null;
  /** Always null in this snapshot. */
  readonly bonus_actions: ReadonlyArray<Open5eAction> | null;
  readonly reactions: ReadonlyArray<Open5eAction> | null;
  /** `""` when the creature has no legendary actions. */
  readonly legendary_desc: string;
  /** Null when there are none, never `[]`. */
  readonly legendary_actions: ReadonlyArray<Open5eAction> | null;
  /** Null when there are none, never `[]`. */
  readonly special_abilities: ReadonlyArray<Open5eAction> | null;
  /** Open5e spell URLs. `[]` when none. */
  readonly spell_list: ReadonlyArray<string>;
  readonly page_no: number;
  readonly environments: ReadonlyArray<string>;
  readonly img_main: string | null;
  readonly document__slug: string;
  readonly document__title: string;
  readonly document__license_url: string;
  readonly document__url: string;
  readonly v2_converted_path: string;
  readonly [unknownField: string]: unknown;
}

/**
 * Speeds in feet. Every key is optional: six swim-only creatures have no
 * `walk`, and flyers that can't walk list `walk: 0`.
 */
export interface Open5eSpeed {
  readonly walk?: number;
  readonly fly?: number;
  readonly swim?: number;
  readonly climb?: number;
  readonly burrow?: number;
  /** `true` when present (7 records). */
  readonly hover?: boolean;
  /** Free text about other forms, e.g. "40 ft. in wolf form" (the four lycanthropes). */
  readonly notes?: string;
  readonly [unknownKind: string]: number | boolean | string | undefined;
}

/**
 * One action, special ability, reaction or legendary action.
 *
 * The structured attack fields are unreliable: `attack_bonus` is 0 on many
 * non-attacks, missing on some real attacks, and sometimes disagrees with the
 * "+N to hit" in `desc`. `damage_dice` can be compound ("2d10+1d8").
 * The adapter treats `desc` as the source of truth.
 */
export interface Open5eAction {
  readonly name: string;
  readonly desc: string;
  readonly attack_bonus?: number;
  readonly damage_dice?: string;
  readonly damage_bonus?: number;
}

/** One entry in data/open5e/manifest.json. */
export interface SnapshotManifestEntry {
  /** e.g. "open5e-v1-2026-10". Season configs reference this id. */
  readonly id: string;
  readonly fetchedAt: string;
  readonly sourceUrl: string;
  readonly apiVersion: 'v1' | 'v2';
  /** Open5e document slugs included, each with its license. */
  readonly documents: ReadonlyArray<{ readonly slug: string; readonly title: string; readonly licenseUrl: string }>;
  readonly count: number;
  /** sha256 of the snapshot file, for integrity checks. */
  readonly sha256: string;
  /** Path relative to data/open5e/. */
  readonly file: string;
}
