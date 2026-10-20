import { describe, expect, it } from 'vitest';
import {
  checkAccountsHealth,
  checkApiCors,
  checkBackupRecency,
  checkBaseUrl,
  checkClickProbe,
  checkGeoDb,
  checkNotifyConfig,
  checkPixelProbe,
  checkProxyContract,
  checkRangeIntegrity,
  checkRanges,
  checkUrlMatchesTrackingBase,
  summarise,
  type PixelProbe,
} from '../../src/core/doctor.js';
import { RangeSet, parseCidr } from '../../src/core/cidr.js';
import { makeConfig } from '../helpers/setup.js';

function healthyProbe(overrides: Partial<PixelProbe> = {}): PixelProbe {
  return {
    status: 200,
    headers: { 'content-type': 'image/gif', 'content-length': '43', 'cache-control': 'no-store, no-cache' },
    bodyLength: 43,
    redirected: false,
    elapsedMs: 20,
    ...overrides,
  };
}

describe('checkPixelProbe', () => {
  it('106. passes on a correct probe and fails separately for each mismatch', () => {
    const ok = checkPixelProbe(healthyProbe());
    expect(summarise(ok).fail).toBe(0);

    const wrongContentType = checkPixelProbe(healthyProbe({ headers: { 'content-type': 'text/html' } }));
    expect(summarise(wrongContentType).fail).toBeGreaterThan(0);
    expect(wrongContentType.find((r) => r.id === 'pixel.reachable.content-type')?.status).toBe('fail');

    const wrongLength = checkPixelProbe(healthyProbe({ bodyLength: 42 }));
    expect(wrongLength.find((r) => r.id === 'pixel.reachable.length')?.status).toBe('fail');

    const withEtag = checkPixelProbe(healthyProbe({ headers: { ...healthyProbe().headers, etag: '"abc"' } }));
    expect(withEtag.find((r) => r.id === 'pixel.reachable.no-validators')?.status).toBe('fail');

    const redirected = checkPixelProbe(healthyProbe({ redirected: true }));
    expect(redirected.find((r) => r.id === 'pixel.reachable.redirect')?.status).toBe('fail');

    const wrongStatus = checkPixelProbe(healthyProbe({ status: 404 }));
    expect(wrongStatus.find((r) => r.id === 'pixel.reachable.status')?.status).toBe('fail');
  });
});

describe('checkProxyContract', () => {
  it('107. fails for TRUST_PROXY=true + non-loopback bind and for TRUST_PROXY=false + public https base URL', () => {
    const trustProxyMisconfig = makeConfig({ trustProxy: 1, bindAddress: '0.0.0.0' });
    expect(checkProxyContract(trustProxyMisconfig)[0]?.status).toBe('fail');

    const missingTrustProxy = makeConfig({ trustProxy: false, trackingBaseUrl: 'https://t.example.com', bindAddress: '0.0.0.0' });
    expect(checkProxyContract(missingTrustProxy)[0]?.status).toBe('fail');

    const healthy = makeConfig({ trustProxy: false, bindAddress: '127.0.0.1', trackingBaseUrl: 'http://127.0.0.1:8787' });
    expect(checkProxyContract(healthy)[0]?.status).toBe('pass');
  });
});

describe('checkBaseUrl', () => {
  it('108. warns on *.trycloudflare.com / *.ngrok-free.app', () => {
    const cloudflare = checkBaseUrl('https://random.trycloudflare.com');
    expect(cloudflare.find((r) => r.id === 'base_url.host')?.status).toBe('warn');

    const ngrok = checkBaseUrl('https://random.ngrok-free.app');
    expect(ngrok.find((r) => r.id === 'base_url.host')?.status).toBe('warn');

    const normal = checkBaseUrl('https://t.example.com');
    expect(normal.find((r) => r.id === 'base_url.host')?.status).toBe('pass');

    const httpPublic = checkBaseUrl('http://t.example.com');
    expect(httpPublic.find((r) => r.id === 'base_url.scheme')?.status).toBe('fail');
  });
});

