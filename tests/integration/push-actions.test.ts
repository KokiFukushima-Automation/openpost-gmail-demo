import { createECDH, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { csrfTokenFor, issueSession } from '../../src/server/auth/session.js';
import { countActiveSubscriptions } from '../../src/db/push.js';

function sessionAuth(env: TestServer): { cookieHeader: string; csrf: string } {
  const { cookie, sid } = issueSession(env.config, Date.now());
  const sessionCookieValue = cookie.split(';')[0]!.split('=')[1]!;
  return { cookieHeader: `openpost_sess=${sessionCookieValue}`, csrf: csrfTokenFor(env.config, sid) };
}

function validSubscription(endpoint = 'https://push.example.com/wp/abc') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') },
  };
}

describe('push subscription actions (docs/09_phase5_spec.md §4.5)', () => {
  let env: TestServer;
  afterEach(async () => {
    await env.app.close();
    env.db.close();
  });

  it('a valid subscription is accepted, upserted, and audited', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const sub = validSubscription();
    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers: { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf },
      payload: JSON.stringify(sub),
    });
    expect(res.statusCode).toBe(200);
    expect(countActiveSubscriptions(env.db)).toBe(1);
    const audit = env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'push.subscribe'`).get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it('405. rejects a non-HTTPS endpoint, a short p256dh, and a wrong-length auth', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const headers = { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf };

    const nonHttps = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers,
      payload: JSON.stringify({ endpoint: 'http://push.example.com/wp/x', keys: validSubscription().keys }),
    });
    expect(nonHttps.statusCode).toBe(400);

    const shortP256dh = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers,
      payload: JSON.stringify({ endpoint: 'https://push.example.com/wp/x', keys: { p256dh: Buffer.alloc(10).toString('base64url'), auth: Buffer.alloc(16).toString('base64url') } }),
    });
    expect(shortP256dh.statusCode).toBe(400);

    const wrongAuth = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers,
      payload: JSON.stringify({ endpoint: 'https://push.example.com/wp/x', keys: { ...validSubscription().keys, auth: Buffer.alloc(4).toString('base64url') } }),
    });
    expect(wrongAuth.statusCode).toBe(400);
  });

  it('an over-long endpoint (> 2048 chars) is rejected', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const sub = validSubscription(`https://push.example.com/wp/${'a'.repeat(2100)}`);
    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers: { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf },
      payload: JSON.stringify(sub),
    });
    expect(res.statusCode).toBe(400);
  });

  it('406. PUSH_MAX_SUBSCRIPTIONS -> 409', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein', pushMaxSubscriptions: 1 } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const headers = { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf };
    const first = await env.app.inject({ method: 'POST', url: '/dashboard/actions/push-subscribe', headers, payload: JSON.stringify(validSubscription('https://push.example.com/wp/one')) });
    expect(first.statusCode).toBe(200);
    const second = await env.app.inject({ method: 'POST', url: '/dashboard/actions/push-subscribe', headers, payload: JSON.stringify(validSubscription('https://push.example.com/wp/two')) });
    expect(second.statusCode).toBe(409);
  });

  it('unsubscribe deletes the row and audits', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const headers = { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf };
    const subRes = await env.app.inject({ method: 'POST', url: '/dashboard/actions/push-subscribe', headers, payload: JSON.stringify(validSubscription()) });
    const { id } = JSON.parse(subRes.body);
    const res = await env.app.inject({ method: 'POST', url: '/dashboard/actions/push-unsubscribe', headers, payload: JSON.stringify({ id }) });
    expect(res.statusCode).toBe(200);
    expect(countActiveSubscriptions(env.db)).toBe(0);
  });

  it('loopback http:// is accepted only under NOTIFY_ALLOW_PRIVATE_URLS (finding #4, phase5.1)', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const rejected = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers: { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf },
      payload: JSON.stringify(validSubscription('http://127.0.0.1:9999/wp/local')),
    });
    expect(rejected.statusCode).toBe(400);
    await env.app.close();
    env.db.close();

    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein', notifyAllowPrivateUrls: true } });
    const second = sessionAuth(env);
    const sub = validSubscription('http://127.0.0.1:9999/wp/local');
    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers: { cookie: second.cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': second.csrf },
      payload: JSON.stringify(sub),
    });
    expect(res.statusCode).toBe(200);
  });

  it('finding #3 (phase5.1): a service-worker-shaped re-subscribe POST with no CSRF token is rejected 403', async () => {
    // Mirrors exactly what sw.js's `pushsubscriptionchange` handler used to send before finding #3
    // was fixed: a session cookie, a same-origin-shaped request, a JSON body carrying `oldEndpoint`
    // - but no `_csrf` field and no `X-Openpost-CSRF` header at all.
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader } = sessionAuth(env);
    const sub = { ...validSubscription('https://push.example.com/wp/rotated'), oldEndpoint: 'https://push.example.com/wp/stale' };
    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers: { cookie: cookieHeader, 'content-type': 'application/json' },
      payload: JSON.stringify(sub),
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({ error: 'csrf' });
    expect(countActiveSubscriptions(env.db)).toBe(0);
  });

  it('finding #3 (phase5.1): the same re-subscribe POST succeeds and swaps the row once X-Openpost-CSRF is set', async () => {
    // This is what sw.js sends after the fix: it reads the non-HttpOnly `openpost_csrf` cookie (or
    // asks an open client page) and sends it back as `X-Openpost-CSRF`, exactly like every other
    // dashboard-actions POST already does.
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const headers = { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf };
    const first = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers,
      payload: JSON.stringify(validSubscription('https://push.example.com/wp/stale')),
    });
    expect(first.statusCode).toBe(200);
    expect(countActiveSubscriptions(env.db)).toBe(1);

    const sub = { ...validSubscription('https://push.example.com/wp/rotated'), oldEndpoint: 'https://push.example.com/wp/stale' };
    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers,
      payload: JSON.stringify(sub),
    });
    expect(res.statusCode).toBe(200);
    // The swap: exactly one active row, and it is the new endpoint, not the stale one.
    expect(countActiveSubscriptions(env.db)).toBe(1);
    const row = env.db.prepare('SELECT endpoint FROM push_subscriptions WHERE disabled_at IS NULL').get() as { endpoint: string };
    expect(row.endpoint).toBe('https://push.example.com/wp/rotated');
  });

  it('finding #4 (phase5.1): private/loopback/link-local https endpoints are rejected by default', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const headers = { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf };
    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data/',
      'https://10.0.0.5/internal',
      'https://[::1]/y',
      'https://localhost/z',
    ]) {
      const res = await env.app.inject({
        method: 'POST',
        url: '/dashboard/actions/push-subscribe',
        headers,
        payload: JSON.stringify(validSubscription(endpoint)),
      });
      expect(res.statusCode, endpoint).toBe(400);
    }
    expect(countActiveSubscriptions(env.db)).toBe(0);
  });

  it('finding #4 (phase5.1): NOTIFY_ALLOW_PRIVATE_URLS=true accepts a private-range https endpoint', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein', notifyAllowPrivateUrls: true } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const res = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers: { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf },
      payload: JSON.stringify(validSubscription('https://10.0.0.5/internal')),
    });
    expect(res.statusCode).toBe(200);
  });

  it('finding #2 (phase5.1): 50 POSTs with oldEndpoint: "" under a cap of 1 leave exactly 1 active row', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein', pushMaxSubscriptions: 1 } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const headers = { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf };
    for (let i = 0; i < 50; i++) {
      const sub = { ...validSubscription(`https://push.example.com/wp/bypass-${i}`), oldEndpoint: '' };
      await env.app.inject({ method: 'POST', url: '/dashboard/actions/push-subscribe', headers, payload: JSON.stringify(sub) });
    }
    expect(countActiveSubscriptions(env.db)).toBe(1);
  });

  it('finding #8 (phase5.1): label/uaFamily/deviceType are bounded to 200 chars and non-strings become null', async () => {
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    const headers = { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf };
    const sub = {
      ...validSubscription('https://push.example.com/wp/bounded'),
      label: 'x'.repeat(5000),
      uaFamily: 12345,
      deviceType: { evil: true },
    };
    const res = await env.app.inject({ method: 'POST', url: '/dashboard/actions/push-subscribe', headers, payload: JSON.stringify(sub) });
    expect(res.statusCode).toBe(200);
    const row = env.db.prepare('SELECT label, ua_family, device_type FROM push_subscriptions').get() as {
      label: string;
      ua_family: string | null;
      device_type: string | null;
    };
    expect(row.label.length).toBe(200);
    expect(row.ua_family).toBeNull();
    expect(row.device_type).toBeNull();
  });

  it('434. openpost forget leaves push_subscriptions untouched (deliberate)', async () => {
    const { planForget, executeForget } = await import('../../src/db/erase.js');
    env = setupTestServer({ configOverrides: { dashboardPassword: 'letmein' } });
    const { cookieHeader, csrf } = sessionAuth(env);
    await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/push-subscribe',
      headers: { cookie: cookieHeader, 'content-type': 'application/json', 'x-openpost-csrf': csrf },
      payload: JSON.stringify(validSubscription()),
    });
    expect(countActiveSubscriptions(env.db)).toBe(1);
    const plan = planForget(env.db, 'someone@example.com');
    executeForget(env.db, plan, { purgeBodies: false, keepSuppression: false, ipSalt: env.config.ipSalt, atMs: Date.now() });
    expect(countActiveSubscriptions(env.db)).toBe(1);
  });
});
