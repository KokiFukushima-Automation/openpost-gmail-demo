import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { seedDemo, SeedRefusedError } from '../../src/db/seed.js';
import { createMessage, ensureAccount } from '../../src/db/repo.js';

const SEED_NOW = 1_789_000_000_000;

describe('db/seed seedDemo', () => {
  it('185a. populates every recipient state, several classifications, and a reminder in more than one status', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedDemo(db, { seed: 7, nowMs: SEED_NOW, messages: 12, reset: false, force: false });

    const states = (db.prepare('SELECT DISTINCT state FROM recipients').all() as Array<{ state: string }>).map((r) => r.state);
    for (const s of ['not_opened', 'prefetched', 'opened', 'read_confirmed', 'replied']) {
      expect(states).toContain(s);
    }

    const classifications = (db.prepare('SELECT DISTINCT classification FROM open_events').all() as Array<{ classification: string }>).map((r) => r.classification);
    for (const c of ['human', 'bot', 'duplicate']) {
      expect(classifications).toContain(c);
    }

    const reminderStatuses = (db.prepare('SELECT DISTINCT status FROM reminders').all() as Array<{ status: string }>).map((r) => r.status);
    expect(reminderStatuses.length).toBeGreaterThanOrEqual(2);

    const overrideAudit = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reclassify.override'`).get() as { n: number };
    expect(overrideAudit.n).toBe(1);
    db.close();
  });

  it('185b. refuses a non-empty non-seeded database without --reset/--force', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'operator@example.com', transport: 'dryrun' });
    createMessage(db, { accountId: account.id, subject: 'real message', bodyHtml: null, bodyText: null, status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });

    expect(() => seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: false, force: false })).toThrow(SeedRefusedError);
    expect(() => seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: false, force: true })).not.toThrow();
    db.close();
  });

  it('185c. --reset wipes first and leaves exactly the seeded counts (--yes required against non-seeded data)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'operator@example.com', transport: 'dryrun' });
    createMessage(db, { accountId: account.id, subject: 'real message', bodyHtml: null, bodyText: null, status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });

    const result = seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: true, force: false, yes: true });
    const messageCount = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    expect(messageCount).toBe(result.messages);
    db.close();
  });

  it('M4a. --reset on a database holding non-seeded data requires --yes; --force also bypasses it', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'operator@example.com', transport: 'dryrun' });
    createMessage(db, { accountId: account.id, subject: 'real message', bodyHtml: null, bodyText: null, status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });

    expect(() => seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: true, force: false })).toThrow(SeedRefusedError);
    // Still there - the refusal happened before any wipe.
    expect((db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n).toBe(1);

    expect(() => seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: true, force: false, yes: true })).not.toThrow();
    db.close();

    const db2 = openDb(':memory:');
    migrate(db2);
    const account2 = ensureAccount(db2, { email: 'operator@example.com', transport: 'dryrun' });
    createMessage(db2, { accountId: account2.id, subject: 'real message', bodyHtml: null, bodyText: null, status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });
    expect(() => seedDemo(db2, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: true, force: true })).not.toThrow();
    db2.close();
  });

  it('M4b. --reset never wipes suppressions or settings, even against non-seeded data (with --yes)', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'operator@example.com', transport: 'dryrun' });
    createMessage(db, { accountId: account.id, subject: 'real message', bodyHtml: null, bodyText: null, status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });
    db.prepare(`INSERT INTO suppressions (email, reason, created_at) VALUES ('opted-out@example.com', 'unsubscribe', ?)`).run(SEED_NOW);
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES ('operator_setting', 'keep-me', ?)`).run(SEED_NOW);

    const result = seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: true, force: false, yes: true });
    expect(result.wiped).not.toBeNull();
    expect(result.suppressionsPreserved).toBe(1);
    const suppression = db.prepare(`SELECT email FROM suppressions WHERE email = 'opted-out@example.com'`).get();
    expect(suppression).toBeTruthy();
    const setting = db.prepare(`SELECT value FROM settings WHERE key = 'operator_setting'`).get() as { value: string } | undefined;
    expect(setting?.value).toBe('keep-me');
    db.close();
  });

  it('M4c. --reset against an already-seeded (or empty) database needs no --yes', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: false, force: false });
    expect(() => seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: true, force: false })).not.toThrow();
    db.close();

    const emptyDb = openDb(':memory:');
    migrate(emptyDb);
    expect(() => seedDemo(emptyDb, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: true, force: false })).not.toThrow();
    emptyDb.close();
  });

  it('L12. reseeding an already-seeded database without --reset/--force gives a friendly refusal, not a raw SQLITE_CONSTRAINT', () => {
    const db = openDb(':memory:');
    migrate(db);
    seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: false, force: false });
    expect(() => seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: false, force: false })).toThrow(SeedRefusedError);
    expect(() => seedDemo(db, { seed: 1, nowMs: SEED_NOW, messages: 12, reset: false, force: false })).toThrow(/--reset/);
    db.close();
  });

  it('186. two seed --demo --seed 7 runs against fresh databases produce identical ids, timestamps and row counts', () => {
    function run(): { ids: string; timestamps: string; result: ReturnType<typeof seedDemo> } {
      const db = openDb(':memory:');
      migrate(db);
      const result = seedDemo(db, { seed: 7, nowMs: SEED_NOW, messages: 12, reset: false, force: false });
      const ids = (db.prepare('SELECT id FROM recipients ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id).join(',');
      const timestamps = (db.prepare('SELECT created_at FROM recipients ORDER BY id').all() as Array<{ created_at: number }>)
        .map((r) => r.created_at)
        .join(',');
      db.close();
      return { ids, timestamps, result };
    }
    const a = run();
    const b = run();
    expect(a.ids).toBe(b.ids);
    expect(a.timestamps).toBe(b.timestamps);
    expect(a.result).toEqual(b.result);
  });
});
