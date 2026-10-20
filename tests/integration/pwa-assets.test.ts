import { describe, expect, it } from 'vitest';
import { setupTestServer } from '../helpers/setup.js';
import { VERSION } from '../../src/version.js';

describe('PWA assets (docs/09_phase5_spec.md §2.5-2.6)', () => {
  it('374. manifest is valid JSON with the required keys, scope/start_url inside /dashboard/', async () => {
    const { app } = setupTestServer();
    const res = await app.inject({ method: 'GET', url: '/dashboard/assets/manifest.webmanifest' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/manifest+json');
    const manifest = JSON.parse(res.body);
    expect(manifest.scope).toBe('/dashboard/');
    expect(manifest.start_url).toBe('/dashboard/messages');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.length).toBeGreaterThanOrEqual(2);
  });

  it('375. sw.js is served no-cache with Service-Worker-Allowed: /dashboard/', async () => {
    const { app } = setupTestServer();
    const res = await app.inject({ method: 'GET', url: '/dashboard/assets/sw.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toMatch(/no-cache/);
    expect(res.headers['service-worker-allowed']).toBe('/dashboard/');
  });

  it('376. icons/manifest/offline page are served without any CSP header and without auth', async () => {
    const { app, config } = setupTestServer({ configOverrides: { dashboardPassword: 'secret', apiToken: undefined } });
    expect(config.dashboardPassword).toBe('secret');
    for (const path of ['/dashboard/assets/manifest.webmanifest', '/dashboard/assets/icon-192.png', '/dashboard/offline.html', '/dashboard/assets/sw.js']) {
      const res = await app.inject({ method: 'GET', url: path });
      expect(res.statusCode, path).toBe(200);
      expect(res.headers['content-security-policy'], path).toBeUndefined();
    }
  });

  it('377. the dashboard CSP contains manifest-src \'self\' and worker-src \'self\' and no unsafe-inline', async () => {
    const { app } = setupTestServer();
    const res = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).toContain("manifest-src 'self'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('378. an unknown asset name is still 404 with no filesystem access', async () => {
    const { app } = setupTestServer();
    const res = await app.inject({ method: 'GET', url: '/dashboard/assets/../../etc/passwd' });
    expect(res.statusCode).toBe(404);
    const res2 = await app.inject({ method: 'GET', url: '/dashboard/assets/does-not-exist.js' });
    expect(res2.statusCode).toBe(404);
  });

  it('379. ?v= is ignored by the asset route (same content) but present in layout output', async () => {
    const { app } = setupTestServer();
    const res1 = await app.inject({ method: 'GET', url: '/dashboard/assets/app.css' });
    const res2 = await app.inject({ method: 'GET', url: '/dashboard/assets/app.css?v=whatever' });
    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);
    expect(res1.body).toBe(res2.body);

    const page = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(page.body).toMatch(/app\.css\?v=/);
    expect(page.body).toMatch(/app\.js\?v=/);
  });

  it('phase5.1 finding #11: sw.js CACHE_VERSION is derived from VERSION, with no leftover placeholder', async () => {
    const { app } = setupTestServer();
    const res = await app.inject({ method: 'GET', url: '/dashboard/assets/sw.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`var CACHE_VERSION = 'openpost-static-v${VERSION}'`);
    expect(res.body).not.toContain('__OPENPOST_VERSION__');
    expect(res.body).not.toContain("'openpost-static-v1'");
  });

  it('381. offline.html contains no <script> and no inline data', async () => {
    const { app } = setupTestServer();
    const res = await app.inject({ method: 'GET', url: '/dashboard/offline.html' });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script');
    expect(res.body).not.toContain('onclick=');
  });

  it('installable: navigator.serviceWorker.register target and scope are reflected in the manifest + layout links', async () => {
    const { app } = setupTestServer();
    const page = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(page.body).toContain('rel="manifest"');
    expect(page.body).toContain('/dashboard/assets/manifest.webmanifest');
    expect(page.body).toContain('apple-touch-icon');
  });

  it('PWA_ENABLED=false omits the manifest/theme links from the page (assets are still served)', async () => {
    const { app } = setupTestServer({ configOverrides: { pwaEnabled: false } });
    const page = await app.inject({ method: 'GET', url: '/dashboard/messages' });
    expect(page.body).not.toContain('rel="manifest"');
    const asset = await app.inject({ method: 'GET', url: '/dashboard/assets/manifest.webmanifest' });
    expect(asset.statusCode).toBe(200);
  });
});
