import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';

const MIGRATIONS_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'db', 'migrations');

function seedV1Db() {
  const v1Only = mkdtempSync(join(tmpdir(), 'openpost-v1-'));
  writeFileSync(join(v1Only, '001_init.sql'), readFileSync(join(MIGRATIONS_DIR, '001_init.sql'), 'utf8'));
  const db = openDb(':memory:');
  migrate(db, { dir: v1Only });
  rmSync(v1Only, { recursive: true, force: true });
  expect(db.pragma('user_version', { simple: true })).toBe(1);

  db.prepare(
    `INSERT INTO accounts (id, email, display_name, transport, created_at) VALUES ('acc1','s@example.com',NULL,'dryrun',0)`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, account_id, subject, status, tracking_enabled, click_tracking_enabled, sent_at, created_at)
     VALUES ('msg1','acc1','hello','sent',1,0,1000,0)`,
  ).run();

  // Four recipients, one per deriveRecipientState shape.
  const insertRecipient = db.prepare(
    `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, first_open_at, last_open_at, click_count, created_at)
     VALUES (@id,'msg1',@email,'to',@token,@open_count,@machine_open_count,@first_open_at,@last_open_at,@click_count,0)`,
  );
  insertRecipient.run({ id: 'r_not_opened', email: 'a@example.com', token: 'a'.repeat(26), open_count: 0, machine_open_count: 0, first_open_at: null, last_open_at: null, click_count: 0 });
  insertRecipient.run({ id: 'r_prefetched', email: 'b@example.com', token: 'b'.repeat(26), open_count: 0, machine_open_count: 2, first_open_at: null, last_open_at: null, click_count: 0 });
  insertRecipient.run({ id: 'r_opened', email: 'c@example.com', token: 'c'.repeat(26), open_count: 1, machine_open_count: 0, first_open_at: 1000, last_open_at: 1000, click_count: 0 });
  insertRecipient.run({ id: 'r_read_confirmed', email: 'd@example.com', token: 'd'.repeat(26), open_count: 2, machine_open_count: 0, first_open_at: 1000, last_open_at: 1000 + 61_000, click_count: 0 });
  // read_confirmed via a click, with only one open.
  insertRecipient.run({ id: 'r_read_confirmed_click', email: 'e@example.com', token: 'e'.repeat(26), open_count: 1, machine_open_count: 0, first_open_at: 1000, last_open_at: 1000, click_count: 1 });

  return db;
}

describe('migrate v1 -> current (120a)', () => {
  it('upgrades a populated v1 DB with zero row loss, defaults new columns, back-fills recipients.state for every shape, empties notifications; running again is a no-op', () => {
    const db = seedV1Db();

    const before = {
      accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      recipients: (db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number }).n,
    };

    const version = migrate(db);
    expect(version).toBeGreaterThanOrEqual(3);

    const after = {
      accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      recipients: (db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number }).n,
    };
    expect(after).toEqual(before);

    const states = db.prepare('SELECT id, state, cache_buster, notify_muted FROM recipients ORDER BY id').all() as Array<{
      id: string;
      state: string;
      cache_buster: string | null;
      notify_muted: number;
    }>;
    const byId = Object.fromEntries(states.map((r) => [r.id, r]));
    expect(byId.r_not_opened?.state).toBe('not_opened');
    expect(byId.r_prefetched?.state).toBe('prefetched');
    expect(byId.r_opened?.state).toBe('opened');
    expect(byId.r_read_confirmed?.state).toBe('read_confirmed');
    expect(byId.r_read_confirmed_click?.state).toBe('read_confirmed');
    // New nullable columns default sanely.
    for (const r of states) {
      expect(r.cache_buster).toBeNull();
      expect(r.notify_muted).toBe(0);
    }

    const notificationCount = (db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number }).n;
    expect(notificationCount).toBe(0);

    const second = migrate(db);
    expect(second).toBe(version);
    db.close();
  });
});
