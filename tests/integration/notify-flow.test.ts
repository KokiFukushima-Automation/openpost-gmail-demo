import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { NotifyWorker } from '../../src/notify/worker.js';
import { enqueue, requeue } from '../../src/notify/queue.js';
import type { FetchLike, NotificationPayload } from '../../src/notify/types.js';
import { getRecipient, addRecipient, createMessage, ensureAccount } from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { signToken } from '../../src/core/token.js';

const SENT_AT = 1_700_000_000_000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const APPLE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mail/16.0 CFNetwork/1408.0.4 Darwin/22.5.0';

function fakeOkFetch(calls: Array<{ url: string; init: unknown }>): FetchLike {
  return (async (url: string, init: unknown) => {
    calls.push({ url, init });
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      text: async () => '',
    };
  }) as unknown as FetchLike;
}

function sendOneMessage(env: TestServer, opts: { html?: string } = {}) {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(env.db, {
    accountId: account.id,
    subject: 'hello',
    bodyHtml: opts.html ?? '<p>hi</p>',
    bodyText: 'hi',
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: false,
  });
  env.db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(SENT_AT, message.id);
  const recipient = addRecipient(env.db, {
    messageId: message.id,
    email: 'alice@example.com',
    token: newId(),
  });
  return { message, recipient };
}

