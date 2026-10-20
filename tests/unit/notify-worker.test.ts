import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { addRecipient, createMessage, ensureAccount } from '../../src/db/repo.js';
import { EventBus } from '../../src/notify/bus.js';
import { enqueue } from '../../src/notify/queue.js';
import { NotifyWorker } from '../../src/notify/worker.js';
import type { FetchLike, NotificationPayload } from '../../src/notify/types.js';
import { makeConfig } from '../helpers/setup.js';

function seed() {
  const db = openDb(':memory:');
  migrate(db);
  const account = ensureAccount(db, { email: 's@example.com', transport: 'dryrun' });
  const message = createMessage(db, {
    accountId: account.id,
    subject: 's',
    bodyHtml: null,
    bodyText: null,
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: false,
  });
  const recipient = addRecipient(db, { messageId: message.id, email: 'a@example.com', token: 'a'.repeat(26) });
  return { db, message, recipient };
}

function fakePayload(): NotificationPayload {
  return {
    version: 1,
    id: 'n1',
    trigger: 'first_open',
    occurredAt: 1000,
    message: { id: 'm1', subject: 's', sentAt: 900 },
    recipient: { id: 'r1', email: 'a@example.com', state: 'opened', openCount: 1, clickCount: 0 },
    event: { id: 'e1', kind: 'open', classification: 'human', reasons: ['R9'], counted: true, uaFamily: null, deviceType: null, country: null, linkUrl: null },
  };
}

