import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { addRecipient, createMessage, ensureAccount, getRecipient, markMessageSent, markRecipientSent } from '../../src/db/repo.js';
import { createReminder, getReminder } from '../../src/db/reminders.js';
import { runReplyPollOnce } from '../../src/jobs/replies.js';
import { EventBus } from '../../src/notify/bus.js';
import { NotifyWorker } from '../../src/notify/worker.js';
import type { ThreadMessageMeta, ThreadReader } from '../../src/mail/threads.js';
import { newId } from '../../src/core/ids.js';
import { makeConfig } from '../helpers/setup.js';

const SENT_AT = 1_700_000_000_000;

function seed(db: ReturnType<typeof openDb>) {
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(db, { accountId: account.id, subject: 'hi', bodyHtml: null, bodyText: null, status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });
  markMessageSent(db, message.id, { rfc822MsgId: '<orig@example.com>', sentAt: SENT_AT });
  const recipient = addRecipient(db, { messageId: message.id, email: 'alice@example.com', token: newId() });
  markRecipientSent(db, recipient.id, {
    rfc822MsgId: '<orig@example.com>',
    sentAt: SENT_AT,
    threadId: 'thread-1',
    providerMsgId: 'own-msg-1',
  });
  return { message, recipient };
}

function fakeReader(messages: ThreadMessageMeta[]): ThreadReader {
  return {
    kind: 'gmail',
    unitCost: 10,
    async fetchThread() {
      return messages;
    },
  };
}

const replyMessage: ThreadMessageMeta = {
  id: 'reply-1',
  threadId: 'thread-1',
  internalDate: SENT_AT + 3_600_000,
  from: 'alice@example.com',
  to: 'sender@example.com',
  messageIdHeader: '<reply-1@example.com>',
  inReplyTo: '<orig@example.com>',
  references: '<orig@example.com>',
  labelIds: [],
  isSelfCopy: false,
  autoSubmitted: null,
  precedence: null,
  xAutoreply: null,
  xAutorespond: null,
  returnPath: null,
};

