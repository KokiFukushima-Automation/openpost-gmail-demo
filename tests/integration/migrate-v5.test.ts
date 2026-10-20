import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_SCHEMA, migrate, openDb } from '../../src/db/index.js';
import { setupTestServer } from '../helpers/setup.js';

const MIGRATIONS_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'db', 'migrations');

function seedPopulatedV4Db() {
  const upTo004 = mkdtempSync(join(tmpdir(), 'openpost-v4-'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f <= '004_notify_sending_state.sql')) {
    writeFileSync(join(upTo004, file), readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  const db = openDb(':memory:');
  migrate(db, { dir: upTo004 });
  rmSync(upTo004, { recursive: true, force: true });
  expect(db.pragma('user_version', { simple: true })).toBe(4);

  db.prepare(`INSERT INTO accounts (id, email, display_name, transport, created_at) VALUES ('acc1','s@example.com',NULL,'dryrun',0)`).run();
  db.prepare(
    `INSERT INTO messages (id, account_id, subject, status, tracking_enabled, click_tracking_enabled, sent_at, created_at)
     VALUES ('msg1','acc1','hello','sent',1,0,1000,0)`,
  ).run();
  db.prepare(
    `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, first_open_at, last_open_at,
       click_count, created_at, state, replied_at)
     VALUES ('r_normal','msg1','a@example.com','to','${'a'.repeat(26)}',1,0,1000,1000,0,0,'opened',NULL)`,
  ).run();
  // A hand-edited row: replied_at set but state never updated to match (the exact scenario the
  // migration's back-fill exists for).
  db.prepare(
    `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, first_open_at, last_open_at,
       click_count, created_at, state, replied_at)
     VALUES ('r_replied','msg1','b@example.com','to','${'b'.repeat(26)}',1,0,1000,1000,0,0,'opened',5000)`,
  ).run();
  db.prepare(`INSERT INTO reminders (id, message_id, recipient_id, condition, due_at, state, created_at) VALUES ('rem_stub','msg1','r_normal','no_reply',9999,'pending',0)`).run();

  return db;
}

describe('migrate v4 -> v6 (Phase 3 + recipient semantics)', () => {
  it('184. upgrades a populated v4 DB to the latest schema with zero row loss; reminders rebuilt empty; new recipient columns defaulted; state="replied" back-filled; a second run is a no-op; /healthz reports the current schema', async () => {
    const db = seedPopulatedV4Db();
    const before = {
      accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      recipients: (db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number }).n,
    };

    const version = migrate(db);
    expect(version).toBe(EXPECTED_SCHEMA);

    const after = {
      accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      recipients: (db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number }).n,
    };
    expect(after).toEqual(before);

    // The 001-era `reminders` stub is dropped and rebuilt - the old stub row (state-based, no
    // `status` column) cannot survive a `DROP TABLE`, so the rebuilt table is empty.
    const reminderCount = (db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as { n: number }).n;
    expect(reminderCount).toBe(0);
    const reminderColumns = (db.prepare('PRAGMA table_info(reminders)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(reminderColumns).toEqual(
      expect.arrayContaining(['status', 'lease_owner', 'lease_expires_at', 'draft', 'draft_status', 'cancel_reason']),
    );

    const recipients = db.prepare('SELECT id, state, reply_checked_at, reply_check_count, reply_msg_id FROM recipients ORDER BY id').all() as Array<{
      id: string;
      state: string;
      reply_checked_at: number | null;
      reply_check_count: number;
      reply_msg_id: string | null;
    }>;
    const byId = Object.fromEntries(recipients.map((r) => [r.id, r]));
    expect(byId.r_normal?.state).toBe('opened');
    expect(byId.r_replied?.state).toBe('replied'); // back-filled
    for (const r of recipients) {
      expect(r.reply_check_count).toBe(0);
      expect(r.reply_msg_id).toBeNull();
    }

    const second = migrate(db);
    expect(second).toBe(EXPECTED_SCHEMA);
    const afterSecond = {
      accounts: (db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n,
      messages: (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
      recipients: (db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number }).n,
    };
    expect(afterSecond).toEqual(after);
    db.close();

    const env = setupTestServer();
    const res = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json().schema).toBe(EXPECTED_SCHEMA);
    await env.app.close();
    env.db.close();
  });
});