describe('notify worker integration', () => {
  let env: TestServer;

  beforeEach(() => {
    env = setupTestServer({
      startAt: SENT_AT + 60_000,
      configOverrides: {
        notifyChannels: ['webhook'],
        webhookUrl: 'https://hook.test/x',
        webhookSecret: 'shh-secret-value',
        notifyOn: ['first_open', 'read_confirmed', 'click'],
      },
    });
  });

  it('81. a counted pixel hit delivers one notification per configured channel within one tickOnce()', async () => {
    const { recipient } = sendOneMessage(env);
    const calls: Array<{ url: string; init: unknown }> = [];
    const worker = new NotifyWorker({ db: env.db, config: env.config, bus: env.bus, fetch: fakeOkFetch(calls), clock: () => env.clock.now });
    worker.attach();

    const secret = env.config.trackingSecret as string;
    const signed = signToken('o', recipient.token, secret);

    const res = await env.app.inject({ method: 'GET', url: `/o/${signed}.gif`, headers: { 'user-agent': CHROME_UA } });
    expect(res.statusCode).toBe(200);

    await worker.tickOnce();
    expect(calls).toHaveLength(1);

    const auditRows = env.db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'notify.deliver'`)
      .get() as { n: number };
    expect(auditRows.n).toBe(1);

    const notifRow = env.db.prepare('SELECT status FROM notifications').get() as { status: string };
    expect(notifRow.status).toBe('sent');
  });

  it('82. an Apple-MPP-only recipient produces zero notifications and reports state prefetched', async () => {
    const { recipient } = sendOneMessage(env);
    const calls: Array<{ url: string; init: unknown }> = [];
    const worker = new NotifyWorker({ db: env.db, config: env.config, bus: env.bus, fetch: fakeOkFetch(calls), clock: () => env.clock.now });
    worker.attach();

    const secret = env.config.trackingSecret as string;
    const signed = signToken('o', recipient.token, secret);

    // Within the MPP window, Apple Mail UA, first event -> apple_mpp (R4), uncounted.
    env.clock.now = SENT_AT + 2 * 60_000;
    const res = await env.app.inject({ method: 'GET', url: `/o/${signed}.gif`, headers: { 'user-agent': APPLE_UA } });
    expect(res.statusCode).toBe(200);
    await worker.tickOnce();

    expect(calls).toHaveLength(0);
    const notifCount = env.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(notifCount.n).toBe(0);
    const updated = getRecipient(env.db, recipient.id);
    expect(updated?.state).toBe('prefetched');
  });

  it('83. a pending row enqueued by a previous worker instance is delivered by a fresh worker after "restart"', async () => {
    const { message, recipient } = sendOneMessage(env);
    const payload: NotificationPayload = {
      version: 1,
      id: 'notif-x',
      trigger: 'first_open',
      occurredAt: env.clock.now,
      message: { id: message.id, subject: 'hello', sentAt: SENT_AT },
      recipient: { id: recipient.id, email: recipient.email, state: 'opened', openCount: 1, clickCount: 0 },
      event: { id: 'evt-x', kind: 'open', classification: 'human', reasons: ['R9'], counted: true, uaFamily: 'Chrome', deviceType: 'desktop', country: null, linkUrl: null },
    };
    // Simulate an earlier process instance having enqueued this (no delivery attempted yet).
    enqueue(env.db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload,
      messageId: message.id,
      recipientId: recipient.id,
      eventType: 'open',
      eventId: 'evt-x',
      dedupeKey: 'webhook:first_open:restart-test',
      atMs: env.clock.now,
    });

    const calls: Array<{ url: string; init: unknown }> = [];
    // A brand new NotifyWorker instance - nothing shared with whatever enqueued the row above.
    const freshWorker = new NotifyWorker({ db: env.db, config: env.config, bus: env.bus, fetch: fakeOkFetch(calls), clock: () => env.clock.now });
    await freshWorker.tickOnce();

    expect(calls).toHaveLength(1);
    const row = env.db.prepare('SELECT status FROM notifications WHERE dedupe_key = ?').get('webhook:first_open:restart-test') as {
      status: string;
    };
    expect(row.status).toBe('sent');
  });

  it('84. notifications retry --all-failed (requeue) moves a dead letter back to pending and the next tick delivers it', async () => {
    const { message, recipient } = sendOneMessage(env);
    const payload: NotificationPayload = {
      version: 1,
      id: 'notif-y',
      trigger: 'first_open',
      occurredAt: env.clock.now,
      message: { id: message.id, subject: 'hello', sentAt: SENT_AT },
      recipient: { id: recipient.id, email: recipient.email, state: 'opened', openCount: 1, clickCount: 0 },
      event: { id: 'evt-y', kind: 'open', classification: 'human', reasons: ['R9'], counted: true, uaFamily: 'Chrome', deviceType: 'desktop', country: null, linkUrl: null },
    };
    enqueue(env.db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload,
      messageId: message.id,
      recipientId: recipient.id,
      eventType: 'open',
      eventId: 'evt-y',
      dedupeKey: 'webhook:first_open:retry-test',
      atMs: env.clock.now,
    });

    // First delivery attempt fails hard (non-retryable) -> immediately dead-lettered.
    const failFetch: FetchLike = (async () => ({
      status: 400,
      ok: false,
      headers: { get: () => null },
      text: async () => 'bad request',
    })) as unknown as FetchLike;
    const failingWorker = new NotifyWorker({ db: env.db, config: env.config, bus: env.bus, fetch: failFetch, clock: () => env.clock.now });
    await failingWorker.tickOnce();

    const failedRow = env.db.prepare('SELECT id, status FROM notifications WHERE dedupe_key = ?').get('webhook:first_open:retry-test') as {
      id: string;
      status: string;
    };
    expect(failedRow.status).toBe('failed');

    const requeued = requeue(env.db, failedRow.id, env.clock.now + 1);
    expect(requeued).toBe(true);

    const calls: Array<{ url: string; init: unknown }> = [];
    const successWorker = new NotifyWorker({ db: env.db, config: env.config, bus: env.bus, fetch: fakeOkFetch(calls), clock: () => env.clock.now + 1 });
    await successWorker.tickOnce();
    expect(calls).toHaveLength(1);
    const finalRow = env.db.prepare('SELECT status FROM notifications WHERE id = ?').get(failedRow.id) as { status: string };
    expect(finalRow.status).toBe('sent');
  });
});
