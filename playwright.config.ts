import { defineConfig, devices } from '@playwright/test';

// The Phase 3 live-update DoD (test 152) is proven in a real browser, not merely via app.inject().
// Chromium is preinstalled at PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers; this repo's installed
// @playwright/test version may not exactly match that revision, so the chromium project below
// pins `executablePath` to the preinstalled binary directly rather than relying on Playwright's
// own (potentially mismatched) auto-download path.
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.OPENPOST_E2E_BASE_URL ?? 'http://127.0.0.1:18787',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      testMatch: /dashboard\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: { executablePath: CHROMIUM_PATH },
      },
    },
    // docs/09_phase5_spec.md §7.6: a second project at a phone viewport with touch enabled, for
    // the mobile compose/PWA/responsive/push-subscribe smoke pass (tests 437-441). Separate from
    // the desktop project (own testMatch) so neither project runs the other's spec twice.
    {
      name: 'mobile',
      testMatch: /mobile\.spec\.ts$/,
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        launchOptions: { executablePath: CHROMIUM_PATH },
      },
    },
  ],
});
