/**
 * Node-stdlib-only secret storage for account credentials at rest (docs/08_phase4_spec.md §3.1).
 * KDF: scrypt (N=2^15, r=8, p=1) - memory-hard, in `node:crypto`, no dependency. AEAD: AES-256-GCM
 * with a 12-byte random nonce and a 16-byte tag, also stdlib. AAD binds a ciphertext to
 * `(accountId, field)` so a value lifted from one account row (or field) and pasted into another
 * fails to authenticate instead of silently decrypting.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

export class SecretKeyError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'SecretKeyError';
    this.remedy = remedy;
  }
}

export interface MasterKey {
  key: Buffer;
  source: 'env' | 'file';
  path?: string;
  fingerprint: string;
}

const ENVELOPE_PREFIX = 'op.sb.v1';
const SALT_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32;
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function b64u(buf: Buffer): string {
  return buf.toString('base64url');
}
function fromB64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** 32 random bytes, base64 - suitable for `OPENPOST_MASTER_KEY` or a keyfile. */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64');
}

// Finding #14: exactly 64 hex characters is unambiguous (32 bytes, every character valid hex) -
// tried FIRST and exclusively, so a genuinely-hex key is never routed through base64 decoding at
// all (every hex digit is also a valid base64 character, so `Buffer.from(hexString, 'base64')`
// used to "succeed" silently and return a completely different 48 bytes - the documented hex form
// in docs/accounts.md never actually took the intended path). Base64 is then required to actually
// look like base64 (its own alphabet plus `=` padding, length a multiple of 4) rather than accepted
// via whatever Node's lenient `Buffer.from(s, 'base64')` manages to salvage from any input string.
const HEX_KEY_RE = /^[0-9a-f]{64}$/i;
const BASE64_SHAPE_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function decodeKeyMaterial(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (HEX_KEY_RE.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  if (BASE64_SHAPE_RE.test(trimmed) && trimmed.length % 4 === 0) {
    try {
      const b = Buffer.from(trimmed, 'base64');
      if (b.length >= 32) return b.subarray(0, 32);
    } catch {
      /* fall through */
    }
  }
  return null;
}

export function keyFingerprint(key: Buffer): string {
  return createHash('sha256').update('op.mk.fp').update(key).digest('hex').slice(0, 16);
}

function checkKeyfileMode(path: string): void {
  const st = statSync(path);
  const mode = st.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new SecretKeyError(
      `master keyfile ${path} has mode ${mode.toString(8)} (group/other-readable)`,
      `chmod 600 ${path}`,
    );
  }
}

export interface LoadMasterKeyOptions {
  required?: boolean;
  /** Overrides the default `${OPENPOST_CONFIG_DIR ?? ~/.config/openpost}/master.key` path. */
  configDir?: string;
}

/** Key source order: `OPENPOST_MASTER_KEY` -> the file at `OPENPOST_MASTER_KEY_FILE` -> the
 *  default keyfile path. Returns `null` when none is configured and `opts.required` is falsy;
 *  throws `SecretKeyError` when one is configured/expected but unusable (missing, unreadable, or a
 *  keyfile with a loose mode). */
export function loadMasterKey(env: NodeJS.ProcessEnv, opts: LoadMasterKeyOptions = {}): MasterKey | null {
  const fromEnv = env.OPENPOST_MASTER_KEY;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const key = decodeKeyMaterial(fromEnv);
    if (key === null) {
      throw new SecretKeyError(
        'OPENPOST_MASTER_KEY could not be decoded (need >= 32 bytes of base64 or hex)',
        'regenerate with `openpost accounts init-key` or set a valid base64/hex value',
      );
    }
    return { key, source: 'env', fingerprint: keyFingerprint(key) };
  }

  const configDir = opts.configDir ?? env.OPENPOST_CONFIG_DIR ?? `${env.HOME ?? '.'}/.config/openpost`;
  const path = env.OPENPOST_MASTER_KEY_FILE ?? `${configDir}/master.key`;
  if (!existsSync(path)) {
    if (opts.required) {
      throw new SecretKeyError(
        `no master key: OPENPOST_MASTER_KEY is unset and ${path} does not exist`,
        'run `openpost accounts init-key`',
      );
    }
    return null;
  }
  checkKeyfileMode(path);
  const raw = readFileSync(path, 'utf8');
  const key = decodeKeyMaterial(raw);
  if (key === null) {
    throw new SecretKeyError(`master keyfile ${path} does not contain a valid key`, 'regenerate it with `openpost accounts init-key --force`');
  }
  return { key, source: 'file', path, fingerprint: keyFingerprint(key) };
}

