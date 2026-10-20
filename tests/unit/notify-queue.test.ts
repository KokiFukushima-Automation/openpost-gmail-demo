import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { addRecipient, createMessage, ensureAccount } from '../../src/db/repo.js';
import {
  backoffMs,
  claimDue,
  enqueue,
  getNotification,
  listFailedIds,
  listNotifications,
  markFailed,
  markRetry,
  markSent,
  purgeNotifications,
  requeue,
} from '../../src/notify/queue.js';
import type { NotificationPayload } from '../../src/notify/types.js';

function fakePayload(id = 'n1'): NotificationPayload {
  return {
    version: 1,
    id,
    trigger: 'first_open',
    occurredAt: 1000,
    message: { id: 'm1', subject: 's', sentAt: 900 },
    recipient: { id: 'r1', email: 'a@example.com', state: 'opened', openCount: 1, clickCount: 0 },
    event: { id: 'e1', kind: 'open', classification: 'human', reasons: ['R9'], counted: true, uaFamily: null, deviceType: null, country: null, linkUrl: null },
  };
}

function setupDb() {
  const db = openDb(':memory:');
  migrate(db);
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(db, {
    accountId: account.id,
    subject: 's',
    bodyHtml: null,
    bodyText: null,
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: false,
  });
  const recipient = addRecipient(db, { messageId: message.id, email: 'a@example.com', token: 'tok1' });
  return { db, messageId: message.id, recipientId: recipient.id };
}

// Finding #5: `enqueue`'s row id is now `payload.id` (never a second, independently minted id), so
// distinct notifications enqueued in the same test must each carry a distinct payload id - just as
// NotifyWorker.enqueueForEvent mints a fresh one per (trigger, channel) pair in production.
let payloadIdCounter = 0;
function enqueueOne(
  ctx: ReturnType<typeof setupDb>,
  overrides: Partial<Parameters<typeof enqueue>[1]> = {},
) {
  payloadIdCounter += 1;
  return enqueue(ctx.db, {
    trigger: 'first_open',
    channel: 'webhook',
    payload: fakePayload(`n${payloadIdCounter}`),
    messageId: ctx.messageId,
    recipientId: ctx.recipientId,
    eventType: 'open',
    eventId: 'e1',
    dedupeKey: 'webhook:first_open:r1',
    atMs: 1000,
    ...overrides,
  });
}

describe('backoffMs', () => {
  it('75. yields 1s, 2s, 4s, 8s before jitter, caps at 300s, stays within +-20%', () => {
    const noJitter = () => 0.5; // 0.8 + 0.4*0.5 = 1.0, no adjustment
    expect(backoffMs(1, 1000, noJitter)).toBe(1000);
    expect(backoffMs(2, 1000, noJitter)).toBe(2000);
    expect(backoffMs(3, 1000, noJitter)).toBe(4000);
    expect(backoffMs(4, 1000, noJitter)).toBe(8000);
    expect(backoffMs(20, 1000, noJitter)).toBe(300_000);

    const lowJitter = backoffMs(2, 1000, () => 0);
    const highJitter = backoffMs(2, 1000, () => 1);
    expect(lowJitter).toBeGreaterThanOrEqual(2000 * 0.8 - 1);
    expect(highJitter).toBeLessThanOrEqual(2000 * 1.2 + 1);
  });
});

