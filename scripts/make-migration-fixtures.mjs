// Generates tests/fixtures/db/v{1..7}.sqlite by applying migrations 001..N to a fresh file and
// inserting a fixed, documented row set (docs/08_phase4_spec.md §4.5). Checked in by hand, not run
// by CI - this script exists so a future phase can extend the fixture set the same way.
//
// Row set (superset across every version - a column that doesn't exist yet at a given schema is
// silently dropped by insertRow() below, letting that column's own ALTER-TABLE DEFAULT apply):
//   2 accounts, 3 messages, 6 recipients, 8 open events, 3 click events, 2 notifications,
//   1 audit row, 1 suppression, and (from schema 5 on) 2 reminders.
//
// Usage: node scripts/make-migration-fixtures.mjs
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'src', 'db', 'migrations');
const FIXTURES_DIR = join(here, '..', 'tests', 'fixtures', 'db');

const ALL_MIGRATIONS = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
const MAX_VERSION = ALL_MIGRATIONS.length; // 8 today
const FIXTURE_VERSIONS = Array.from({ length: MAX_VERSION - 1 }, (_, i) => i + 1); // 1..7

function insertRow(db, table, data) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  const usable = Object.keys(data).filter((k) => cols.includes(k));
  const placeholders = usable.map((k) => `@${k}`).join(', ');
  db.prepare(`INSERT INTO ${table} (${usable.join(', ')}) VALUES (${placeholders})`).run(
    Object.fromEntries(usable.map((k) => [k, data[k]])),
  );
}

