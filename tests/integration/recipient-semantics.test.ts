import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import { migrate, openDb, EXPECTED_SCHEMA } from '../../src/db/index.js';
import { signToken } from '../../src/core/token.js';
import {
  addRecipient,
  addSuppression,
  createMessage,
  ensureAccount,
  findRecipientByToken,
  getMessage,
  getMessageDetail,
  markMessageSent,
  markRecipientSent,
} from '../../src/db/repo.js';
import { executeForget, planForget } from '../../src/db/erase.js';
import { statsReport } from '../../src/db/stats.js';
import { presentMessageDetail } from '../../src/server/present.js';
import { recordOpen } from '../../src/server/services/record.js';
import { buildPayload } from '../../src/notify/payload.js';
import { summaryLine } from '../../src/notify/channels/util.js';
import { newId } from '../../src/core/ids.js';
import { setupTestServer, TEST_SECRET, makeConfig, type TestServer } from '../helpers/setup.js';

// docs/07_recipient_semantics.md §6.5 - test cases 217-227 (numbering starts at 200 to avoid
// clashing with Phase 3's 121-192).

const ORIGINAL_ENV = { ...process.env };

function runCli(args: string[]): Promise<void> {
  const program = createProgram();
  return program.parseAsync(['node', 'openpost', ...args]);
}

/** Undoes just enough quoted-printable (soft line-break + `=XX` hex escapes) for substring/regex
 *  assertions against an .eml's HTML part to work the same way whether or not nodemailer happened
 *  to QP-encode it. */