describe('enqueue / claimDue', () => {
  it('finding #5: the returned/stored row id is exactly payload.id, so X-Openpost-Delivery always names the real row', () => {
    const ctx = setupDb();
    const payload = fakePayload('the-payload-id');
    const id = enqueue(ctx.db, {
      trigger: 'first_open',
      channel: 'webhook',
      payload,
      messageId: ctx.messageId,
      recipientId: ctx.recipientId,
      eventType: 'open',
      eventId: 'e1',
      dedupeKey: 'webhook:first_open:unique',
      atMs: 1000,
    });
    expect(id).toBe('the-payload-id');
    const row = ctx.db.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get('webhook:first_open:unique') as {
      id: string;
    };
    expect(row.id).toBe('the-payload-id');
  });

  it('76. enqueue twice with the same dedupe key -> second returns null, one row exists', () => {
    const ctx = setupDb();
    const db = ctx.db;
    const first = enqueueOne(ctx);
    const second = enqueueOne(ctx);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const rows = db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it('77. claimDue returns only pending, due rows, ordered, limited; claiming leases them (finding #23: proven by re-claiming at the SAME due time, not at now=0 where nothing would be due regardless)', () => {
    const ctx = setupDb();
    const db = ctx.db;
    enqueueOne(ctx, { dedupeKey: 'a', atMs: 1000 });
    enqueueOne(ctx, { dedupeKey: 'b', atMs: 2000 });
    enqueueOne(ctx, { dedupeKey: 'c', atMs: 5000 }); // not yet due

    const claimed = claimDue(db, 3000, 10);
    expect(claimed.map((r) => r.dedupe_key)).toEqual(['a', 'b']);
    expect(claimed.every((r) => r.attempts === 1)).toBe(true);

    // Re-claiming at the exact same timestamp now returns nothing: a and b were leased into the
    // future by the claim above (their next_attempt_at moved past 3000), and c genuinely isn't due
    // yet either. This is what actually proves the lease works - claiming at now=0 (the previous
    // version of this test) would pass even with no leasing at all, since nothing is due at time 0.
    const reclaim = claimDue(db, 3000, 10);
    expect(reclaim).toHaveLength(0);

    // c becomes claimable once its own due time genuinely arrives.
    const later = claimDue(db, 5000, 10);
    expect(later.map((r) => r.dedupe_key)).toEqual(['c']);
  });
});

describe('failure / retry / dead-letter', () => {
  it('78. three consecutive retryable failures -> failed with last_error and exactly one dead letter', () => {
    const ctx = setupDb();
    const db = ctx.db;
    enqueueOne(ctx);
    let id = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      const claimed = claimDue(db, attempt * 100_000, 10);
      expect(claimed).toHaveLength(1);
      id = claimed[0]!.id;
      if (attempt < 4) {
        markRetry(db, id, `boom ${attempt}`, attempt * 100_000 + 1);
      } else {
        markFailed(db, id, 'boom 4', attempt * 100_000 + 1);
      }
    }
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as { status: string; last_error: string };
    expect(row.status).toBe('failed');
    expect(row.last_error).toBe('boom 4');
    const deadLetters = db.prepare('SELECT COUNT(*) AS n FROM notification_dead_letters WHERE notification_id = ?').get(id) as {
      n: number;
    };
    expect(deadLetters.n).toBe(1);
  });

  it('79. failure then success -> sent with sent_at set, no dead letter', () => {
    const ctx = setupDb();
    const db = ctx.db;
    enqueueOne(ctx);
    const claimed1 = claimDue(db, 1000, 10);
    const id = claimed1[0]!.id;
    markRetry(db, id, 'transient', 2000);
    const claimed2 = claimDue(db, 2000, 10);
    expect(claimed2).toHaveLength(1);
    markSent(db, id, 2500);
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as { status: string; sent_at: number };
    expect(row.status).toBe('sent');
    expect(row.sent_at).toBe(2500);
    const deadLetters = db.prepare('SELECT COUNT(*) AS n FROM notification_dead_letters WHERE notification_id = ?').get(id) as {
      n: number;
    };
    expect(deadLetters.n).toBe(0);
  });

  it('80. a non-retryable failure fails on the first attempt without consuming the retry budget', () => {
    const ctx = setupDb();
    const db = ctx.db;
    enqueueOne(ctx);
    const claimed = claimDue(db, 1000, 10);
    const id = claimed[0]!.id;
    expect(claimed[0]!.attempts).toBe(1);
    markFailed(db, id, 'HTTP 400: bad request', 1500);
    const row = db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as { status: string; attempts: number };
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
  });
});

describe('listNotifications / getNotification / listFailedIds / requeue / purgeNotifications', () => {
  it('listNotifications filters by status and since, getNotification returns null for an unknown id', () => {
    const ctx = setupDb();
    enqueueOne(ctx, { dedupeKey: 'a', atMs: 1000 });
    enqueueOne(ctx, { dedupeKey: 'b', atMs: 5000 });
    const claimed = claimDue(ctx.db, 1000, 10);
    markSent(ctx.db, claimed[0]!.id, 1500);

    expect(listNotifications(ctx.db, { status: 'sent' })).toHaveLength(1);
    expect(listNotifications(ctx.db, { since: 4000 })).toHaveLength(1);
    expect(listNotifications(ctx.db)).toHaveLength(2);
    expect(getNotification(ctx.db, claimed[0]!.id)?.status).toBe('sent');
    expect(getNotification(ctx.db, 'no-such-id')).toBeNull();
  });

  it('listFailedIds returns only failed rows; requeue on a non-failed id is a no-op', () => {
    const ctx = setupDb();
    enqueueOne(ctx, { dedupeKey: 'a', atMs: 1000 });
    enqueueOne(ctx, { dedupeKey: 'b', atMs: 1000 });
    const claimed = claimDue(ctx.db, 1000, 10);
    markFailed(ctx.db, claimed[0]!.id, 'boom', 1500);

    expect(listFailedIds(ctx.db)).toEqual([claimed[0]!.id]);
    expect(requeue(ctx.db, claimed[1]!.id, 2000)).toBe(false); // still pending, not failed
    expect(requeue(ctx.db, claimed[0]!.id, 2000)).toBe(true);
    expect(requeue(ctx.db, 'no-such-id', 2000)).toBe(false);
    const row = ctx.db.prepare('SELECT status, last_error FROM notifications WHERE id = ?').get(claimed[0]!.id) as {
      status: string;
      last_error: string | null;
    };
    expect(row.status).toBe('pending');
    expect(row.last_error).toBeNull();
  });

  it('purgeNotifications deletes old sent rows and old dead letters, reporting counts', () => {
    const ctx = setupDb();
    enqueueOne(ctx, { dedupeKey: 'a', atMs: 1000 });
    enqueueOne(ctx, { dedupeKey: 'b', atMs: 1000 });
    const claimed = claimDue(ctx.db, 1000, 10);
    markSent(ctx.db, claimed[0]!.id, 1000); // old sent
    markFailed(ctx.db, claimed[1]!.id, 'boom', 1000); // old dead letter

    const result = purgeNotifications(ctx.db, { sentOlderThanMs: 2000, deadLettersOlderThanMs: 2000 });
    expect(result).toEqual({ sent: 1, deadLetters: 1 });
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n).toBe(1); // failed row stays
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM notification_dead_letters').get() as { n: number }).n).toBe(0);
  });
});