describe('checkClickProbe', () => {
  it('passes for 302/404, fails for 5xx or a hang, warns otherwise', () => {
    expect(checkClickProbe(302).status).toBe('pass');
    expect(checkClickProbe(404).status).toBe('pass');
    expect(checkClickProbe(500).status).toBe('fail');
    expect(checkClickProbe(null).status).toBe('fail');
    expect(checkClickProbe(200).status).toBe('warn');
  });
});

describe('checkRanges', () => {
  it('fails on an empty apple/google set, warns when older than 90 days, passes otherwise', () => {
    const now = 1_700_000_000_000;
    const empty = new RangeSet('apple_relay', [], 'x');
    const fresh = new RangeSet('google_proxy', [parseCidr('8.8.8.0/24')!], 'x', null, now);
    const old = new RangeSet('apple_relay', [parseCidr('17.0.0.0/8')!], 'x', null, now - 91 * 24 * 60 * 60 * 1000);

    const emptyResult = checkRanges(new Map([['apple_relay', empty], ['google_proxy', fresh]]), now);
    expect(emptyResult.find((r) => r.id === 'ranges.loaded.apple_relay')?.status).toBe('fail');
    expect(emptyResult.find((r) => r.id === 'ranges.loaded.google_proxy')?.status).toBe('pass');

    const oldResult = checkRanges(new Map([['apple_relay', old], ['google_proxy', fresh]]), now);
    expect(oldResult.find((r) => r.id === 'ranges.loaded.apple_relay')?.status).toBe('warn');
  });
});

describe('checkUrlMatchesTrackingBase (finding #18)', () => {
  it('passes when --url is the same origin as TRACKING_BASE_URL (path/trailing slash aside)', () => {
    expect(checkUrlMatchesTrackingBase('https://t.example.com', 'https://t.example.com/').status).toBe('pass');
    expect(checkUrlMatchesTrackingBase('https://t.example.com:8443', 'https://t.example.com:8443/o/x').status).toBe(
      'pass',
    );
  });

  it('warns (never fails outright) for a different origin, naming both', () => {
    const result = checkUrlMatchesTrackingBase('https://real.example.com', 'https://attacker.example.com');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('real.example.com');
    expect(result.detail).toContain('attacker.example.com');
  });

  it('a different port is a different origin', () => {
    expect(checkUrlMatchesTrackingBase('https://t.example.com:8787', 'https://t.example.com:9999').status).toBe(
      'warn',
    );
  });
});

describe('checkRangeIntegrity (finding #19)', () => {
  it('passes trivially when no sha256 has ever been recorded (fresh install, update-ranges never run)', () => {
    const results = checkRangeIntegrity([{ name: 'apple_relay', computedSha256: 'abc', storedSha256: null }]);
    expect(results[0]?.status).toBe('pass');
  });

  it('passes when the file matches the last recorded update, fails when it does not (tampering)', () => {
    const matching = checkRangeIntegrity([{ name: 'apple_relay', computedSha256: 'abc', storedSha256: 'abc' }]);
    expect(matching[0]?.status).toBe('pass');

    const tampered = checkRangeIntegrity([{ name: 'apple_relay', computedSha256: 'abc-edited', storedSha256: 'abc' }]);
    expect(tampered[0]?.status).toBe('fail');
    expect(tampered[0]?.detail).toContain('sha256');
  });
});

describe('checkNotifyConfig', () => {
  it('passes with no channels, fails a listed channel missing its URL', () => {
    expect(checkNotifyConfig(makeConfig({ notifyChannels: [] }))[0]?.status).toBe('pass');
    const missingSlack = checkNotifyConfig(makeConfig({ notifyChannels: ['slack'] }));
    expect(missingSlack[0]?.status).toBe('fail');
    const okSlack = checkNotifyConfig(makeConfig({ notifyChannels: ['slack'], slackWebhookUrl: 'https://hooks.slack.test/x' }));
    expect(okSlack[0]?.status).toBe('pass');
  });
});

