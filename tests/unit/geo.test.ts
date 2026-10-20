import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createMmdbLookup,
  effectiveGranularity,
  geoForEvent,
  NULL_GEO,
  type GeoGranularity,
  type GeoLookup,
} from '../../src/core/geo.js';
import type { PrivacyMode } from '../../src/types.js';

const FAKE_LOOKUP: GeoLookup = {
  buildEpoch: 1,
  lookup: (ip: string) => (ip === '203.0.113.9' ? { country: 'US', region: 'CA', city: 'Mountain View' } : null),
};

const NO_FLAGS = { isAppleRelay: false, isGoogleProxy: false, isDatacenter: false };

describe('geo', () => {
  it('324. geoForEvent returns a country for a human open with a fake lookup', () => {
    const result = geoForEvent({
      ip: '203.0.113.9',
      classification: 'human',
      privacyMode: 'off',
      granularity: 'city',
      flags: NO_FLAGS,
      lookup: FAKE_LOOKUP,
    });
    expect(result).toEqual({ country: 'US', region: 'CA', city: 'Mountain View' });
  });

  it('325. machine/proxy classifications return NULL_GEO even when the lookup would answer', () => {
    const classifications = ['google_proxy_prefetch', 'apple_mpp', 'self_open', 'bot', 'scanner', 'duplicate'];
    for (const classification of classifications) {
      const result = geoForEvent({
        ip: '203.0.113.9',
        classification,
        privacyMode: 'off',
        granularity: 'city',
        flags: NO_FLAGS,
        lookup: FAKE_LOOKUP,
      });
      expect(result).toEqual(NULL_GEO);
    }
  });

  it('326. an IP flagged datacenter/appleRelay/googleProxy returns NULL_GEO', () => {
    for (const flags of [
      { ...NO_FLAGS, isDatacenter: true },
      { ...NO_FLAGS, isAppleRelay: true },
      { ...NO_FLAGS, isGoogleProxy: true },
    ]) {
      expect(
        geoForEvent({ ip: '203.0.113.9', classification: 'human', privacyMode: 'off', granularity: 'city', flags, lookup: FAKE_LOOKUP }),
      ).toEqual(NULL_GEO);
    }
  });

  it('327. PRIVACY_MODE=strict never calls the lookup at all', () => {
    let calls = 0;
    const spy: GeoLookup = { buildEpoch: null, lookup: (ip) => { calls += 1; return FAKE_LOOKUP.lookup(ip); } };
    const result = geoForEvent({ ip: '203.0.113.9', classification: 'human', privacyMode: 'strict', granularity: 'city', flags: NO_FLAGS, lookup: spy });
    expect(result).toEqual(NULL_GEO);
    expect(calls).toBe(0);
  });

  it('328. PRIVACY_MODE=balanced caps at country even with granularity city', () => {
    const result = geoForEvent({
      ip: '203.0.113.9',
      classification: 'human',
      privacyMode: 'balanced',
      granularity: 'city',
      flags: NO_FLAGS,
      lookup: FAKE_LOOKUP,
    });
    expect(result).toEqual({ country: 'US', region: null, city: null });
  });

  it('329. effectiveGranularity is total over all nine mode x granularity combinations', () => {
    const modes: PrivacyMode[] = ['off', 'balanced', 'strict'];
    const granularities: GeoGranularity[] = ['country', 'region', 'city'];
    for (const mode of modes) {
      for (const g of granularities) {
        const result = effectiveGranularity(g, mode);
        if (mode === 'strict') expect(result).toBe('none');
        else if (mode === 'balanced') expect(result).toBe('country');
        else expect(result).toBe(g);
      }
    }
  });

  it('330. a lookup that throws is swallowed and yields NULL_GEO', () => {
    const throwing: GeoLookup = {
      buildEpoch: null,
      lookup: () => {
        throw new Error('boom');
      },
    };
    const result = geoForEvent({ ip: '203.0.113.9', classification: 'human', privacyMode: 'off', granularity: 'city', flags: NO_FLAGS, lookup: throwing });
    expect(result).toEqual(NULL_GEO);
  });

  it('330b. reader test against the vendored fixture mmdb, skipped when absent', async () => {
    const fixture = join(process.cwd(), 'tests', 'fixtures', 'geo', 'GeoIP2-City-Test.mmdb');
    if (!existsSync(fixture)) {
      return; // no vendored fixture in this checkout - equivalent to it.skipIf
    }
    const lookup = await createMmdbLookup(fixture);
    expect(lookup).not.toBeNull();
  });

  it('createMmdbLookup returns null (never throws) for a missing/unparseable file', async () => {
    const lookup = await createMmdbLookup('/nonexistent/path/to.mmdb');
    expect(lookup).toBeNull();
  });

  it('geoForEvent returns NULL_GEO with no lookup or no IP', () => {
    expect(geoForEvent({ ip: null, classification: 'human', privacyMode: 'off', granularity: 'city', flags: NO_FLAGS, lookup: FAKE_LOOKUP })).toEqual(NULL_GEO);
    expect(geoForEvent({ ip: '203.0.113.9', classification: 'human', privacyMode: 'off', granularity: 'city', flags: NO_FLAGS, lookup: null })).toEqual(NULL_GEO);
  });
});
