import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import { loadConfig, ConfigError } from '../../src/config/env.js';
import { generateVapidKeys } from '../../src/core/webpush.js';

const ORIGINAL_ENV = { ...process.env };

describe('openpost push CLI (docs/09_phase5_spec.md §7.4)', () => {
  let workDir: string;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdoutChunks: string[];

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'op-push-cli-'));
    stdoutChunks = [];
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    stdoutSpy.mockRestore();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('433. push keys --json prints a usable pair; human mode never prints the private key', async () => {
    process.env = { ...ORIGINAL_ENV, DB_PATH: join(workDir, 'openpost.db'), TRACKING_SECRET: 'x'.repeat(32) };

    const program = createProgram();
    await program.parseAsync(['push', 'keys', '--json'], { from: 'user' });
    const jsonOut = stdoutChunks.join('');
    const parsed = JSON.parse(jsonOut.trim());
    expect(parsed.publicKey).toBeDefined();
    expect(parsed.privateKey).toBeDefined();
    expect(Buffer.from(parsed.publicKey, 'base64url').length).toBe(65);
    expect(Buffer.from(parsed.privateKey, 'base64url').length).toBe(32);

    stdoutChunks = [];
    const program2 = createProgram();
    await program2.parseAsync(['push', 'keys'], { from: 'user' });
    const humanOut = stdoutChunks.join('');
    expect(humanOut).toContain('VAPID_PUBLIC_KEY=');
    expect(humanOut).not.toContain('VAPID_PRIVATE_KEY=');
  });

  it('push keys --write-env appends VAPID_* to .env (0600, backed up) and it round-trips through loadConfig', async () => {
    const envPath = join(workDir, '.env');
    writeFileSync(envPath, 'TRACKING_SECRET=' + 'x'.repeat(32) + '\nFROM_EMAIL=me@example.com\n');
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(workDir);
    // `openpost push keys` reads FROM_EMAIL from the running process's env (already loaded from
    // .env at process start by `dotenv/config`, exactly as every other command does) to derive the
    // default VAPID_SUBJECT - a file write after the fact does not retroactively populate it.
    process.env = { ...ORIGINAL_ENV, DB_PATH: join(workDir, 'openpost.db'), FROM_EMAIL: 'me@example.com' };

    const program = createProgram();
    await program.parseAsync(['push', 'keys', '--write-env'], { from: 'user' });
    cwdSpy.mockRestore();

    const { readFileSync, statSync } = await import('node:fs');
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/VAPID_PUBLIC_KEY=/);
    expect(content).toMatch(/VAPID_PRIVATE_KEY=/);
    expect(content).toMatch(/VAPID_SUBJECT=mailto:me@example.com/);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    const vapidPublicMatch = /VAPID_PUBLIC_KEY=(\S+)/.exec(content);
    const vapidPrivateMatch = /VAPID_PRIVATE_KEY=(\S+)/.exec(content);
    const config = loadConfig({
      TRACKING_SECRET: 'x'.repeat(32),
      NOTIFY_CHANNELS: 'webpush',
      VAPID_PUBLIC_KEY: vapidPublicMatch![1],
      VAPID_PRIVATE_KEY: vapidPrivateMatch![1],
    });
    expect(config.vapidPublicKey).toBe(vapidPublicMatch![1]);
  });

  it('430/431. webpush in NOTIFY_CHANNELS without valid keys is a ConfigError naming the remedy', () => {
    expect(() => loadConfig({ TRACKING_SECRET: 'x'.repeat(32), NOTIFY_CHANNELS: 'webpush' })).toThrow(ConfigError);
    try {
      loadConfig({ TRACKING_SECRET: 'x'.repeat(32), NOTIFY_CHANNELS: 'webpush' });
      expect.unreachable();
    } catch (err) {
      expect((err as ConfigError).message).toContain('openpost push keys');
    }

    const keys = generateVapidKeys();
    expect(() =>
      loadConfig({ TRACKING_SECRET: 'x'.repeat(32), NOTIFY_CHANNELS: 'webpush', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: generateVapidKeys().privateKey }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({ TRACKING_SECRET: 'x'.repeat(32), NOTIFY_CHANNELS: 'webpush', VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey }),
    ).not.toThrow();
  });

  it('432. ADDON_ENABLED without API_TOKEN is a ConfigError', () => {
    expect(() => loadConfig({ TRACKING_SECRET: 'x'.repeat(32), ADDON_ENABLED: 'true' })).toThrow(ConfigError);
    expect(() => loadConfig({ TRACKING_SECRET: 'x'.repeat(32), ADDON_ENABLED: 'true', API_TOKEN: 'tok' })).not.toThrow();
  });

  it('DIGEST_DAILY_AT/DIGEST_TIMEZONE validation', () => {
    expect(() => loadConfig({ TRACKING_SECRET: 'x'.repeat(32), DIGEST_DAILY_AT: 'not-a-time' })).toThrow(ConfigError);
    expect(() => loadConfig({ TRACKING_SECRET: 'x'.repeat(32), DIGEST_DAILY_AT: '09:00' })).not.toThrow();
    expect(() => loadConfig({ TRACKING_SECRET: 'x'.repeat(32), DIGEST_TIMEZONE: 'Not/AZone' })).toThrow(ConfigError);
  });

  it('every new Phase 5 env var parses with its default', () => {
    const config = loadConfig({ TRACKING_SECRET: 'x'.repeat(32) });
    expect(config.composeEnabled).toBe(true);
    expect(config.composeMaxRecipients).toBe(25);
    expect(config.composeMaxBodyBytes).toBe(262_144);
    expect(config.composeRatePerHour).toBe(20);
    expect(config.pwaEnabled).toBe(true);
    expect(config.pushTtlSeconds).toBe(3600);
    expect(config.pushUrgency).toBe('normal');
    expect(config.pushMaxSubscriptions).toBe(10);
    expect(config.pushMaxFailures).toBe(10);
    expect(config.notifyEmailTo).toBeUndefined();
    expect(config.digestDailyAt).toBeUndefined();
    expect(config.digestTimezone).toBe('UTC');
    expect(config.addonEnabled).toBe(false);
    expect(config.addonRatePerHour).toBe(120);
    expect(config.addonLinkTimeoutHours).toBe(48);
  });
});
