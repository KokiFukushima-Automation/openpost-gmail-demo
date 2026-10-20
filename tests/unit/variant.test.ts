import { describe, expect, it } from 'vitest';
import { assignVariant, twoProportionZ, SIGNIFICANCE_CAVEAT, type Variant } from '../../src/core/variant.js';

const VARIANTS_50_50: Variant[] = [
  { key: 'A', template: 'a', weight: 1 },
  { key: 'B', template: 'b', weight: 1 },
];
const VARIANTS_90_10: Variant[] = [
  { key: 'A', template: 'a', weight: 9 },
  { key: 'B', template: 'b', weight: 1 },
];

describe('variant', () => {
  it('253. assignVariant is deterministic for the same (campaignId, email) across 1000 calls', () => {
    const first = assignVariant('camp1', 'user@example.com', VARIANTS_50_50);
    for (let i = 0; i < 1000; i++) {
      expect(assignVariant('camp1', 'user@example.com', VARIANTS_50_50)).toBe(first);
    }
  });

  it('254. a 50/50 split over 1000 synthetic addresses lands within +-3%; a 90/10 split likewise', () => {
    const n = 1000;
    let aCount50 = 0;
    let aCount90 = 0;
    for (let i = 0; i < n; i++) {
      const email = `user${i}@example.com`;
      if (assignVariant('camp1', email, VARIANTS_50_50) === 'A') aCount50 += 1;
      if (assignVariant('camp1', email, VARIANTS_90_10) === 'A') aCount90 += 1;
    }
    expect(Math.abs(aCount50 / n - 0.5)).toBeLessThanOrEqual(0.03);
    expect(Math.abs(aCount90 / n - 0.9)).toBeLessThanOrEqual(0.03);
  });

  it('255. variant assignment is independent of row order and of a later re-import', () => {
    const emails = ['a@x.com', 'b@x.com', 'c@x.com'];
    const forward = emails.map((e) => assignVariant('camp1', e, VARIANTS_50_50));
    const backward = [...emails].reverse().map((e) => assignVariant('camp1', e, VARIANTS_50_50));
    expect(backward.reverse()).toEqual(forward);
    // Re-import: same call again later, unaffected by anything except (campaignId, email).
    expect(emails.map((e) => assignVariant('camp1', e, VARIANTS_50_50))).toEqual(forward);
  });

  it('assignVariant with one variant always returns it (no hashing needed)', () => {
    expect(assignVariant('camp1', 'x@example.com', [{ key: 'only', template: 't', weight: 1 }])).toBe('only');
  });

  it('twoProportionZ computes a z-statistic for a hand-built 2x2 table and carries the caveat', () => {
    const result = twoProportionZ([
      { key: 'A', n: 500, successes: 200 },
      { key: 'B', n: 500, successes: 150 },
    ]);
    expect(result).not.toBeNull();
    expect(result?.caveat).toBe(SIGNIFICANCE_CAVEAT);
    expect(result?.z).toBeGreaterThan(0);
  });

  it('twoProportionZ returns null with fewer than two sampled groups', () => {
    expect(twoProportionZ([{ key: 'A', n: 10, successes: 1 }])).toBeNull();
    expect(twoProportionZ([{ key: 'A', n: 0, successes: 0 }, { key: 'B', n: 0, successes: 0 }])).toBeNull();
  });
});
