import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeToServeDashboard, ConfigError } from '../../src/config/env.js';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { csrfTokenFor, issueSession } from '../../src/server/auth/session.js';
import { _resetLoginRateLimiterForTests } from '../../src/server/routes/dashboard-actions.js';

describe('dashboard auth', () => {
  let env: TestServer;

  beforeEach(() => {
    _resetLoginRateLimiterForTests();
  });

  afterEach(async () => {
    await env.app.close();
    env.db.close();
  });

  it('133. assertSafeToServeDashboard throws ConfigError for a non-loopback bind (or TRUST_PROXY) with no secret; passes with either secret', () => {
    env = setupTestServer();
    const noSecret = { ...env.config, dashboardPassword: undefined, apiToken: undefined };
    expect(() => assertSafeToServeDashboard(noSecret, '0.0.0.0')).toThrow(ConfigError);
    expect(() => assertSafeToServeDashboard({ ...noSecret, trustProxy: 1 }, '127.0.0.1')).toThrow(ConfigError);
    expect(() => assertSafeToServeDashboard({ ...noSecret, dashboardPassword: 'secret-pw' }, '0.0.0.0')).not.toThrow();
    expect(() => assertSafeToServeDashboard({ ...noSecret, apiToken: 'tok' }, '0.0.0.0')).not.toThrow();
    expect(() => assertSafeToServeDashboard(noSecret, '127.0.0.1')).not.toThrow();
  });

  it('134. with a password set: GET /dashboard -> 302 login?next=...; a correct login sets cookies and redirects to a validated next; an external next is rewritten to /dashboard', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const listRes = await env.app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(listRes.statusCode).toBe(302);
    expect(listRes.headers.location).toBe('/dashboard/login?next=%2Fdashboard%2Fmessages');

    const loginRes = await env.app.inject({
      method: 'POST',
      url: '/dashboard/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'password=letmein&next=https%3A%2F%2Fevil.example',
    });
    expect(loginRes.statusCode).toBe(302);
    expect(loginRes.headers.location).toBe('/dashboard');
    expect(loginRes.cookies.some((c) => c.name === 'openpost_sess')).toBe(true);
    expect(loginRes.cookies.some((c) => c.name === 'openpost_csrf')).toBe(true);
  });

  it('135. a wrong password returns to the login page with an error, writes dashboard.login.failed, and the 11th attempt inside a minute returns 429', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein', dashboardLoginRatePerMin: 10 } });
    for (let i = 0; i < 10; i++) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/dashboard/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'password=wrong',
      });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain('error=1');
    }
    const failedAudits = env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'dashboard.login.failed'`).get() as { n: number };
    expect(failedAudits.n).toBe(10);

    const eleventh = await env.app.inject({
      method: 'POST',
      url: '/dashboard/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'password=wrong',
    });
    expect(eleventh.statusCode).toBe(429);
  });

  it('136. POST reclassify without _csrf -> 403; with another session\'s token -> 403; with a mismatched Origin -> 403; with the correct token -> 200/303', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookie, sid } = issueSession(env.config, Date.now());
    const sessionCookieValue = cookie.split(';')[0]!.split('=')[1]!;
    const cookieHeader = `openpost_sess=${sessionCookieValue}`;

    const noCsrf = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/mute',
      headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'messageId=nonexistent',
    });
    expect(noCsrf.statusCode).toBe(403);

    const otherSessionToken = csrfTokenFor(env.config, 'a-different-sid');
    const wrongCsrf = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/mute',
      headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `messageId=nonexistent&_csrf=${otherSessionToken}`,
    });
    expect(wrongCsrf.statusCode).toBe(403);

    const validToken = csrfTokenFor(env.config, sid);
    const badOrigin = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/mute',
      headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' },
      payload: `messageId=nonexistent&_csrf=${validToken}`,
    });
    expect(badOrigin.statusCode).toBe(403);

    const ok = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/mute',
      headers: { cookie: cookieHeader, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `messageId=nonexistent&_csrf=${validToken}`,
    });
    expect(ok.statusCode).toBe(404); // valid CSRF, but the message doesn't exist
  });

  it('137. a bearer-authenticated POST (no cookies) succeeds without a CSRF token', async () => {
    env = setupTestServer({ configOverrides: { apiToken: 'bearer-tok' } });
    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/mute',
      headers: { authorization: 'Bearer bearer-tok', 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'messageId=nonexistent',
    });
    // no CSRF token supplied at all, and it is not rejected for that reason (404: message missing).
    expect(res.statusCode).toBe(404);
  });
});
