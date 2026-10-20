import { describe, expect, it } from 'vitest';
import { checkAddonConfig, checkPushKeys, checkPushSecureContext, checkPushSubscriptions, checkPwaAssets } from '../../src/core/doctor.js';
import { generateVapidKeys } from '../../src/core/webpush.js';
import { makeConfig } from '../helpers/setup.js';

describe('436. Phase 5 doctor checks (docs/09_phase5_spec.md §7.5)', () => {
  it('push.keys: pass when webpush is off; fail when on with no keys; pass when on with a valid matching pair', () => {
    expect(checkPushKeys(makeConfig()).status).toBe('pass');
    expect(checkPushKeys(makeConfig({ notifyChannels: ['webpush'] })).status).toBe('fail');
    const keys = generateVapidKeys();
    expect(checkPushKeys(makeConfig({ notifyChannels: ['webpush'], vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey })).status).toBe('pass');
  });

  it('push.secure_context: pass on https or loopback; warn otherwise', () => {
    expect(checkPushSecureContext('https://openpost.example.com').status).toBe('pass');
    expect(checkPushSecureContext('http://127.0.0.1:8787').status).toBe('pass');
    expect(checkPushSecureContext('http://openpost.example.com').status).toBe('warn');
  });

  it('push.subscriptions: pass when webpush is off; warn at 0 active with webpush on; pass with >=1', () => {
    expect(checkPushSubscriptions(makeConfig(), 0).status).toBe('pass');
    expect(checkPushSubscriptions(makeConfig({ notifyChannels: ['webpush'] }), 0).status).toBe('warn');
    expect(checkPushSubscriptions(makeConfig({ notifyChannels: ['webpush'] }), 1).status).toBe('pass');
  });

  it('pwa.assets: pass when every icon matches; fail on a missing or mismatched icon', () => {
    const ok = checkPwaAssets([{ name: 'icon-192.png', actualSha256: 'abc', expectedSha256: 'abc' }]);
    expect(ok.status).toBe('pass');
    const missing = checkPwaAssets([{ name: 'icon-192.png', actualSha256: null, expectedSha256: 'abc' }]);
    expect(missing.status).toBe('fail');
    expect(missing.detail).toContain('missing');
    const mismatch = checkPwaAssets([{ name: 'icon-192.png', actualSha256: 'def', expectedSha256: 'abc' }]);
    expect(mismatch.status).toBe('fail');
    expect(mismatch.detail).toContain('mismatch');
  });

  it('addon.config: pass when disabled; fail without API_TOKEN; fail on a loopback TRACKING_BASE_URL; pass otherwise', () => {
    expect(checkAddonConfig(makeConfig({ addonEnabled: false })).status).toBe('pass');
    expect(checkAddonConfig(makeConfig({ addonEnabled: true, apiToken: undefined })).status).toBe('fail');
    expect(checkAddonConfig(makeConfig({ addonEnabled: true, apiToken: 'tok', trackingBaseUrl: 'http://127.0.0.1:8787' })).status).toBe('fail');
    expect(checkAddonConfig(makeConfig({ addonEnabled: true, apiToken: 'tok', trackingBaseUrl: 'https://openpost.example.com' })).status).toBe('pass');
  });
});
