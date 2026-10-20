import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { executeForget, planForget } from '../../src/db/erase.js';
import { createProgram } from '../../src/cli/program.js';
import {
  addClickToken,
  addLink,
  addRecipient,
  createMessage,
  ensureAccount,
  getMessage,
} from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { signToken } from '../../src/core/token.js';

const SENT_AT = 1_700_000_000_000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function setup(env: TestServer) {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  // message1: alice is the only recipient -> should be deleted once she's forgotten.
  const message1 = createMessage(env.db, {
    accountId: account.id,
    subject: 'only alice',
    bodyHtml: '<p>hi Alice, my address is alice@example.com</p>',
    bodyText: 'hi',
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: true,
  });
  env.db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(SENT_AT, message1.id);
  const alice1 = addRecipient(env.db, { messageId: message1.id, email: 'alice@example.com', token: newId() });
  const link1 = addLink(env.db, { messageId: message1.id, url: 'https://example.com/x', label: null, position: 0 });
  const clickToken1 = addClickToken(env.db, { linkId: link1.id, recipientId: alice1.id });

  // message2: alice AND bob -> should survive (bob remains).
  const message2 = createMessage(env.db, {
    accountId: account.id,
    subject: 'alice and bob',
    bodyHtml: '<p>hi</p>',
    bodyText: 'hi',
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: false,
  });
  env.db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(SENT_AT, message2.id);
  const alice2 = addRecipient(env.db, { messageId: message2.id, email: 'alice@example.com', token: newId() });
  addRecipient(env.db, { messageId: message2.id, email: 'bob@example.com', token: newId() });

  return { message1, message2, alice1, alice2, clickToken1 };
}

