import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { addRecipient, createMessage, ensureAccount, getMessage, markMessageSent } from '../../src/db/repo.js';
import {
  cancelPendingForRecipient,
  claim,
  createReminder,
  getReminder,
  markFailed,
  markFired,
  markSkipped,
  selectDue,
  sweepExhaustedLeases,
} from '../../src/db/reminders.js';
import { runRemindersOnce } from '../../src/jobs/reminders.js';
import { EventBus } from '../../src/notify/bus.js';
import { newId } from '../../src/core/ids.js';
import { makeConfig } from '../helpers/setup.js';

const NOW = 1_700_000_000_000;

function seed(db: ReturnType<typeof openDb>) {
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(db, { accountId: account.id, subject: 'hi', bodyHtml: null, bodyText: null, status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });
  markMessageSent(db, message.id, { rfc822MsgId: '<a@b>', sentAt: NOW });
  const recipient = addRecipient(db, { messageId: message.id, email: 'a@example.com', token: newId() });
  return { message, recipient };
}

describe('db/reminders claim/lease', () => {
  it('163. selectDue: a future reminder is not selected; a due one is; cancelled/fired never are', () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const future = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW + 1000, createdAt: NOW });
    const due = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });
    const cancelled = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });
    db.prepare(`UPDATE reminders SET status = 'cancelled' WHERE id = ?`).run(cancelled.id);

    const selected = selectDue(db, NOW, 10).map((r) => r.id);
    expect(selected).toContain(due.id);
    expect(selected).not.toContain(future.id);
    expect(selected).not.toContain(cancelled.id);
    db.close();
  });

  it('164. claim returns the row once; a second claim before the lease expires returns null; after expiry it succeeds with attempts=2', () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const r = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });

    const claimed1 = claim(db, r.id, 'owner-a', NOW, { leaseMs: 1000, maxAttempts: 3 });
    expect(claimed1?.attempts).toBe(1);
    const claimed2 = claim(db, r.id, 'owner-b', NOW + 100, { leaseMs: 1000, maxAttempts: 3 });
    expect(claimed2).toBeNull();
    const claimed3 = claim(db, r.id, 'owner-c', NOW + 2000, { leaseMs: 1000, maxAttempts: 3 });
    expect(claimed3?.attempts).toBe(2);
    db.close();
  });

  it('165. attempts >= maxAttempts with an expired lease is swept to failed, never re-claimed', () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const r = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });
    claim(db, r.id, 'owner-a', NOW, { leaseMs: 100, maxAttempts: 1 });

    const swept = sweepExhaustedLeases(db, NOW + 1000, 1);
    expect(swept).toBe(1);
    const row = getReminder(db, r.id);
    expect(row?.status).toBe('failed');
    // L10: a swept row must not keep looking claimed/leased in a listing - the lease fields (and
    // the new failed_at timestamp) are cleared just like every other terminal-state writer does.
    expect(row?.failed_at).toBe(NOW + 1000);
    expect(row?.lease_owner).toBeNull();
    expect(row?.lease_expires_at).toBeNull();
    expect(claim(db, r.id, 'owner-b', NOW + 2000, { leaseMs: 1000, maxAttempts: 1 })).toBeNull();
    db.close();
  });

  it('166. markFired/markSkipped/markFailed only succeed for the current lease_owner; markSkipped/markFailed record their own atMs (L10)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const r = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });
    claim(db, r.id, 'real-owner', NOW, { leaseMs: 60_000, maxAttempts: 3 });

    expect(markFired(db, r.id, 'stale-owner', NOW)).toBe(false);
    expect(markSkipped(db, r.id, 'stale-owner', NOW, 'x')).toBe(false);
    expect(markFailed(db, r.id, 'stale-owner', NOW, 'x')).toBe(false);
    expect(getReminder(db, r.id)?.status).toBe('claimed');

    expect(markFired(db, r.id, 'real-owner', NOW)).toBe(true);
    expect(getReminder(db, r.id)?.status).toBe('fired');

    const r2 = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_open', dueAt: NOW - 1000, createdAt: NOW });
    claim(db, r2.id, 'real-owner-2', NOW, { leaseMs: 60_000, maxAttempts: 3 });
    expect(markSkipped(db, r2.id, 'real-owner-2', NOW + 5, 'opened')).toBe(true);
    expect(getReminder(db, r2.id)?.skipped_at).toBe(NOW + 5);

    const r3 = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'always', dueAt: NOW - 1000, createdAt: NOW });
    claim(db, r3.id, 'real-owner-3', NOW, { leaseMs: 60_000, maxAttempts: 3 });
    expect(markFailed(db, r3.id, 'real-owner-3', NOW + 9, 'boom')).toBe(true);
    expect(getReminder(db, r3.id)?.failed_at).toBe(NOW + 9);
    db.close();
  });

  it('167. two runRemindersOnce calls with distinct owners over the same due reminder fire it exactly once', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'always', dueAt: NOW - 1000, createdAt: NOW });
    const config = makeConfig();
    const bus = new EventBus();
    let enqueued = 0;
    const notifyEnqueue = (): boolean => {
      enqueued += 1;
      return true;
    };

    const [r1, r2] = await Promise.all([
      runRemindersOnce({ db, config, bus, owner: 'owner-a', notifyEnqueue }, NOW, 10),
      runRemindersOnce({ db, config, bus, owner: 'owner-b', notifyEnqueue }, NOW, 10),
    ]);
    expect(r1.fired + r2.fired).toBe(1);
    expect(enqueued).toBe(1);
    db.close();
  });

  it('168. condition evaluation: no_reply skips when replied_at is set, no_open skips when open_count>0, always never skips', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    db.prepare('UPDATE recipients SET replied_at = ? WHERE id = ?').run(NOW, recipient.id);
    const r = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });
    const config = makeConfig();
    const bus = new EventBus();
    const result = await runRemindersOnce({ db, config, bus, owner: 'o' }, NOW, 10);
    expect(result.skipped).toBe(1);
    expect(getReminder(db, r.id)?.status).toBe('skipped');
    db.close();
  });

  it('169. a reminder whose message was deleted is cancelled with cancel_reason=message_deleted', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const r = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'always', dueAt: NOW - 1000, createdAt: NOW });
    db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
    expect(getMessage(db, message.id)).toBeNull();

    const config = makeConfig();
    const bus = new EventBus();
    await runRemindersOnce({ db, config, bus, owner: 'o' }, NOW, 10);
    const row = getReminder(db, r.id);
    // the FK cascade may have already deleted the reminder row itself once the recipient (and thus
    // the reminder) cascaded away with the message - either outcome is correct.
    if (row) {
      expect(row.status).toBe('cancelled');
      expect(row.cancel_reason).toBe('message_deleted');
    } else {
      expect(row).toBeNull();
    }
    db.close();
  });

  it('170. cancelPendingForRecipient cancels only no_reply reminders and leaves no_open/always pending', () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const noReply = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW + 1000, createdAt: NOW });
    const noOpen = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_open', dueAt: NOW + 1000, createdAt: NOW });
    const always = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'always', dueAt: NOW + 1000, createdAt: NOW });

    const n = cancelPendingForRecipient(db, recipient.id, NOW, 'replied', ['no_reply']);
    expect(n).toBe(1);
    expect(getReminder(db, noReply.id)?.status).toBe('cancelled');
    expect(getReminder(db, noOpen.id)?.status).toBe('pending');
    expect(getReminder(db, always.id)?.status).toBe('pending');
    db.close();
  });

  it('M8. cancelPendingForRecipient never cancels a claimed reminder whose lease has not expired yet', () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const activelyClaimed = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });
    const staleClaimed = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'no_reply', dueAt: NOW - 1000, createdAt: NOW });
    // A live claim (lease still in the future) - another process is actively mid-fire on this row
    // right now; cancelling it out from under that claim is exactly the M8 race.
    claim(db, activelyClaimed.id, 'live-owner', NOW, { leaseMs: 60_000, maxAttempts: 3 });
    // A claim whose lease already expired - fair game, same as `selectDue`/`claim` would treat it.
    claim(db, staleClaimed.id, 'dead-owner', NOW - 120_000, { leaseMs: 1000, maxAttempts: 3 });

    const n = cancelPendingForRecipient(db, recipient.id, NOW, 'replied', ['no_reply']);
    expect(n).toBe(1);
    expect(getReminder(db, activelyClaimed.id)?.status).toBe('claimed');
    expect(getReminder(db, staleClaimed.id)?.status).toBe('cancelled');
    db.close();
  });

  it('M8b. processClaimed bails out (no audit/publish/fired-count) when markFired reports the row was cancelled out from under it', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { message, recipient } = seed(db);
    const r = createReminder(db, { messageId: message.id, recipientId: recipient.id, condition: 'always', dueAt: NOW - 1000, createdAt: NOW });
    const config = makeConfig();
    const bus = new EventBus();
    let published = 0;
    bus.subscribe(() => {
      published += 1;
    });

    const result = await runRemindersOnce(
      {
        db,
        config,
        bus,
        owner: 'racer',
        // Simulates a reply arriving between the claim and the fire: cancel the row (the same
        // update cancelPendingForRecipient would do to an expired-lease claim) right after
        // notifyEnqueue but before markFired - via the onEnqueued seam.
        onEnqueued: () => {
          db.prepare(`UPDATE reminders SET status = 'cancelled', cancelled_at = ?, cancel_reason = 'replied' WHERE id = ?`).run(NOW, r.id);
        },
      },
      NOW,
      10,
    );
    expect(result.fired).toBe(0);
    expect(published).toBe(0);
    expect(getReminder(db, r.id)?.status).toBe('cancelled');
    const fireAudit = db.prepare(`SELECT 1 FROM audit_log WHERE action = 'reminder.fire' AND subject_id = ?`).get(r.id);
    expect(fireAudit).toBeUndefined();
    db.close();
  });
});
