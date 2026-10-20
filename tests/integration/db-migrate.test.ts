import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrate, openDb, withTx } from '../../src/db/index.js';
import { addRecipient, createMessage, ensureAccount } from '../../src/db/repo.js';

const REAL_MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'db', 'migrations');

/** A temp migrations directory containing only the real migration files numbered <= `maxVersion` -
 *  lets a test `migrate()` a fresh DB up to a specific pre-Phase-4.1 schema, insert data in the
 *  shape that version's application code would have written, and then run the real 009 migration
 *  against it (rather than reproducing 009's SQL by hand and testing nothing but a copy of itself). */
function dirUpTo(maxVersion: number): string {
  const dir = mkdtempSync(join(tmpdir(), `openpost-migrate-upto-${maxVersion}-`));
  const files = readdirSync(REAL_MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql') && parseInt(f.slice(0, 3), 10) <= maxVersion)
    .sort();
  for (const f of files) writeFileSync(join(dir, f), readFileSync(join(REAL_MIGRATIONS_DIR, f), 'utf8'));
  return dir;
}

// Current schema version. Bumped to 2 in Phase 1.1 (finding #16: recipients.cache_buster), to 3 in
// Phase 2 (003_phase2.sql - see docs/05_phase2_spec.md's §7.1 deviation note: the spec calls this
// "migration 002" against a pre-hardening tree that didn't have 002 yet), to 4 in Phase 2.1
// (004_notify_sending_state.sql, finding #6), to 5 in Phase 3 (005_phase3.sql - see
// docs/06_phase3_spec.md's own header: the spec calls this "migration 004" against a
// pre-Phase-2.1 tree), to 6 for recipient semantics (006_recipient_semantics.sql - see
// docs/07_recipient_semantics.md §4.1), and to 7 for the Phase 3.1 hardening pass
// (007_phase3_1.sql - see docs/reports/phase3_review.md), and to 8 for Phase 4
// (008_phase4.sql - see docs/08_phase4_spec.md).
const CURRENT_SCHEMA_VERSION = 10;

describe('db migrate', () => {
  it(`46. migrate on a fresh :memory: DB sets user_version=${CURRENT_SCHEMA_VERSION}; running twice is a no-op`, () => {
    const db = openDb(':memory:');
    const first = migrate(db);
    expect(first).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);

    const second = migrate(db);
    expect(second).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('finding #11: a failing migration file is rolled back entirely and never bumps user_version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'openpost-migrations-'));
    try {
      writeFileSync(join(dir, '001_ok.sql'), 'CREATE TABLE ok_table (id TEXT PRIMARY KEY);');
      writeFileSync(
        join(dir, '002_broken.sql'),
        'CREATE TABLE partial_table (id TEXT PRIMARY KEY); THIS IS NOT VALID SQL;',
      );

      const db = openDb(':memory:');
      expect(() => migrate(db, { dir })).toThrow();

      // 001 committed (its own transaction succeeded)...
      expect(db.pragma('user_version', { simple: true })).toBe(1);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ok_table'").get(),
      ).toBeDefined();
      // ...but 002's CREATE TABLE was rolled back along with its invalid statement and its own
      // trailing `PRAGMA user_version` bump, rather than leaving a half-applied schema recorded as
      // "up to date" at version 2.
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='partial_table'").get(),
      ).toBeUndefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finding #2: 009_phase4_1 folds case-variant suppression rows to lower(trim(...)), keeping the earliest, and the column becomes COLLATE NOCASE', () => {
    const db = openDb(':memory:');
    const upTo8 = dirUpTo(8);
    migrate(db, { dir: upTo8 }); // migrate through 008 only, then seed pre-fold data
    rmSync(upTo8, { recursive: true, force: true });
    // Three rows that all normalise to the same address: the earliest (by created_at) must survive
    // with its own reason; the later duplicates must be gone, not merged/overwritten.
    db.prepare('INSERT INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)').run('Alice@Example.com', 'recipient_optout', 1000);
    db.prepare('INSERT INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)').run(' alice@example.com ', 'manual_block', 2000);
    db.prepare('INSERT INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)').run('ALICE@EXAMPLE.COM', 'erasure', 3000);
    db.prepare('INSERT INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)').run('bob@example.com', 'manual_block', 1500);

    const after = migrate(db);
    expect(after).toBe(CURRENT_SCHEMA_VERSION);

    const rows = db.prepare('SELECT email, reason FROM suppressions ORDER BY email').all() as Array<{ email: string; reason: string }>;
    expect(rows).toHaveLength(2);
    const alice = rows.find((r) => r.email === 'alice@example.com');
    expect(alice).toBeDefined();
    expect(alice?.reason).toBe('recipient_optout'); // the earliest (created_at=1000) row's reason survived
    expect(rows.find((r) => r.email === 'bob@example.com')).toBeDefined();

    // COLLATE NOCASE: a case-varying lookup finds the normalised row without the app normalising it.
    const found = db.prepare('SELECT 1 AS present FROM suppressions WHERE email = ?').get('ALICE@example.COM');
    expect(found).toBeDefined();

    db.close();
  });

  it('finding #3: 009_phase4_1 rewrites any pre-existing literal \'(erased)\' campaign_rows email to a per-row-unique sentinel', () => {
    const db = openDb(':memory:');
    const upTo8 = dirUpTo(8);
    migrate(db, { dir: upTo8 });
    rmSync(upTo8, { recursive: true, force: true });
    const account = ensureAccount(db, { email: 'a@example.com', transport: 'dryrun' });
    db.prepare(
      `INSERT INTO campaigns (id, name, account_id, status, subject_template, body_html_template, from_email,
         transport, rate_per_minute, jitter_ms, daily_cap, email_column, columns_json, created_at)
       VALUES ('camp1', 'C', ?, 'completed', 'Hi', '<p>Hi</p>', 'a@example.com', 'dryrun', 60, 0, 100, 'email', '[]', 0)`,
    ).run(account.id);
    // Simulate the pre-4.1 state: both rows already redacted to the literal '(erased)' (only
    // reachable pre-fix via two separate processes racing the old, non-transactional bug, or a
    // partially-rolled-back attempt) - the exact collision finding #3 describes.
    db.prepare(
      `INSERT INTO campaign_rows (id, campaign_id, row_index, email, vars_json, variant, status, skip_reason, created_at)
       VALUES ('row1', 'camp1', 0, '(erased)', '{}', 'A', 'sent', 'erased', 0)`,
    ).run();

    const after = migrate(db);
    expect(after).toBe(CURRENT_SCHEMA_VERSION);
    const row = db.prepare(`SELECT email FROM campaign_rows WHERE id = 'row1'`).get() as { email: string };
    expect(row.email).toBe('(erased):row1');
    db.close();
  });

  it('47. foreign keys cascade: deleting a message deletes its recipients and events', () => {
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
    const recipient = addRecipient(db, { messageId: message.id, email: 'r@example.com', token: 'tok1234567890123456789012' });

    db.prepare(
      `INSERT INTO open_events (id, recipient_id, occurred_at, classification, confidence, counted, created_at)
       VALUES ('ev1', ?, 0, 'human', 1.0, 1, 0)`,
    ).run(recipient.id);

    expect(db.prepare('SELECT COUNT(*) AS n FROM recipients').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM open_events').get()).toEqual({ n: 1 });

    withTx(db, () => {
      db.prepare('DELETE FROM messages WHERE id = ?').run(message.id);
    });

    expect(db.prepare('SELECT COUNT(*) AS n FROM recipients').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM open_events').get()).toEqual({ n: 0 });
    db.close();
  });
});
