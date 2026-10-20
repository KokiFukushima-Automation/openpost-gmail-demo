import { describe, expect, it } from 'vitest';
import { ConfigError, assertSafeToBind, isLoopbackAddress, loadConfig } from '../../src/config/env.js';

const VALID_SECRET = 'x'.repeat(32);

describe('env', () => {
  it('31. missing TRACKING_SECRET throws ConfigError listing it; short secret also errors', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({});
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const issues = (err as ConfigError).issues;
      expect(issues.some((i) => i.includes('TRACKING_SECRET'))).toBe(true);
    }

    expect(() => loadConfig({ TRACKING_SECRET: 'too-short' })).toThrow(ConfigError);
  });

  it('init-style callers may opt out of requiring a secret', () => {
    const config = loadConfig({}, { requireSecret: false });
    expect(config.trackingSecret).toBeUndefined();
  });

  it('32. applies defaults, strips trailing slash from TRACKING_BASE_URL, rejects invalid PRIVACY_MODE', () => {
    const config = loadConfig({ TRACKING_SECRET: VALID_SECRET, TRACKING_BASE_URL: 'https://t.example.com/' });
    expect(config.trackingBaseUrl).toBe('https://t.example.com');
    expect(config.port).toBe(8787);
    expect(config.bindAddress).toBe('127.0.0.1');
    expect(config.privacyMode).toBe('balanced');
    expect(config.openIgnoreSeconds).toBe(10);
    expect(config.mailTransport).toBe('dryrun');

    expect(() =>
      loadConfig({ TRACKING_SECRET: VALID_SECRET, PRIVACY_MODE: 'nonsense' }),
    ).toThrow(ConfigError);
  });

  it('is pure with respect to the passed env object', () => {
    const env = { TRACKING_SECRET: VALID_SECRET };
    const snapshot = { ...env };
    loadConfig(env);
    expect(env).toEqual(snapshot);
  });

  it('finding #13: the default IP_SALT is HMAC-derived from TRACKING_SECRET, not the secret itself', () => {
    const config = loadConfig({ TRACKING_SECRET: VALID_SECRET });
    expect(config.ipSalt).not.toBe(VALID_SECRET);
    expect(config.ipSalt).not.toContain(VALID_SECRET);
    // Deterministic for a given secret (so hashes stay stable across restarts without IP_SALT set)...
    const again = loadConfig({ TRACKING_SECRET: VALID_SECRET });
    expect(again.ipSalt).toBe(config.ipSalt);
    // ...but different secrets derive different salts.
    const other = loadConfig({ TRACKING_SECRET: 'y'.repeat(32) });
    expect(other.ipSalt).not.toBe(config.ipSalt);
  });

  it('finding #14: ipSaltIsDefault is true only when neither IP_SALT nor TRACKING_SECRET is configured', () => {
    expect(loadConfig({}, { requireSecret: false }).ipSaltIsDefault).toBe(true);
    expect(loadConfig({ TRACKING_SECRET: VALID_SECRET }).ipSaltIsDefault).toBe(false);
    expect(
      loadConfig({ IP_SALT: 'a-real-per-install-salt' }, { requireSecret: false }).ipSaltIsDefault,
    ).toBe(false);
  });

  it('finding #5: TRUST_PROXY parses false/true/hop-count/CIDR-list forms', () => {
    const off = loadConfig({ TRACKING_SECRET: VALID_SECRET, TRUST_PROXY: 'false' });
    expect(off.trustProxy).toBe(false);
    expect(off.trustProxyWarning).toBeNull();

    const unset = loadConfig({ TRACKING_SECRET: VALID_SECRET });
    expect(unset.trustProxy).toBe(false);

    const trueVal = loadConfig({ TRACKING_SECRET: VALID_SECRET, TRUST_PROXY: 'true' });
    expect(trueVal.trustProxy).toBe(1);
    expect(trueVal.trustProxyWarning).toMatch(/hop count 1/);

    const hops = loadConfig({ TRACKING_SECRET: VALID_SECRET, TRUST_PROXY: '2' });
    expect(hops.trustProxy).toBe(2);
    expect(hops.trustProxyWarning).toBeNull();

    const zero = loadConfig({ TRACKING_SECRET: VALID_SECRET, TRUST_PROXY: '0' });
    expect(zero.trustProxy).toBe(false);

    const cidr = loadConfig({
      TRACKING_SECRET: VALID_SECRET,
      TRUST_PROXY: '10.0.0.0/8, 192.168.1.1',
    });
    expect(cidr.trustProxy).toEqual(['10.0.0.0/8', '192.168.1.1']);

    expect(() => loadConfig({ TRACKING_SECRET: VALID_SECRET, TRUST_PROXY: ' , ,' })).toThrow(
      ConfigError,
    );
  });

  it('finding #8: SELF_UA_PATTERNS rejects too many patterns and overly long patterns', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `pattern${i}`).join(',');
    expect(() => loadConfig({ TRACKING_SECRET: VALID_SECRET, SELF_UA_PATTERNS: tooMany })).toThrow(
      ConfigError,
    );

    const tooLong = 'a'.repeat(201);
    try {
      loadConfig({ TRACKING_SECRET: VALID_SECRET, SELF_UA_PATTERNS: tooLong });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).issues.some((i) => i.includes('SELF_UA_PATTERNS'))).toBe(true);
    }

    const ok = loadConfig({ TRACKING_SECRET: VALID_SECRET, SELF_UA_PATTERNS: 'Chrome/120,Foo' });
    expect(ok.selfUaPatterns).toHaveLength(2);
  });

  it('finding #2: refuses to bind non-loopback or with TRUST_PROXY enabled unless API_TOKEN is set', () => {
    const loopbackNoToken = loadConfig({ TRACKING_SECRET: VALID_SECRET });
    expect(() => assertSafeToBind(loopbackNoToken)).not.toThrow();

    const nonLoopbackNoToken = loadConfig({ TRACKING_SECRET: VALID_SECRET, BIND_ADDRESS: '0.0.0.0' });
    expect(() => assertSafeToBind(nonLoopbackNoToken)).toThrow(ConfigError);

    const nonLoopbackWithToken = loadConfig({
      TRACKING_SECRET: VALID_SECRET,
      BIND_ADDRESS: '0.0.0.0',
      API_TOKEN: 'x'.repeat(20),
    });
    expect(() => assertSafeToBind(nonLoopbackWithToken)).not.toThrow();

    const trustProxyNoToken = loadConfig({ TRACKING_SECRET: VALID_SECRET, TRUST_PROXY: '1' });
    expect(() => assertSafeToBind(trustProxyNoToken)).toThrow(ConfigError);

    const trustProxyWithToken = loadConfig({
      TRACKING_SECRET: VALID_SECRET,
      TRUST_PROXY: '1',
      API_TOKEN: 'x'.repeat(20),
    });
    expect(() => assertSafeToBind(trustProxyWithToken)).not.toThrow();
  });

  it('isLoopbackAddress recognises 127.0.0.0/8, ::1 and localhost only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('127.5.5.5')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('localhost')).toBe(true);
    expect(isLoopbackAddress('0.0.0.0')).toBe(false);
    expect(isLoopbackAddress('10.0.0.1')).toBe(false);
  });

  it('118. rejects SELF_OPEN_STRATEGY=insert with MAIL_TRANSPORT=gmail, and imap-append without IMAP credentials', () => {
    expect(() =>
      loadConfig({
        TRACKING_SECRET: VALID_SECRET,
        MAIL_TRANSPORT: 'gmail',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REFRESH_TOKEN: 'rt',
        SELF_OPEN_STRATEGY: 'insert',
      }),
    ).toThrow(/SELF_OPEN_STRATEGY=insert requires MAIL_TRANSPORT=smtp/);

    expect(() =>
      loadConfig({
        TRACKING_SECRET: VALID_SECRET,
        MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SELF_OPEN_STRATEGY: 'insert',
      }),
    ).toThrow(/GOOGLE_CLIENT_ID/);

    const validInsert = loadConfig({
      TRACKING_SECRET: VALID_SECRET,
      MAIL_TRANSPORT: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SELF_OPEN_STRATEGY: 'insert',
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    expect(validInsert.selfOpenStrategy).toBe('insert');

    expect(() =>
      loadConfig({ TRACKING_SECRET: VALID_SECRET, SELF_OPEN_STRATEGY: 'imap-append' }),
    ).toThrow(/IMAP_USER and IMAP_PASS/);

    const validImap = loadConfig({
      TRACKING_SECRET: VALID_SECRET,
      SELF_OPEN_STRATEGY: 'imap-append',
      IMAP_USER: 'me@example.com',
      IMAP_PASS: 'app-password',
    });
    expect(validImap.selfOpenStrategy).toBe('imap-append');
  });

  it('finding #9: notify channel URLs must be valid http(s) and are rejected for a loopback/private host unless opted in', () => {
    expect(() =>
      loadConfig({ TRACKING_SECRET: VALID_SECRET, NOTIFY_CHANNELS: 'webhook', WEBHOOK_URL: 'not a url', WEBHOOK_SECRET: 's'.repeat(16) }),
    ).toThrow(/WEBHOOK_URL is not a valid URL/);

    expect(() =>
      loadConfig({
        TRACKING_SECRET: VALID_SECRET,
        NOTIFY_CHANNELS: 'webhook',
        WEBHOOK_URL: 'ftp://example.com/hook',
        WEBHOOK_SECRET: 's'.repeat(16),
      }),
    ).toThrow(/WEBHOOK_URL must use http or https/);

    expect(() =>
      loadConfig({
        TRACKING_SECRET: VALID_SECRET,
        NOTIFY_CHANNELS: 'webhook',
        WEBHOOK_URL: 'http://127.0.0.1:9099/hook',
        WEBHOOK_SECRET: 's'.repeat(16),
      }),
    ).toThrow(/loopback\/private-network host/);

    expect(() =>
      loadConfig({
        TRACKING_SECRET: VALID_SECRET,
        NOTIFY_CHANNELS: 'webhook',
        WEBHOOK_URL: 'http://10.0.0.5/hook',
        WEBHOOK_SECRET: 's'.repeat(16),
      }),
    ).toThrow(/loopback\/private-network host/);

    // Same private URL is accepted once explicitly opted in.
    const allowed = loadConfig({
      TRACKING_SECRET: VALID_SECRET,
      NOTIFY_CHANNELS: 'webhook',
      WEBHOOK_URL: 'http://127.0.0.1:9099/hook',
      WEBHOOK_SECRET: 's'.repeat(16),
      NOTIFY_ALLOW_PRIVATE_URLS: 'true',
    });
    expect(allowed.webhookUrl).toBe('http://127.0.0.1:9099/hook');

    // A public https URL needs no opt-in.
    const publicUrl = loadConfig({
      TRACKING_SECRET: VALID_SECRET,
      NOTIFY_CHANNELS: 'slack',
      SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T000/B000/XXXXXXXX',
    });
    expect(publicUrl.slackWebhookUrl).toBe('https://hooks.slack.com/services/T000/B000/XXXXXXXX');
  });
});
