import { describe, expect, it } from 'vitest';
import { makeConfig } from '../helpers/setup.js';
import {
  authenticateDashboard,
  csrfTokenFor,
  issueSession,
  parseCookies,
  serializeCookie,
  verifyCsrf,
  verifySession,
} from '../../src/server/auth/session.js';

describe('server/auth/session', () => {
  it('127. issueSession -> verifySession round-trips; a tampered/truncated/over-lifetime cookie verifies as null', () => {
    const config = makeConfig({ dashboardSessionHours: 12 });
    const now = 1_700_000_000_000;
    const { cookie } = issueSession(config, now);
    const raw = cookie.split(';')[0]!.split('=')[1]!;

    const ok = verifySession(config, raw, now + 1000);
    expect(ok).not.toBeNull();
    expect(ok?.sid).toBeTruthy();

    const tampered = `${raw.slice(0, -1)}${raw.at(-1) === 'a' ? 'b' : 'a'}`;
    expect(verifySession(config, tampered, now)).toBeNull();

    const truncated = raw.slice(0, raw.length - 6);
    expect(verifySession(config, truncated, now)).toBeNull();

    const parts = raw.split('.');
    const forgedFarFuture = `v1.${Number(parts[1]) + 100_000_000}.${parts[2]}.${parts[3]}`;
    expect(verifySession(config, forgedFarFuture, now)).toBeNull();
  });

  it('128. an expired cookie (clock advanced past DASHBOARD_SESSION_HOURS) verifies as null', () => {
    const config = makeConfig({ dashboardSessionHours: 1 });
    const now = 1_700_000_000_000;
    const { cookie } = issueSession(config, now);
    const raw = cookie.split(';')[0]!.split('=')[1]!;
    expect(verifySession(config, raw, now + 1 * 3600_000 + 1000)).toBeNull();
    expect(verifySession(config, raw, now + 1000)).not.toBeNull();
  });

  it('129. csrfTokenFor differs per sid; verifyCsrf rejects another session\'s token and is length-mismatch-safe', () => {
    const config = makeConfig();
    const t1 = csrfTokenFor(config, 'sid-one');
    const t2 = csrfTokenFor(config, 'sid-two');
    expect(t1).not.toBe(t2);
    expect(verifyCsrf(config, 'sid-one', t1)).toBe(true);
    expect(verifyCsrf(config, 'sid-one', t2)).toBe(false);
    expect(verifyCsrf(config, 'sid-one', 'short')).toBe(false);
    expect(verifyCsrf(config, 'sid-one', undefined)).toBe(false);
  });

  it('130. parseCookies handles quoting, whitespace, duplicates (first wins) and a missing header; serializeCookie emits the right flags', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('a=1; b="two"; a=2')).toEqual({ a: '1', b: 'two' });
    expect(parseCookies('  a = 1  ;  b=2  ')).toEqual({ a: '1', b: '2' });

    const withSecure = serializeCookie('openpost_sess', 'v', { maxAgeSec: 100, secure: true, httpOnly: true, sameSite: 'Strict', path: '/dashboard' });
    expect(withSecure).toContain('HttpOnly');
    expect(withSecure).toContain('SameSite=Strict');
    expect(withSecure).toContain('Path=/dashboard');
    expect(withSecure).toContain('Secure');

    const withoutSecure = serializeCookie('openpost_sess', 'v', { maxAgeSec: 100, secure: false, httpOnly: true, sameSite: 'Strict', path: '/dashboard' });
    expect(withoutSecure).not.toContain('Secure');
  });

  it('131. authenticateDashboard precedence: bearer wins; session next; loopback+no-secret -> open; non-loopback+no-secret -> not ok', () => {
    const bearerConfig = makeConfig({ apiToken: 'tok123' });
    const bearerAuth = authenticateDashboard(bearerConfig, { headers: { authorization: 'Bearer tok123' } }, Date.now());
    expect(bearerAuth).toEqual({ ok: true, via: 'bearer', sid: null });

    const now = 1_700_000_000_000;
    const { cookie } = issueSession(bearerConfig, now);
    const raw = cookie.split(';')[0]!.split('=')[1]!;
    const sessionAuth = authenticateDashboard(bearerConfig, { headers: { cookie: `openpost_sess=${raw}` } }, now + 1000);
    expect(sessionAuth.ok).toBe(true);
    expect(sessionAuth.ok && sessionAuth.via).toBe('session');

    const openConfig = makeConfig({ dashboardBind: '127.0.0.1', trustProxy: false, apiToken: undefined, dashboardPassword: undefined });
    const openAuth = authenticateDashboard(openConfig, { headers: {} }, Date.now());
    expect(openAuth).toEqual({ ok: true, via: 'open', sid: null });

    const publicConfig = makeConfig({ dashboardBind: '0.0.0.0', trustProxy: false, apiToken: undefined, dashboardPassword: undefined });
    const publicAuth = authenticateDashboard(publicConfig, { headers: {} }, Date.now());
    expect(publicAuth.ok).toBe(false);
  });

  it('132. a session cookie issued under a different TRACKING_SECRET does not verify', () => {
    const configA = makeConfig({ trackingSecret: 'a'.repeat(40) });
    const configB = makeConfig({ trackingSecret: 'b'.repeat(40) });
    const now = 1_700_000_000_000;
    const { cookie } = issueSession(configA, now);
    const raw = cookie.split(';')[0]!.split('=')[1]!;
    expect(verifySession(configB, raw, now + 1000)).toBeNull();
  });
});
