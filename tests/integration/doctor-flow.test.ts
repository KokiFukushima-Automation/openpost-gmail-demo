import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { setupTestServer } from '../helpers/setup.js';
import { runDoctor } from '../../src/cli/commands/doctor.js';
import { EMPTY_RANGE_INDEX } from '../../src/core/ranges.js';
import { RangeSet, parseCidr } from '../../src/core/cidr.js';
import { upsertRangeSet } from '../../src/db/repo.js';

const SENT_AT = 1_700_000_000_000;

function fetchViaInject(app: FastifyInstance): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const res = await app.inject({ method: (init?.method as 'GET') ?? 'GET', url: u.pathname + u.search });
    const headersObj = res.headers as Record<string, string | string[] | number | undefined>;
    return {
      status: res.statusCode,
      ok: res.statusCode >= 200 && res.statusCode < 300,
      headers: {
        forEach: (cb: (value: string, key: string) => void) => {
          for (const [k, v] of Object.entries(headersObj)) {
            if (v !== undefined) cb(String(v), k);
          }
        },
        get: (name: string) => {
          const v = headersObj[name.toLowerCase()];
          return v === undefined ? null : String(v);
        },
      },
      arrayBuffer: async () => {
        const buf = res.rawPayload;
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
      text: async () => res.payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function healthyRanges() {
  const now = Date.now();
  return {
    apple: new RangeSet('apple_relay', [parseCidr('17.0.0.0/8')!], 'x', null, now),
    googleProxy: new RangeSet('google_proxy', [parseCidr('34.64.0.0/10')!], 'x', null, now),
    datacenter: EMPTY_RANGE_INDEX.datacenter,
    loadedAt: now,
  };
}

describe('doctor end-to-end (injected fetch, no real network)', () => {
  it('109a. a healthy instance -> ok:true, exit 0 (no failing checks)', async () => {
    const env = setupTestServer({ startAt: SENT_AT, ranges: healthyRanges() });

    const result = await runDoctor({
      config: env.config,
      db: env.db,
      ranges: env.ranges,
      url: env.config.trackingBaseUrl,
      timeoutMs: 1000,
      offline: false,
      nowMs: SENT_AT,
      fetchImpl: fetchViaInject(env.app),
    });

    expect(result.summary.fail).toBe(0);
    expect(result.summary.ok).toBe(true);
  });

  it('109b. an unreachable pixel URL (mistyped token) -> exit 1, naming pixel.reachable', async () => {
    // no TRACKING_SECRET means signToken can't run; instead corrupt the base URL's port so the
    // pixel probe hits nothing listening there via the injected fetch (simulated as a 404).
    const env = setupTestServer({ startAt: SENT_AT, ranges: healthyRanges() });
    const brokenFetch: typeof fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await runDoctor({
      config: env.config,
      db: env.db,
      ranges: env.ranges,
      url: env.config.trackingBaseUrl,
      timeoutMs: 1000,
      offline: false,
      nowMs: SENT_AT,
      fetchImpl: brokenFetch,
    });

    expect(result.summary.ok).toBe(false);
    expect(result.results.some((r) => r.id.startsWith('pixel.reachable') && r.status === 'fail')).toBe(true);
  });

  it('finding #18: --url pointed at a different origin than TRACKING_BASE_URL skips the signed pixel/click probe, warning instead', async () => {
    const env = setupTestServer({ startAt: SENT_AT, ranges: healthyRanges() });
    let fetchCalled = false;
    const trackingFetch: typeof fetch = (async () => {
      fetchCalled = true;
      throw new Error('should never be called for a foreign --url');
    }) as unknown as typeof fetch;

    const result = await runDoctor({
      config: env.config,
      db: env.db,
      ranges: env.ranges,
      url: 'https://attacker.example.com',
      timeoutMs: 1000,
      offline: false,
      nowMs: SENT_AT,
      fetchImpl: trackingFetch,
      resolveDns: async () => ['203.0.113.1'],
    });

    expect(fetchCalled).toBe(false);
    expect(result.results.some((r) => r.id.startsWith('pixel.reachable'))).toBe(false);
    expect(result.results.some((r) => r.id.startsWith('click.reachable'))).toBe(false);
    const scope = result.results.find((r) => r.id === 'doctor.url_scope');
    expect(scope?.status).toBe('warn');
  });

  it('finding #19: a range file whose content no longer matches the sha256 recorded at the last update-ranges run fails doctor', async () => {
    const env = setupTestServer({ startAt: SENT_AT, ranges: healthyRanges() });
    // Simulate a legitimate `update-ranges` run having recorded this sha256...
    upsertRangeSet(env.db, {
      name: 'apple_relay',
      sourceUrl: null,
      generatedAt: SENT_AT,
      entryCount: 1,
      sha256: 'trusted-baseline-sha256',
      updatedAt: SENT_AT,
    });
    // ...and the on-disk (or, here, in-memory) RangeSet openpost actually loaded computing a
    // *different* sha256 - i.e. the file changed since that trusted update.
    const tamperedRanges = {
      ...healthyRanges(),
      apple: new RangeSet('apple_relay', [parseCidr('0.0.0.0/0')!], 'a-completely-different-sha256', null, SENT_AT),
    };

    const result = await runDoctor({
      config: env.config,
      db: env.db,
      ranges: tamperedRanges,
      timeoutMs: 1000,
      offline: true,
      nowMs: SENT_AT,
    });

    expect(result.summary.ok).toBe(false);
    const check = result.results.find((r) => r.id === 'ranges.integrity.apple_relay');
    expect(check?.status).toBe('fail');
  });

  it('--offline skips every network check', async () => {
    const env = setupTestServer({ startAt: SENT_AT, ranges: healthyRanges() });
    const result = await runDoctor({
      config: env.config,
      db: env.db,
      ranges: env.ranges,
      url: env.config.trackingBaseUrl,
      timeoutMs: 1000,
      offline: true,
      nowMs: SENT_AT,
    });
    expect(result.results.some((r) => r.id.startsWith('pixel.reachable'))).toBe(false);
  });

  it('finding #7: geo.db fails as "not applied" when GEOIP_DB_PATH points at a file that cannot be parsed, rather than passing just because it exists', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'openpost-doctor-geo-'));
    const bogusPath = join(dir, 'not-an-mmdb.mmdb');
    // Readable (statSync succeeds) but not a valid mmdb - createMmdbLookup must fail to load it.
    writeFileSync(bogusPath, 'this is not a valid mmdb file');
    try {
      const env = setupTestServer({ startAt: SENT_AT, ranges: healthyRanges(), configOverrides: { geoipDbPath: bogusPath } });
      const result = await runDoctor({
        config: env.config,
        db: env.db,
        ranges: env.ranges,
        timeoutMs: 1000,
        offline: true,
        nowMs: SENT_AT,
      });
      const geoCheck = result.results.find((r) => r.id === 'geo.db');
      expect(geoCheck?.status).toBe('fail');
      expect(geoCheck?.detail).toContain('not applied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finding #7: geo.db passes as "loaded and applied" only when GEOIP_DB_PATH is unset (geo genuinely off)', async () => {
    const env = setupTestServer({ startAt: SENT_AT, ranges: healthyRanges() });
    const result = await runDoctor({
      config: env.config,
      db: env.db,
      ranges: env.ranges,
      timeoutMs: 1000,
      offline: true,
      nowMs: SENT_AT,
    });
    const geoCheck = result.results.find((r) => r.id === 'geo.db');
    expect(geoCheck?.status).toBe('pass');
    expect(geoCheck?.detail).toContain('disabled');
  });
});
