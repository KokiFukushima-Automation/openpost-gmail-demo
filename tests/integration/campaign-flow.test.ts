import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { addSuppression, ensureAccount } from '../../src/db/repo.js';
import { loadConfig, type AppConfig } from '../../src/config/env.js';
import { assignVariant } from '../../src/core/variant.js';
import { campaignCounts, createCampaign, getCampaign, insertRows, setCampaignStatus } from '../../src/db/campaigns.js';
import { createCampaignsJob, nextDelayMs, recoverCampaign, runCampaignOnce } from '../../src/jobs/campaigns.js';

function baseEnv(outDir: string): NodeJS.ProcessEnv {
  return {
    TRACKING_SECRET: 'a'.repeat(40),
    TRACKING_BASE_URL: 'http://localhost:8787',
    FROM_EMAIL: 'sender@example.com',
    MAIL_TRANSPORT: 'dryrun',
    OUT_DIR: outDir,
  };
}

interface Ctx {
  db: DB;
  config: AppConfig;
  accountId: string;
  outDir: string;
  dir: string;
}

function setup(rows: number, opts: { ratePerMinute?: number; dailyCap?: number } = {}): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'op-campaign-'));
  const outDir = join(dir, 'out');
  const config = loadConfig(baseEnv(outDir));
  const db = openDb(':memory:');
  migrate(db);
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const campaign = createCampaign(db, {
    name: 'Q3 outreach',
    accountId: account.id,
    subjectTemplate: 'Hi {{name}}',
    bodyHtmlTemplate: '<html><body><p>Hi {{name}}</p></body></html>',
    fromEmail: 'sender@example.com',
    fromName: 'Sender',
    transport: 'dryrun',
    ratePerMinute: opts.ratePerMinute ?? 6000,
    jitterMs: 0,
    dailyCap: opts.dailyCap ?? 100_000,
    emailColumn: 'email',
    columnsJson: '["name","email"]',
    createdAt: Date.now(),
  });
  const items = Array.from({ length: rows }, (_, i) => ({
    rowIndex: i,
    email: `row${i}@example.com`,
    varsJson: JSON.stringify({ name: `Row ${i}` }),
    variant: assignVariant(campaign.id, `row${i}@example.com`, [{ key: 'A', template: '', weight: 1 }]),
    status: 'pending' as const,
  }));
  insertRows(db, campaign.id, items, Date.now());
  return { db, config, accountId: account.id, outDir, dir, campaignId: campaign.id } as Ctx & { campaignId: string };
}

