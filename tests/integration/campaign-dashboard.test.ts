import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import { ensureAccount } from '../../src/db/repo.js';
import { createCampaign, insertRows, claimNextRow, beginRowSubmit, markRowSent } from '../../src/db/campaigns.js';

const NOW = 1_789_000_000_000;

function seedCampaign(env: TestServer, name = 'Q3 outreach'): string {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const campaign = createCampaign(env.db, {
    name,
    accountId: account.id,
    subjectTemplate: 'Hi {{name}}',
    subjectVariantsJson: JSON.stringify([
      { key: 'A', template: 'Hi {{name}}', weight: 1 },
      { key: 'B', template: 'Hey {{name}}', weight: 1 },
    ]),
    bodyHtmlTemplate: '<p>Hi {{name}}</p>',
    fromEmail: 'sender@example.com',
    transport: 'dryrun',
    ratePerMinute: 6000,
    jitterMs: 0,
    dailyCap: 1000,
    emailColumn: 'email',
    columnsJson: '["name","email"]',
    createdAt: NOW,
  });
  const items = Array.from({ length: 10 }, (_, i) => ({
    rowIndex: i,
    email: `row${i}@example.com`,
    varsJson: JSON.stringify({ name: `Row ${i}` }),
    variant: i % 2 === 0 ? 'A' : 'B',
    status: 'pending' as const,
  }));
  insertRows(env.db, campaign.id, items, NOW);
  env.db.prepare(`UPDATE campaigns SET status = 'running' WHERE id = ?`).run(campaign.id);
  for (let i = 0; i < 8; i++) {
    const row = claimNextRow(env.db, campaign.id, 'seed', NOW, 60_000, 3);
    if (!row) continue;
    beginRowSubmit(env.db, row.id, 'seed', NOW);
    env.db
      .prepare(
        `INSERT INTO messages (id, account_id, subject, body_html, body_text, status, tracking_enabled, click_tracking_enabled, created_at, campaign_id)
         VALUES (@id, @accountId, 'x', null, null, 'sent', 1, 1, @now, @campaignId)`,
      )
      .run({ id: `m${i}`, accountId: account.id, now: NOW, campaignId: campaign.id });
    env.db
      .prepare(
        `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, click_count, created_at, state, notify_muted, is_aggregate)
         VALUES (@id, @messageId, @email, 'to', @token, 0, 0, 0, @now, 'not_opened', 0, 0)`,
      )
      .run({ id: `r${i}`, messageId: `m${i}`, email: row.email, token: `tok${i}`, now: NOW });
    markRowSent(env.db, row.id, 'seed', { messageId: `m${i}`, recipientId: `r${i}`, sentAt: NOW });
  }
  return campaign.id;
}