/** Writes a fresh keyfile with `O_EXCL` (refuses to overwrite) and mode 0600. */
export function writeKeyFile(path: string, keyB64: string): void {
  const dir = dirname(path);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, `${keyB64}\n`);
  } finally {
    closeSync(fd);
  }
}

/** `op.sb.v1|<accountId>|<field>` - the AEAD's associated data. */
export function secretAad(accountId: string, field: string): string {
  return `${ENVELOPE_PREFIX}|${accountId}|${field}`;
}

// Derived-key cache: at most 32 entries for the process lifetime, so a many-row campaign pays the
// scrypt cost once per (masterKey, salt) pair, not once per row (§3.1, test 298).
const derivedKeyCache = new Map<string, Buffer>();
let kdfCallCount = 0;

/** Exposed for tests only, to assert the derived-key cache actually avoids repeat scrypt calls. */
export function _kdfCallCountForTests(): number {
  return kdfCallCount;
}
export function _resetKdfCacheForTests(): void {
  derivedKeyCache.clear();
  kdfCallCount = 0;
}

function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  const cacheKey = `${masterKey.toString('hex')}:${salt.toString('hex')}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;
  kdfCallCount += 1;
  const derived = scryptSync(masterKey, salt, KEY_LEN, SCRYPT_OPTS);
  if (derivedKeyCache.size >= 32) {
    const firstKey = derivedKeyCache.keys().next().value;
    if (firstKey !== undefined) derivedKeyCache.delete(firstKey);
  }
  derivedKeyCache.set(cacheKey, derived);
  return derived;
}

/** Seals `plaintext` into an `op.sb.v1.<salt>.<nonce>.<ct||tag>` envelope. */
export function seal(plaintext: string, key: Buffer, aad: string): string {
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const derived = deriveKey(key, salt);
  const cipher = createCipheriv('aes-256-gcm', derived, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}.${b64u(salt)}.${b64u(nonce)}.${b64u(Buffer.concat([ct, tag]))}`;
}

/** Opens an envelope produced by `seal`. Throws (never returns garbage plaintext) on a bad key, a
 *  mismatched AAD, or a tampered envelope. */
export function open(envelope: string, key: Buffer, aad: string): string {
  const parts = envelope.split('.');
  if (parts.length !== 6 || `${parts[0]}.${parts[1]}.${parts[2]}` !== ENVELOPE_PREFIX) {
    throw new Error('malformed secret envelope');
  }
  const [, , , saltPart, noncePart, ctPart] = parts;
  const salt = fromB64u(saltPart as string);
  const nonce = fromB64u(noncePart as string);
  const ctAndTag = fromB64u(ctPart as string);
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN || ctAndTag.length < 17) {
    throw new Error('malformed secret envelope');
  }
  const tag = ctAndTag.subarray(ctAndTag.length - 16);
  const ct = ctAndTag.subarray(0, ctAndTag.length - 16);
  const derived = deriveKey(key, salt);
  const decipher = createDecipheriv('aes-256-gcm', derived, nonce);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return plaintext.toString('utf8');
}

/** sha256(ciphertext)[0..8] hex - a display-safe fingerprint, never the plaintext or the key. */
export function envelopeFingerprint(envelope: string): string {
  return createHash('sha256').update(envelope).digest('hex').slice(0, 8);
}

/** Constant-time comparison of two fingerprints (both fixed, short hex strings). */
export function fingerprintsEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