describe('reply detection job', () => {
  it('178. one poll with a fake ThreadReader sets replied_at/reply_msg_id, state replied, one address-free reply.detected audit row (DoD 4a)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { recipient } = seed(db);
    const config = makeConfig();
    const bus = new EventBus();
    const reader = fakeReader([replyMessage]);

    const result = await runReplyPollOnce({ db, config, bus, reader }, SENT_AT + 3_700_000);
    expect(result.replied).toBe(1);

    const updated = getRecipient(db, recipient.id);
    expect(updated?.replied_at).toBe(SENT_AT + 3_600_000);
    expect(updated?.reply_msg_id).toBe('reply-1');
    expect(updated?.state).toBe('replied');

    const auditRow = db.prepare(`SELECT detail_json FROM audit_log WHERE action = 'reply.detected'`).get() as { detail_json: string };
    expect(auditRow).toBeTruthy();
    expect(auditRow.detail_json).not.toContain('alice@example.com');
    expect(auditRow.detail_json).not.toContain('@'); // no address, no snippet
    db.close();
  });

  it('179. the same poll cancels the recipient\'s pending no_reply reminder with cancel_reason=replied (DoD 4b)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const reminder = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: SENT_AT + 86_400_000, createdAt: SENT_AT });
    const noOpenReminder = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_open', dueAt: SENT_AT + 86_400_000, createdAt: SENT_AT });

    const config = makeConfig();
    const bus = new EventBus();
    await runReplyPollOnce({ db, config, bus, reader: fakeReader([replyMessage]) }, SENT_AT + 3_700_000);

    expect(getReminder(db, reminder.id)?.status).toBe('cancelled');
    expect(getReminder(db, reminder.id)?.cancel_reason).toBe('replied');
    expect(getReminder(db, noOpenReminder.id)?.status).toBe('pending');
    db.close();
  });

  it('180. the reply publishes a reply TrackingEvent (SSE) and exactly one reply notification; a second poll of the same thread enqueues nothing', async () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db);
    const config = makeConfig({ notifyChannels: ['slack'], slackWebhookUrl: 'http://127.0.0.1:1/webhook' });
    const bus = new EventBus();
    const notifyWorker = new NotifyWorker({ db, config, bus });
    let sseFrames = 0;
    bus.subscribe((e) => {
      if (e.kind === 'reply') sseFrames += 1;
    });

    await runReplyPollOnce(
      { db, config, bus, reader: fakeReader([replyMessage]), notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e) },
      SENT_AT + 3_700_000,
    );
    expect(sseFrames).toBe(1);
    const notifications = db.prepare(`SELECT * FROM notifications WHERE trigger = 'reply'`).all();
    expect(notifications).toHaveLength(1);

    // A second poll: replied_at is already set, so the candidate query no longer selects this
    // recipient at all - nothing new is enqueued.
    await runReplyPollOnce(
      { db, config, bus, reader: fakeReader([replyMessage]), notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e) },
      SENT_AT + 4_000_000,
    );
    const notificationsAfter = db.prepare(`SELECT * FROM notifications WHERE trigger = 'reply'`).all();
    expect(notificationsAfter).toHaveLength(1);
    db.close();
  });

  it('181. a later counted open on a replied recipient does not reset the state (deriveRecipientState regression)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { recipient } = seed(db);
    const config = makeConfig();
    const bus = new EventBus();
    await runReplyPollOnce({ db, config, bus, reader: fakeReader([replyMessage]) }, SENT_AT + 3_700_000);
    expect(getRecipient(db, recipient.id)?.state).toBe('replied');

    const { insertOpenEvent, recomputeRecipientCounters } = await import('../../src/db/repo.js');
    insertOpenEvent(db, {
      recipientId: recipient.id,
      occurredAt: SENT_AT + 5_000_000,
      classification: 'human',
      confidence: 0.9,
      counted: true,
      reason: 'R9',
      ipHash: null,
      ipNetHash: null,
      ua: null,
      uaFamily: null,
      deviceType: null,
      os: null,
    });
    const counters = recomputeRecipientCounters(db, recipient.id);
    expect(counters.state).toBe('replied');
    db.close();
  });

  it('H2f. an autoresponder/bounce in the thread is never recorded as a reply, and the no_reply reminder survives', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const reminder = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: SENT_AT + 86_400_000, createdAt: SENT_AT });
    const bounce: ThreadMessageMeta = {
      ...replyMessage,
      id: 'bounce-1',
      from: 'Mail Delivery Subsystem <mailer-daemon@example.com>',
    };
    const config = makeConfig();
    const bus = new EventBus();
    const result = await runReplyPollOnce({ db, config, bus, reader: fakeReader([bounce]) }, SENT_AT + 3_700_000);
    expect(result.replied).toBe(0);
    expect(getRecipient(db, recipient.id)?.state).not.toBe('replied');
    expect(getRecipient(db, recipient.id)?.replied_at).toBeNull();
    expect(getReminder(db, reminder.id)?.status).toBe('pending');
    db.close();
  });

  it('H3. one candidate\'s non-rate-limit fetchThread failure advances its checkpoint and does not wedge the rest of the tick', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'hi',
      bodyHtml: null,
      bodyText: null,
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    markMessageSent(db, message.id, { rfc822MsgId: '<orig@example.com>', sentAt: SENT_AT });
    const bad = addRecipient(db, { messageId: message.id, email: 'bad@example.com', token: newId() });
    markRecipientSent(db, bad.id, { rfc822MsgId: '<bad@example.com>', sentAt: SENT_AT, threadId: 'thread-bad', providerMsgId: 'own-bad' });
    const good = addRecipient(db, { messageId: message.id, email: 'good@example.com', token: newId() });
    markRecipientSent(db, good.id, { rfc822MsgId: '<good@example.com>', sentAt: SENT_AT, threadId: 'thread-good', providerMsgId: 'own-good' });

    // Older sent_at first -> `bad` (the recipient created first, further back) is selected before
    // `good` by listReplyCandidates' `ORDER BY sent_at DESC`... both share sent_at here, so force
    // the ordering explicitly instead of relying on insertion order.
    db.prepare('UPDATE recipients SET sent_at = ? WHERE id = ?').run(SENT_AT + 1, bad.id);
    db.prepare('UPDATE recipients SET sent_at = ? WHERE id = ?').run(SENT_AT, good.id);

    const flakyReader: ThreadReader = {
      kind: 'gmail',
      unitCost: 10,
      async fetchThread(ref) {
        if (ref.threadId === 'thread-bad') throw new Error('boom: transient network error');
        return [];
      },
    };
    const config = makeConfig();
    const bus = new EventBus();
    const result = await runReplyPollOnce({ db, config, bus, reader: flakyReader }, SENT_AT + 3_700_000);
    expect(result.errors).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.backoffActive).toBe(false);
    // The failing candidate's checkpoint still advanced - it is not re-selected first on the very
    // next tick over and over, permanently starving every other recipient.
    expect(getRecipient(db, bad.id)?.reply_checked_at).toBe(SENT_AT + 3_700_000);
    db.close();
  });

  it('182. candidate selection honours the tiered interval and REPLY_WATCH_DAYS, and never exceeds REPLY_POLL_BATCH', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { recipient } = seed(db);
    // checked 1 minute ago at age 3h -> should be skipped (tier is 15 min at that age)
    db.prepare('UPDATE recipients SET reply_checked_at = ? WHERE id = ?').run(SENT_AT + 3 * 3600_000 - 60_000, recipient.id);
    const config = makeConfig({ replyPollBatch: 25, replyWatchDays: 14 });
    const bus = new EventBus();
    const noopReader = fakeReader([]);
    const atAge3h = SENT_AT + 3 * 3600_000;
    const result1 = await runReplyPollOnce({ db, config, bus, reader: noopReader }, atAge3h);
    expect(result1.checked).toBe(0);

    // checked 6 minutes ago at age 30 min -> tier is 300s (5 min) at that age, so 6 min is stale enough to poll again
    db.prepare('UPDATE recipients SET reply_checked_at = ? WHERE id = ?').run(SENT_AT + 30 * 60_000 - 6 * 60_000, recipient.id);
    const atAge30m = SENT_AT + 30 * 60_000;
    const result2 = await runReplyPollOnce({ db, config, bus, reader: noopReader }, atAge30m);
    expect(result2.checked).toBe(1);

    // Beyond REPLY_WATCH_DAYS the recipient is never selected again.
    const farFuture = SENT_AT + 20 * 86_400_000;
    const result3 = await runReplyPollOnce({ db, config, bus, reader: noopReader }, farFuture);
    expect(result3.checked).toBe(0);
    db.close();
  });

  it('182b. M9: REPLY_POLL_BATCH actually bounds how many eligible candidates one poll checks', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'hi',
      bodyHtml: null,
      bodyText: null,
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    markMessageSent(db, message.id, { rfc822MsgId: '<orig@example.com>', sentAt: SENT_AT });
    // 5 eligible (never-checked) recipients, but REPLY_POLL_BATCH caps the poll at 3.
    for (let i = 0; i < 5; i++) {
      const recipient = addRecipient(db, { messageId: message.id, email: `r${i}@example.com`, token: newId() });
      markRecipientSent(db, recipient.id, {
        rfc822MsgId: `<orig${i}@example.com>`,
        sentAt: SENT_AT,
        threadId: `thread-${i}`,
        providerMsgId: `own-msg-${i}`,
      });
    }
    const config = makeConfig({ replyPollBatch: 3 });
    const bus = new EventBus();
    const result = await runReplyPollOnce({ db, config, bus, reader: fakeReader([]) }, SENT_AT + 3_700_000);
    expect(result.checked).toBe(3);
    db.close();
  });

  it('183. a rate-limit error sets a backoff that stops the tick and doubles on the next failure, resetting after a clean tick', async () => {
    const db = openDb(':memory:');
    migrate(db);
    seed(db);
    const config = makeConfig();
    const bus = new EventBus();
    let calls = 0;
    const rateLimitedReader: ThreadReader = {
      kind: 'gmail',
      unitCost: 10,
      async fetchThread() {
        calls += 1;
        const err = new Error('rateLimitExceeded') as Error & { code: number };
        err.code = 429;
        throw err;
      },
    };
    const result1 = await runReplyPollOnce({ db, config, bus, reader: rateLimitedReader }, SENT_AT + 3_700_000);
    expect(result1.backoffActive).toBe(true);
    expect(calls).toBe(1);
    const backoffRow = db.prepare(`SELECT value FROM settings WHERE key = 'reply_poll_backoff_until'`).get() as { value: string };
    expect(Number(backoffRow.value)).toBeGreaterThan(SENT_AT + 3_700_000);

    // Still within the backoff window - the tick is skipped entirely (no fetch attempted).
    const result2 = await runReplyPollOnce({ db, config, bus, reader: rateLimitedReader }, SENT_AT + 3_700_100);
    expect(result2.backoffActive).toBe(true);
    expect(calls).toBe(1);

    // M9 (183): the backoff MS itself (not just the jittered "until") doubles on a second failure.
    const backoffMsRow1 = db.prepare(`SELECT value FROM settings WHERE key = 'reply_poll_backoff_ms'`).get() as { value: string };
    expect(Number(backoffMsRow1.value)).toBe(60_000);

    const pastFirstBackoff = Number(backoffRow.value) + 1000;
    const result3 = await runReplyPollOnce({ db, config, bus, reader: rateLimitedReader }, pastFirstBackoff);
    expect(result3.backoffActive).toBe(true);
    expect(calls).toBe(2);
    const backoffMsRow2 = db.prepare(`SELECT value FROM settings WHERE key = 'reply_poll_backoff_ms'`).get() as { value: string };
    expect(Number(backoffMsRow2.value)).toBe(120_000);
    const backoffRow2 = db.prepare(`SELECT value FROM settings WHERE key = 'reply_poll_backoff_until'`).get() as { value: string };
    expect(Number(backoffRow2.value)).toBeGreaterThan(pastFirstBackoff);

    // M9 (183): once past the (now-doubled) backoff window, a CLEAN tick resets it to zero.
    const pastSecondBackoff = Number(backoffRow2.value) + 1000;
    const result4 = await runReplyPollOnce({ db, config, bus, reader: fakeReader([]) }, pastSecondBackoff);
    expect(result4.backoffActive).toBe(false);
    const backoffMsRow3 = db.prepare(`SELECT value FROM settings WHERE key = 'reply_poll_backoff_ms'`).get() as { value: string };
    expect(Number(backoffMsRow3.value)).toBe(0);
    const backoffUntilRow3 = db.prepare(`SELECT value FROM settings WHERE key = 'reply_poll_backoff_until'`).get() as { value: string };
    expect(Number(backoffUntilRow3.value)).toBe(0);

    db.close();
  });
});
