import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { ensureAccount } from '../../src/db/repo.js';
import { loadConfig } from '../../src/config/env.js';
import { assignVariant } from '../../src/core/variant.js';
import { campaignCounts, createCampaign, insertRows, requeueIndeterminate } from '../../src/db/campaigns.js';
import { recoverCampaign, runCampaignOnce } from '../../src/jobs/campaigns.js';

const TSX_BIN = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CRASH_SCRIPT = join(process.cwd(), 'scripts', 'campaign-crash-child.mjs');

function makeCampaign(dbPath: string, rowCount: number): { db: DB; campaignId: string } {
  const db = openDb(dbPath);
  migrate(db);
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const campaign = createCampaign(db, {
    name: 'crash test',
    accountId: account.id,
    subjectTemplate: 'Hi {{name}}',
    bodyHtmlTemplate: '<html><body><p>Hi {{name}}</p></body></html>',
    fromEmail: 'sender@example.com',
    transport: 'dryrun',
    ratePerMinute: 6000,
    jitterMs: 0,
    dailyCap: 100_000,
    emailColumn: 'email',
    columnsJson: '["name","email"]',
    createdAt: Date.now(),
  });
  const items = Array.from({ length: rowCount }, (_, i) => ({
    rowIndex: i,
    email: `row${i}@example.com`,
    varsJson: JSON.stringify({ name: `Row ${i}` }),
    variant: assignVariant(campaign.id, `row${i}@example.com`, [{ key: 'A', template: '', weight: 1 }]),
    status: 'pending' as const,
  }));
  insertRows(db, campaign.id, items, Date.now());
  return { db, campaignId: campaign.id };
}

describe('campaign crash-resume (DoD 2)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-campaign-crash-'));
    dbPath = join(dir, 'openpost.db');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('265. crash BETWEEN rows: every remaining row is pending, and a fresh run sends each exactly once', async () => {
    const { db, campaignId } = makeCampaign(dbPath, 5);
    db.close();

    const result = spawnSync(TSX_BIN, [CRASH_SCRIPT, dbPath, campaignId, 'between-rows', '1'], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    expect(result.signal === 'SIGKILL' || result.status === 137).toBe(true);

    const afterCrash = openDb(dbPath);
    const counts = campaignCounts(afterCrash, campaignId);
    // Row 0 was fully sent before the crash; row 1 was claimed but killed before beginRowSubmit -
    // recoverCampaign requeues it (and everything after it stays untouched, i.e. pending).
    expect(counts.sent).toBe(1);
    // Simulate having waited past the row's lease (avoids a real 120s sleep in the test).
    recoverCampaign(afterCrash, campaignId, Date.now() + 130_000, 120_000);
    const pendingOrClaimed = afterCrash
      .prepare(`SELECT COUNT(*) AS n FROM campaign_rows WHERE campaign_id = ? AND status IN ('pending','claimed')`)
      .get(campaignId) as { n: number };
    expect(pendingOrClaimed.n).toBe(4);
    afterCrash.close();

    const finalDb = openDb(dbPath);
    const finalConfig = loadConfig({
      TRACKING_SECRET: 'x'.repeat(40),
      TRACKING_BASE_URL: 'http://127.0.0.1:8787',
      DB_PATH: dbPath,
      MAIL_TRANSPORT: 'dryrun',
      FROM_EMAIL: 'sender@example.com',
    });
    await runCampaignOnce({ db: finalDb, config: finalConfig }, campaignId, { sleep: async () => undefined });
    const finalCounts = campaignCounts(finalDb, campaignId);
    expect(finalCounts.sent).toBe(5);
    const distinctMessages = finalDb
      .prepare(`SELECT COUNT(DISTINCT message_id) AS n FROM campaign_rows WHERE campaign_id = ? AND status='sent'`)
      .get(campaignId) as { n: number };
    expect(distinctMessages.n).toBe(5);
    finalDb.close();
  });

  it('266/267. crash AFTER submit began: one row is failed/indeterminate, never auto-resent; --retry-indeterminate requeues it', async () => {
    const { db, campaignId } = makeCampaign(dbPath, 3);
    db.close();

    const result = spawnSync(TSX_BIN, [CRASH_SCRIPT, dbPath, campaignId, 'mid-submit', '0'], {
      cwd: process.cwd(),
      timeout: 30_000,
    });
    expect(result.signal === 'SIGKILL' || result.status === 137).toBe(true);

    const afterCrash = openDb(dbPath);
    const claimedRow = afterCrash.prepare(`SELECT status, submit_started_at, lease_expires_at FROM campaign_rows WHERE row_index = 0`).get() as {
      status: string;
      submit_started_at: number | null;
      lease_expires_at: number | null;
    };
    expect(claimedRow.status).toBe('claimed');
    expect(claimedRow.submit_started_at).not.toBeNull();

    // Advance past the lease and recover: this must become terminal `failed`/`indeterminate:`, not
    // silently re-sent.
    const recovered = recoverCampaign(afterCrash, campaignId, (claimedRow.lease_expires_at as number) + 1000, 120_000);
    expect(recovered.indeterminate).toBe(1);
    const row0 = afterCrash.prepare(`SELECT status, last_error FROM campaign_rows WHERE row_index = 0`).get() as {
      status: string;
      last_error: string | null;
    };
    expect(row0.status).toBe('failed');
    expect(row0.last_error).toMatch(/^indeterminate:/);

    const config = loadConfig({ TRACKING_SECRET: 'x'.repeat(40), TRACKING_BASE_URL: 'http://127.0.0.1:8787', DB_PATH: dbPath, MAIL_TRANSPORT: 'dryrun', FROM_EMAIL: 'sender@example.com' });
    const freshRun = await runCampaignOnce({ db: afterCrash, config }, campaignId, { sleep: async () => undefined });
    expect(freshRun.sent).toBe(2); // rows 1 and 2 only - row 0 is never re-sent automatically
    const row0After = afterCrash.prepare(`SELECT status FROM campaign_rows WHERE row_index = 0`).get() as { status: string };
    expect(row0After.status).toBe('failed');

    const requeued = requeueIndeterminate(afterCrash, campaignId);
    expect(requeued).toBe(1);
    // The campaign is 'completed' by now; requeue alone doesn't restart it - a fresh run finishes it.
    const { setCampaignStatus } = await import('../../src/db/campaigns.js');
    setCampaignStatus(afterCrash, campaignId, 'running', Date.now());
    const finalRun = await runCampaignOnce({ db: afterCrash, config }, campaignId, { sleep: async () => undefined });
    expect(finalRun.sent).toBe(1);
    afterCrash.close();
  });
});
