import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { loadConfig } from '../../src/config/env.js';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { buildServer } from '../../src/server/app.js';
import { seedDemo } from '../../src/db/seed.js';
import { signToken, pixelUrl } from '../../src/core/token.js';
import type { FastifyInstance } from 'fastify';
import { ensureAccount } from '../../src/db/repo.js';
import { createCampaign, insertRows, claimNextRow, beginRowSubmit, markRowSent } from '../../src/db/campaigns.js';

const CHROMIUM_AVAILABLE = existsSync('/opt/pw-browsers/chromium') || existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '');
const SEED_NOW = 1_789_000_000_000;
const SCREENSHOT_DIR = join(process.cwd(), 'docs', 'reports', 'screenshots');

/**
 * Phase 3.1 (M7): this file used to `test.skip()` unconditionally when Chromium was missing, with
 * no signal anywhere that DoD 1 (a real browser proving live updates) had silently stopped running
 * - and `npm test` never even looks at this file (a separate `npm run test:e2e`/`playwright test`
 * invocation is required), so a missing Chromium install could go unnoticed indefinitely. A missing
 * Chromium now FAILS this file loudly (a thrown error at collection time, not a skip) unless the
 * environment explicitly opts in to skipping with `OPENPOST_ALLOW_E2E_SKIP=1` - e.g. a CI lane that
 * genuinely never installs browsers.
 */
if (!CHROMIUM_AVAILABLE) {
  if (process.env.OPENPOST_ALLOW_E2E_SKIP === '1') {
    console.warn(
      '\n=====================================================================\n' +
        'OPENPOST E2E SKIPPED: Chromium not found at /opt/pw-browsers (or\n' +
        'PLAYWRIGHT_CHROMIUM_PATH) - OPENPOST_ALLOW_E2E_SKIP=1 is set, so DoD 1\n' +
        '(live-browser proof of real-time updates) is NOT being verified this run.\n' +
        '=====================================================================\n',
    );
    test.skip(true, 'Chromium is not available and OPENPOST_ALLOW_E2E_SKIP=1 explicitly allows skipping this file');
  } else {
    throw new Error(
      '\n=====================================================================\n' +
        'OPENPOST E2E FAILURE: Chromium was not found at /opt/pw-browsers (or the\n' +
        'path named by PLAYWRIGHT_CHROMIUM_PATH). This test proves DoD 1 (live\n' +
        'updates in a real browser) and must not silently pass by skipping.\n' +
        'Install Chromium (see README/Playwright setup), or set\n' +
        'OPENPOST_ALLOW_E2E_SKIP=1 to explicitly skip it in an environment that\n' +
        'deliberately never installs a browser.\n' +
        '=====================================================================\n',
    );
  }
}

// docs/09_phase5_spec.md deviation note: a plain `npm run test:e2e` used to rewrite every tracked
// screenshot under docs/reports/screenshots on every run, which is noisy for a working tree and
// makes every e2e run look "dirty" in git status for no functional reason. Screenshot capture is
// now opt-in via OPENPOST_E2E_SCREENSHOTS=1 - a plain e2e run (asserting behaviour) leaves the tree
// clean; set the flag when you actually want the screenshots refreshed (e.g. for a smoke report).
const CAPTURE_SCREENSHOTS = process.env.OPENPOST_E2E_SCREENSHOTS === '1';
async function maybeScreenshot(page: Page, path: string, opts: { fullPage?: boolean } = {}): Promise<void> {
  if (!CAPTURE_SCREENSHOTS) return;
  await page.screenshot({ path, fullPage: opts.fullPage ?? true });
}

let app: FastifyInstance;
let db: DB;
let baseUrl: string;
let openRecipientId: string;
let messageIdWithOpen: string;
let campaignId: string;