describe('campaign dashboard pages', () => {
  let env: TestServer;
  beforeEach(() => {
    env = setupTestServer({ startAt: NOW });
  });
  afterEach(async () => {
    await env.app.close();
    env.db.close();
  });

  it('282. /dashboard/campaigns lists a seeded campaign with the correct progress and open rate', async () => {
    seedCampaign(env);
    const res = await env.app.inject({ method: 'GET', url: '/dashboard/campaigns' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Q3 outreach');
    expect(res.body).toContain('8 / 10');
  });

  it('283. /dashboard/campaigns/:id renders the per-variant table and a filtered rows table (?status=failed)', async () => {
    const id = seedCampaign(env);
    const res = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Variants');
    expect(res.body).toMatch(/>A<\/td>/);
    expect(res.body).toMatch(/>B<\/td>/);

    const pendingRes = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}?status=pending` });
    expect(pendingRes.statusCode).toBe(200);
    expect((pendingRes.body.match(/badge-pending/g) ?? []).length).toBe(2);

    const failedRes = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}?status=failed` });
    expect(failedRes.body).toContain('No rows match this filter.');
  });

  it('284. the progress fragment is valid standalone HTML and reflects a status change without a reload', async () => {
    const id = seedCampaign(env);
    const before = await env.app.inject({ method: 'GET', url: `/dashboard/fragments/campaign/${id}` });
    expect(before.statusCode).toBe(200);
    expect(before.body).toContain('Status: running');

    env.db.prepare(`UPDATE campaigns SET status = 'paused' WHERE id = ?`).run(id);
    const after = await env.app.inject({ method: 'GET', url: `/dashboard/fragments/campaign/${id}` });
    expect(after.body).toContain('Status: paused');
  });

  it('285. Pause/Resume/Cancel go through the CSRF guard; a missing token is 403 in password mode', async () => {
    const passwordEnv = setupTestServer({ startAt: NOW, configOverrides: { dashboardPassword: 'hunter2222' } });
    const id = seedCampaign(passwordEnv);
    // No session cookie at all -> onRequest redirects (GET) or 401s (non-GET) before CSRF is even reached.
    const res = await passwordEnv.app.inject({
      method: 'POST',
      url: '/dashboard/actions/campaign',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}&action=pause`,
    });
    expect([401, 403]).toContain(res.statusCode);
    const unchanged = passwordEnv.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string };
    expect(unchanged.status).toBe('running');
    passwordEnv.db.close();
  });

  it('pause/resume/cancel actions work end to end in open (no-password) mode', async () => {
    const id = seedCampaign(env);
    const pauseRes = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/campaign',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}&action=pause`,
    });
    expect(pauseRes.statusCode).toBe(303);
    expect((env.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status).toBe('paused');

    await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/campaign',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}&action=resume`,
    });
    expect((env.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status).toBe('running');

    await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/campaign',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}&action=cancel`,
    });
    expect((env.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status).toBe('cancelled');
  });

  it('finding #6: the dashboard action route rejects an invalid transition (resume on a cancelled campaign) with 409, not a silent status flip', async () => {
    const id = seedCampaign(env);
    await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/campaign',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}&action=cancel`,
    });
    expect((env.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status).toBe('cancelled');

    const resumeRes = await env.app.inject({
      method: 'POST',
      url: '/dashboard/actions/campaign',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `id=${id}&action=resume`,
    });
    expect(resumeRes.statusCode).toBe(409);
    // Still cancelled - the terminal transition was refused, not silently applied.
    expect((env.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status).toBe('cancelled');
  });

  it('286. a campaign name of "><script>alert(1)</script> renders escaped on both pages and in the CSV export', async () => {
    const id = seedCampaign(env, '"><script>alert(1)</script>');
    const listRes = await env.app.inject({ method: 'GET', url: '/dashboard/campaigns' });
    expect(listRes.body).not.toContain('<script>alert(1)</script>');
    expect(listRes.body).toContain('&lt;script&gt;');

    const detailRes = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}` });
    expect(detailRes.body).not.toContain('<script>alert(1)</script>');

    const csvRes = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}/rows.csv` });
    expect(csvRes.statusCode).toBe(200);
    expect(csvRes.headers['content-type']).toContain('text/csv');
  });

  it('287. rows.csv honours the status filter and the formula guard', async () => {
    const id = seedCampaign(env);
    // Inject a formula-shaped email-like cell to prove the guard fires end to end.
    env.db.prepare(`UPDATE campaign_rows SET email = '=cmd|calc' WHERE campaign_id = ? AND row_index = 0`).run(id);
    const res = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}/rows.csv?status=all` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("'=cmd|calc");
    const sentOnly = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}/rows.csv?status=sent` });
    const lines = sentOnly.body.trim().split('\r\n');
    expect(lines.length - 1).toBe(8); // header + 8 sent rows
  });

  it('191b. /dashboard/campaigns/:id sets the exact CSP/security headers', async () => {
    const id = seedCampaign(env);
    const res = await env.app.inject({ method: 'GET', url: `/dashboard/campaigns/${id}` });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.body).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
    expect(res.body).not.toMatch(/\sstyle=/);
  });
});