describe('Phase 4 doctor checks (test 342: pass/warn, never throw, on a fresh credential-free install)', () => {
  it('checkAccountsHealth: no accounts -> all pass', () => {
    const results = checkAccountsHealth({ hasEncryptedSecrets: false, masterKeyError: null, accountCount: 0, hasDefault: false, defaultIsDisabled: false, undecryptableLabels: [] });
    expect(results.every((r) => r.status === 'pass')).toBe(true);
  });

  it('checkAccountsHealth: encrypted secrets but no key -> fail with a remedy', () => {
    const results = checkAccountsHealth({ hasEncryptedSecrets: true, masterKeyError: 'no master key', accountCount: 1, hasDefault: true, defaultIsDisabled: false, undecryptableLabels: [] });
    expect(results.find((r) => r.id === 'accounts.key')?.status).toBe('fail');
  });

  it('checkAccountsHealth: multiple accounts and no default -> warn', () => {
    const results = checkAccountsHealth({ hasEncryptedSecrets: false, masterKeyError: null, accountCount: 2, hasDefault: false, defaultIsDisabled: false, undecryptableLabels: [] });
    expect(results.find((r) => r.id === 'accounts.default')?.status).toBe('warn');
  });

  it('checkBackupRecency: disabled -> null; enabled with no backup -> warn; enabled and recent -> pass', () => {
    expect(checkBackupRecency({ enabled: false, newestBackupAgeMs: null, intervalHours: 24 })).toBeNull();
    expect(checkBackupRecency({ enabled: true, newestBackupAgeMs: null, intervalHours: 24 })?.status).toBe('warn');
    expect(checkBackupRecency({ enabled: true, newestBackupAgeMs: 1000, intervalHours: 24 })?.status).toBe('pass');
    expect(checkBackupRecency({ enabled: true, newestBackupAgeMs: 100 * 3_600_000, intervalHours: 24 })?.status).toBe('warn');
  });

  it('checkGeoDb: unset -> pass; not applied -> fail; stale -> warn; downgraded granularity noted in a pass', () => {
    expect(checkGeoDb({ configured: false, applied: false, notAppliedReason: null, ageDays: null, maxAgeDays: 90, granularity: 'country', effectiveGranularity: 'country' }).status).toBe('pass');
    // finding #7: "not applied" now fails even when configured=true - the important thing doctor
    // reports is whether the same loader the server uses actually succeeded, not just that the file
    // exists (which `notAppliedReason` here mimics: readable but unparseable).
    const notApplied = checkGeoDb({ configured: true, applied: false, notAppliedReason: 'file could not be parsed', ageDays: null, maxAgeDays: 90, granularity: 'country', effectiveGranularity: 'country' });
    expect(notApplied.status).toBe('fail');
    expect(notApplied.detail).toContain('not applied');
    expect(checkGeoDb({ configured: true, applied: true, notAppliedReason: null, ageDays: 200, maxAgeDays: 90, granularity: 'country', effectiveGranularity: 'country' }).status).toBe('warn');
    const downgraded = checkGeoDb({ configured: true, applied: true, notAppliedReason: null, ageDays: 1, maxAgeDays: 90, granularity: 'city', effectiveGranularity: 'country' });
    expect(downgraded.status).toBe('pass');
    expect(downgraded.detail).toContain('downgraded');
    expect(downgraded.detail).toContain('applied');
  });

  it('checkApiCors: empty -> pass; set without API_TOKEN -> fail; "*" -> fail; valid -> pass', () => {
    expect(checkApiCors({ origins: [], hasApiToken: false }).status).toBe('pass');
    expect(checkApiCors({ origins: ['https://x.example.com'], hasApiToken: false }).status).toBe('fail');
    expect(checkApiCors({ origins: ['*'], hasApiToken: true }).status).toBe('fail');
    expect(checkApiCors({ origins: ['https://x.example.com'], hasApiToken: true }).status).toBe('pass');
  });
});
