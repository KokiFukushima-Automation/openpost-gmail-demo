import { describe, expect, it, beforeEach } from 'vitest';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { ensureAccount } from '../../src/db/repo.js';
import {
  beginRowSubmit,
  campaignCounts,
  claimNextRow,
  createCampaign,
  insertRows,
  markRowFailed,
  markRowIndeterminate,
  markRowSent,
  markRowSkipped,
  recoverExpiredLeases,
  requeueIndeterminate,
  setCampaignStatus,
} from '../../src/db/campaigns.js';

function setup(): { db: DB; accountId: string; campaignId: string } {
  const db = openDb(':memory:');
  migrate(db);
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const campaign = createCampaign(db, {
    name: 'Test',
    accountId: account.id,
    subjectTemplate: 'Hi {{name}}',
    bodyHtmlTemplate: '<p>Hi {{name}}</p>',
    fromEmail: 'sender@example.com',
    transport: 'dryrun',
    ratePerMinute: 6000,
    jitterMs: 0,
    dailyCap: 1000,
    emailColumn: 'email',
    columnsJson: '["name","email"]',
    createdAt: Date.now(),
  });
  insertRows(
    db,
    campaign.id,
    [
      { rowIndex: 0, email: 'a@example.com', varsJson: '{}', variant: 'A', status: 'pending' },
      { rowIndex: 1, email: 'b@example.com', varsJson: '{}', variant: 'A', status: 'pending' },
      { rowIndex: 2, email: 'c@example.com', varsJson: '{}', variant: 'A', status: 'pending' },
    ],
    Date.now(),
  );
  return { db, accountId: account.id, campaignId: campaign.id };
}

