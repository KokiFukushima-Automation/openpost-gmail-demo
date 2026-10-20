import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { TokenPurpose } from '../types.js';
import { base32Decode, base32Encode } from './ids.js';

export interface TokenParts {
  version: '1';
  rid: string; // base32 of 16 bytes
}

export type VerifyResult =
  | { ok: true; rid: string; usedPrevious: boolean }
  | { ok: false; reason: 'format' | 'signature' };

const SIG_BYTES = 10;
const RID_LEN = 26; // base32(16 random bytes), no padding
const SIG_LEN = 16; // base32(10 signature bytes), no padding, no leftover bits
// Lowercase Crockford alphabet only - the exact characters newId()/signToken() ever emit. Rejecting
// anything else (different case, or the decode-tolerant i/l/o aliases) closes the malleability
// finding: base32Decode() is deliberately permissive for *generating* ids, but a signature or rid
// segment that isn't spelled exactly as we would have spelled it is never something we produced,
// so there is no reason to accept it (finding #9).
const CANONICAL_RE = /^[0-9a-hjkmnp-tv-z]+$/;

function isCanonical(s: string, expectedLen: number): boolean {
  return s.length === expectedLen && CANONICAL_RE.test(s);
}

function computeSig(purpose: TokenPurpose, rid: string, secret: string): Buffer {
  const h = createHmac('sha256', secret);
  h.update(purpose);
  h.update('\0');
  h.update(rid);
  return h.digest().subarray(0, SIG_BYTES);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** `1<rid>.<sigB32>` where sig = HMAC-SHA256(secret, purpose \0 rid) truncated to 10 bytes. */
export function signToken(purpose: TokenPurpose, rid: string, secret: string): string {
  const sig = computeSig(purpose, rid, secret);
  return `1${rid}.${base32Encode(sig)}`;
}

/**
 * Verify a token for a given purpose. Never throws. Timing-safe. Tolerates the caller having
 * already stripped an optional trailing `.gif` suffix.
 */
export function verifyToken(
  purpose: TokenPurpose,
  token: string,
  secrets: { current: string; previous?: string | undefined },
): VerifyResult {
  if (typeof token !== 'string' || token.length < 4 || token[0] !== '1') {
    return { ok: false, reason: 'format' };
  }
  const dotIdx = token.indexOf('.');
  if (dotIdx === -1) {
    return { ok: false, reason: 'format' };
  }
  const rid = token.slice(1, dotIdx);
  const sigPart = token.slice(dotIdx + 1);
  if (rid.length === 0 || sigPart.length === 0) {
    return { ok: false, reason: 'format' };
  }
  if (!isCanonical(rid, RID_LEN) || !isCanonical(sigPart, SIG_LEN)) {
    return { ok: false, reason: 'format' };
  }

  let sigBytes: Uint8Array;
  try {
    sigBytes = base32Decode(sigPart);
    base32Decode(rid); // validate rid alphabet too
  } catch {
    return { ok: false, reason: 'format' };
  }

  const expectedCurrent = computeSig(purpose, rid, secrets.current);
  if (timingSafeEqualBytes(sigBytes, expectedCurrent)) {
    return { ok: true, rid, usedPrevious: false };
  }
  if (secrets.previous) {
    const expectedPrevious = computeSig(purpose, rid, secrets.previous);
    if (timingSafeEqualBytes(sigBytes, expectedPrevious)) {
      return { ok: true, rid, usedPrevious: true };
    }
  }
  return { ok: false, reason: 'signature' };
}

export function pixelUrl(baseUrl: string, token: string, cacheBuster: string): string {
  return `${baseUrl}/o/${token}.gif?v=${cacheBuster}`;
}

export function clickUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/c/${token}`;
}

export function optOutUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/u/${token}`;
}

/** 8 base32 chars (5 random bytes encode to exactly 8 chars with no padding). */
export function newCacheBuster(): string {
  return base32Encode(randomBytes(5));
}
