import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import type { DraftClient } from '../../src/mail/draft.js';
import { migrate, openDb } from '../../src/db/index.js';
import { addRecipient, createMessage, ensureAccount, markMessageSent, markRecipientSent } from '../../src/db/repo.js';
import { createReminder, getReminder, listReminders } from '../../src/db/reminders.js';
import { listNotifications } from '../../src/notify/queue.js';
import { newId } from '../../src/core/ids.js';
import { makeConfig, TEST_SECRET } from '../helpers/setup.js';
import { runRemindersOnce } from '../../src/jobs/reminders.js';
import { EventBus } from '../../src/notify/bus.js';
import { NotifyWorker } from '../../src/notify/worker.js';

const ORIGINAL_ENV = { ...process.env };
const SENT_AT = 1_700_000_000_000;

function runCli(args: string[]): Promise<void> {
  const program = createProgram();
  return program.parseAsync(['node', 'openpost', ...args]);
}

function captureStdout(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return { logs, restore: () => (process.stdout.write = original) };
}

describe('reminders CLI flow', () => {
  let dbPath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dbPath = join(mkdtempSync(join(tmpdir(), 'openpost-db-')), 'test.db');
    process.env = {
      ...ORIGINAL_ENV,
      TRACKING_SECRET: TEST_SECRET,
      TRACKING_BASE_URL: 'http://127.0.0.1:8787',
      DB_PATH: dbPath,
      MAIL_TRANSPORT: 'dryrun',
      NOTIFY_CHANNELS: 'slack',
      SLACK_WEBHOOK_URL: 'http://127.0.0.1:1/webhook',
      NOTIFY_ALLOW_PRIVATE_URLS: 'true',
    };
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const db = openDb(dbPath);
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, { accountId: account.id, subject: 'hello', bodyHtml: '<p>hi</p>', bodyText: 'hi', status: 'sent', trackingEnabled: true, clickTrackingEnabled: false });
    markMessageSent(db, message.id, { rfc822MsgId: '<orig@example.com>', sentAt: SENT_AT });
    const recipient = addRecipient(db, { messageId: message.id, email: 'alice@example.com', token: newId() });
    markRecipientSent(db, recipient.id, { rfc822MsgId: '<orig@example.com>', sentAt: SENT_AT, threadId: 'thread-1' });
    db.close();
    process.env.OPENPOST_MESSAGE_ID = message.id;
    process.env.OPENPOST_RECIPIENT_ID = recipient.id;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    exitSpy.mockRestore();
    rmSync(dbPath, { force: true });
  });

  it('171. `openpost remind <id> --if no-reply --in 3d --json` prints {reminderId, dueAt, condition} and inserts one row; --at in the past exits 2', async () => {
    const messageId = process.env.OPENPOST_MESSAGE_ID as string;
    const cap = captureStdout();
    try {
      await runCli(['remind', messageId, '--if', 'no-reply', '--in', '3d', '--json']);
    } finally {
      cap.restore();
    }
    const jsonLine = cap.logs.find((l) => l.trim().startsWith('{'));
    const parsed = JSON.parse(jsonLine as string) as { reminderId: string; dueAt: number; condition: string };
    expect(parsed.condition).toBe('no_reply');
    expect(typeof parsed.reminderId).toBe('string');

    const db = openDb(dbPath);
    expect(listReminders(db, {})).toHaveLength(1);
    db.close();

    const past = new Date(Date.now() - 60_000).toISOString();
    const cap2 = captureStdout();
    try {
      await runCli(['remind', messageId, '--if', 'no-reply', '--at', past, '--json']);
    } finally {
      cap2.restore();
    }
    expect(exitSpy).toHaveBeenCalledWith(2);
    // M9: exit code alone doesn't prove much - the error must actually name what was wrong
    // (--at), not just fail generically.
    const errorLine = cap2.logs.find((l) => l.includes('"error"'));
    expect(errorLine).toBeTruthy();
    expect(JSON.parse(errorLine as string).error).toContain('--at');
    expect(JSON.parse(errorLine as string).error).toContain('future');
  });

  it('L7. `--if constructor` is rejected (Object.hasOwn, not a plain-object index into Object.prototype)', async () => {
    const messageId = process.env.OPENPOST_MESSAGE_ID as string;
    const cap = captureStdout();
    try {
      await runCli(['remind', messageId, '--if', 'constructor', '--in', '1d', '--json']);
    } finally {
      cap.restore();
    }
    expect(exitSpy).toHaveBeenCalledWith(2);
    const errorLine = cap.logs.find((l) => l.includes('"error"'));
    expect(errorLine).toBeTruthy();
    expect(JSON.parse(errorLine as string).error).toContain('--if must be one of');

    const db = openDb(dbPath);
    expect(listReminders(db, {})).toHaveLength(0); // no bogus reminder row was ever created
    db.close();
  });

  it('172. `openpost reminders list/cancel` filter and cancel correctly; --all-pending cancels only pending rows', async () => {
    const messageId = process.env.OPENPOST_MESSAGE_ID as string;
    await runCli(['remind', messageId, '--if', 'no-reply', '--in', '1d', '--json']);
    await runCli(['remind', messageId, '--if', 'always', '--in', '2d', '--json']);

    const db = openDb(dbPath);
    const all = listReminders(db, {});
    expect(all).toHaveLength(2);
    db.close();

    const cap = captureStdout();
    try {
      await runCli(['reminders', 'cancel', '--all-pending', '--json']);
    } finally {
      cap.restore();
    }
    const jsonLine = cap.logs.find((l) => l.trim().startsWith('{'));
    expect(JSON.parse(jsonLine as string)).toEqual({ cancelled: 2 });

    const db2 = openDb(dbPath);
    const after = listReminders(db2, {});
    expect(after.every((r) => r.status === 'cancelled')).toBe(true);
    db2.close();
  });

  it('173. a fired reminder enqueues exactly one notification per configured channel with trigger reminder and the right dedupe key', async () => {
    const messageId = process.env.OPENPOST_MESSAGE_ID as string;
    await runCli(['remind', messageId, '--if', 'always', '--in', '1m', '--json']);

    const future = new Date(Date.now() + 120_000).toISOString();
    await runCli(['reminders', 'run', '--now', future, '--json']);

    const db = openDb(dbPath);
    const notifications = listNotifications(db, {});
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.trigger).toBe('reminder');
    expect(notifications[0]?.dedupe_key).toMatch(/^slack:reminder:/);
    db.close();
  });

  it('174. a muted message still fires its reminder (P7)', async () => {
    const messageId = process.env.OPENPOST_MESSAGE_ID as string;
    await runCli(['mute', messageId, '--json']);
    await runCli(['remind', messageId, '--if', 'always', '--in', '1m', '--json']);
    const future = new Date(Date.now() + 120_000).toISOString();

    const cap = captureStdout();
    try {
      await runCli(['reminders', 'run', '--now', future, '--json']);
    } finally {
      cap.restore();
    }
    const db = openDb(dbPath);
    const notifications = listNotifications(db, {});
    expect(notifications.some((n) => n.trigger === 'reminder')).toBe(true);
    db.close();
  });

  it('M3e. draft recovery: an uncertain findDraftByHeader result never creates a duplicate draft', async () => {
    const messageId = process.env.OPENPOST_MESSAGE_ID as string;
    const recipientId = process.env.OPENPOST_RECIPIENT_ID as string;
    const nowMs = 1_800_000_000_000;

    const db = openDb(dbPath);
    const reminder = createReminder(db, {
      messageId,
      recipientId,
      condition: 'always',
      dueAt: nowMs - 1000,
      createdAt: nowMs - 5000,
      draft: true,
      draftBodyHtml: '<p>hi</p>',
    });
    // Simulate a prior crashed attempt: noteDraftAttempt ran (§3.5), but recordDraft never did.
    db.prepare('UPDATE reminders SET draft_attempted_at = ? WHERE id = ?').run(nowMs - 4000, reminder.id);
    db.close();

    let createCalls = 0;
    const uncertainDraftClient: DraftClient = {
      async createDraft(input) {
        createCalls += 1;
        return { draftId: 'should-never-be-created', messageId: null, threadId: input.threadId };
      },
      async findDraftByHeader() {
        return { status: 'uncertain' };
      },
    };

    const db2 = openDb(dbPath);
    const config = makeConfig({ dbPath });
    const bus = new EventBus();
    const result = await runRemindersOnce({ db: db2, config, bus, draftClient: uncertainDraftClient, owner: 'test' }, nowMs, 10);
    expect(result.fired).toBe(1);
    expect(createCalls).toBe(0); // never falls through to creating a second draft
    const after = getReminder(db2, reminder.id);
    expect(after?.draft_status).toBe('uncertain');
    expect(after?.draft_id).toBeNull();
    db2.close();
  });

  it('176. crash safety (DoD 3): SIGKILL between enqueue and fire, then a fresh pass notifies exactly once', () => {
    const messageId = process.env.OPENPOST_MESSAGE_ID as string;
    const recipientId = process.env.OPENPOST_RECIPIENT_ID as string;
    const nowMs = 1_800_000_000_000;

    const db = openDb(dbPath);
    const reminder = createReminder(db, {
      messageId,
      recipientId,
      condition: 'always',
      dueAt: nowMs - 1000,
      createdAt: nowMs - 5000,
    });
    db.close();

    // Real process death, mid-fire, via a SIGKILL the parent cannot intercept - proving the crash
    // recovery is a property of the on-disk state, not of any in-process cleanup. Depending on the
    // platform, a SIGKILL'd child is reported either as `signal: 'SIGKILL'` or as `status: 137`
    // (128 + SIGKILL's number 9) once it has crossed a process boundary - both mean the same thing.
    const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
    const result = spawnSync(tsxBin, [join(process.cwd(), 'scripts', 'reminder-crash-child.mjs'), dbPath, String(nowMs)], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    expect(result.signal === 'SIGKILL' || result.status === 137).toBe(true);

    const afterCrash = openDb(dbPath);
    const claimedRow = listReminders(afterCrash, {})[0];
    expect(claimedRow?.id).toBe(reminder.id);
    expect(claimedRow?.status).toBe('claimed');
    expect(claimedRow?.lease_expires_at).not.toBeNull();
    expect((claimedRow?.lease_expires_at as number) > nowMs).toBe(true);
    // Phase 3.1 (M5): the crash now happens right after notifyEnqueue (via the onEnqueued seam),
    // not right after the claim - so the crash-safety property this test actually needs to prove
    // is that the enqueue already durably happened (one notification row exists) even though the
    // reminder itself never made it to `fired`, AND that the eventual recovery pass's own
    // (idempotent, dedupe-keyed) re-enqueue does not produce a second row.
    expect(listNotifications(afterCrash, {})).toHaveLength(1);
    afterCrash.close();

    // Advance past the lease (synthetic clock - no real waiting) and run a fresh firing pass.
    const config = makeConfig({ dbPath, notifyChannels: ['slack'], slackWebhookUrl: 'http://127.0.0.1:1/webhook' });
    const nowAfterLease = nowMs + config.reminderLeaseMs + 1000;
    const db2 = openDb(dbPath);
    const bus = new EventBus();
    const notifyWorker = new NotifyWorker({ db: db2, config, bus });
    const secondPass = runRemindersOnce(
      { db: db2, config, bus, owner: 'parent-recovery', notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e) },
      nowAfterLease,
      10,
    );
    return secondPass.then((firstResult) => {
      expect(firstResult.fired).toBe(1);
      const firedRows = listReminders(db2, { status: 'fired' });
      expect(firedRows).toHaveLength(1);
      expect(listNotifications(db2, {})).toHaveLength(1);

      // A second pass at the same (or later) time adds nothing - the reminder is terminal.
      return runRemindersOnce(
        { db: db2, config, bus, owner: 'parent-recovery-2', notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e) },
        nowAfterLease + 1000,
        10,
      ).then((thirdResult) => {
        expect(thirdResult.fired).toBe(0);
        expect(listNotifications(db2, {})).toHaveLength(1);
        db2.close();
      });
    });
  }, 40_000);
});