test.beforeAll(async () => {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const config = loadConfig({
    TRACKING_SECRET: 'e2e-test-secret-padded-to-32-characters!!',
    TRACKING_BASE_URL: 'http://127.0.0.1:18787',
    DB_PATH: ':memory:',
    DASHBOARD_PASSWORD: 'letmein',
    BIND_ADDRESS: '127.0.0.1',
  });
  db = openDb(':memory:');
  migrate(db);
  seedDemo(db, { seed: 7, nowMs: SEED_NOW, messages: 12, reset: false, force: false });

  // A fresh, not-yet-opened recipient to drive the live-update assertion.
  const target = db
    .prepare(`SELECT id, message_id, token FROM recipients WHERE state = 'not_opened' AND sent_at IS NOT NULL LIMIT 1`)
    .get() as { id: string; message_id: string; token: string };
  openRecipientId = target.id;
  messageIdWithOpen = target.message_id;

  // Seed a campaign for the Phase 4 dashboard screenshot.
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const campaign = createCampaign(db, {
    name: 'Q3 outreach',
    accountId: account.id,
    subjectTemplate: 'Hi {{name}}',
    subjectVariantsJson: JSON.stringify([
      { key: 'A', template: 'Hi {{name}}', weight: 1 },
      { key: 'B', template: 'Quick one, {{name}}', weight: 1 },
    ]),
    bodyHtmlTemplate: '<p>Hi {{name}}</p>',
    fromEmail: 'sender@example.com',
    transport: 'dryrun',
    ratePerMinute: 6000,
    jitterMs: 0,
    dailyCap: 1000,
    emailColumn: 'email',
    columnsJson: '["name","email"]',
    createdAt: SEED_NOW,
  });
  campaignId = campaign.id;
  const campaignRows = Array.from({ length: 20 }, (_, i) => ({
    rowIndex: i,
    email: `row${i}@example.com`,
    varsJson: JSON.stringify({ name: `Row ${i}` }),
    variant: i % 2 === 0 ? 'A' : 'B',
    status: 'pending' as const,
  }));
  insertRows(db, campaign.id, campaignRows, SEED_NOW);
  db.prepare(`UPDATE campaigns SET status = 'running' WHERE id = ?`).run(campaign.id);
  // Only 8 of the 20 rows get a real `messages` row (kept well under DASHBOARD_PAGE_SIZE=25
  // together with seedDemo's own 12, so the campaign's messages can never push test 152's target
  // message row onto page 2 of /dashboard/messages - their sent_at range overlaps seedDemo's).
  for (let i = 0; i < 8; i++) {
    const row = claimNextRow(db, campaign.id, 'e2e-seed', SEED_NOW, 60_000, 3);
    if (!row) continue;
    beginRowSubmit(db, row.id, 'e2e-seed', SEED_NOW);
    db.prepare(
      `INSERT INTO messages (id, account_id, subject, body_html, body_text, status, tracking_enabled, click_tracking_enabled, created_at, campaign_id)
       VALUES (@id, @accountId, 'x', null, null, 'sent', 1, 1, @now, @campaignId)`,
    ).run({ id: `e2e-cm${i}`, accountId: account.id, now: SEED_NOW - 999_999_999, campaignId: campaign.id });
    db.prepare(
      `INSERT INTO recipients (id, message_id, email, kind, token, open_count, machine_open_count, click_count, created_at, state, notify_muted, is_aggregate)
       VALUES (@id, @messageId, @email, 'to', @token, @opens, 0, 0, @now, @state, 0, 0)`,
    ).run({
      id: `e2e-cr${i}`,
      messageId: `e2e-cm${i}`,
      email: row.email,
      token: `e2etok${i}`,
      now: SEED_NOW - 999_999_999,
      opens: i < 6 ? 1 : 0,
      state: i < 6 ? 'opened' : 'not_opened',
    });
    markRowSent(db, row.id, 'e2e-seed', { messageId: `e2e-cm${i}`, recipientId: `e2e-cr${i}`, sentAt: SEED_NOW - 999_999_999 });
  }

  app = buildServer({ db, config });
  await app.listen({ port: 18787, host: '127.0.0.1' });
  baseUrl = 'http://127.0.0.1:18787';
  void baseUrl;
});

test.afterAll(async () => {
  await app.close();
  db.close();
});

async function login(page: Page): Promise<void> {
  await page.goto('/dashboard/messages');
  await page.fill('#login-password', 'letmein');
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard/messages');
}

test('152. a pixel hit updates a message-list row live, with no navigation, and no CSP violations', async ({ page, context }) => {
  const cspViolations: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) {
      cspViolations.push(msg.text());
    }
  });
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });

  await login(page);
  // The initial goto()+login navigation is expected; reset the counter before the live-update part.
  navigations = 0;

  const row = page.locator(`tr[data-message-id="${messageIdWithOpen}"]`);
  await expect(row).toBeVisible();
  const beforeText = await row.locator('td').nth(4).innerText();

  await maybeScreenshot(page, join(SCREENSHOT_DIR, 'messages.png'));

  // Fire the pixel from outside the page (a real recipient's mail client would do this) - this
  // must reach the dashboard purely over the SSE connection the page already opened.
  const recipientRow = db.prepare('SELECT token FROM recipients WHERE id = ?').get(openRecipientId) as { token: string };
  const secret = 'e2e-test-secret-padded-to-32-characters!!';
  const token = signToken('o', recipientRow.token, secret);
  const url = pixelUrl('http://127.0.0.1:18787', token, 'e2e');
  const pixelResponse = await context.request.get(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36' },
  });
  expect(pixelResponse.status()).toBe(200);

  await page.waitForFunction(
    (args) => {
      const el = document.querySelector(`tr[data-message-id="${args.id}"] td:nth-child(5)`);
      return el !== null && el.textContent !== args.before;
    },
    { id: messageIdWithOpen, before: beforeText },
    { timeout: 10_000 },
  );

  expect(navigations).toBe(0);
  expect(cspViolations).toEqual([]);

  // Also visit the stats page and message detail for the required screenshots / smoke coverage.
  await page.goto('/dashboard/stats');
  await expect(page.locator('h1')).toHaveText('Stats');
  await maybeScreenshot(page, join(SCREENSHOT_DIR, 'stats.png'));

  await page.goto(`/dashboard/messages/${messageIdWithOpen}`);
  await expect(page.locator('h1')).toBeVisible();
  await maybeScreenshot(page, join(SCREENSHOT_DIR, 'message.png'));
});

test('Phase 4: campaign dashboard renders live progress and per-variant stats', async ({ page }) => {
  await login(page);
  await page.goto('/dashboard/campaigns');
  await expect(page.locator('h1')).toHaveText('Campaigns');
  await expect(page.getByRole('link', { name: 'Q3 outreach' })).toBeVisible();

  await page.goto(`/dashboard/campaigns/${campaignId}`);
  await expect(page.locator('h1')).toHaveText('Q3 outreach');
  await expect(page.getByRole('heading', { name: 'Variants' })).toBeVisible();
  await expect(page.locator('#campaign-progress')).toBeVisible();

  await maybeScreenshot(page, join(SCREENSHOT_DIR, 'campaign.png'));
});
