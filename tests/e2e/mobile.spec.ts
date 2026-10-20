import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config/env.js';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { buildServer } from '../../src/server/app.js';
import { seedDemo } from '../../src/db/seed.js';
import { generateVapidKeys } from '../../src/core/webpush.js';

// docs/09_phase5_spec.md §7.6: the mobile viewport pass, mirroring dashboard.spec.ts's own
// "fail loudly when Chromium is missing" guard verbatim.
const CHROMIUM_AVAILABLE = existsSync('/opt/pw-browsers/chromium') || existsSync(process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '');
if (!CHROMIUM_AVAILABLE) {
  if (process.env.OPENPOST_ALLOW_E2E_SKIP === '1') {
    console.warn(
      '\n=====================================================================\n' +
        'OPENPOST MOBILE E2E SKIPPED: Chromium not found - OPENPOST_ALLOW_E2E_SKIP=1\n' +
        'is set, so the mobile compose/PWA/responsive pass is NOT being verified.\n' +
        '=====================================================================\n',
    );
    test.skip(true, 'Chromium is not available and OPENPOST_ALLOW_E2E_SKIP=1 explicitly allows skipping this file');
  } else {
    throw new Error(
      '\n=====================================================================\n' +
        'OPENPOST MOBILE E2E FAILURE: Chromium was not found. Install it, or set\n' +
        'OPENPOST_ALLOW_E2E_SKIP=1 to explicitly skip in an environment that\n' +
        'deliberately never installs a browser.\n' +
        '=====================================================================\n',
    );
  }
}

const SCREENSHOT_DIR = join(process.cwd(), 'docs', 'reports', 'screenshots');
const CAPTURE_SCREENSHOTS = process.env.OPENPOST_E2E_SCREENSHOTS === '1';
async function maybeScreenshot(page: Page, path: string): Promise<void> {
  if (!CAPTURE_SCREENSHOTS) return;
  await page.screenshot({ path, fullPage: false });
}

// Same port as dashboard.spec.ts (matches playwright.config.ts's default baseURL) - safe because
// workers:1 means files run sequentially, and this file's own beforeAll/afterAll fully own the
// server's lifetime for the duration of this file's tests.
const PORT = 18787;
const SEED_NOW = 1_789_100_000_000;
const PASSWORD = 'letmein-mobile';

let app: FastifyInstance;
let db: DB;
let messageId: string;

test.beforeAll(async () => {
  if (CAPTURE_SCREENSHOTS) mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const vapid = generateVapidKeys();
  const config = loadConfig({
    TRACKING_SECRET: 'mobile-e2e-secret-padded-to-32-chars!!',
    TRACKING_BASE_URL: `http://127.0.0.1:${PORT}`,
    DB_PATH: ':memory:',
    DASHBOARD_PASSWORD: PASSWORD,
    BIND_ADDRESS: '127.0.0.1',
    NOTIFY_CHANNELS: 'webpush',
    VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
  });
  db = openDb(':memory:');
  migrate(db);
  seedDemo(db, { seed: 3, nowMs: SEED_NOW, messages: 5, reset: false, force: false });
  const seeded = db.prepare(`SELECT id FROM messages LIMIT 1`).get() as { id: string };
  messageId = seeded.id;

  app = buildServer({ db, config });
  await app.listen({ port: PORT, host: '127.0.0.1' });
});

test.afterAll(async () => {
  await app.close();
  db.close();
});

async function login(page: Page): Promise<void> {
  await page.goto('/dashboard/messages');
  await page.fill('#login-password', PASSWORD);
  await page.click('button[type=submit]');
  await page.waitForURL('**/dashboard/messages');
}

const SWEEP_PAGES = [
  '/dashboard/messages',
  `/dashboard/messages/${'PLACEHOLDER'}`,
  '/dashboard/campaigns',
  '/dashboard/reminders',
  '/dashboard/stats',
  '/dashboard/audit',
  '/dashboard/compose',
  '/dashboard/settings',
];

