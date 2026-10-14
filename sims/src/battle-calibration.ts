/**
 * Calibration for battle model `ev-ttk-v0` (T6.2, docs/decisions.md D-28).
 *
 * Run: pnpm --filter @league-of-taverns/sims exec tsx src/battle-calibration.ts [parties]
 *
 * 1. Samples random legal parties of four distinct creatures from the pinned
 *    snapshot with total CR in [9, 12]: legal under B = 12, and spending most
 *    of the budget, as a real lineup would. CR 0 creatures are left out of
 *    both sides (they are free and mostly have no attacks).
 * 2. For each party and each ratio r in 0.25, 0.5, 0.75, 1.0, 1.5, samples an
 *    encounter of 1–6 creatures whose total CR is within 15% of r × the
 *    party's CR, and prints mean / p10 / median / p90 of `pWin` per ratio.
 * 3. For parties of a fixed strength (total CR 11–12), scores every creature
 *    of CR ≤ 1.5 × B (the largest encounter above; the fit is unstable in
 *    the sparse tail beyond it) fought alone by the model's unclamped logit,
 *    fits that against ln(CR),
 *    and lists the 10 creatures furthest above the fit (most favourable to
 *    the party: weak for their CR) and furthest below (least favourable:
 *    strong for their CR).
 *
 * Seeded with rngFor, so every run prints the same numbers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRAITS,
  effectiveStats,
  rngFor,
  toBaseStats,
  type BaseStats,
  type EffectiveStats,
  type Open5eMonster,
  type Party,
  type Rng,
} from '@league-of-taverns/engine';
import { EV_TTK_V0_K, P_WIN_RANGE, attackHitChance, evTtkBreakdown, evTtkV0 } from '../../engine/src/resolution/battle';

const SNAPSHOT_ID = 'open5e-v1-2026-10';
const SEED = 'battle-calibration-v0';
const BUDGET = 96; // B = 12, in eighths (D-16)
const PARTY_MIN_CR = 72; // 9
const RATIOS = [0.25, 0.5, 0.75, 1.0, 1.5] as const;
const ENCOUNTERS_PER_RATIO = 4;
const MAX_FOES = 6;
const CR_TOLERANCE = 0.15;
const PARTY_COUNT = Number(process.argv[2] ?? 500);
/** Creatures ranked in part 3: up to the largest encounter sampled, 1.5 × B. */
const RANKED_MAX_CR = 144;

type Foes = Array<{ readonly stats: BaseStats; readonly count: number }>;

// ── data ──────────────────────────────────────────────────────────────────

const snapshotPath = join(import.meta.dirname, '..', '..', 'data', 'open5e', SNAPSHOT_ID, 'monsters.json');
const records = JSON.parse(readFileSync(snapshotPath, 'utf8')) as ReadonlyArray<Open5eMonster>;
const creatures: ReadonlyArray<BaseStats> = records.map((r) => toBaseStats(r).stats).filter((s) => s.cr > 0);
const effective = new Map<string, EffectiveStats>(
  creatures.map((base) => [base.slug, effectiveStats({ ref: { id: base.slug, base: base.slug }, modifiers: [] }, base, TRAITS)]),
);
const crValues = [...new Set(creatures.map((c) => c.cr))].sort((a, b) => a - b);

// ── sampling ──────────────────────────────────────────────────────────────

function pick<T>(rng: Rng, xs: ReadonlyArray<T>): T {
  const x = xs[Math.floor(rng() * xs.length)];
  if (x === undefined) throw new Error('pick from an empty list');
  return x;
}

/** Four distinct creatures with total CR in [minCr, BUDGET], by rejection. */
function sampleParty(rng: Rng, minCr: number): Party {
  for (let attempt = 0; attempt < 100_000; attempt++) {
    const chosen = new Set<BaseStats>();
    while (chosen.size < 4) chosen.add(pick(rng, creatures));
    const members = [...chosen];
    const total = members.reduce((n, m) => n + m.cr, 0);
    if (total < minCr || total > BUDGET) continue;
    const stats = members.map((m) => effective.get(m.slug) as EffectiveStats);
    return { members: stats };
  }
  throw new Error('could not sample a party');
}

