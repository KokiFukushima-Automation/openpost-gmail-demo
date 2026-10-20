import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { addRecipient, createMessage, ensureAccount } from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { signToken } from '../../src/core/token.js';

const SENT_AT = 1_700_000_000_000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface StreamHandle {
  req: ReturnType<typeof httpRequest>;
  res: IncomingMessage;
  chunks: string[];
  close: () => void;
}

function openStream(port: number, path: string, headers: Record<string, string> = {}): Promise<StreamHandle> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      const chunks: string[] = [];
      res.setEncoding('utf8');
      res.on('data', (d: string) => chunks.push(d));
      resolve({ req, res, chunks, close: () => req.destroy() });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function plainGet(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d: string) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode as number, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('SSE stream', () => {
  let env: TestServer;
  let port: number;

  beforeEach(async () => {
    env = setupTestServer({
      startAt: SENT_AT + 60_000,
      configOverrides: { sseHeartbeatSeconds: 1 },
    });
    await env.app.listen({ port: 0, host: '127.0.0.1' });
    port = (env.app.server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await env.app.close();
  });

  it('85. returns text/event-stream + no-store and writes retry: 3000 first', async () => {
    const stream = await openStream(port, '/api/events/stream');
    expect(stream.res.headers['content-type']).toBe('text/event-stream');
    expect(stream.res.headers['cache-control']).toBe('no-store');
    await waitFor(() => stream.chunks.join('').includes('retry: 3000'));
    stream.close();
  });

  it('86. a pixel hit produces an event: tracking frame whose data parses to a NotificationPayload', async () => {
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

    const stream = await openStream(port, '/api/events/stream');
    await waitFor(() => stream.chunks.join('').includes('retry: 3000'));

    const secret = env.config.trackingSecret as string;
    const signed = signToken('o', recipient.token, secret);
    const res = await env.app.inject({ method: 'GET', url: `/o/${signed}.gif`, headers: { 'user-agent': CHROME_UA } });
    expect(res.statusCode).toBe(200);

    await waitFor(() => stream.chunks.join('').includes('event: tracking'));
    const text = stream.chunks.join('');
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse((dataLine as string).slice('data: '.length));
    expect(payload.event.kind).toBe('open');
    expect(typeof payload.event.id).toBe('string');
    stream.close();
  });

  it('87. advancing time emits a ping heartbeat; closing the request unsubscribes', async () => {
    expect(env.bus.size()).toBe(0);
    const stream = await openStream(port, '/api/events/stream');
    await waitFor(() => env.bus.size() === 1);
    await waitFor(() => stream.chunks.join('').includes(': ping'), 3000);
    stream.close();
    await waitFor(() => env.bus.size() === 0);
  });

  it('88. API_TOKEN configured -> unauthenticated request gets 401; with the right bearer -> 200 (finding #29: gated on API_TOKEN being set, not on the bind address itself - see isValidApiBearer)', async () => {
    const secureEnv = setupTestServer({
      startAt: SENT_AT,
      configOverrides: { bindAddress: '0.0.0.0', apiToken: 'secret-token' },
    });
    await secureEnv.app.listen({ port: 0, host: '127.0.0.1' });
    const securePort = (secureEnv.app.server.address() as { port: number }).port;

    const unauthorized = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: securePort, path: '/api/events/stream', method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode as number);
      });
      req.on('error', reject);
      req.end();
    });
    expect(unauthorized).toBe(401);

    const authorizedStream = await openStream(securePort, '/api/events/stream', { Authorization: 'Bearer secret-token' });
    expect(authorizedStream.res.statusCode).toBe(200);
    authorizedStream.close();

    await secureEnv.app.close();
  });

  it('finding #28: SSE_MAX_CLIENTS is enforced - the next client over the limit gets 503, and a slot frees up once one disconnects', async () => {
    const limitedEnv = setupTestServer({ startAt: SENT_AT, configOverrides: { sseMaxClients: 1 } });
    await limitedEnv.app.listen({ port: 0, host: '127.0.0.1' });
    const limitedPort = (limitedEnv.app.server.address() as { port: number }).port;

    const first = await openStream(limitedPort, '/api/events/stream');
    await waitFor(() => first.chunks.join('').includes('retry: 3000'));

    const rejected = await plainGet(limitedPort, '/api/events/stream');
    expect(rejected.status).toBe(503);
    expect(JSON.parse(rejected.body)).toEqual({ error: 'too_many_clients' });

    // Disconnecting the first client frees its slot for a new one.
    first.close();
    await waitFor(() => limitedEnv.bus.size() === 0);
    const second = await openStream(limitedPort, '/api/events/stream');
    expect(second.res.statusCode).toBe(200);
    second.close();

    await limitedEnv.app.close();
  });

  it('finding #28: ?since=<ms> replays only the buffered events strictly after that timestamp before the client subscribes to new ones', async () => {
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
    const early = addRecipient(env.db, { messageId: message.id, email: 'early@example.com', token: newId() });
    const late = addRecipient(env.db, { messageId: message.id, email: 'late@example.com', token: newId() });
    const secret = env.config.trackingSecret as string;

    // Both opens happen with no stream connected yet - they only ever reach the bus's own
    // recent-events buffer (size 100), not any live subscriber.
    const t1 = env.clock.now;
    await env.app.inject({ method: 'GET', url: `/o/${signToken('o', early.token, secret)}.gif`, headers: { 'user-agent': CHROME_UA } });
    env.clock.now += 10_000;
    const t2 = env.clock.now;
    await env.app.inject({ method: 'GET', url: `/o/${signToken('o', late.token, secret)}.gif`, headers: { 'user-agent': CHROME_UA } });

    const since = t1 + 1; // strictly between t1 and t2
    expect(since).toBeLessThan(t2);

    const stream = await openStream(port, `/api/events/stream?since=${since}`);
    await waitFor(() => stream.chunks.join('').includes('event: tracking'));
    // Give a moment for a (wrongly) second frame to arrive if the catch-up over-replayed.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const dataLines = stream.chunks
      .join('')
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => JSON.parse(l.slice('data: '.length)) as { recipient: { email: string | null } } );
    expect(dataLines).toHaveLength(1);
    expect(dataLines[0]?.recipient.email).toBe('late@example.com');
    stream.close();
  });
});