describe('NotifyWorker.tickOnce edge cases', () => {
  it('a channel removed from configuration after enqueue is skipped and dead-lettered, not counted as failed', async () => {
    const { db, message, recipient } = seed();
    enqueue(db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload: fakePayload(),
      messageId: message.id,
      recipientId: recipient.id,
      eventType: 'open',
      eventId: 'e1',
      dedupeKey: 'k1',
      atMs: 1000,
    });
    const config = makeConfig({ notifyChannels: [] }); // webhook no longer configured
    const worker = new NotifyWorker({ db, config, bus: new EventBus(), notifiers: new Map(), clock: () => 2000 });
    const result = await worker.tickOnce();
    expect(result.skipped).toBe(1);
    const row = db.prepare('SELECT status FROM notifications WHERE id IS NOT NULL LIMIT 1').get() as { status: string };
    expect(row.status).toBe('failed');
  });

  it('a corrupt payload_json is skipped and dead-lettered', async () => {
    const { db, message, recipient } = seed();
    db.prepare(
      `INSERT INTO notifications (id, trigger, channel, message_id, recipient_id, event_type, event_id, dedupe_key, payload_json, status, attempts, next_attempt_at, created_at)
       VALUES ('nrow1','first_open','webhook',?,?,'open','e1','k1','{not valid json','pending',0,500,500)`,
    ).run(message.id, recipient.id);
    const config = makeConfig({ notifyChannels: ['webhook'], webhookUrl: 'https://hook.test', webhookSecret: 'x'.repeat(10) });
    const worker = new NotifyWorker({ db, config, bus: new EventBus(), clock: () => 1000 });
    const result = await worker.tickOnce();
    expect(result.skipped).toBe(1);
  });

  it('a retryable failure under max attempts schedules a retry (not sent, not failed)', async () => {
    const { db, message, recipient } = seed();
    enqueue(db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload: fakePayload(),
      messageId: message.id,
      recipientId: recipient.id,
      eventType: 'open',
      eventId: 'e1',
      dedupeKey: 'k2',
      atMs: 1000,
    });
    const config = makeConfig({
      notifyChannels: ['webhook'],
      webhookUrl: 'https://hook.test',
      webhookSecret: 'x'.repeat(10),
      notifyMaxAttempts: 4,
    });
    const failFetch: FetchLike = (async () => ({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => 'oops',
    })) as unknown as FetchLike;
    const worker = new NotifyWorker({ db, config, bus: new EventBus(), fetch: failFetch, clock: () => 1000, rand: () => 0.5 });
    const result = await worker.tickOnce();
    expect(result.retried).toBe(1);
    const row = db.prepare('SELECT status, attempts FROM notifications WHERE dedupe_key = ?').get('k2') as {
      status: string;
      attempts: number;
    };
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
  });

  it('finding #26: start() is idempotent, and stop() genuinely awaits an in-flight tick rather than just clearing the interval handle', async () => {
    const { db, message, recipient } = seed();
    enqueue(db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload: fakePayload(),
      messageId: message.id,
      recipientId: recipient.id,
      eventType: 'open',
      eventId: 'e1',
      dedupeKey: 'k-stop',
      atMs: 1000,
    });
    const config = makeConfig({
      notifyChannels: ['webhook'],
      webhookUrl: 'https://hook.test',
      webhookSecret: 'x'.repeat(10),
      notifyTickSeconds: 1,
    });
    let deliveryFinished = false;
    const slowFetch: FetchLike = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      deliveryFinished = true;
      return { status: 200, ok: true, headers: { get: () => null }, text: async () => '' };
    }) as unknown as FetchLike;
    const worker = new NotifyWorker({ db, config, bus: new EventBus(), fetch: slowFetch, clock: () => 1000 });

    worker.start();
    worker.start(); // idempotent - a second call must not throw or double up the interval
    const tick = worker.tickOnce();
    expect(deliveryFinished).toBe(false); // the delivery is still in flight when stop() is called
    await worker.stop();
    // The whole point of stop() awaiting `this.inFlight`: by the time it resolves, the tick it
    // caught mid-flight must have actually finished, not merely been abandoned.
    expect(deliveryFinished).toBe(true);
    const result = await tick;
    expect(result.sent).toBe(1);
  });

  it('finding #25: NOTIFY_MAX_ATTEMPTS is enforced by the worker itself, tick by tick, not by hand-driving markRetry/markFailed', async () => {
    const { db, message, recipient } = seed();
    enqueue(db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload: fakePayload(),
      messageId: message.id,
      recipientId: recipient.id,
      eventType: 'open',
      eventId: 'e1',
      dedupeKey: 'k-max-attempts',
      atMs: 1000,
    });
    const config = makeConfig({
      notifyChannels: ['webhook'],
      webhookUrl: 'https://hook.test',
      webhookSecret: 'x'.repeat(10),
      notifyMaxAttempts: 3,
      notifyBackoffBaseMs: 1,
    });
    let now = 1000;
    const alwaysRetryableFail: FetchLike = (async () => ({
      status: 503,
      ok: false,
      headers: { get: () => null },
      text: async () => 'unavailable',
    })) as unknown as FetchLike;
    const worker = new NotifyWorker({ db, config, bus: new EventBus(), fetch: alwaysRetryableFail, clock: () => now, rand: () => 0 });

    // Tick once per (would-be) attempt, advancing the clock past whatever backoff was scheduled -
    // this drives the real worker code path (deliverRow's `row.attempts >= config.notifyMaxAttempts`
    // check), not a hand-written substitute for it.
    for (let i = 0; i < config.notifyMaxAttempts; i++) {
      const result = await worker.tickOnce();
      expect(result.retried + result.failed).toBe(1);
      now += 100_000;
    }

    const row = db.prepare('SELECT status, attempts, last_error FROM notifications WHERE dedupe_key = ?').get(
      'k-max-attempts',
    ) as { status: string; attempts: number; last_error: string };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(config.notifyMaxAttempts);
    expect(row.last_error).toContain('503');

    const deadLetter = db
      .prepare('SELECT COUNT(*) AS n FROM notification_dead_letters WHERE recipient_id = ?')
      .get(recipient.id) as { n: number };
    expect(deadLetter.n).toBe(1);

    // One more tick must not pick it up again or add a second dead letter.
    const extra = await worker.tickOnce();
    expect(extra.sent + extra.retried + extra.failed).toBe(0);
    const deadLetterAfter = db
      .prepare('SELECT COUNT(*) AS n FROM notification_dead_letters WHERE recipient_id = ?')
      .get(recipient.id) as { n: number };
    expect(deadLetterAfter.n).toBe(1);
  });

  it('finding #9: a delivery error containing the configured webhook URL is redacted before being stored', async () => {
    const { db, message, recipient } = seed();
    enqueue(db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload: fakePayload(),
      messageId: message.id,
      recipientId: recipient.id,
      eventType: 'open',
      eventId: 'e1',
      dedupeKey: 'k-redact',
      atMs: 1000,
    });
    const config = makeConfig({
      notifyChannels: ['webhook'],
      webhookUrl: 'https://hook.test/SECRET-PATH',
      webhookSecret: 'x'.repeat(10),
    });
    const failFetch: FetchLike = (async () => {
      throw new Error('fetch failed while POSTing to https://hook.test/SECRET-PATH');
    }) as unknown as FetchLike;
    const worker = new NotifyWorker({ db, config, bus: new EventBus(), fetch: failFetch, clock: () => 1000 });
    await worker.tickOnce();
    const row = db.prepare('SELECT last_error FROM notifications WHERE dedupe_key = ?').get('k-redact') as {
      last_error: string;
    };
    expect(row.last_error).not.toContain('SECRET-PATH');
    expect(row.last_error).toContain('[redacted]');
  });

  it('onTrackingEvent does nothing when NOTIFY_ENABLED=false', () => {
    const { db } = seed();
    const config = makeConfig({ notifyEnabled: false, notifyChannels: ['webhook'], webhookUrl: 'https://hook.test', webhookSecret: 'x'.repeat(10) });
    const bus = new EventBus();
    const worker = new NotifyWorker({ db, config, bus });
    worker.attach();
    bus.publish({
      kind: 'open',
      eventId: 'e1',
      occurredAt: 1000,
      messageId: 'm1',
      subject: 's',
      recipientId: 'r1',
      recipientEmail: 'a@example.com',
      classification: 'human',
      reasons: ['R9'],
      counted: true,
      backfilled: false,
      prevState: 'not_opened',
      newState: 'opened',
      counters: { openCount: 1, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1000, lastOpenAt: 1000 },
      uaFamily: null,
      deviceType: null,
      linkUrl: null,
      muted: false,
      sentAt: 900,
      country: null,
    });
    const count = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
