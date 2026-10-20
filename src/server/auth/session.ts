import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppConfig } from '../../config/env.js';
import { isLoopbackAddress } from '../../config/env.js';
import { base32Decode, base32Encode } from '../../core/ids.js';
import { isValidApiBearer } from '../api-auth.js';

export interface SessionCookie {
  sid: string;
  issuedAt: number;
  expiresAt: number;
}

/** Parses a `Cookie` request header: handles quoting, surrounding whitespace, duplicate names
 *  (first wins) and a missing header (empty object). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name.length === 0 || name in out) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface SerializeCookieOpts {
  maxAgeSec: number;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax';
  path: string;
}

export function serializeCookie(name: string, value: string, opts: SerializeCookieOpts): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Max-Age=${opts.maxAgeSec}`, `Path=${opts.path}`, `SameSite=${opts.sameSite}`];
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  return parts.join('; ');
}

const SESSION_KEY_LABEL = 'openpost:dashboard-session:v1';
const CSRF_LABEL_PREFIX = 'csrf:';
const SID_BYTES = 16;
const MAC_BYTES = 10; // 16 base32 chars, no padding

export function sessionKey(config: AppConfig): Buffer {
  const secret = config.trackingSecret ?? '';
  return createHmac('sha256', secret).update(SESSION_KEY_LABEL).digest();
}

function cookieMac(key: Buffer, expSec: number, sid: string): Buffer {
  return createHmac('sha256', key).update(`v1.${expSec}.${sid}`).digest().subarray(0, MAC_BYTES);
}

export const SESSION_COOKIE_NAME = 'openpost_sess';
export const CSRF_COOKIE_NAME = 'openpost_csrf';
export const DASHBOARD_COOKIE_PATH = '/dashboard';

function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function resolveSecureCookies(config: AppConfig): boolean {
  if (config.dashboardSecureCookies !== 'auto') return config.dashboardSecureCookies;
  try {
    return new URL(config.trackingBaseUrl).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface IssuedSession {
  cookie: string;
  csrfCookie: string;
  sid: string;
}

/** Cookie format: `v1.<expEpochSec>.<sid>.<b32 HMAC-SHA256(sessionKey, "v1."+exp+"."+sid)[0..10]>`
 *  (§2.4). Sessions are stateless - no table; revocation is rotating `TRACKING_SECRET` or waiting
 *  for expiry. */
export function issueSession(config: AppConfig, nowMs: number): IssuedSession {
  const sid = base32Encode(randomBytes(SID_BYTES));
  const expSec = Math.floor(nowMs / 1000) + config.dashboardSessionHours * 3600;
  const mac = cookieMac(sessionKey(config), expSec, sid);
  const raw = `v1.${expSec}.${sid}.${base32Encode(mac)}`;
  const secure = resolveSecureCookies(config);
  const maxAgeSec = config.dashboardSessionHours * 3600;

  const cookie = serializeCookie(SESSION_COOKIE_NAME, raw, {
    maxAgeSec,
    secure,
    httpOnly: true,
    sameSite: 'Strict',
    path: DASHBOARD_COOKIE_PATH,
  });
  const csrfCookie = serializeCookie(CSRF_COOKIE_NAME, csrfTokenFor(config, sid), {
    maxAgeSec,
    secure,
    httpOnly: false,
    sameSite: 'Strict',
    path: DASHBOARD_COOKIE_PATH,
  });
  return { cookie, csrfCookie, sid };
}

/** Verifies a raw `openpost_sess` cookie value. Never throws; returns `null` for anything
 *  malformed, tampered, expired, or issued under a different `TRACKING_SECRET` (key rotation
 *  revokes every session). */
export function verifySession(config: AppConfig, raw: string | undefined, nowMs: number): SessionCookie | null {
  if (typeof raw !== 'string') return null;
  const parts = raw.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const expPart = parts[1] as string;
  const sid = parts[2] as string;
  const macPart = parts[3] as string;
  if (!/^\d+$/.test(expPart)) return null;
  const expSec = Number(expPart);
  if (!Number.isSafeInteger(expSec)) return null;

  const expected = cookieMac(sessionKey(config), expSec, sid);
  let providedMac: Uint8Array;
  try {
    providedMac = base32Decode(macPart);
  } catch {
    return null;
  }
  if (providedMac.length !== expected.length || !timingSafeEqual(providedMac, expected)) return null;

  const issuedAtMs = (expSec - config.dashboardSessionHours * 3600) * 1000;
  const expiresAtMs = expSec * 1000;
  if (nowMs >= expiresAtMs) return null;
  // Reject an expiry further in the future than the configured lifetime could ever produce (a
  // forged/replayed cookie with an inflated `exp`) - re-derive the max instead of trusting `exp`
  // blindly beyond one session lifetime from "now".
  if (expiresAtMs - nowMs > config.dashboardSessionHours * 3600 * 1000 + 5000) return null;

  return { sid, issuedAt: issuedAtMs, expiresAt: expiresAtMs };
}

export function csrfTokenFor(config: AppConfig, sid: string): string {
  const mac = createHmac('sha256', sessionKey(config)).update(`${CSRF_LABEL_PREFIX}${sid}`).digest();
  return base32Encode(mac.subarray(0, 16)).slice(0, 26);
}

export function verifyCsrf(config: AppConfig, sid: string, submitted: string | undefined): boolean {
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  const expected = csrfTokenFor(config, sid);
  return timingSafeEqualStr(expected, submitted);
}

export type DashboardAuth =
  | { ok: true; via: 'bearer' | 'session' | 'open'; sid: string | null }
  | { ok: false; reason: 'missing' | 'invalid' };

export interface DashboardAuthRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string | null;
}

/** Precedence (§2.4): bearer wins, then a valid session cookie, then - only when neither is
 *  configured *and* the effective bind is loopback *and* `TRUST_PROXY` is off - an implicit `open`
 *  session for zero-config local dev. */
export function authenticateDashboard(config: AppConfig, req: DashboardAuthRequest, nowMs: number): DashboardAuth {
  const authHeader = req.headers['authorization'];
  if (isValidApiBearer(config, Array.isArray(authHeader) ? authHeader[0] : authHeader) && config.apiToken !== undefined) {
    return { ok: true, via: 'bearer', sid: null };
  }
  const cookieHeader = req.headers['cookie'];
  const cookies = parseCookies(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader);
  const session = verifySession(config, cookies[SESSION_COOKIE_NAME], nowMs);
  if (session) {
    return { ok: true, via: 'session', sid: session.sid };
  }
  const noSecret = config.dashboardPassword === undefined && config.apiToken === undefined;
  const loopback = isLoopbackAddress(config.dashboardBind) && config.trustProxy === false;
  if (noSecret && loopback) {
    return { ok: true, via: 'open', sid: null };
  }
  return { ok: false, reason: 'missing' };
}