describe('forget', () => {
  let env: TestServer;

  beforeEach(() => {
    env = setupTestServer({ startAt: SENT_AT + 60_000 });
  });

  it('98. --dry-run reports counts and changes nothing', () => {
    const { alice1 } = setup(env);
    const secret = env.config.trackingSecret as string;
    // give alice1 an open event so counts are non-zero
    return env.app
      .inject({ method: 'GET', url: `/o/${signToken('o', alice1.token, secret)}.gif`, headers: { 'user-agent': CHROME_UA } })
      .then(() => {
        const before = env.db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number };
        const plan = planForget(env.db, 'alice@example.com');
        expect(plan.counts.recipients).toBe(2);
        expect(plan.counts.openEvents).toBeGreaterThanOrEqual(1);
        const after = env.db.prepare('SELECT COUNT(*) AS n FROM recipients').get() as { n: number };
        expect(after.n).toBe(before.n);
      });
  });

  it('99. a real run deletes events/click tokens/recipients; a message with no recipients left is deleted; a shared message survives', () => {
    const { message1, message2 } = setup(env);
    const plan = planForget(env.db, 'ALICE@Example.com  '); // case/whitespace-insensitive
    executeForget(env.db, plan, { purgeBodies: false, keepSuppression: true, ipSalt: env.config.ipSalt, atMs: Date.now() });

    expect(getMessage(env.db, message1.id)).toBeNull();
    expect(getMessage(env.db, message2.id)).not.toBeNull();

    const remainingRecipients = env.db.prepare('SELECT email FROM recipients').all() as Array<{ email: string }>;
    expect(remainingRecipients).toHaveLength(1);
    expect(remainingRecipients[0]?.email).toBe('bob@example.com');

    const clickTokens = env.db.prepare('SELECT COUNT(*) AS n FROM click_tokens').get() as { n: number };
    expect(clickTokens.n).toBe(0);
  });

  it('100. exactly one audit row whose JSON contains no raw address; subject_id is the 16-char hash', () => {
    setup(env);
    const plan = planForget(env.db, 'alice@example.com');
    executeForget(env.db, plan, { purgeBodies: false, keepSuppression: true, ipSalt: env.config.ipSalt, atMs: Date.now() });

    const rows = env.db.prepare(`SELECT * FROM audit_log WHERE action = 'forget.execute'`).all() as Array<{
      subject_id: string;
      detail_json: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.subject_id).toHaveLength(16);
    expect(rows[0]?.detail_json).not.toContain('alice@example.com');
    expect(rows[0]?.detail_json).not.toMatch(/alice/i);
  });

  it('338. openpost forget redacts matching campaign_rows (email/vars_json) and counts them in the address-free audit row', async () => {
    const { createCampaign, insertRows } = await import('../../src/db/campaigns.js');
    const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
    const campaign = createCampaign(env.db, {
      name: 'Q3',
      accountId: account.id,
      subjectTemplate: 'Hi',
      bodyHtmlTemplate: '<p>Hi</p>',
      fromEmail: 'sender@example.com',
      transport: 'dryrun',
      ratePerMinute: 60,
      jitterMs: 0,
      dailyCap: 100,
      emailColumn: 'email',
      columnsJson: '["email","company"]',
      createdAt: Date.now(),
    });
    insertRows(
      env.db,
      campaign.id,
      [{ rowIndex: 0, email: 'alice@example.com', varsJson: JSON.stringify({ company: 'Acme' }), variant: 'A', status: 'sent' }],
      Date.now(),
    );

    setup(env);
    const plan = planForget(env.db, 'alice@example.com');
    expect(plan.counts.campaignRowsRedacted).toBe(1);
    const counts = executeForget(env.db, plan, { purgeBodies: false, keepSuppression: true, ipSalt: env.config.ipSalt, atMs: Date.now() });
    expect(counts.campaignRowsRedacted).toBe(1);

    const row = env.db.prepare(`SELECT email, vars_json, skip_reason FROM campaign_rows WHERE campaign_id = ?`).get(campaign.id) as {
      email: string;
      vars_json: string;
      skip_reason: string | null;
    };
    // Finding #3: the sentinel is per-row-unique ('(erased):<row id>'), not the fixed literal
    // '(erased)' that collided with idx_campaign_rows_addr's partial UNIQUE index.
    expect(row.email).toMatch(/^\(erased\):/);
    expect(row.vars_json).toBe('{}');
    expect(row.skip_reason).toBe('erased');

    const auditRows = env.db.prepare(`SELECT detail_json FROM audit_log WHERE action = 'forget.execute'`).all() as Array<{ detail_json: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.detail_json).not.toContain('alice@example.com');
    expect(auditRows[0]?.detail_json).toContain('campaignRowsRedacted');
  });

  it('finding #3/#18: forgetting TWO addresses from the same campaign redacts both rows without a UNIQUE constraint failure', async () => {
    const { createCampaign, insertRows } = await import('../../src/db/campaigns.js');
    const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
    const campaign = createCampaign(env.db, {
      name: 'Q3',
      accountId: account.id,
      subjectTemplate: 'Hi',
      bodyHtmlTemplate: '<p>Hi</p>',
      fromEmail: 'sender@example.com',
      transport: 'dryrun',
      ratePerMinute: 60,
      jitterMs: 0,
      dailyCap: 100,
      emailColumn: 'email',
      columnsJson: '["email","company"]',
      createdAt: Date.now(),
    });
    insertRows(
      env.db,
      campaign.id,
      [
        { rowIndex: 0, email: 'alice@example.com', varsJson: JSON.stringify({ company: 'Acme' }), variant: 'A', status: 'sent' },
        { rowIndex: 1, email: 'carol@example.com', varsJson: JSON.stringify({ company: 'Acme' }), variant: 'A', status: 'sent' },
      ],
      Date.now(),
    );

    // First erasure: alice. Must not throw, and must not accidentally collide with carol's
    // still-live row under whatever sentinel is chosen.
    const planAlice = planForget(env.db, 'alice@example.com');
    expect(() =>
      executeForget(env.db, planAlice, { purgeBodies: false, keepSuppression: true, ipSalt: env.config.ipSalt, atMs: Date.now() }),
    ).not.toThrow();

    // Second erasure: carol, from the SAME campaign. Before the fix this threw
    // SQLITE_CONSTRAINT_UNIQUE (both rows redacted to the literal '(erased)', colliding under
    // idx_campaign_rows_addr's UNIQUE(campaign_id, email) WHERE status <> 'skipped'), rolling back
    // the whole erasure.
    const planCarol = planForget(env.db, 'carol@example.com');
    expect(() =>
      executeForget(env.db, planCarol, { purgeBodies: false, keepSuppression: true, ipSalt: env.config.ipSalt, atMs: Date.now() }),
    ).not.toThrow();

    const rows = env.db
      .prepare(`SELECT email, vars_json FROM campaign_rows WHERE campaign_id = ? ORDER BY row_index ASC`)
      .all(campaign.id) as Array<{ email: string; vars_json: string }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.email).toMatch(/^\(erased\):/);
      expect(row.vars_json).toBe('{}');
    }
    // Both sentinels are distinct - the whole point of the per-row fix.
    expect(rows[0]?.email).not.toBe(rows[1]?.email);
  });

  it('190. openpost forget also deletes that recipient\'s reminders and reports the count in the single (still address-free) audit row', async () => {
    const { alice1, message1 } = setup(env);
    const { createReminder } = await import('../../src/db/reminders.js');
    createReminder(env.db, { messageId: message1.id, recipientId: alice1.id, condition: 'no_reply', dueAt: SENT_AT + 86_400_000, createdAt: SENT_AT });

    const plan = planForget(env.db, 'alice@example.com');
    expect(plan.counts.reminders).toBe(1);
    const counts = executeForget(env.db, plan, { purgeBodies: false, keepSuppression: true, ipSalt: env.config.ipSalt, atMs: Date.now() });
    expect(counts.reminders).toBe(1);

    const remainingReminders = env.db.prepare('SELECT COUNT(*) AS n FROM reminders').get() as { n: number };
    expect(remainingReminders.n).toBe(0);

    const auditRows = env.db.prepare(`SELECT detail_json FROM audit_log WHERE action = 'forget.execute'`).all() as Array<{ detail_json: string }>;
    expect(auditRows).toHaveLength(1);
    expect(JSON.parse(auditRows[0]!.detail_json).reminders).toBe(1);
    expect(auditRows[0]!.detail_json).not.toContain('alice@example.com');
  });

  it('101. --purge-bodies nulls surviving message bodies; --full also drops the suppression row', () => {
    const { message2 } = setup(env);
    const plan = planForget(env.db, 'alice@example.com');
    executeForget(env.db, plan, { purgeBodies: true, keepSuppression: false, ipSalt: env.config.ipSalt, atMs: Date.now() });

    const survivingMessage = getMessage(env.db, message2.id);
    expect(survivingMessage?.body_html).toBeNull();
    expect(survivingMessage?.body_text).toBeNull();

    const suppression = env.db.prepare('SELECT 1 FROM suppressions WHERE email = ?').get('alice@example.com');
    expect(suppression).toBeUndefined();
  });

  it('102. after forget, a pixel hit on the old token -> 200 + GIF, zero events, one token.orphan', async () => {
    const { alice1 } = setup(env);
    const token = alice1.token;
    const plan = planForget(env.db, 'alice@example.com');
    executeForget(env.db, plan, { purgeBodies: false, keepSuppression: true, ipSalt: env.config.ipSalt, atMs: Date.now() });

    const secret = env.config.trackingSecret as string;
    const res = await env.app.inject({ method: 'GET', url: `/o/${signToken('o', token, secret)}.gif` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');

    const openEvents = env.db.prepare('SELECT COUNT(*) AS n FROM open_events').get() as { n: number };
    expect(openEvents.n).toBe(0);
    const orphanAudits = env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'token.orphan'`).get() as {
      n: number;
    };
    expect(orphanAudits.n).toBe(1);
  });
});

describe('finding #14: openpost forget (CLI) refuses to run with the hard-coded default IP_SALT', () => {
  const ORIGINAL_ENV = { ...process.env };
  let workDir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'openpost-forget-'));
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(workDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('exits with an error and never opens/touches the database when neither IP_SALT nor TRACKING_SECRET is set', async () => {
    process.env = { ...ORIGINAL_ENV, DB_PATH: join(workDir, 'openpost.db') };
    delete process.env.TRACKING_SECRET;
    delete process.env.IP_SALT;

    const program = createProgram();
    await program.parseAsync(['forget', 'alice@example.com', '--yes'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(2); // ConfigError-shaped: fail() exits 2 for config problems...
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(workDir, 'openpost.db'))).toBe(false);
  });

  it('proceeds normally once IP_SALT is set', async () => {
    process.env = { ...ORIGINAL_ENV, DB_PATH: join(workDir, 'openpost.db'), IP_SALT: 'a-real-per-install-salt' };
    delete process.env.TRACKING_SECRET;

    const program = createProgram();
    await program.parseAsync(['forget', 'alice@example.com', '--yes'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('finding #21: --json without --yes prints a warning (to stderr, never stdout) that it implies --yes', async () => {
    process.env = { ...ORIGINAL_ENV, DB_PATH: join(workDir, 'openpost.db'), IP_SALT: 'a-real-per-install-salt' };
    delete process.env.TRACKING_SECRET;

    const program = createProgram();
    await program.parseAsync(['forget', 'alice@example.com', '--json'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--json implies --yes'));

    // --json + --yes together: no need to warn, the caller already knew.
    stderrSpy.mockClear();
    await program.parseAsync(['forget', 'alice@example.com', '--json', '--yes'], { from: 'user' });
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});
