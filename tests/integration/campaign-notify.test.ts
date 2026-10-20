import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { ensureAccount, insertOpenEvent } from '../../src/db/repo.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { createCampaign, insertRows, markRowSent, claimNextRow, beginRowSubmit } from '../../src/db/campaigns.js';
import { runCampaignDigestOnce } from '../../src/jobs/campaign-digest.js';

function baseEnv(dir: string): NodeJS.ProcessEnv {
  return {
    TRACKING_SECRET: 'a'.repeat(40),
    TRACKING_BASE_URL: 'http://localhost:8787',
    FROM_EMAIL: 'sender@example.com',
    MAIL_TRANSPORT: 'dryrun',
    OUT_DIR: join(dir, 'out'),
    NOTIFY_CHANNELS: 'slack',
    SLACK_WEBHOOK_URL: 'http://127.0.0.1:1/webhook',
    NOTIFY_ALLOW_PRIVATE_URLS: 'true',
  };
}

describe('campaign digest notifications', () => {
  let dir: string;
  let db: DB;
  let config: AppConfig;
  let campaignId: string;
  let seedAtMs: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-campaign-notify-'));
    config = loadConfig(baseEnv(dir));
    db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const campaign = createCampaign(db, {
      name: 'Q3 outreach',
      accountId: account.id,
      subjectTemplate: 'Hi {{name}}',
      bodyHtmlTemplate: '<p>Hi {{name}}</p>',
      fromEmail: 'sender@example.com',
      transport: 'dryrun',
      ratePerMinute: 6000,
      jitterMs: 0,
      dailyCap: 100_000,
      emailColumn: 'email',
      columnsJson: '["email"]',
      createdAt: Date.now(),
    });
    campaignId = campaign.id;
    // Fixed clock for every row's timestamps - avoids any real-wall-clock boundary flakiness
    // between "when a row was sent" and "when the digest window closes" under a loaded machine.
    const fixedNow = 1_800_000_000_000;
    seedAtMs = fixedNow;
    // Seed 50 sent rows with real recipients/messages, 30 of which get an open event.
    const items = Array.from({ length: 50 }, (_, i) => ({
      rowIndex: i,
      email: `row${i}@example.com`,
      varsJson: '{}',
      variant: 'A',
      status: 'pending' as const,
    }));
    insertRows(db, campaignId, items, fixedNow);
    db.prepare(`UPDATE campaigns SET status = 'running' WHERE id = ?`).run(campaignId);

    for (let i = 0; i < 50; i++) {
      const row = claimNextRow(db, campaignId, 'test', fixedNow, 60_000, 3);
      if (!row) continue;
      beginRowSubmit(db, row.id, 'test', fixedNow);
      db.prepare(
        `INSERT INTO messages (id, account_id, subject, body_html, body_text, status, tracking_enabled, click_tracking_enabled, created_at, campaign_id)
         VALUES (@id, @accountId, 'x', null, null, 'sent', 1, 1, @now, @campaignId)`,
      ).run({ id: `m${i}`, accountId: account.id, now: fixedNow, campaignId });
      db.prepare(
        `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, click_count, created_at, state, notify_muted, is_aggregate)
         VALUES (@id, @messageId, @email, 'to', @token, 0, 0, 0, @now, 'not_opened', 0, 0)`,
      ).run({ id: `r${i}`, messageId: `m${i}`, email: row.email, token: `tok${i}`, now: fixedNow });
      markRowSent(db, row.id, 'test', { messageId: `m${i}`, recipientId: `r${i}`, sentAt: fixedNow });
      if (i < 30) {
        insertOpenEvent(db, {
          recipientId: `r${i}`,
          occurredAt: fixedNow,
          classification: 'human',
          confidence: 0.9,
          counted: true,
          reason: 'R9',
          ipHash: null,
          ipNetHash: null,
          ua: null,
          uaFamily: null,
          deviceType: null,
          os: null,
        });
      }
    }
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('278. 30 opens in one window produce exactly one digest per channel; a second pass in the same window enqueues nothing', async () => {
    const first = await runCampaignDigestOnce({ db, config }, seedAtMs + 1000);
    expect(first.digestsSent).toBe(1);
    const rows = db.prepare(`SELECT * FROM notifications WHERE campaign_id = ?`).all(campaignId) as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);

    const second = await runCampaignDigestOnce({ db, config }, seedAtMs + 2000);
    expect(second.digestsSent).toBe(0);
    const rowsAfter = db.prepare(`SELECT * FROM notifications WHERE campaign_id = ?`).all(campaignId) as unknown[];
    expect(rowsAfter).toHaveLength(1);
  });

  it('279. the digest payload names no recipient anywhere in its JSON', async () => {
    await runCampaignDigestOnce({ db, config }, seedAtMs + 1000);
    const row = db.prepare(`SELECT payload_json FROM notifications WHERE campaign_id = ?`).get(campaignId) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { recipient: { email: string | null; id: string }; campaign?: { sent: number; opened: number } };
    expect(payload.recipient.email).toBeNull();
    expect(payload.recipient.id).toBe('');
    expect(row.payload_json).not.toMatch(/row\d+@example\.com/);
    expect(payload.campaign?.sent).toBe(50);
    expect(payload.campaign?.opened).toBe(30);
  });

  it('281. a completed campaign emits a final digest even when the window has not elapsed', async () => {
    await runCampaignDigestOnce({ db, config }, seedAtMs + 1000);
    db.prepare(`UPDATE campaigns SET status = 'completed', finished_at = @now WHERE id = @id`).run({ now: seedAtMs + 2000, id: campaignId });
    const result = await runCampaignDigestOnce({ db, config }, seedAtMs + 3000);
    expect(result.digestsSent).toBe(1);
    const rows = db.prepare(`SELECT * FROM notifications WHERE campaign_id = ? AND dedupe_key LIKE 'final:%'`).all(campaignId) as unknown[];
    expect(rows).toHaveLength(1);
    expect((db.prepare('SELECT final_digest_sent_at FROM campaigns WHERE id = ?').get(campaignId) as { final_digest_sent_at: number | null }).final_digest_sent_at).not.toBeNull();
  });

  it('finding #16: a campaign that completes before its FIRST periodic digest pass still gets exactly one final digest (digest_from was never set)', async () => {
    // No prior runCampaignDigestOnce call at all - digest_from is still NULL, exactly the gap the
    // old `digest_from IS NOT NULL` requirement on the "just finished" query missed entirely.
    expect((db.prepare('SELECT digest_from FROM campaigns WHERE id = ?').get(campaignId) as { digest_from: number | null }).digest_from).toBeNull();
    db.prepare(`UPDATE campaigns SET status = 'completed', finished_at = @now WHERE id = @id`).run({ now: seedAtMs + 500, id: campaignId });

    const result = await runCampaignDigestOnce({ db, config }, seedAtMs + 1000);
    expect(result.digestsSent).toBe(1);
    const rows = db.prepare(`SELECT * FROM notifications WHERE campaign_id = ? AND dedupe_key LIKE 'final:%'`).all(campaignId) as Array<{ payload_json: string }>;
    expect(rows).toHaveLength(1);
    // The payload's counts must still be correct - windowFrom fell back to started_at/created_at,
    // not some arbitrary/zero value that would have missed the 50 sent rows.
    const payload = JSON.parse(rows[0]!.payload_json) as { campaign?: { sent: number; opened: number } };
    expect(payload.campaign?.sent).toBe(50);
    expect(payload.campaign?.opened).toBe(30);
  });

  it('finding #16: the final digest is never re-sent after its notification row is purged, because final_digest_sent_at persists on the campaign row', async () => {
    db.prepare(`UPDATE campaigns SET status = 'completed', finished_at = @now WHERE id = @id`).run({ now: seedAtMs + 500, id: campaignId });
    const first = await runCampaignDigestOnce({ db, config }, seedAtMs + 1000);
    expect(first.digestsSent).toBe(1);

    // Simulate retention purging every notification row for this campaign - the old duplicate
    // guard (`NOT EXISTS (... dedupe_key LIKE 'final:%')`) would then see nothing and re-enqueue.
    db.prepare('DELETE FROM notifications WHERE campaign_id = ?').run(campaignId);
    expect((db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE campaign_id = ?').get(campaignId) as { n: number }).n).toBe(0);

    const second = await runCampaignDigestOnce({ db, config }, seedAtMs + 2000);
    expect(second.digestsSent).toBe(0);
    const rowsAfter = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE campaign_id = ?').get(campaignId) as { n: number };
    expect(rowsAfter.n).toBe(0);
  });
});