function partyCr(party: Party): number {
  return party.members.reduce((n, m) => n + m.cr, 0);
}

/**
 * 1–6 creatures with total CR within CR_TOLERANCE of `target` eighths. Each
 * slot but the last takes a creature near its fair share of what is left;
 * the last takes the CR closest to the remainder. Rejects and retries.
 */
function sampleEncounter(rng: Rng, target: number): Foes {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const n = 1 + Math.floor(rng() * MAX_FOES);
    const slots: BaseStats[] = [];
    let remaining = target;
    for (let left = n; left > 0; left--) {
      let candidates: ReadonlyArray<BaseStats>;
      if (left === 1) {
        const nearest = crValues.reduce((best, cr) => (Math.abs(cr - remaining) < Math.abs(best - remaining) ? cr : best));
        candidates = creatures.filter((c) => c.cr === nearest);
      } else {
        const share = remaining / left;
        candidates = creatures.filter((c) => c.cr >= share / 2 && c.cr <= share * 1.5 && c.cr <= remaining - (left - 1));
      }
      if (candidates.length === 0) break;
      const c = pick(rng, candidates);
      slots.push(c);
      remaining -= c.cr;
    }
    if (slots.length !== n || Math.abs(remaining) > Math.max(CR_TOLERANCE * target, 1)) continue;
    const counts = new Map<BaseStats, number>();
    for (const c of slots) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts].map(([stats, count]) => ({ stats, count }));
  }
  throw new Error(`could not sample an encounter of CR ${target / 8}`);
}

// ── stats helpers ─────────────────────────────────────────────────────────

function quantile(sorted: ReadonlyArray<number>, q: number): number {
  return sorted[Math.round(q * (sorted.length - 1))] ?? Number.NaN;
}

function mean(xs: ReadonlyArray<number>): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function fmt(x: number, digits = 3): string {
  return x.toFixed(digits);
}

function formatCr(eighths: number): string {
  const frac: Record<number, string> = { 1: '1/8', 2: '1/4', 4: '1/2' };
  return frac[eighths] ?? String(eighths / 8);
}

/** Least squares for y ≈ a + b·x + c·x². */
function fitQuadratic(xs: ReadonlyArray<number>, ys: ReadonlyArray<number>): (x: number) => number {
  // Normal equations, solved by Cramer's rule.
  const s = [0, 0, 0, 0, 0];
  const t = [0, 0, 0];
  xs.forEach((x, i) => {
    const y = ys[i] ?? 0;
    for (let p = 0; p < 5; p++) s[p] = (s[p] ?? 0) + x ** p;
    for (let p = 0; p < 3; p++) t[p] = (t[p] ?? 0) + y * x ** p;
  });
  const [s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0] = s;
  const [t0 = 0, t1 = 0, t2 = 0] = t;
  const det3 = (m: number[][]): number => {
    const [[a = 0, b = 0, c = 0] = [], [d = 0, e = 0, f = 0] = [], [g = 0, h = 0, i = 0] = []] = m;
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  };
  const m = [
    [s0, s1, s2],
    [s1, s2, s3],
    [s2, s3, s4],
  ];
  const d = det3(m);
  const a = det3([[t0, s1, s2], [t1, s2, s3], [t2, s3, s4]]) / d;
  const b = det3([[s0, t0, s2], [s1, t1, s3], [s2, t2, s4]]) / d;
  const c = det3([[s0, s1, t0], [s1, s2, t1], [s2, s3, t2]]) / d;
  return (x) => a + b * x + c * x * x;
}

// ── 1 + 2: p(win) by encounter CR ratio ───────────────────────────────────

