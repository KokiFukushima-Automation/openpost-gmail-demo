import { request as httpRequest, type IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { addRecipient, createMessage, ensureAccount } from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { signToken } from '../../src/core/token.js';

const SENT_AT = 1_700_000_000_000;
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function plainRequest(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (data += d));
      res.on('end', () => resolve({ status: res.statusCode as number, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function openStream(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ res: IncomingMessage; chunks: string[]; close: () => void }>((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (d: string) => chunks.push(d));
      resolve({ res, chunks, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('timed out waiting for condition'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('dashboard live updates (real listening server)', () => {
  let env: TestServer;
  let port: number;

  beforeEach(async () => {
    env = setupTestServer({ startAt: SENT_AT + 60_000, configOverrides: { dashboardPassword: 'letmein' } });
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    port = (env.app.server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await env.app.close();
  });

  it('150. /api/events/stream accepts a session cookie (no bearer); with API_TOKEN configured, no credential at all -> 401 (test 88 unchanged)', async () => {
    // A bearer requirement only ever turns on when API_TOKEN is configured (finding #29) - build a
    // second server with one, so "no credential at all" has something to be rejected by, exactly
    // as it would off loopback.
    const securedEnv = setupTestServer({
      startAt: SENT_AT + 60_000,
      configOverrides: { dashboardPassword: 'letmein', apiToken: 'bearer-tok' },
    });
    await securedEnv.app.listen({ port: 0, host: '127.0.0.1' });
    const securedPort = (securedEnv.app.server.address() as { port: number }).port;

    const login = await plainRequest(
      securedPort,
      'POST',
      '/dashboard/login',
      { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String('password=letmein'.length) },
      'password=letmein',
    );
    const setCookies = ([] as string[]).concat((login.headers['set-cookie'] as string[] | string) ?? []);
    const sessCookie = setCookies.find((c) => c.startsWith('openpost_sess='))?.split(';')[0];
    expect(sessCookie).toBeTruthy();

    const noCred = await plainRequest(securedPort, 'GET', '/api/events/stream');
    expect(noCred.status).toBe(401);

    const stream = await openStream(securedPort, '/api/events/stream', { cookie: sessCookie as string });
    expect(stream.res.statusCode).toBe(200);
    stream.close();
    await securedEnv.app.close();
  });

  it('150b. H1: a real login cookie reaches /dashboard/events/stream by Path; a browser would never send it to /api/events/stream', async () => {
    const securedEnv = setupTestServer({
      startAt: SENT_AT + 60_000,
      configOverrides: { dashboardPassword: 'letmein', apiToken: 'bearer-tok' },
    });
    await securedEnv.app.listen({ port: 0, host: '127.0.0.1' });
    const securedPort = (securedEnv.app.server.address() as { port: number }).port;

    const login = await plainRequest(
      securedPort,
      'POST',
      '/dashboard/login',
      { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String('password=letmein'.length) },
      'password=letmein',
    );
    const setCookies = ([] as string[]).concat((login.headers['set-cookie'] as string[] | string) ?? []);
    const sessSetCookie = setCookies.find((c) => c.startsWith('openpost_sess='));
    expect(sessSetCookie).toBeTruthy();
    const sessCookiePair = (sessSetCookie as string).split(';')[0] as string;
    const pathAttr = /Path=([^;]+)/i.exec(sessSetCookie as string)?.[1];
    expect(pathAttr).toBe('/dashboard');

    // Mimics a real browser's own cookie-jar Path matching (Node's http client does not do this
    // for us): only attach the cookie to a request whose path starts with the cookie's own Path.
    function cookieHeaderFor(requestPath: string): Record<string, string> {
      return requestPath.startsWith(pathAttr as string) ? { cookie: sessCookiePair } : {};
    }

    const dashboardStream = await openStream(securedPort, '/dashboard/events/stream', cookieHeaderFor('/dashboard/events/stream'));
    expect(dashboardStream.res.statusCode).toBe(200);
    dashboardStream.close();

    // A real browser would never attach a Path=/dashboard cookie here - with API_TOKEN configured
    // and no bearer, this must still 401 (the regression H1 found: before the fix, the dashboard's
    // own EventSource pointed at exactly this path and could never authenticate off-loopback).
    const apiNoCookie = await plainRequest(securedPort, 'GET', '/api/events/stream', cookieHeaderFor('/api/events/stream'));
    expect(apiNoCookie.status).toBe(401);

    await securedEnv.app.close();
  });

  it('151. a pixel hit produces a tracking frame; fetching the recipient fragment afterwards reflects the new state (the two steps app.js performs)', async () => {
    const login = await plainRequest(
      port,
      'POST',
      '/dashboard/login',
      { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String('password=letmein'.length) },
      'password=letmein',
    );
    const setCookies = ([] as string[]).concat((login.headers['set-cookie'] as string[] | string) ?? []);
    const sessCookie = setCookies.find((c) => c.startsWith('openpost_sess='))?.split(';')[0] as string;

    const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(env.db, {
      accountId: account.id,
      subject: 'hello',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    env.db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(SENT_AT, message.id);
    const recipient = addRecipient(env.db, { messageId: message.id, email: 'alice@example.com', token: newId() });

    const stream = await openStream(port, '/api/events/stream', { cookie: sessCookie });
    await waitFor(() => stream.chunks.join('').includes('retry: 3000'));

    const secret = env.config.trackingSecret as string;
    const pixelRes = await plainRequest(port, 'GET', `/o/${signToken('o', recipient.token, secret)}.gif`, { 'user-agent': CHROME_UA });
    expect(pixelRes.status).toBe(200);

    await waitFor(() => stream.chunks.join('').includes('event: tracking'));
    stream.close();

    const fragmentRes = await plainRequest(port, 'GET', `/dashboard/fragments/recipient/${recipient.id}`, { cookie: sessCookie });
    expect(fragmentRes.status).toBe(200);
    expect(fragmentRes.body).toContain('data-recipient-id');
    expect(fragmentRes.body).not.toContain('Not opened');
  });

  it('189b. the SSE stream payload for a reply/reminder TrackingEvent parses to a valid NotificationPayload', async () => {
    const login = await plainRequest(
      port,
      'POST',
      '/dashboard/login',
      { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String('password=letmein'.length) },
      'password=letmein',
    );
    const setCookies = ([] as string[]).concat((login.headers['set-cookie'] as string[] | string) ?? []);
    const sessCookie = setCookies.find((c) => c.startsWith('openpost_sess='))?.split(';')[0] as string;

    const stream = await openStream(port, '/api/events/stream', { cookie: sessCookie });
    await waitFor(() => stream.chunks.join('').includes('retry: 3000'));

    env.bus.publish({
      kind: 'reply',
      eventId: 'reply:rcpt-x',
      occurredAt: Date.now(),
      messageId: 'msg-x',
      subject: 'hello',
      recipientId: 'rcpt-x',
      recipientEmail: 'alice@example.com',
      classification: 'reply',
      reasons: ['reply'],
      counted: false,
      backfilled: false,
      prevState: 'read_confirmed',
      newState: 'replied',
      counters: { openCount: 1, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1, lastOpenAt: 1 },
      uaFamily: null,
      deviceType: null,
      linkUrl: null,
      muted: false,
      sentAt: 0,
      country: null,
    });

    await waitFor(() => stream.chunks.join('').includes('event: tracking'));
    const dataLine = stream.chunks
      .join('')
      .split('\n')
      .find((l) => l.startsWith('data: ')) as string;
    const payload = JSON.parse(dataLine.slice('data: '.length));
    expect(payload.version).toBe(1);
    expect(payload.trigger).toBe('reply');
    expect(payload.event.kind).toBe('reply');
    expect(payload.recipient.state).toBe('replied');
    stream.close();
  });
});