function unfoldQuotedPrintable(raw: string): string {
  return raw.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

describe('single recipient mode (§4.2) - CLI send', () => {
  let outDir: string;
  let dbPath: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'openpost-out-'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'openpost-db-')), 'test.db');
    process.env = {
      ...ORIGINAL_ENV,
      TRACKING_SECRET: TEST_SECRET,
      TRACKING_BASE_URL: 'http://127.0.0.1:8787',
      FROM_EMAIL: 'sender@example.com',
      FROM_NAME: 'Sender',
      DB_PATH: dbPath,
      OUT_DIR: outDir,
      MAIL_TRANSPORT: 'dryrun',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(outDir, { recursive: true, force: true });
  });

  it('217. --recipient-mode single writes exactly one delivered .eml with full To/Cc, no Bcc, one pixel', async () => {
    await runCli([
      'send',
      '--to', 'a@example.com',
      '--to', 'b@example.com',
      '--cc', 'c@example.com',
      '--bcc', 'd@example.com',
      '--subject', 'recipient semantics',
      '--html', '<p>hi</p>',
      '--dry-run',
      '--recipient-mode', 'single',
      '--json',
    ]);

    const dirents = readdirSync(outDir);
    const emlFiles = dirents.filter((f) => f.endsWith('.eml') && !f.endsWith('.sent.eml'));
    expect(emlFiles).toHaveLength(1);
    const raw = readFileSync(join(outDir, emlFiles[0] as string), 'utf8');
    expect(raw).toMatch(/^To: .*a@example\.com.*b@example\.com/im);
    expect(raw).toMatch(/^Cc: .*c@example\.com/im);
    expect(raw).not.toMatch(/^bcc:/im);
    const pixelHits = unfoldQuotedPrintable(raw).match(/\/o\/[0-9a-z.]+\.gif/gi) ?? [];
    expect(pixelHits).toHaveLength(1);
  });

  it('218. exactly 1 aggregate + N addressee rows; the pixel token belongs to the aggregate; addressee tokens appear in no artefact', async () => {
    await runCli([
      'send',
      '--to', 'a@example.com',
      '--to', 'b@example.com',
      '--cc', 'c@example.com',
      '--subject', 'recipient semantics',
      '--html', '<p>hi</p>',
      '--dry-run',
      '--recipient-mode', 'single',
    ]);

    const db = openDb(dbPath);
    try {
      const rows = db.prepare('SELECT * FROM recipients').all() as Array<{ id: string; email: string; is_aggregate: number; token: string }>;
      expect(rows).toHaveLength(4); // 3 addressees + 1 aggregate
      const aggregateRows = rows.filter((r) => r.is_aggregate === 1);
      const addresseeRows = rows.filter((r) => r.is_aggregate === 0);
      expect(aggregateRows).toHaveLength(1);
      expect(addresseeRows).toHaveLength(3);
      expect(aggregateRows[0]?.email).toBe('(all recipients)');

      const emlFiles = readdirSync(outDir).filter((f) => f.endsWith('.eml') && !f.endsWith('.sent.eml'));
      const raw = unfoldQuotedPrintable(readFileSync(join(outDir, emlFiles[0] as string), 'utf8'));
      expect(raw).toContain(aggregateRows[0]?.token);
      for (const a of addresseeRows) {
        expect(raw).not.toContain(a.token);
      }
    } finally {
      db.close();
    }
  });

  it('220. any suppressed addressee forces the whole message untracked, with a reported reason', async () => {
    const db = openDb(dbPath);
    migrate(db);
    addSuppression(db, 'bad@example.com', 'manual');
    db.close();

    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli([
        'send',
        '--to', 'a@example.com',
        '--to', 'bad@example.com',
        '--subject', 'recipient semantics',
        '--html', '<p>hi</p>',
        '--dry-run',
        '--recipient-mode', 'single',
        '--json',
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const jsonLine = logs.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const output = JSON.parse(jsonLine as string) as {
      recipientMode: string;
      recipients: Array<{ email: string; isAggregate?: boolean; pixelUrl?: string; suppressed: boolean }>;
    };
    expect(output.recipientMode).toBe('single');
    const aggregate = output.recipients.find((r) => r.isAggregate);
    expect(aggregate?.pixelUrl).toBeUndefined();
    expect(aggregate?.suppressed).toBe(true);

    const emlFiles = readdirSync(outDir).filter((f) => f.endsWith('.eml') && !f.endsWith('.sent.eml'));
    const raw = readFileSync(join(outDir, emlFiles[0] as string), 'utf8');
    expect(raw).not.toContain('<img');
  });

  it('227. the full §6.4 dry-run scenario, asserted programmatically (per-recipient mode)', async () => {
    await runCli([
      'send',
      '--to', 'a@example.com',
      '--to', 'b@example.com',
      '--cc', 'c@example.com',
      '--bcc', 'd@example.com',
      '--subject', 'recipient semantics',
      '--html', '<p>hi <a href="https://example.com">x</a></p>',
      '--dry-run',
      '--out', outDir,
    ]);

    const dirents = readdirSync(outDir);
    const deliveredEml = dirents.filter((f) => f.endsWith('.eml') && !f.endsWith('.sent.eml'));
    expect(deliveredEml).toHaveLength(4); // a, b, c, d - one copy each

    const headerLinesOf = (file: string) =>
      readFileSync(join(outDir, file), 'utf8')
        .split(/\r?\n\r?\n/)[0]!
        .split(/\r?\n/)
        .filter((l) => /^(to|cc|subject|date):/i.test(l));
    const firstHeaders = headerLinesOf(deliveredEml[0] as string);
    for (const f of deliveredEml.slice(1)) {
      expect(headerLinesOf(f)).toEqual(firstHeaders);
    }

    for (const f of deliveredEml) {
      const raw = readFileSync(join(outDir, f), 'utf8');
      expect(raw).not.toMatch(/^bcc:/im);
    }

    const envelopeTos = deliveredEml
      .map((f) => readFileSync(join(outDir, f), 'utf8'))
      .map((raw) => /^X-Openpost-Envelope-To:\s*(.+)$/im.exec(raw)?.[1]?.trim())
      .sort();
    expect(envelopeTos).toEqual(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']);

    const messageIds = new Set(
      deliveredEml
        .map((f) => readFileSync(join(outDir, f), 'utf8'))
        .map((raw) => /^Message-ID:\s*(.+)$/im.exec(raw)?.[1]?.trim()),
    );
    expect(messageIds.size).toBe(4);
    const referencesSet = new Set(
      deliveredEml
        .map((f) => readFileSync(join(outDir, f), 'utf8'))
        .map((raw) => /^References:\s*(.+)$/im.exec(raw)?.[1]?.trim()),
    );
    expect(referencesSet.size).toBe(1);
  });
});

describe('219/221. pixel hit on the aggregate row; notification attribution message + recipientCount', () => {
  it('219. aggregate open increments the aggregate row only; presenter marks it isAggregate', async () => {
    const env: TestServer = setupTestServer();
    try {
      const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
      const message = createMessage(env.db, {
        accountId: account.id,
        subject: 'single mode',
        bodyHtml: '<p>hi</p>',
        bodyText: 'hi',
        status: 'sent',
        trackingEnabled: true,
        clickTrackingEnabled: false,
        recipientMode: 'single',
      });
      markMessageSent(env.db, message.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
      const alice = addRecipient(env.db, { messageId: message.id, email: 'alice@example.com', token: newId() });
      const bob = addRecipient(env.db, { messageId: message.id, email: 'bob@example.com', token: newId() });
      const aggregate = addRecipient(env.db, {
        messageId: message.id,
        email: '(all recipients)',
        name: '2 recipients',
        token: newId(),
        isAggregate: true,
      });
      for (const r of [alice, bob, aggregate]) {
        markRecipientSent(env.db, r.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
      }

      const token = signToken('o', aggregate.token, TEST_SECRET);
      const res = await env.app.inject({ method: 'GET', url: `/o/${token}.gif` });
      expect(res.statusCode).toBe(200);

      const found = findRecipientByToken(env.db, aggregate.token);
      expect(found?.open_count).toBe(1);
      const aliceAfter = findRecipientByToken(env.db, alice.token);
      expect(aliceAfter?.open_count).toBe(0);

      const detail = getMessageDetail(env.db, message.id);
      expect(detail).not.toBeNull();
      const presented = presentMessageDetail(env.config, detail!, []);
      const aggregatePresented = presented.recipients.find((r) => r.isAggregate);
      expect(aggregatePresented?.isAggregate).toBe(true);
      expect(aggregatePresented?.openCount).toBe(1);
      expect(presented.recipientMode).toBe('single');
    } finally {
      await env.app.close();
      env.db.close();
    }
  });

  it('221. notification payload: email null, attribution message, "recipient unknown, N on thread" text', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'single mode',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
      recipientMode: 'single',
    });
    markMessageSent(db, message.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      const r = addRecipient(db, { messageId: message.id, email, token: newId() });
      markRecipientSent(db, r.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    }
    const aggregate = addRecipient(db, {
      messageId: message.id,
      email: '(all recipients)',
      name: '3 recipients',
      token: newId(),
      isAggregate: true,
    });
    markRecipientSent(db, aggregate.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });

    const recipientWithMessage = { ...aggregate, messageSubject: message.subject, messageNotifyMuted: false };
    const { events } = recordOpen(db, {
      recipient: recipientWithMessage,
      occurredAt: 1_700_000_100_000,
      classification: { classification: 'human', confidence: 0.9, counted: true, reasons: ['R9'] },
      fields: {},
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.isAggregate).toBe(true);
    expect(event.recipientCount).toBe(3);

    const config = makeConfig();
    const payload = buildPayload(event, 'first_open', 'notif-1', config);
    expect(payload.recipient.email).toBeNull();
    expect(payload.recipient.attribution).toBe('message');
    expect(payload.recipient.recipientCount).toBe(3);
    expect(summaryLine(payload)).toContain('recipient unknown, 3 on thread');
    db.close();
  });
});

describe('persistence (§4.3)', () => {
  it('222. migrate v5 -> 6: old rows read as per-recipient / is_aggregate 0', () => {
    const migrationsDir = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'db', 'migrations');
    const upTo005 = mkdtempSync(join(tmpdir(), 'openpost-v5-'));
    try {
      for (const file of readdirSync(migrationsDir).filter((f) => f <= '005_phase3.sql')) {
        writeFileSync(join(upTo005, file), readFileSync(join(migrationsDir, file), 'utf8'));
      }
      const db = openDb(':memory:');
      migrate(db, { dir: upTo005 });
      expect(db.pragma('user_version', { simple: true })).toBe(5);

      db.prepare(`INSERT INTO accounts (id, email, display_name, transport, created_at) VALUES ('acc1','s@example.com',NULL,'dryrun',0)`).run();
      db.prepare(
        `INSERT INTO messages (id, account_id, subject, status, tracking_enabled, click_tracking_enabled, sent_at, created_at)
         VALUES ('msg1','acc1','hello','sent',1,0,1000,0)`,
      ).run();
      db.prepare(
        `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, click_count, created_at, state)
         VALUES ('r1','msg1','a@example.com','to','${'a'.repeat(26)}',0,0,0,0,'not_opened')`,
      ).run();

      const version = migrate(db);
      expect(version).toBe(EXPECTED_SCHEMA);

      const message = getMessage(db, 'msg1');
      expect(message?.recipient_mode).toBe('per-recipient');
      const recipient = db.prepare('SELECT is_aggregate, envelope_to FROM recipients WHERE id = ?').get('r1') as {
        is_aggregate: number;
        envelope_to: string | null;
      };
      expect(recipient.is_aggregate).toBe(0);
      expect(recipient.envelope_to).toBeNull();
      db.close();
    } finally {
      rmSync(upTo005, { recursive: true, force: true });
    }
  });

  it('223. per-recipient N>1 stores the thread root in messages.rfc822_msg_id and NULL provider/thread ids; per-copy ids on recipients', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openpost-out-'));
    const dbPath = join(mkdtempSync(join(tmpdir(), 'openpost-db-')), 'test.db');
    process.env = {
      ...ORIGINAL_ENV,
      TRACKING_SECRET: TEST_SECRET,
      TRACKING_BASE_URL: 'http://127.0.0.1:8787',
      FROM_EMAIL: 'sender@example.com',
      DB_PATH: dbPath,
      OUT_DIR: outDir,
      MAIL_TRANSPORT: 'dryrun',
    };
    try {
      await runCli(['send', '--to', 'a@example.com', '--to', 'b@example.com', '--subject', 'hi', '--html', '<p>hi</p>', '--dry-run']);
      const db = openDb(dbPath);
      const message = db.prepare('SELECT * FROM messages').get() as { rfc822_msg_id: string; provider_msg_id: string | null; thread_id: string | null };
      expect(message.provider_msg_id).toBeNull();
      expect(message.thread_id).toBeNull();
      expect(message.rfc822_msg_id).toMatch(/^<op\./);

      const recipients = db.prepare('SELECT email, rfc822_msg_id FROM recipients').all() as Array<{ email: string; rfc822_msg_id: string }>;
      expect(recipients).toHaveLength(2);
      const ids = new Set(recipients.map((r) => r.rfc822_msg_id));
      expect(ids.size).toBe(2); // distinct per-copy ids
      for (const r of recipients) {
        expect(r.rfc822_msg_id).not.toBe(message.rfc822_msg_id); // never the synthetic root itself
      }
      db.close();
    } finally {
      process.env = { ...ORIGINAL_ENV };
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('224. single mode stores the same provider/thread/rfc822 ids on every row (addressees + aggregate)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'openpost-out-'));
    const dbPath = join(mkdtempSync(join(tmpdir(), 'openpost-db-')), 'test.db');
    process.env = {
      ...ORIGINAL_ENV,
      TRACKING_SECRET: TEST_SECRET,
      TRACKING_BASE_URL: 'http://127.0.0.1:8787',
      FROM_EMAIL: 'sender@example.com',
      DB_PATH: dbPath,
      OUT_DIR: outDir,
      MAIL_TRANSPORT: 'dryrun',
    };
    try {
      await runCli(['send', '--to', 'a@example.com', '--to', 'b@example.com', '--subject', 'hi', '--html', '<p>hi</p>', '--dry-run', '--recipient-mode', 'single']);
      const db = openDb(dbPath);
      const message = db.prepare('SELECT * FROM messages').get() as { rfc822_msg_id: string; provider_msg_id: string | null; thread_id: string | null };
      const recipients = db.prepare('SELECT rfc822_msg_id, provider_msg_id, thread_id, is_aggregate FROM recipients').all() as Array<{
        rfc822_msg_id: string;
        provider_msg_id: string | null;
        thread_id: string | null;
        is_aggregate: number;
      }>;
      expect(recipients).toHaveLength(3); // 2 addressees + 1 aggregate
      for (const r of recipients) {
        expect(r.rfc822_msg_id).toBe(message.rfc822_msg_id);
        expect(r.provider_msg_id).toBe(message.provider_msg_id);
        expect(r.thread_id).toBe(message.thread_id);
      }
      db.close();
    } finally {
      process.env = { ...ORIGINAL_ENV };
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('225. stats.ts counts a 3-recipient single-mode message as exactly one recipient unit', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'single mode stats',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
      recipientMode: 'single',
      createdAt: 1_700_000_000_000,
    });
    markMessageSent(db, message.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    for (const email of ['a@example.com', 'b@example.com', 'c@example.com']) {
      const r = addRecipient(db, { messageId: message.id, email, token: newId() });
      markRecipientSent(db, r.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    }
    const aggregate = addRecipient(db, { messageId: message.id, email: '(all recipients)', name: '3 recipients', token: newId(), isAggregate: true });
    markRecipientSent(db, aggregate.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    db.prepare('UPDATE recipients SET open_count = 1 WHERE id = ?').run(aggregate.id);

    const report = statsReport(db, { sinceMs: 0, untilMs: 2_000_000_000_000, timeZone: 'UTC' });
    expect(report.totals.recipients).toBe(1);
    expect(report.totals.opened).toBe(1);
    db.close();
  });

  it('226. forget deletes the addressee row AND the aggregate row (+ events), one address-free audit row', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'single mode erase',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
      recipientMode: 'single',
    });
    markMessageSent(db, message.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    const alice = addRecipient(db, { messageId: message.id, email: 'alice@example.com', token: newId() });
    markRecipientSent(db, alice.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    const aggregate = addRecipient(db, { messageId: message.id, email: '(all recipients)', name: '1 recipients', token: newId(), isAggregate: true });
    markRecipientSent(db, aggregate.id, { providerMsgId: 'p1', threadId: 't1', rfc822MsgId: '<root@example.com>', sentAt: 1_700_000_000_000 });
    db.prepare(
      `INSERT INTO open_events (id, recipient_id, occurred_at, classification, confidence, counted, reason, created_at)
       VALUES (?, ?, ?, 'human', 0.9, 1, 'R9', ?)`,
    ).run('oe1', aggregate.id, 1_700_000_100_000, 1_700_000_100_000);

    const plan = planForget(db, 'alice@example.com');
    expect(plan.recipientIds).toEqual([alice.id]);
    expect(plan.aggregateRecipientIds).toEqual([aggregate.id]);

    const counts = executeForget(db, plan, { purgeBodies: false, keepSuppression: true, ipSalt: 'salt-value-that-is-not-the-default-x', atMs: Date.now() });
    expect(counts.recipients).toBe(1);
    expect(counts.aggregateRowsErased).toBe(1);
    expect(counts.openEvents).toBe(1);

    const remaining = db.prepare('SELECT COUNT(*) AS n FROM recipients WHERE message_id = ?').get(message.id) as { n: number };
    expect(remaining.n).toBe(0);
    const remainingEvents = db.prepare('SELECT COUNT(*) AS n FROM open_events').get() as { n: number };
    expect(remainingEvents.n).toBe(0);

    const auditRows = db.prepare(`SELECT detail_json FROM audit_log WHERE action = 'forget.execute'`).all() as Array<{ detail_json: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.detail_json).not.toContain('alice@example.com');
    expect(auditRows[0]?.detail_json).not.toContain('@');
    db.close();
  });
});
