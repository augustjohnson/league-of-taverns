/**
 * The raw Open5e monster record, exactly as stored in data/open5e/.
 *
 * We store records verbatim and never reshape them on disk. Only the adapter
 * (./index.ts) interprets them. The fields below are the ones the adapter is
 * expected to read. Unknown fields are preserved because the record is opaque
 * to everything else.
 *
 * Field list targets the Open5e v1 `/monsters/` shape. Verify it against the
 * real pinned snapshot in T1.2. API version choice: docs/decisions.md D-17.
 */
export interface Open5eMonster {
  readonly slug: string;
  readonly name: string;
  readonly size: string;
  readonly type: string;
  readonly subtype: string;
  readonly alignment: string;
  readonly armor_class: number;
  readonly hit_points: number;
  readonly hit_dice: string;
  readonly speed: Readonly<Record<string, number | boolean>>;
  readonly strength: number;
  readonly dexterity: number;
  readonly constitution: number;
  readonly intelligence: number;
  readonly wisdom: number;
  readonly charisma: number;
  readonly strength_save: number | null;
  readonly dexterity_save: number | null;
  readonly constitution_save: number | null;
  readonly intelligence_save: number | null;
  readonly wisdom_save: number | null;
  readonly charisma_save: number | null;
  readonly perception: number | null;
  /** Proficient skills only, with proficiency already applied. Key spelling varies; normalize in the adapter. */
  readonly skills: Readonly<Record<string, number>>;
  /** Free text, e.g. "bludgeoning, piercing, and slashing from nonmagical attacks". */
  readonly damage_vulnerabilities: string;
  readonly damage_resistances: string;
  readonly damage_immunities: string;
  readonly condition_immunities: string;
  /** Free text, e.g. "darkvision 60 ft., passive Perception 8". */
  readonly senses: string;
  readonly languages: string;
  /** Display form: "1/4", "2", "10". */
  readonly challenge_rating: string;
  /** Numeric form: 0.25, 2, 10. */
  readonly cr: number;
  readonly actions: ReadonlyArray<Open5eAction>;
  readonly special_abilities: ReadonlyArray<Open5eAction> | null;
  readonly legendary_actions: ReadonlyArray<Open5eAction> | null;
  readonly environments: ReadonlyArray<string>;
  readonly document__slug: string;
  readonly document__title: string;
  readonly document__license_url: string;
  readonly [unknownField: string]: unknown;
}

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