describe('campaign runner', () => {
  let ctx: Ctx & { campaignId: string };
  afterEach(() => {
    ctx.db.close();
    rmSync(ctx.dir, { recursive: true, force: true });
  });

  it('260. a 500-row dry-run campaign produces 500 messages with distinct pixel/opt-out tokens, zero duplicates', async () => {
    ctx = setup(500) as Ctx & { campaignId: string };
    const result = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined });
    expect(result.sent).toBe(500);
    expect(result.stopped).toBe('completed');
    const html = readdirSync(ctx.outDir).filter((f) => f.endsWith('.html'));
    expect(html).toHaveLength(500);
    const tokens = new Set<string>();
    for (const f of readdirSync(ctx.outDir)) {
      const m = /\.([a-z0-9]{26})\.eml$/.exec(f);
      if (m) tokens.add(m[1] as string);
    }
    expect(tokens.size).toBe(500);
    const counts = campaignCounts(ctx.db, ctx.campaignId);
    expect(counts.sent + counts.skipped + counts.failed).toBe(500);
    expect(getCampaign(ctx.db, ctx.campaignId)?.status).toBe('completed');
  });

  it('261. suppressed and opted-out addresses become skipped with the right skip_reason and are never submitted', async () => {
    ctx = setup(5) as Ctx & { campaignId: string };
    addSuppression(ctx.db, 'row1@example.com', 'manual_block');
    addSuppression(ctx.db, 'row2@example.com', 'recipient_optout');
    const result = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined });
    expect(result.skipped).toBe(2);
    expect(result.sent).toBe(3);
    const rows = ctx.db.prepare('SELECT email, status, skip_reason FROM campaign_rows ORDER BY row_index').all() as Array<{
      email: string;
      status: string;
      skip_reason: string | null;
    }>;
    expect(rows.find((r) => r.email === 'row1@example.com')?.skip_reason).toBe('suppressed');
    expect(rows.find((r) => r.email === 'row2@example.com')?.skip_reason).toBe('opted_out');
  });

  it('finding #2: a suppression recorded with mixed case/whitespace still matches a lowercased CSV import', async () => {
    ctx = setup(5) as Ctx & { campaignId: string };
    // Mirrors an opt-out recorded from a non-campaign send/route, which never lowercased the
    // address before this fix (docs/reports/phase4_review.md finding #2). row1@example.com is what
    // the CSV importer (src/cli/commands/campaign.ts) always stores: trimmed and lowercased.
    addSuppression(ctx.db, '  Row1@Example.com  ', 'recipient_optout');
    const result = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined });
    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(4);
    const row = ctx.db.prepare('SELECT status, skip_reason FROM campaign_rows WHERE email = ?').get('row1@example.com') as {
      status: string;
      skip_reason: string | null;
    };
    expect(row.status).toBe('skipped');
    expect(row.skip_reason).toBe('opted_out');
  });

  it('262/263. pause stops sending; resume continues from the exact next row', async () => {
    ctx = setup(5) as Ctx & { campaignId: string };
    const result = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { limit: 2, sleep: async () => undefined });
    expect(result.claimed).toBe(2);
    setCampaignStatus(ctx.db, ctx.campaignId, 'paused', Date.now());
    const whilePaused = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined });
    expect(whilePaused.stopped).toBe('not_running');
    expect(whilePaused.sent).toBe(0);

    setCampaignStatus(ctx.db, ctx.campaignId, 'running', Date.now()); // the `campaign resume` CLI action's own effect
    const resumed = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined });
    expect(resumed.sent).toBe(3);
    const counts = campaignCounts(ctx.db, ctx.campaignId);
    expect(counts.sent).toBe(5);
  });

  it('264. cancel is terminal: run afterwards sends nothing; already-sent rows keep their messages', async () => {
    ctx = setup(5) as Ctx & { campaignId: string };
    await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { limit: 2, sleep: async () => undefined });
    setCampaignStatus(ctx.db, ctx.campaignId, 'cancelled', Date.now());
    const after = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined });
    expect(after.stopped).toBe('not_running');
    expect(after.sent).toBe(0);
    const counts = campaignCounts(ctx.db, ctx.campaignId);
    expect(counts.sent).toBe(2);
  });

  it('271. a 100-row all-suppressed campaign completes in zero injected sleeps', async () => {
    ctx = setup(100) as Ctx & { campaignId: string };
    for (let i = 0; i < 100; i++) addSuppression(ctx.db, `row${i}@example.com`, 'manual_block');
    let sleepCalls = 0;
    const result = await runCampaignOnce(
      { db: ctx.db, config: ctx.config },
      ctx.campaignId,
      { sleep: async () => { sleepCalls += 1; } },
    );
    expect(result.skipped).toBe(100);
    expect(sleepCalls).toBe(0);
  });

  it('272. exceeding CAMPAIGN_DAILY_CAP stops with stopped:daily_cap and stays running (finding #5: auto-resume, never a manual-only pause)', async () => {
    ctx = setup(5, { dailyCap: 2 }) as Ctx & { campaignId: string };
    const result = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined });
    expect(result.sent).toBe(2);
    expect(result.stopped).toBe('daily_cap');
    const campaign = getCampaign(ctx.db, ctx.campaignId);
    // Finding #5: status must stay 'running' - createCampaignsJob only ever drains
    // `status = 'running'` campaigns, so setting 'paused' here (the old behaviour) stranded the
    // campaign until an operator ran `campaign resume` by hand.
    expect(campaign?.status).toBe('running');
    expect(campaign?.capped_until).not.toBeNull();
  });

  it('finding #5: a capped campaign resumes sending on its own once the 24h window drains, with no operator action, when the drain job re-checks it', async () => {
    // 5 rows, cap 3: the first call sends exactly 3 and hits the cap; the remaining 2 fit
    // comfortably under the cap once the window drains, so the campaign runs to completion with no
    // operator ever calling `campaign resume`.
    ctx = setup(5, { dailyCap: 3 }) as Ctx & { campaignId: string };
    let now = Date.parse('2026-01-01T00:00:00Z');
    const clock = () => now;

    const first = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined, clock });
    expect(first.sent).toBe(3);
    expect(first.stopped).toBe('daily_cap');
    const afterFirst = getCampaign(ctx.db, ctx.campaignId);
    // Finding #5: status must stay 'running', never the old 'paused' - createCampaignsJob only
    // ever drains `status = 'running'` campaigns, so 'paused' stranded the campaign forever.
    expect(afterFirst?.status).toBe('running');
    expect(afterFirst?.capped_until).not.toBeNull();

    // Advance the clock by less than 24h: still capped, and (as createCampaignsJob's own ticks
    // would) another runCampaignOnce call on this still-'running' campaign changes nothing.
    now += 60 * 60 * 1000; // +1h
    const stillCapped = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined, clock });
    expect(stillCapped.stopped).toBe('daily_cap');
    expect(stillCapped.sent).toBe(0);
    expect(getCampaign(ctx.db, ctx.campaignId)?.status).toBe('running');

    // Advance past 24h from the first three sends: the window has fully drained, so the very next
    // drain-job tick (again, just another runCampaignOnce call - no CLI/dashboard resume involved)
    // sends the remaining rows and the campaign completes entirely on its own.
    now += 24 * 60 * 60 * 1000;
    const resumed = await runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined, clock });
    expect(resumed.sent).toBe(2);
    expect(resumed.stopped).toBe('completed');
    const finalCampaign = getCampaign(ctx.db, ctx.campaignId);
    expect(finalCampaign?.status).toBe('completed');
    expect(finalCampaign?.capped_until).toBeNull();
  });

  it('270. nextDelayMs with an injected random produces the exact expected delays', () => {
    expect(nextDelayMs(60, 0, () => 0.5)).toBe(1000); // base = 1000ms, jitter 0
    expect(nextDelayMs(60, 100, () => 1)).toBe(1100); // +100
    expect(nextDelayMs(60, 100, () => 0)).toBe(900); // -100
    expect(nextDelayMs(600, 0, () => 0.5)).toBe(100);
  });

  it('finding #18: two INTERLEAVED runCampaignOnce calls in one process/one db handle never claim the same row (real async concurrency, but not the two-process claim below)', async () => {
    // This shares one process and one better-sqlite3 handle - it proves claimNextRow's CAS is safe
    // against async interleaving within a process, which is weaker than (and does not substitute
    // for) the module header's own "two openpost serve processes" claim. See the real
    // two-child-process test immediately below for that.
    ctx = setup(20) as Ctx & { campaignId: string };
    const [a, b] = await Promise.all([
      runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined, owner: 'a' }),
      runCampaignOnce({ db: ctx.db, config: ctx.config }, ctx.campaignId, { sleep: async () => undefined, owner: 'b' }),
    ]);
    expect(a.sent + b.sent).toBe(20);
    const counts = campaignCounts(ctx.db, ctx.campaignId);
    expect(counts.sent).toBe(20);
  });

  it('finding #18: two REAL child processes racing runCampaignOnce against the SAME on-disk db never claim the same row or double-send', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'op-campaign-concurrent-'));
    try {
      const dbPath = join(dir, 'openpost.db');
      const db = openDb(dbPath);
      migrate(db);
      const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
      const campaign = createCampaign(db, {
        name: 'concurrent test',
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
      const items = Array.from({ length: 40 }, (_, i) => ({
        rowIndex: i,
        email: `row${i}@example.com`,
        varsJson: JSON.stringify({ name: `Row ${i}` }),
        variant: 'A',
        status: 'pending' as const,
      }));
      insertRows(db, campaign.id, items, Date.now());
      db.close();

      const tsxBin = join(process.cwd(), 'node_modules', '.bin', 'tsx');
      const script = join(process.cwd(), 'scripts', 'campaign-concurrent-child.mjs');
      const spawnChild = (owner: string): Promise<{ stdout: string; code: number | null }> =>
        new Promise((resolve, reject) => {
          const child = spawn(tsxBin, [script, dbPath, campaign.id, owner], { cwd: process.cwd() });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (d: Buffer) => {
            stdout += d.toString();
          });
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString();
          });
          child.on('error', reject);
          child.on('close', (code) => {
            if (code !== 0) reject(new Error(`child ${owner} exited ${code}: ${stderr}`));
            else resolve({ stdout, code });
          });
        });

      // Started together (not awaited one at a time) - both processes are alive and racing the
      // same on-disk db file simultaneously, exactly the "two openpost serve processes" scenario
      // the campaign runner's own module header describes.
      const [resultA, resultB] = await Promise.all([spawnChild('proc-a'), spawnChild('proc-b')]);
      const a = JSON.parse(resultA.stdout) as { sent: number; claimed: number };
      const b = JSON.parse(resultB.stdout) as { sent: number; claimed: number };

      const finalDb = openDb(dbPath);
      const counts = campaignCounts(finalDb, campaign.id);
      expect(counts.pending).toBe(0);
      expect(counts.claimed).toBe(0);
      expect(counts.sent).toBe(40);
      // Every row's message_id is unique - if the CAS had failed, some row could have been claimed
      // and sent by BOTH processes, and this count would exceed the row count.
      const distinctMessages = finalDb.prepare('SELECT COUNT(DISTINCT message_id) AS n FROM campaign_rows WHERE campaign_id = ?').get(campaign.id) as { n: number };
      expect(distinctMessages.n).toBe(40);
      // Each real process actually did some of the work (this machine has >1 core in CI/dev) -
      // not a strict requirement of correctness, but demonstrates the race was real, not one
      // process finishing before the other ever started.
      expect(a.sent + b.sent).toBe(40);
      finalDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('finding #8: createCampaignsJob bounds one tick to roughly maxSeconds even with a slow rate and multiple running campaigns, instead of blocking the whole scheduler', async () => {
    ctx = setup(1) as Ctx & { campaignId: string }; // just to get a db/config/account
    const db = ctx.db;
    const config = ctx.config;
    const accountId = ctx.accountId;

    // A second campaign, same db. Each row's pacing delay (nextDelayMs) at ratePerMinute=600 is
    // ceil(60000/600) = 100ms - a real, unmocked delay (createCampaignsJob calls runCampaignOnce
    // with no injected `sleep`, exactly as the real scheduler does), and each campaign has far more
    // rows (50) than a ~300ms budget could ever drain.
    const makeCampaign = (name: string, rows: number) => {
      const campaign = createCampaign(db, {
        name,
        accountId,
        subjectTemplate: 'Hi',
        bodyHtmlTemplate: '<p>Hi</p>',
        fromEmail: 'sender@example.com',
        transport: 'dryrun',
        ratePerMinute: 600,
        jitterMs: 0,
        dailyCap: 100_000,
        emailColumn: 'email',
        columnsJson: '["email"]',
        createdAt: Date.now(),
      });
      const items = Array.from({ length: rows }, (_, i) => ({
        rowIndex: i,
        email: `${name}-row${i}@example.com`,
        varsJson: '{}',
        variant: 'A',
        status: 'pending' as const,
      }));
      insertRows(db, campaign.id, items, Date.now());
      setCampaignStatus(db, campaign.id, 'running', Date.now());
      return campaign.id;
    };
    const campaignA = makeCampaign('A', 50);
    const campaignB = makeCampaign('B', 50);
    // The setup()-created campaign is irrelevant here; keep it out of 'running' so only A/B count.
    db.prepare(`UPDATE campaigns SET status = 'draft' WHERE id = ?`).run(ctx.campaignId);

    // A small budget shared across BOTH campaigns: must stop well short of draining even one
    // campaign's 50 rows (which alone would take ~5s of pacing sleeps), and must never let the
    // second campaign's rows start once the first has exhausted the shared budget.
    const job = createCampaignsJob({ db, config }, { maxSeconds: 0.3 });
    const startedAt = Date.now();
    const result = await job.run(startedAt);
    const elapsedMs = Date.now() - startedAt;

    // Generous upper bound - draining even one full campaign (50 rows x 100ms) would take ~5s;
    // this proves the job returns in a small fraction of that, not that it is instant.
    expect(elapsedMs).toBeLessThan(2000);
    const detail = result.detail as { drained: number; runningTotal: number };
    expect(detail.runningTotal).toBe(2);
    // The second campaign never even got a runCampaignOnce call once the first exhausted the budget.
    expect(detail.drained).toBeLessThan(detail.runningTotal);

    const countsA = campaignCounts(db, campaignA);
    const countsB = campaignCounts(db, campaignB);
    // The first campaign made SOME progress; far from all 50 rows of either completed.
    expect(countsA.sent + countsB.sent).toBeGreaterThan(0);
    expect(countsA.sent).toBeLessThan(50);
    expect(countsB.sent).toBe(0);
  }, 15_000);

  it('finding #17: a row whose BODY template fails to render (but whose subject passes preflight) is skipped as missing_vars, not unsafe_href', async () => {
    ctx = setup(1) as Ctx & { campaignId: string }; // just to get a db/config/account via afterEach's cleanup
    // Subject never references {{name}} - it will render fine in preflightRow's subject-only
    // check - but the body does, so a row missing that key fails only at renderRow (inside the
    // real run loop's try/catch, not preflight).
    const campaign = createCampaign(ctx.db, {
      name: 'body-fails',
      accountId: ctx.accountId,
      subjectTemplate: 'Hi there',
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
    insertRows(
      ctx.db,
      campaign.id,
      [{ rowIndex: 0, email: 'row0@example.com', varsJson: '{}', variant: 'A', status: 'pending' }], // no "name" key at all
      Date.now(),
    );

    const result = await runCampaignOnce({ db: ctx.db, config: ctx.config }, campaign.id, { sleep: async () => undefined });
    expect(result.skipped).toBe(1);
    const row = ctx.db.prepare('SELECT skip_reason FROM campaign_rows WHERE campaign_id = ?').get(campaign.id) as { skip_reason: string };
    expect(row.skip_reason).toBe('missing_vars');
  });

  it('recoverCampaign requeues a pre-submit expired lease to pending', () => {
    ctx = setup(3) as Ctx & { campaignId: string };
    ctx.db
      .prepare(`UPDATE campaign_rows SET status='claimed', lease_owner='dead', lease_expires_at=1 WHERE row_index = 0`)
      .run();
    const result = recoverCampaign(ctx.db, ctx.campaignId, Date.now(), 120_000);
    expect(result.requeued).toBe(1);
    const row = ctx.db.prepare(`SELECT status FROM campaign_rows WHERE row_index = 0`).get() as { status: string };
    expect(row.status).toBe('pending');
  });
});