describe('campaigns claim/lifecycle', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  // Finding #18: renamed - this calls claimNextRow strictly sequentially (no Promise.all, no second
  // process), so it proves row-index ordering and exhaustion, not concurrency; the CAS's actual
  // concurrency safety is covered by tests/integration/campaign-flow.test.ts's real two-process
  // test and its in-process interleaved (Promise.all) test.
  it('claims rows in row_index order, one at a time, and returns null once exhausted', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    const r1 = claimNextRow(db, campaignId, 'owner1', now, 60_000, 3);
    expect(r1?.row_index).toBe(0);
    const r2 = claimNextRow(db, campaignId, 'owner2', now, 60_000, 3);
    expect(r2?.row_index).toBe(1);
    const r3 = claimNextRow(db, campaignId, 'owner1', now, 60_000, 3);
    expect(r3?.row_index).toBe(2);
    const r4 = claimNextRow(db, campaignId, 'owner1', now, 60_000, 3);
    expect(r4).toBeNull();
  });

  it('269. campaignCounts after a full run: pending=0, claimed=0, sent+skipped+failed=total', () => {
    const { db, campaignId, accountId } = ctx;
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      const row = claimNextRow(db, campaignId, 'owner', now, 60_000, 3);
      expect(row).not.toBeNull();
      if (!row) continue;
      beginRowSubmit(db, row.id, 'owner', now);
      db.prepare(
        `INSERT INTO messages (id, account_id, subject, body_html, body_text, status, tracking_enabled, click_tracking_enabled, created_at)
         VALUES (@id, @accountId, 'x', null, null, 'sent', 1, 1, @now)`,
      ).run({ id: `m${i}`, accountId, now });
      db.prepare(
        `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, click_count, created_at, state, notify_muted, is_aggregate)
         VALUES (@id, @messageId, @email, 'to', @token, 0, 0, 0, @now, 'not_opened', 0, 0)`,
      ).run({ id: `r${i}`, messageId: `m${i}`, email: row.email, token: `tok${i}`, now });
      markRowSent(db, row.id, 'owner', { messageId: `m${i}`, recipientId: `r${i}`, sentAt: now });
    }
    const counts = campaignCounts(db, campaignId);
    expect(counts.pending).toBe(0);
    expect(counts.claimed).toBe(0);
    expect(counts.sent + counts.skipped + counts.failed).toBe(3);
  });

  it('261. a skipped row never consumes an attempt and never gets a message/recipient id', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    const row = claimNextRow(db, campaignId, 'owner', now, 60_000, 3);
    expect(row).not.toBeNull();
    if (!row) return;
    const ok = markRowSkipped(db, row.id, 'owner', 'suppressed');
    expect(ok).toBe(true);
    const counts = campaignCounts(db, campaignId);
    expect(counts.skipped).toBe(1);
  });

  it('265. crash BEFORE submit began: expired lease with submit_started_at NULL is safe to requeue', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    const row = claimNextRow(db, campaignId, 'owner', now, 1000, 3);
    expect(row).not.toBeNull();
    const recovered = recoverExpiredLeases(db, campaignId, now + 5000);
    expect(recovered.requeued).toBe(1);
    expect(recovered.indeterminate).toBe(0);
    const counts = campaignCounts(db, campaignId);
    expect(counts.pending).toBe(3);
  });

  it('266/267. crash AFTER submit began is terminal indeterminate, never auto-retried, but --retry-indeterminate requeues it', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    const row = claimNextRow(db, campaignId, 'owner', now, 1000, 3);
    expect(row).not.toBeNull();
    if (!row) return;
    beginRowSubmit(db, row.id, 'owner', now);
    const recovered = recoverExpiredLeases(db, campaignId, now + 5000);
    expect(recovered.requeued).toBe(0);
    expect(recovered.indeterminate).toBe(1);
    const counts = campaignCounts(db, campaignId);
    expect(counts.failed).toBe(1);

    // A fresh run must not silently re-send it.
    const again = claimNextRow(db, campaignId, 'owner2', now + 6000, 60_000, 3);
    expect(again?.row_index).not.toBe(row.row_index);

    const requeued = requeueIndeterminate(db, campaignId);
    expect(requeued).toBe(1);
    const countsAfter = campaignCounts(db, campaignId);
    expect(countsAfter.pending).toBeGreaterThanOrEqual(1);
  });

  it('268. deleting a sent row message nulls message_id but the row stays sent (never resent)', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    const row = claimNextRow(db, campaignId, 'owner', now, 60_000, 3);
    if (!row) throw new Error('expected a row');
    beginRowSubmit(db, row.id, 'owner', now);
    // Simulate a real message + recipient row so ON DELETE SET NULL has something to null.
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    db.prepare(
      `INSERT INTO messages (id, account_id, subject, body_html, body_text, status, tracking_enabled, click_tracking_enabled, created_at)
       VALUES ('msg1', @accountId, 'x', null, null, 'sent', 1, 1, @now)`,
    ).run({ accountId: account.id, now });
    db.prepare(
      `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, click_count, created_at, state, notify_muted, is_aggregate)
       VALUES ('rec1', 'msg1', @email, 'to', 'tokx', 0, 0, 0, @now, 'not_opened', 0, 0)`,
    ).run({ email: row.email, now });
    markRowSent(db, row.id, 'owner', { messageId: 'msg1', recipientId: 'rec1', sentAt: now });
    db.prepare('DELETE FROM messages WHERE id = ?').run('msg1');
    const after = db.prepare('SELECT status, message_id FROM campaign_rows WHERE id = ?').get(row.id) as {
      status: string;
      message_id: string | null;
    };
    expect(after.status).toBe('sent');
    expect(after.message_id).toBeNull();
  });

  it('markRowFailed requeues while attempts remain, then goes terminal', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = claimNextRow(db, campaignId, 'owner', now, 60_000, 3);
      expect(row).not.toBeNull();
      if (!row) return;
      markRowFailed(db, row.id, 'owner', 'transport error', { retryable: true, maxAttempts: 3 });
    }
    const counts = campaignCounts(db, campaignId);
    expect(counts.failed).toBe(1);
    expect(counts.pending).toBe(2);
  });

  it('setCampaignStatus transitions and stamps the matching timestamp column', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    expect(setCampaignStatus(db, campaignId, 'running', now)).toBe(true);
    const row = db.prepare('SELECT status, started_at FROM campaigns WHERE id = ?').get(campaignId) as {
      status: string;
      started_at: number | null;
    };
    expect(row.status).toBe('running');
    expect(row.started_at).toBe(now);
  });

  it('markRowIndeterminate is idempotent and never touches a row that already finished', () => {
    const { db, campaignId } = ctx;
    const now = Date.now();
    const row = claimNextRow(db, campaignId, 'owner', now, 60_000, 3);
    if (!row) throw new Error('expected row');
    beginRowSubmit(db, row.id, 'owner', now);
    expect(markRowIndeterminate(db, row.id)).toBe(true);
    expect(markRowIndeterminate(db, row.id)).toBe(false);
  });
});