console.log(`# Battle calibration: ${evTtkV0.id}, K = ${EV_TTK_V0_K}`);
console.log(`snapshot ${SNAPSHOT_ID}: ${creatures.length} creatures with CR > 0; seed "${SEED}"`);
console.log(`${PARTY_COUNT} parties (4 distinct creatures, total CR ${PARTY_MIN_CR / 8}–${BUDGET / 8}), ${ENCOUNTERS_PER_RATIO} encounters of 1–${MAX_FOES} creatures per party per ratio`);
console.log('');

const parties = Array.from({ length: PARTY_COUNT }, (_, i) => sampleParty(rngFor(SEED, `party:${i}`), PARTY_MIN_CR));

console.log('| ratio | n | mean | p10 | median | p90 | at 0.02 | at 0.98 |');
console.log('|---|---|---|---|---|---|---|---|');
for (const ratio of RATIOS) {
  const ps: number[] = [];
  parties.forEach((party, i) => {
    for (let e = 0; e < ENCOUNTERS_PER_RATIO; e++) {
      const rng = rngFor(SEED, `encounter:${ratio}:${i}:${e}`);
      ps.push(evTtkV0.pWin(party, sampleEncounter(rng, Math.round(ratio * partyCr(party)))));
    }
  });
  const sorted = [...ps].sort((a, b) => a - b);
  const share = (v: number): string => `${fmt((100 * ps.filter((p) => p === v).length) / ps.length, 1)}%`;
  console.log(
    `| ${ratio} | ${ps.length} | ${fmt(mean(ps))} | ${fmt(quantile(sorted, 0.1))} | ${fmt(quantile(sorted, 0.5))} | ${fmt(quantile(sorted, 0.9))} | ${share(0.02)} | ${share(0.98)} |`,
  );
}

// ── 3: creatures most and least favourable for their CR ───────────────────

const strong = parties.filter((p) => partyCr(p) >= 88).slice(0, 200);
console.log('');
console.log(`## Creatures of CR ≤ ${RANKED_MAX_CR / 8} fought alone by ${strong.length} parties of total CR 11–12`);
console.log('Residual = mean logit minus a quadratic fit of mean logit on ln(CR). Positive: easier than its CR says.');
console.log('');

const scored: Array<{ readonly c: BaseStats; readonly z: number; readonly p: number }> = [];
const noDamage: string[] = [];
for (const c of creatures.filter((x) => x.cr <= RANKED_MAX_CR)) {
  const foes: Foes = [{ stats: c, count: 1 }];
  const zs = strong.map((party) => evTtkBreakdown(party, foes).logit);
  if (!zs.every(Number.isFinite)) {
    noDamage.push(`${c.slug} (CR ${formatCr(c.cr)})`);
    continue;
  }
  scored.push({ c, z: mean(zs), p: mean(strong.map((party) => evTtkV0.pWin(party, foes))) });
}
const fit = fitQuadratic(
  scored.map((s) => Math.log(s.c.cr / 8)),
  scored.map((s) => s.z),
);
const ranked = scored.map((s) => ({ ...s, residual: s.z - fit(Math.log(s.c.cr / 8)) })).sort((a, b) => b.residual - a.residual);

const table = (title: string, rows: typeof ranked): void => {
  console.log(`### ${title}`);
  console.log('| creature | CR | AC | HP | DPR vs AC 14 | mean logit | residual | mean p(win) |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const { c, z, residual, p } of rows) {
    const dpr14 = c.attacks.reduce((n, a) => n + a.perTurn * attackHitChance(a.attackBonus, 14) * a.averageDamage, 0);
    console.log(`| ${c.slug} | ${formatCr(c.cr)} | ${c.ac} | ${c.hp} | ${fmt(dpr14, 1)} | ${fmt(z, 2)} | ${fmt(residual, 2)} | ${fmt(p)} |`);
  }
  console.log('');
};
table('Most favourable to the party (weak for their CR)', ranked.slice(0, 10));
table('Least favourable to the party (strong for their CR)', ranked.slice(-10).reverse());
if (noDamage.length > 0) {
  console.log(`No parsed attack damage, so the party always wins (p = ${P_WIN_RANGE.max}): ${noDamage.join(', ')}`);
}
