import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { loadConfig } from '../../src/config/env.js';
import { generateMasterKey, keyFingerprint, writeKeyFile } from '../../src/core/secretbox.js';
import { getSetting } from '../../src/db/repo.js';
import {
  addAccount,
  importEnvAccount,
  listAccounts,
  removeAccount,
  resolveAccount,
  resolveTransportForAccount,
  rotateMasterKey,
  setDefaultAccount,
  AccountError,
} from '../../src/mail/accounts.js';
import { resolveTransport } from '../../src/mail/transport.js';
import { loadMasterKey } from '../../src/core/secretbox.js';

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    TRACKING_SECRET: 'a'.repeat(40),
    TRACKING_BASE_URL: 'http://localhost:8787',
    FROM_EMAIL: 'sender@example.com',
    MAIL_TRANSPORT: 'dryrun',
    ...overrides,
  };
}

describe('accounts', () => {
  let dir: string;
  let db: DB;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-accounts-'));
    db = openDb(':memory:');
    migrate(db);
    keyPath = join(dir, 'master.key');
    writeKeyFile(keyPath, generateMasterKey());
    process.env.OPENPOST_MASTER_KEY_FILE = keyPath;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.OPENPOST_MASTER_KEY_FILE;
  });

  it('292. resolveAccount order: explicit ref -> default row -> env fallback; ref matches label/email/id', () => {
    const config = loadConfig(baseEnv());
    const acc = addAccount(db, config, { email: 'work@example.com', label: 'work', transport: 'dryrun', makeDefault: true });
    expect(resolveAccount(db, config).id).toBe(acc.id); // default row
    expect(resolveAccount(db, config, 'work').id).toBe(acc.id); // label
    expect(resolveAccount(db, config, 'work@example.com').id).toBe(acc.id); // email
    expect(resolveAccount(db, config, acc.id).id).toBe(acc.id); // id

    const acc2 = addAccount(db, config, { email: 'second@example.com', transport: 'dryrun' });
    expect(resolveAccount(db, config).id).toBe(acc.id); // still default, not acc2
    expect(resolveAccount(db, config, acc2.id).id).toBe(acc2.id);
  });

  it('293. with zero CLI-added accounts, resolveAccount falls back to env and matches resolveTransport(config)', () => {
    const config = loadConfig(baseEnv());
    const resolved = resolveAccount(db, config);
    expect(resolved.isEnvFallback).toBe(true);
    expect(resolved.email).toBe(config.fromEmail);
    const t1 = resolveTransportForAccount(resolved, config);
    const t2 = resolveTransport(config);
    expect(t1.name).toBe(t2.name);
  });

  it('294. resolveTransport(config) and resolveTransportForAccount(envAccount) produce equivalent transports', () => {
    for (const transport of ['dryrun', 'smtp'] as const) {
      const config = loadConfig(baseEnv({ MAIL_TRANSPORT: transport, SMTP_HOST: 'smtp.example.com' }));
      const resolved = resolveAccount(db, config);
      expect(resolveTransportForAccount(resolved, config).name).toBe(resolveTransport(config).name);
    }
  });

  it('295. accounts add --app-password-stdin stores only ciphertext: no plaintext in the row', () => {
    const config = loadConfig(baseEnv());
    const acc = addAccount(db, config, {
      email: 'work@example.com',
      transport: 'smtp',
      config: { smtpHost: 'smtp.example.com' },
      secret: { kind: 'app_password', appPassword: 'hunter2-app-password' },
    });
    const row = db.prepare('SELECT secret_ciphertext FROM accounts WHERE id = ?').get(acc.id) as { secret_ciphertext: string };
    expect(row.secret_ciphertext).toMatch(/^op\.sb\.v1\./);
    expect(row.secret_ciphertext).not.toContain('hunter2-app-password');
    expect(acc.secret().appPassword).toBe('hunter2-app-password');
  });

  it('296. a wrong master key yields one named SecretKeyError-shaped failure, not a decrypt loop', () => {
    const config = loadConfig(baseEnv());
    const acc = addAccount(db, config, {
      email: 'work@example.com',
      transport: 'smtp',
      secret: { kind: 'app_password', appPassword: 'secretvalue' },
    });
    // Swap in a different key file - decrypting must fail cleanly, once.
    const otherKeyPath = join(dir, 'other.key');
    writeKeyFile(otherKeyPath, generateMasterKey());
    process.env.OPENPOST_MASTER_KEY_FILE = otherKeyPath;
    expect(() => acc.secret()).toThrow();
  });

  it('297. accounts remove disables by default and leaves messages intact; --purge --yes deletes with a printed count', () => {
    const config = loadConfig(baseEnv());
    const acc = addAccount(db, config, { email: 'work@example.com', transport: 'dryrun', makeDefault: true });
    db.prepare(
      `INSERT INTO messages (id, account_id, subject, body_html, body_text, status, tracking_enabled, click_tracking_enabled, created_at)
       VALUES ('m1', @accountId, 'x', null, null, 'sent', 1, 1, @now)`,
    ).run({ accountId: acc.id, now: Date.now() });

    const disabled = removeAccount(db, acc.id);
    expect(disabled.disabled).toBe(true);
    const row = db.prepare('SELECT status, secret_ciphertext FROM accounts WHERE id = ?').get(acc.id) as {
      status: string;
      secret_ciphertext: string | null;
    };
    expect(row.status).toBe('disabled');
    expect(row.secret_ciphertext).toBeNull();
    const messageStillThere = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get('m1') as { n: number };
    expect(messageStillThere.n).toBe(1);
    expect(() => resolveAccount(db, config, acc.id)).toThrow(AccountError);

    expect(() => removeAccount(db, acc.id, { purge: true })).toThrow(/--yes/);
    const purged = removeAccount(db, acc.id, { purge: true, yes: true });
    expect(purged.purged).toBe(true);
    expect(purged.counts?.messages).toBe(1);
    const messageGone = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id = ?').get('m1') as { n: number };
    expect(messageGone.n).toBe(0); // ON DELETE CASCADE
  });

  it('299. rotate-key re-encrypts every secret in one transaction; a failure rolls back', () => {
    const config = loadConfig(baseEnv());
    const oldKey = loadMasterKey(process.env, { required: true });
    if (!oldKey) throw new Error('expected old key');
    const accs = [
      addAccount(db, config, { email: 'a@example.com', transport: 'smtp', secret: { kind: 'app_password', appPassword: 'pw-a' } }),
      addAccount(db, config, { email: 'b@example.com', transport: 'smtp', secret: { kind: 'app_password', appPassword: 'pw-b' } }),
      addAccount(db, config, { email: 'c@example.com', transport: 'smtp', secret: { kind: 'app_password', appPassword: 'pw-c' } }),
    ];
    const newKeyPath = join(dir, 'new.key');
    writeKeyFile(newKeyPath, generateMasterKey());
    process.env.OPENPOST_MASTER_KEY_FILE = newKeyPath;
    const newKey = loadMasterKey(process.env, { required: true });
    if (!newKey) throw new Error('expected new key');

    const result = rotateMasterKey(db, oldKey, newKey);
    expect(result.reEncrypted).toBe(3);
    for (const acc of accs) {
      const resolved = resolveAccount(db, config, acc.id);
      expect(resolved.secret().appPassword).toMatch(/^pw-/);
    }

    // Finding #11: rotate-key must update the recorded fingerprint to the NEW key and leave an
    // audit trail - before this fix, master_key_fingerprint was never written by anything at all.
    expect(getSetting(db, 'master_key_fingerprint')).toBe(keyFingerprint(newKey.key));
    const auditRows = db.prepare(`SELECT detail_json FROM audit_log WHERE action = 'account.rotate-key'`).all() as Array<{ detail_json: string }>;
    expect(auditRows).toHaveLength(1);
    const detail = JSON.parse(auditRows[0]!.detail_json) as { reEncrypted: number; oldKeyFingerprint: string; newKeyFingerprint: string };
    expect(detail.reEncrypted).toBe(3);
    expect(detail.newKeyFingerprint).toBe(keyFingerprint(newKey.key));
    // No plaintext secret anywhere in the audit row.
    expect(auditRows[0]!.detail_json).not.toMatch(/pw-[abc]/);
  });

  it('finding #11: master_key_fingerprint is recorded on the FIRST secret ever sealed for an account, not before', () => {
    const config = loadConfig(baseEnv());
    expect(getSetting(db, 'master_key_fingerprint')).toBeNull();
    const key = loadMasterKey(process.env, { required: true });
    if (!key) throw new Error('expected a key');

    addAccount(db, config, { email: 'first@example.com', transport: 'smtp', secret: { kind: 'app_password', appPassword: 'pw-first' } });
    expect(getSetting(db, 'master_key_fingerprint')).toBe(keyFingerprint(key.key));

    // A second account sealed under the SAME key must not disturb the recorded fingerprint.
    addAccount(db, config, { email: 'second@example.com', transport: 'smtp', secret: { kind: 'app_password', appPassword: 'pw-second' } });
    expect(getSetting(db, 'master_key_fingerprint')).toBe(keyFingerprint(key.key));
  });

  it('importEnvAccount materialises FROM_EMAIL/MAIL_TRANSPORT without touching .env', () => {
    const config = loadConfig(baseEnv({ MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PASS: 'envpass' }));
    const acc = importEnvAccount(db, config, { makeDefault: true });
    expect(acc.email).toBe('sender@example.com');
    expect(acc.transport).toBe('smtp');
    const summaries = listAccounts(db);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.origin).toBe('env');
  });

  it('setDefaultAccount clears the previous default (unique index respected)', () => {
    const config = loadConfig(baseEnv());
    const a = addAccount(db, config, { email: 'a@example.com', transport: 'dryrun', makeDefault: true });
    const b = addAccount(db, config, { email: 'b@example.com', transport: 'dryrun' });
    setDefaultAccount(db, b.id);
    expect(listAccounts(db).find((x) => x.id === a.id)?.isDefault).toBe(false);
    expect(listAccounts(db).find((x) => x.id === b.id)?.isDefault).toBe(true);
  });
});
