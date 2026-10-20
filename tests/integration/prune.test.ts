import { describe, expect, it } from 'vitest';
import { openDb, migrate } from '../../src/db/index.js';
import { addRecipient, createMessage, ensureAccount, pruneEvents } from '../../src/db/repo.js';
import { disableSubscription, pruneDisabledSubscriptions, upsertSubscription } from '../../src/db/push.js';

describe('prune', () => {
  it('48. deletes events older than the window, keeps newer ones, leaves recipient counters unchanged', () => {
    const db = openDb(':memory:');
    migrate(db);

    const account = ensureAccount(db, { email: 'a@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 's',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
      status: 'draft',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    const recipient = addRecipient(db, {
      messageId: message.id,
      email: 'r@example.com',
      token: 'tok1234567890123456789012',
    });
    db.prepare('UPDATE recipients SET open_count = 3 WHERE id = ?').run(recipient.id);

    const now = 1_700_000_000_000;
    const old = now - 400 * 24 * 60 * 60 * 1000;
    const recent = now - 1 * 24 * 60 * 60 * 1000;

    const insertEvent = db.prepare(
      `INSERT INTO open_events (id, recipient_id, occurred_at, classification, confidence, counted, created_at)
       VALUES (?, ?, ?, 'human', 1.0, 1, 0)`,
    );
    insertEvent.run('old1', recipient.id, old);
    insertEvent.run('recent1', recipient.id, recent);

    const olderThan = now - 365 * 24 * 60 * 60 * 1000;

    const dryRun = pruneEvents(db, olderThan, true);
    expect(dryRun.opens).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM open_events').get()).toEqual({ n: 2 });

    const real = pruneEvents(db, olderThan, false);
    expect(real.opens).toBe(1);
    const remaining = db.prepare('SELECT id FROM open_events').all() as { id: string }[];
    expect(remaining.map((r) => r.id)).toEqual(['recent1']);

    const updatedRecipient = db.prepare('SELECT open_count FROM recipients WHERE id = ?').get(recipient.id) as {
      open_count: number;
    };
    expect(updatedRecipient.open_count).toBe(3);

    db.close();
  });

  it('435. openpost prune deletes push_subscriptions disabled beyond RETENTION_DAYS, keeps active and recently-disabled ones', () => {
    const db = openDb(':memory:');
    migrate(db);

    const now = 1_700_000_000_000;
    const longAgo = now - 400 * 24 * 60 * 60 * 1000;
    const recently = now - 1 * 24 * 60 * 60 * 1000;
    const olderThan = now - 365 * 24 * 60 * 60 * 1000;

    const active = upsertSubscription(db, { endpoint: 'https://push.example.com/active', p256dh: 'p', auth: 'a', label: null, uaFamily: null, deviceType: null, createdAt: longAgo });
    const disabledLongAgo = upsertSubscription(db, { endpoint: 'https://push.example.com/gone-long-ago', p256dh: 'p', auth: 'a', label: null, uaFamily: null, deviceType: null, createdAt: longAgo });
    const disabledRecently = upsertSubscription(db, { endpoint: 'https://push.example.com/gone-recently', p256dh: 'p', auth: 'a', label: null, uaFamily: null, deviceType: null, createdAt: longAgo });
    disableSubscription(db, disabledLongAgo.id, 'gone_410', longAgo);
    disableSubscription(db, disabledRecently.id, 'gone_410', recently);

    const dryRunCount = (
      db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NOT NULL AND disabled_at < ?').get(olderThan) as { n: number }
    ).n;
    expect(dryRunCount).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n).toBe(3);

    const deleted = pruneDisabledSubscriptions(db, olderThan);
    expect(deleted).toBe(1);

    const remainingIds = (db.prepare('SELECT id FROM push_subscriptions ORDER BY id').all() as { id: string }[]).map((r) => r.id).sort();
    expect(remainingIds.sort()).toEqual([active.id, disabledRecently.id].sort());

    db.close();
  });
});
