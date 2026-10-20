import { describe, expect, it } from 'vitest';
import { render } from '../../src/server/views/html.js';
import { settingsPage } from '../../src/server/views/pages/settings.js';

const NOW = 1_700_000_000_000;

describe('settingsPage', () => {
  it('renders a "not configured" note when webpush is disabled', () => {
    const out = render(
      settingsPage({
        csrf: 'tok',
        pwaEnabled: true,
        webpushConfigured: false,
        vapidPublicKey: null,
        subscriptions: [],
        nowMs: NOW,
        sessionVia: 'session',
        dashboardSessionHours: 12,
      }),
    );
    expect(out).toContain('Web Push is not configured');
    expect(out).not.toContain('data-vapid-public-key');
  });

  it('renders a PWA-disabled note when PWA_ENABLED is off', () => {
    const out = render(
      settingsPage({
        csrf: 'tok',
        pwaEnabled: false,
        webpushConfigured: false,
        vapidPublicKey: null,
        subscriptions: [],
        nowMs: NOW,
        sessionVia: null,
        dashboardSessionHours: 12,
      }),
    );
    expect(out).toContain('PWA_ENABLED is off');
  });

  it('renders the device table with the vapid key attribute and each subscription row when configured', () => {
    const out = render(
      settingsPage({
        csrf: 'tok',
        pwaEnabled: true,
        webpushConfigured: true,
        vapidPublicKey: 'abc123',
        subscriptions: [
          {
            id: 'sub1',
            endpoint: 'https://push.example.com/x',
            p256dh: 'p',
            auth: 'a',
            label: 'My Pixel',
            ua_family: 'Chrome',
            device_type: 'mobile',
            created_at: NOW - 1000,
            last_ok_at: NOW,
            last_error: null,
            failure_count: 0,
            disabled_at: null,
            disabled_reason: null,
          },
          {
            id: 'sub2',
            endpoint: 'https://push.example.com/y',
            p256dh: 'p',
            auth: 'a',
            label: null,
            ua_family: null,
            device_type: null,
            created_at: NOW - 2000,
            last_ok_at: null,
            last_error: 'HTTP 410',
            failure_count: 1,
            disabled_at: NOW,
            disabled_reason: 'gone_410',
          },
        ],
        nowMs: NOW,
        sessionVia: 'bearer',
        dashboardSessionHours: 12,
      }),
    );
    expect(out).toContain('data-vapid-public-key="abc123"');
    expect(out).toContain('My Pixel');
    expect(out).toContain('disabled (gone_410)');
    expect(out).toContain('btn-push-unsubscribe');
    expect(out).toContain('Authenticated via: <strong>bearer</strong>');
  });

  it('shows a logout link only in session mode', () => {
    const withSession = render(
      settingsPage({ csrf: 'tok', pwaEnabled: true, webpushConfigured: false, vapidPublicKey: null, subscriptions: [], nowMs: NOW, sessionVia: 'session', dashboardSessionHours: 12 }),
    );
    expect(withSession).toContain('id="link-logout"');
    const withBearer = render(
      settingsPage({ csrf: 'tok', pwaEnabled: true, webpushConfigured: false, vapidPublicKey: null, subscriptions: [], nowMs: NOW, sessionVia: 'bearer', dashboardSessionHours: 12 }),
    );
    expect(withBearer).not.toContain('id="link-logout"');
  });
});