function seedFixedRowSet(db, version) {
  const now = 1_700_000_000_000;

  insertRow(db, 'accounts', { id: 'acc1', email: 'sender1@example.com', display_name: 'Sender One', transport: 'dryrun', created_at: now });
  insertRow(db, 'accounts', { id: 'acc2', email: 'sender2@example.com', display_name: 'Sender Two', transport: 'smtp', created_at: now });

  // 008_phase4.sql's own is_default back-fill (`UPDATE accounts SET is_default = 1 WHERE id = ...`)
  // runs as part of applying the migration subset BELOW, which happens BEFORE this function seeds
  // any rows - so for a fixture whose own version already includes migration 008 (v8 and up), that
  // backfill ran against an empty accounts table and set nothing. Every earlier fixture (v1..v7)
  // doesn't hit this: its migration subset stops before 008, so 008's backfill only ever runs
  // later, inside the *test* itself, against the accounts already seeded here. Replay the same
  // backfill here so a v8+ fixture is not the one case where "exactly one default account" fails to
  // hold on the checked-in file itself.
  if (version >= 8) {
    db.exec(
      `UPDATE accounts SET is_default = 1
        WHERE id = (SELECT id FROM accounts ORDER BY created_at ASC, id ASC LIMIT 1)
          AND NOT EXISTS (SELECT 1 FROM accounts WHERE is_default = 1)`,
    );
  }

  insertRow(db, 'messages', {
    id: 'msg1', account_id: 'acc1', subject: 'Fixture message 1', body_html: '<p>hi</p>', body_text: 'hi',
    status: 'sent', tracking_enabled: 1, click_tracking_enabled: 1, sent_at: now, created_at: now, recipient_mode: 'per-recipient',
  });
  insertRow(db, 'messages', {
    id: 'msg2', account_id: 'acc1', subject: 'Fixture message 2', body_html: '<p>hi</p>', body_text: 'hi',
    status: 'sent', tracking_enabled: 1, click_tracking_enabled: 0, sent_at: now, created_at: now, recipient_mode: 'per-recipient',
  });
  insertRow(db, 'messages', {
    id: 'msg3', account_id: 'acc2', subject: 'Fixture message 3', body_html: '<p>hi</p>', body_text: 'hi',
    status: 'draft', tracking_enabled: 1, click_tracking_enabled: 0, sent_at: null, created_at: now, recipient_mode: 'per-recipient',
  });

  const recipients = [
    { id: 'rec1', message_id: 'msg1', email: 'a@example.com', kind: 'to', token: 'a'.repeat(26), cache_buster: 'cb000001', open_count: 2, click_count: 1, sent_at: now, is_aggregate: 0 },
    { id: 'rec2', message_id: 'msg1', email: 'b@example.com', kind: 'cc', token: 'b'.repeat(26), cache_buster: 'cb000002', open_count: 1, click_count: 0, sent_at: now, is_aggregate: 0 },
    { id: 'rec3', message_id: 'msg2', email: 'c@example.com', kind: 'to', token: 'c'.repeat(26), cache_buster: 'cb000003', open_count: 0, click_count: 0, sent_at: now, is_aggregate: 0 },
    { id: 'rec4', message_id: 'msg2', email: 'd@example.com', kind: 'to', token: 'd'.repeat(26), cache_buster: 'cb000004', open_count: 3, click_count: 2, sent_at: now, is_aggregate: 0 },
    { id: 'rec5', message_id: 'msg3', email: 'e@example.com', kind: 'to', token: 'e'.repeat(26), cache_buster: 'cb000005', open_count: 0, click_count: 0, sent_at: null, is_aggregate: 0 },
    { id: 'rec6', message_id: 'msg3', email: 'f@example.com', kind: 'bcc', token: 'f'.repeat(26), cache_buster: 'cb000006', open_count: 0, click_count: 0, sent_at: null, is_aggregate: 0 },
  ];
  for (const r of recipients) {
    insertRow(db, 'recipients', { ...r, machine_open_count: 0, created_at: now, state: 'not_opened', notify_muted: 0 });
  }

  // From schema 6 on: one single-mode message with a real addressee plus its aggregate recipient.
  if (version >= 6) {
    insertRow(db, 'messages', {
      id: 'msg4', account_id: 'acc1', subject: 'Single-mode fixture', body_html: '<p>hi all</p>', body_text: 'hi all',
      status: 'sent', tracking_enabled: 1, click_tracking_enabled: 0, sent_at: now, created_at: now, recipient_mode: 'single',
    });
    insertRow(db, 'recipients', {
      id: 'rec7', message_id: 'msg4', email: 'g@example.com', kind: 'to', token: 'g'.repeat(26), cache_buster: 'cb000007',
      open_count: 0, click_count: 0, machine_open_count: 0, created_at: now, sent_at: now, state: 'not_opened', notify_muted: 0, is_aggregate: 0,
    });
    insertRow(db, 'recipients', {
      id: 'rec8', message_id: 'msg4', email: '(all recipients)', name: '1 recipient', kind: 'to', token: 'h'.repeat(26), cache_buster: 'cb000008',
      open_count: 1, click_count: 0, machine_open_count: 0, created_at: now, sent_at: now, state: 'opened', notify_muted: 0, is_aggregate: 1,
    });
  }

  const opens = [
    { recipient_id: 'rec1', occurred_at: now + 1000, classification: 'human', confidence: 0.9, counted: 1, reason: 'R9' },
    { recipient_id: 'rec1', occurred_at: now + 2000, classification: 'human', confidence: 0.9, counted: 1, reason: 'R9' },
    { recipient_id: 'rec2', occurred_at: now + 1500, classification: 'human', confidence: 0.9, counted: 1, reason: 'R9' },
    { recipient_id: 'rec4', occurred_at: now + 500, classification: 'human', confidence: 0.9, counted: 1, reason: 'R9' },
    { recipient_id: 'rec4', occurred_at: now + 1500, classification: 'human', confidence: 0.9, counted: 1, reason: 'R9' },
    { recipient_id: 'rec4', occurred_at: now + 2500, classification: 'human', confidence: 0.9, counted: 1, reason: 'R9' },
    { recipient_id: 'rec1', occurred_at: now + 3000, classification: 'bot', confidence: 0.5, counted: 0, reason: 'R6' },
    { recipient_id: 'rec2', occurred_at: now + 3500, classification: 'google_proxy_prefetch', confidence: 0.5, counted: 0, reason: 'R2' },
  ];
  for (const o of opens) {
    insertRow(db, 'open_events', { id: `oe_${o.recipient_id}_${o.occurred_at}`, created_at: o.occurred_at, ...o });
  }

  insertRow(db, 'links', { id: 'link1', message_id: 'msg1', url: 'https://example.com/a', label: 'Link A', position: 0, created_at: now });
  insertRow(db, 'links', { id: 'link2', message_id: 'msg2', url: 'https://example.com/b', label: 'Link B', position: 0, created_at: now });
  insertRow(db, 'click_tokens', { id: 'ct1', link_id: 'link1', recipient_id: 'rec1', created_at: now });
  insertRow(db, 'click_tokens', { id: 'ct2', link_id: 'link2', recipient_id: 'rec4', created_at: now });

  const clicks = [
    { link_id: 'link1', recipient_id: 'rec1', occurred_at: now + 2200, classification: 'human', confidence: 0.9, counted: 1 },
    { link_id: 'link2', recipient_id: 'rec4', occurred_at: now + 900, classification: 'human', confidence: 0.9, counted: 1 },
    { link_id: 'link2', recipient_id: 'rec4', occurred_at: now + 1900, classification: 'human', confidence: 0.9, counted: 1 },
  ];
  for (const c of clicks) {
    insertRow(db, 'click_events', { id: `ce_${c.recipient_id}_${c.occurred_at}`, created_at: c.occurred_at, ...c });
  }

  // notifications' shape changed at schema 3 (001's stub -> the real queue) - only seed it once
  // the real table exists.
  if (version >= 3) {
    insertRow(db, 'notifications', {
      id: 'notif1', trigger: 'first_open', channel: 'slack', message_id: 'msg1', recipient_id: 'rec1',
      event_type: 'open', event_id: 'oe1', dedupe_key: 'slack:first_open:rec1', payload_json: '{}',
      status: 'sent', attempts: 1, next_attempt_at: now, created_at: now, sent_at: now,
    });
    insertRow(db, 'notifications', {
      id: 'notif2', trigger: 'click', channel: 'slack', message_id: 'msg2', recipient_id: 'rec4',
      event_type: 'click', event_id: 'ce1', dedupe_key: 'slack:click:ce1', payload_json: '{}',
      status: 'pending', attempts: 0, next_attempt_at: now, created_at: now, sent_at: null,
    });
  }

  insertRow(db, 'audit_log', { id: 'audit1', at: now, actor: 'server', action: 'fixture.seed', subject_type: 'message', subject_id: 'msg1', detail_json: '{}' });
  insertRow(db, 'suppressions', { email: 'suppressed@example.com', reason: 'manual_block', created_at: now });

  if (version >= 5) {
    insertRow(db, 'reminders', {
      id: 'rem1', message_id: 'msg1', recipient_id: 'rec2', condition: 'no_reply', due_at: now + 86_400_000,
      status: 'pending', state: 'pending', attempts: 0, created_at: now, created_by: 'cli',
    });
    insertRow(db, 'reminders', {
      id: 'rem2', message_id: 'msg2', recipient_id: 'rec3', condition: 'no_open', due_at: now + 172_800_000,
      status: 'pending', state: 'pending', attempts: 0, created_at: now, created_by: 'cli',
    });
  }
}

