import { createHash } from 'node:crypto';

/**
 * Deterministic A/B subject-variant assignment (docs/08_phase4_spec.md §2.8). Pure and total:
 * `h = sha256(campaignId + '\0' + email)`, `n = h.readUInt32BE(0)`, `bucket = n % totalWeight`,
 * walking the variants in declared order. Independent of row order, of resume, and of the other
 * rows - the same `(campaignId, email)` pair always lands in the same bucket, forever.
 */
export interface Variant {
  key: string;
  template: string;
  weight: number;
}

export function assignVariant(campaignId: string, email: string, variants: Variant[]): string {
  if (variants.length === 0) throw new Error('assignVariant requires at least one variant');
  if (variants.length === 1) return variants[0]!.key;
  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  if (totalWeight <= 0) throw new Error('assignVariant requires a positive total weight');
  const normalizedEmail = email.trim().toLowerCase();
  const digest = createHash('sha256').update(`${campaignId}\0${normalizedEmail}`).digest();
  const n = digest.readUInt32BE(0);
  const bucket = n % totalWeight;
  let acc = 0;
  for (const v of variants) {
    acc += v.weight;
    if (bucket < acc) return v.key;
  }
  return variants[variants.length - 1]!.key;
}

/** Two-proportion z-statistic between the two largest variants by sample size. Returned alongside
 *  an honest caveat string - reporting an unqualified "winner" is the dishonest thing every
 *  competing tool does. `null` when there are fewer than two variants with at least one sample. */
export interface TwoProportionZResult {
  z: number;
  variantA: string;
  variantB: string;
  caveat: string;
}

export const SIGNIFICANCE_CAVEAT =
  'indicative only - no multiple-comparison or sequential-testing correction, and N is usually far too small';

export function twoProportionZ(
  groups: Array<{ key: string; n: number; successes: number }>,
): TwoProportionZResult | null {
  const withSamples = groups.filter((g) => g.n > 0);
  if (withSamples.length < 2) return null;
  const sorted = [...withSamples].sort((a, b) => b.n - a.n);
  const a = sorted[0]!;
  const b = sorted[1]!;
  const p1 = a.successes / a.n;
  const p2 = b.successes / b.n;
  const pPooled = (a.successes + b.successes) / (a.n + b.n);
  const se = Math.sqrt(pPooled * (1 - pPooled) * (1 / a.n + 1 / b.n));
  const z = se === 0 ? 0 : (p1 - p2) / se;
  return { z, variantA: a.key, variantB: b.key, caveat: SIGNIFICANCE_CAVEAT };
}