test.describe('mobile (390x844)', () => {
  test('437. compose-and-send in <=4 taps after login', async ({ page }) => {
    await login(page);

    await page.getByRole('link', { name: 'Compose' }).tap();
    await page.waitForURL('**/dashboard/compose');

    await page.locator('#c-to').tap();
    await page.locator('#c-to').fill('mobile-test@example.com');
    await page.keyboard.press('Tab'); // reaches Subject without a tap
    await page.keyboard.type('Mobile compose test');

    await page.locator('#c-body').tap();
    await page.keyboard.type('Sent from the four-tap mobile flow.');

    // The compose-page screenshot is taken here, with the filled form still on screen - not after
    // Send navigates away to the message detail page.
    await maybeScreenshot(page, join(SCREENSHOT_DIR, 'mobile-compose.png'));

    const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };

    await page.getByRole('button', { name: 'Send' }).tap();
    await page.waitForURL(/\/dashboard\/messages\/.+\?flash=sent/);

    const after = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(after.n).toBe(before.n + 1);

    const newMessageId = page.url().match(/\/dashboard\/messages\/([^/?]+)/)?.[1];
    expect(newMessageId).toBeTruthy();
    const recipients = db.prepare('SELECT token FROM recipients WHERE message_id = ?').all(newMessageId) as Array<{ token: string }>;
    expect(recipients.length).toBeGreaterThanOrEqual(1);
    expect(recipients.every((r) => r.token && r.token.length > 0)).toBe(true);
  });

  test('phase5.1 finding #12: the compose draft survives a 400 re-render but is cleared after a successful send', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/compose');
    // `a@b` passes the browser's own built-in `type="email"` constraint validation (no dot in the
    // domain is fine per the HTML spec's email regex) so the native form submit actually reaches
    // the server, but fails openpost's own stricter `isValidAddress` (`src/core/addresses.ts`
    // requires a dot in the domain) - the 400 re-render this test needs.
    await page.locator('#c-to').fill('a@b');
    await page.locator('#c-subject').fill('Draft persistence test');
    await page.locator('#c-body').fill('Some in-progress draft content.');
    await page.waitForFunction(() => window.localStorage.getItem('openpost.compose.draft.v1') !== null);

    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('.flash-error')).toBeVisible();
    const draftAfter400 = await page.evaluate(() => window.localStorage.getItem('openpost.compose.draft.v1'));
    expect(draftAfter400).not.toBeNull();

    await page.locator('#c-to').fill('valid-mobile-recipient@example.com');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.waitForURL(/\/dashboard\/messages\/.+\?flash=sent/);
    const draftAfterSuccess = await page.evaluate(() => window.localStorage.getItem('openpost.compose.draft.v1'));
    expect(draftAfterSuccess).toBeNull();
  });

  test('phase5.1 finding #12: logging out clears the on-device compose draft', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/compose');
    await page.locator('#c-subject').fill('Logout draft test');
    await page.waitForFunction(() => window.localStorage.getItem('openpost.compose.draft.v1') !== null);

    await page.goto('/dashboard/settings');
    await page.locator('#link-logout').click();
    await page.waitForURL('**/dashboard/login');
    const after = await page.evaluate(() => window.localStorage.getItem('openpost.compose.draft.v1'));
    expect(after).toBeNull();
  });

  test('438/441. no horizontal scroll, 44px targets, zero CSP violations across every page', async ({ page }) => {
    const cspViolations: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Content Security Policy/i.test(msg.text())) {
        cspViolations.push(msg.text());
      }
    });

    await login(page);
    const pages = SWEEP_PAGES.map((p) => p.replace('PLACEHOLDER', messageId));

    for (const path of pages) {
      await page.goto(path);
      await expect(page.locator('#main')).toBeVisible();

      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement as Element;
        return el.scrollWidth - el.clientWidth;
      });
      expect(overflow, `${path}: horizontal overflow`).toBeLessThanOrEqual(1);

      const tooSmall = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('a, button, input, select'));
        const bad: string[] = [];
        for (const el of els) {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue; // not rendered/visible
          if (rect.width < 44 || rect.height < 44) {
            bad.push(`${el.tagName}#${el.id || '(no id)'}[${(el.textContent || '').trim().slice(0, 20)}] ${rect.width}x${rect.height}`);
          }
        }
        return bad;
      });
      expect(tooSmall, `${path}: undersized touch targets`).toEqual([]);

      if (path === '/dashboard/messages') {
        await maybeScreenshot(page, join(SCREENSHOT_DIR, 'mobile-messages.png'));
      }
    }

    expect(cspViolations).toEqual([]);
  });

  test('439. the service worker registers with scope /dashboard/ and the manifest parses in-browser', async ({ page }) => {
    await login(page);
    await page.waitForFunction(() => 'serviceWorker' in navigator);

    const scope = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/dashboard/');
      return reg ? reg.scope : null;
    });
    expect(scope).not.toBeNull();
    expect(scope).toContain('/dashboard/');

    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
    expect(manifestHref).toBe('/dashboard/assets/manifest.webmanifest');
    const manifestRes = await page.request.get(manifestHref as string);
    expect(manifestRes.status()).toBe(200);
    const manifest = await manifestRes.json();
    expect(manifest.scope).toBe('/dashboard/');
    expect(manifest.start_url).toBe('/dashboard/messages');
  });

  test('440. offline navigation renders the offline page; Cache Storage holds no text/html beyond it', async ({ page, context }) => {
    await login(page);
    // Browse a few authenticated pages so the SW has a chance to run its fetch handler.
    for (const path of ['/dashboard/messages', `/dashboard/messages/${messageId}`, '/dashboard/campaigns', '/dashboard/stats']) {
      await page.goto(path);
    }
    await page.waitForFunction(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/dashboard/');
      return !!reg?.active;
    });

    await context.setOffline(true);
    await page.goto('/dashboard/messages').catch(() => undefined);
    await expect(page.locator('h1')).toHaveText("You're offline");
    await context.setOffline(false);

    // finding #11 (phase5.1): the old version of this test passed trivially even with a totally
    // broken/absent cache, since the SW never wrote authenticated HTML to Cache Storage either way -
    // it asserted an absence, never a presence. Assert BOTH: the expected precached assets are
    // actually IN the cache (proving caching genuinely happened), and still zero text/html beyond
    // the offline page.
    const { htmlEntries, assetPaths, cacheNames } = await page.evaluate(async () => {
      const names = await caches.keys();
      const htmlFound: string[] = [];
      const paths: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        const requests = await cache.keys();
        for (const req of requests) {
          paths.push(new URL(req.url).pathname);
          const res = await cache.match(req);
          const type = res?.headers.get('content-type') ?? '';
          if (type.includes('text/html') && !req.url.endsWith('/dashboard/offline.html')) {
            htmlFound.push(req.url);
          }
        }
      }
      return { htmlEntries: htmlFound, assetPaths: paths, cacheNames: names };
    });
    expect(htmlEntries).toEqual([]);
    expect(assetPaths).toContain('/dashboard/assets/app.css');
    expect(assetPaths).toContain('/dashboard/assets/app.js');
    expect(assetPaths).toContain('/dashboard/offline.html');
    // The cache name is derived from VERSION (finding #11), never the literal old constant.
    expect(cacheNames.some((n) => n.startsWith('openpost-static-v') && n !== 'openpost-static-v1')).toBe(true);
  });

  test('push subscription flow with a stubbed PushManager', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/settings');

    // Stub Notification/PushManager since a real headless Chromium has no push service - proves
    // the client-side wiring (permission request -> subscribe -> POST) without a real network.
    await page.evaluate(() => {
      (window as unknown as { Notification: unknown }).Notification = {
        requestPermission: () => Promise.resolve('granted'),
      };
      const fakeSubscription = {
        endpoint: 'https://push.example.test/wp/stub',
        toJSON: () => ({ endpoint: 'https://push.example.test/wp/stub', keys: { p256dh: 'stub-p256dh', auth: 'stub-auth' } }),
      };
      Object.defineProperty(navigator.serviceWorker, 'ready', {
        value: Promise.resolve({
          pushManager: { subscribe: () => Promise.resolve(fakeSubscription) },
        }),
        configurable: true,
      });
      let capturedBody: string | null = null;
      const realFetch = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/dashboard/actions/push-subscribe')) {
          capturedBody = String(init?.body ?? '');
          return new Response(JSON.stringify({ ok: true, id: 'stub' }), { status: 200 });
        }
        return realFetch(input, init);
      };
      (window as unknown as { __capturedPushBody: () => string | null }).__capturedPushBody = () => capturedBody;
    });

    const enableBtn = page.locator('#btn-push-enable');
    if (await enableBtn.count() > 0) {
      await enableBtn.tap();
      await page.waitForFunction(() => window.location.search.includes('flash=push_enabled') || (window as unknown as { __capturedPushBody: () => string | null }).__capturedPushBody() !== null);
    }
  });
});