mkdirSync(FIXTURES_DIR, { recursive: true });

for (const version of FIXTURE_VERSIONS) {
  const migrationSubset = ALL_MIGRATIONS.slice(0, version);
  const tmpMigrationsDir = join(FIXTURES_DIR, `.tmp-migrations-v${version}`);
  rmSync(tmpMigrationsDir, { recursive: true, force: true });
  mkdirSync(tmpMigrationsDir, { recursive: true });
  for (const file of migrationSubset) {
    const { readFileSync, writeFileSync } = await import('node:fs');
    writeFileSync(join(tmpMigrationsDir, file), readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }

  const fixturePath = join(FIXTURES_DIR, `v${version}.sqlite`);
  if (existsSync(fixturePath)) rmSync(fixturePath);
  for (const ext of ['-wal', '-shm']) rmSync(`${fixturePath}${ext}`, { force: true });

  const db = new Database(fixturePath);
  db.pragma('foreign_keys = ON');

  // Minimal inline migration runner (mirrors src/db/index.ts's migrate(), duplicated here so this
  // script has zero dependency on the built dist/ output).
  const files = readdirSync(tmpMigrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(join(tmpMigrationsDir, file), 'utf8');
    const versionNum = Number(file.split('_')[0]);
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${versionNum}`);
    })();
  }

  seedFixedRowSet(db, version);
  db.close();
  rmSync(tmpMigrationsDir, { recursive: true, force: true });
  console.log(`wrote ${fixturePath} at schema ${version}`);
}

console.log(`done: ${FIXTURE_VERSIONS.length} fixtures (v1..v${MAX_VERSION - 1}) for current schema ${MAX_VERSION}`);
