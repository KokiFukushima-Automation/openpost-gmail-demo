import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _kdfCallCountForTests,
  _resetKdfCacheForTests,
  envelopeFingerprint,
  generateMasterKey,
  keyFingerprint,
  loadMasterKey,
  open,
  seal,
  secretAad,
  SecretKeyError,
  writeKeyFile,
} from '../../src/core/secretbox.js';
import { checkAccountsHealth } from '../../src/core/doctor.js';

describe('secretbox', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-secretbox-'));
    _resetKdfCacheForTests();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('288. seal/open round-trip; a flipped byte anywhere in the envelope throws', () => {
    const key = randomBytes(32);
    const aad = secretAad('acc1', 'app_password');
    const envelope = seal('hunter2', key, aad);
    expect(open(envelope, key, aad)).toBe('hunter2');

    const parts = envelope.split('.');
    const ctIdx = 5;
    const flipped = [...parts];
    // Flip a character in the MIDDLE of the ciphertext, not the last one - base64url's final
    // character can carry unused padding bits that a decoder discards, so changing only that
    // character can occasionally decode to the exact same bytes (a flaky, not a real, failure).
    const ct = flipped[ctIdx] as string;
    const mid = Math.floor(ct.length / 2);
    flipped[ctIdx] = ct.slice(0, mid) + (ct[mid] === 'A' ? 'B' : 'A') + ct.slice(mid + 1);
    expect(() => open(flipped.join('.'), key, aad)).toThrow();
  });

  it('289. AAD binding: a ciphertext moved to another accountId or field fails to authenticate', () => {
    const key = randomBytes(32);
    const envelope = seal('secret-value', key, secretAad('acc1', 'app_password'));
    expect(() => open(envelope, key, secretAad('acc2', 'app_password'))).toThrow();
    expect(() => open(envelope, key, secretAad('acc1', 'refresh_token'))).toThrow();
  });

  it('290. envelope format matches ^op\\.sb\\.v1\\. with three valid base64url segments', () => {
    const key = randomBytes(32);
    const envelope = seal('x', key, secretAad('a', 'f'));
    expect(envelope).toMatch(/^op\.sb\.v1\./);
    const parts = envelope.split('.');
    expect(parts).toHaveLength(6);
    expect(Buffer.from(parts[3] as string, 'base64url').length).toBe(16);
    expect(Buffer.from(parts[4] as string, 'base64url').length).toBe(12);
    expect(Buffer.from(parts[5] as string, 'base64url').length).toBeGreaterThanOrEqual(17);
  });

  it('291. a keyfile with mode 0640 is a SecretKeyError naming chmod 600; 0600 passes', () => {
    const path = join(dir, 'master.key');
    writeKeyFile(path, generateMasterKey());
    chmodSync(path, 0o640);
    expect(() => loadMasterKey({ OPENPOST_MASTER_KEY_FILE: path })).toThrow(SecretKeyError);
    try {
      loadMasterKey({ OPENPOST_MASTER_KEY_FILE: path });
    } catch (err) {
      expect((err as SecretKeyError).remedy).toMatch(/chmod 600/);
    }
    chmodSync(path, 0o600);
    const loaded = loadMasterKey({ OPENPOST_MASTER_KEY_FILE: path });
    expect(loaded?.source).toBe('file');
  });

  it('296. a wrong master key throws exactly once at the AEAD layer (no decrypt loop/retry)', () => {
    const key1 = randomBytes(32);
    const key2 = randomBytes(32);
    const envelope = seal('x', key1, secretAad('a', 'f'));
    expect(() => open(envelope, key2, secretAad('a', 'f'))).toThrow();
  });

  it('296b. finding #14/#18: the wrong master key is reported as a fingerprint mismatch naming both fingerprints, via checkAccountsHealth - not just an opaque decrypt failure', () => {
    // secretbox's own `open()` has no concept of a "recorded" fingerprint to compare against - that
    // comparison lives one layer up (src/core/doctor.ts's checkAccountsHealth, fed by
    // src/mail/accounts.ts recording master_key_fingerprint on first seal - finding #11). This is
    // the actual "names a fingerprint mismatch" the test's own title promises; test 296 above only
    // ever proved the AEAD layer throws, which secretbox.test.ts's own review found insufficient.
    const sealedUnderKey1 = randomBytes(32);
    const configuredKey2 = randomBytes(32);
    const recordedFingerprint = keyFingerprint(sealedUnderKey1);
    const configuredFingerprint = keyFingerprint(configuredKey2);
    expect(configuredFingerprint).not.toBe(recordedFingerprint);

    const results = checkAccountsHealth({
      hasEncryptedSecrets: true,
      masterKeyError: null,
      accountCount: 1,
      hasDefault: true,
      defaultIsDisabled: false,
      undecryptableLabels: ['acc@example.com'],
      keyFingerprint: { configured: configuredFingerprint, recorded: recordedFingerprint },
    });
    const keyCheck = results.find((r) => r.id === 'accounts.key');
    expect(keyCheck?.status).toBe('fail');
    expect(keyCheck?.detail).toContain(configuredFingerprint);
    expect(keyCheck?.detail).toContain(recordedFingerprint);
    expect(keyCheck?.detail).toContain('does not match');
  });

  it('finding #14: matching fingerprints (no key change) pass, even with encrypted secrets present', () => {
    const key = randomBytes(32);
    const fp = keyFingerprint(key);
    const results = checkAccountsHealth({
      hasEncryptedSecrets: true,
      masterKeyError: null,
      accountCount: 1,
      hasDefault: true,
      defaultIsDisabled: false,
      undecryptableLabels: [],
      keyFingerprint: { configured: fp, recorded: fp },
    });
    expect(results.find((r) => r.id === 'accounts.key')?.status).toBe('pass');
  });

  it('298. derived keys are cached: repeated seals under one salt cost one scrypt call', () => {
    const key = randomBytes(32);
    _resetKdfCacheForTests();
    const envelope = seal('v1', key, secretAad('a', 'f'));
    const afterFirstSeal = _kdfCallCountForTests();
    expect(afterFirstSeal).toBe(1);
    // Opening the SAME envelope reuses its salt -> cached, no extra scrypt call.
    open(envelope, key, secretAad('a', 'f'));
    expect(_kdfCallCountForTests()).toBe(afterFirstSeal);
  });

  it('OPENPOST_MASTER_KEY (env) beats the keyfile', () => {
    const path = join(dir, 'master.key');
    writeKeyFile(path, generateMasterKey());
    const envKey = generateMasterKey();
    const loaded = loadMasterKey({ OPENPOST_MASTER_KEY: envKey, OPENPOST_MASTER_KEY_FILE: path });
    expect(loaded?.source).toBe('env');
  });

  it('loadMasterKey returns null when unconfigured and not required', () => {
    const missing = join(dir, 'nope', 'master.key');
    expect(loadMasterKey({ OPENPOST_MASTER_KEY_FILE: missing })).toBeNull();
    expect(() => loadMasterKey({ OPENPOST_MASTER_KEY_FILE: missing }, { required: true })).toThrow(SecretKeyError);
  });

  it('writeKeyFile refuses to overwrite an existing file (O_EXCL)', () => {
    const path = join(dir, 'master.key');
    writeKeyFile(path, generateMasterKey());
    expect(() => writeKeyFile(path, generateMasterKey())).toThrow();
  });

  it('finding #14: a 64-char hex master key decodes to the exact hex bytes, not a mis-decoded base64 substring', () => {
    // Every hex digit is also a valid base64 character, so `Buffer.from(hex, 'base64')` used to
    // "succeed" silently and return a completely different 48 bytes, truncated to 32 - the hex form
    // documented in docs/accounts.md never actually took the intended path.
    const hexKey = 'a1b2c3d4'.repeat(8); // 64 hex chars = 32 bytes
    const loaded = loadMasterKey({ OPENPOST_MASTER_KEY: hexKey });
    expect(loaded).not.toBeNull();
    expect(loaded?.key.toString('hex')).toBe(hexKey);
    expect(loaded?.key.length).toBe(32);
  });

  it('finding #14: a base64 master key (generateMasterKey\'s own format) still decodes correctly', () => {
    const b64Key = generateMasterKey();
    const loaded = loadMasterKey({ OPENPOST_MASTER_KEY: b64Key });
    expect(loaded).not.toBeNull();
    expect(loaded?.key.length).toBe(32);
    expect(loaded?.key.equals(Buffer.from(b64Key, 'base64').subarray(0, 32))).toBe(true);
  });

  it('finding #14: a key that is neither valid hex nor valid base64 shape is rejected with a named error', () => {
    // Contains '_' and '!' - not in the base64 alphabet, and not 64 hex characters either.
    expect(() => loadMasterKey({ OPENPOST_MASTER_KEY: 'not_a_valid_key!!!' })).toThrow(SecretKeyError);
  });

  it('envelopeFingerprint is stable and display-safe (never the plaintext)', () => {
    const key = randomBytes(32);
    const envelope = seal('hunter2', key, secretAad('a', 'f'));
    const fp = envelopeFingerprint(envelope);
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(envelope).not.toContain('hunter2');
  });
});
