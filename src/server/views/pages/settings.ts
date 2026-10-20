import { attr, html, join, type SafeHtml } from '../html.js';
import { fmtRelative, fmtTime } from '../format.js';
import type { PushSubscriptionRow } from '../../../db/push.js';

export interface SettingsPageModel {
  csrf: string;
  pwaEnabled: boolean;
  webpushConfigured: boolean;
  vapidPublicKey: string | null;
  subscriptions: PushSubscriptionRow[];
  nowMs: number;
  sessionVia: 'bearer' | 'session' | 'open' | null;
  dashboardSessionHours: number;
}

function deviceRow(s: PushSubscriptionRow, csrf: string, nowMs: number): SafeHtml {
  const state = s.disabled_at !== null ? `disabled (${s.disabled_reason ?? 'unknown'})` : 'active';
  return html`<tr data-subscription-id="${attr(s.id)}">
  <td data-label="Device">${s.label ?? s.ua_family ?? '(unlabelled device)'}</td>
  <td data-label="Added" title="${fmtTime(s.created_at)}">${fmtRelative(s.created_at, nowMs)}</td>
  <td data-label="Last OK">${s.last_ok_at !== null ? fmtRelative(s.last_ok_at, nowMs) : '-'}</td>
  <td data-label="State">${state}</td>
  <td data-label="Action">
    <button type="button" class="btn-push-unsubscribe" data-subscription-id="${attr(s.id)}" data-csrf="${attr(csrf)}">Unsubscribe</button>
  </td>
</tr>`;
}

/** docs/09_phase5_spec.md §4.5: the Notifications section carries the VAPID public key in a
 *  `data-vapid-public-key` attribute so `app.js` can read it without a second request. */
export function settingsPage(model: SettingsPageModel): SafeHtml {
  return html`<h1>Settings</h1>

<section id="notifications-section" ${model.vapidPublicKey ? html`data-vapid-public-key="${attr(model.vapidPublicKey)}"` : ''} aria-labelledby="notif-h">
  <h2 id="notif-h">Push notifications</h2>
  ${
    !model.pwaEnabled
      ? html`<p class="note">PWA_ENABLED is off - push notifications are unavailable.</p>`
      : !model.webpushConfigured
        ? html`<p class="note">Web Push is not configured on this server. Run <code>openpost push keys --write-env</code> and set <code>NOTIFY_CHANNELS=webpush</code>.</p>`
        : html`
    <div class="push-actions">
      <button type="button" id="btn-push-enable" class="btn-primary">Enable on this device</button>
    </div>
    <p id="push-status" role="status" aria-live="polite"></p>
    <div class="table-wrap">
    <table class="push-devices-table">
      <caption class="visually-hidden">Registered push devices</caption>
      <thead><tr><th scope="col">Device</th><th scope="col">Added</th><th scope="col">Last OK</th><th scope="col">State</th><th scope="col">Action</th></tr></thead>
      <tbody>${join(model.subscriptions.map((s) => deviceRow(s, model.csrf, model.nowMs)))}</tbody>
    </table>
    </div>
    ${model.subscriptions.length === 0 ? html`<p class="note">No devices registered yet.</p>` : ''}
  `
  }
</section>

<section aria-labelledby="install-h">
  <h2 id="install-h">Install openpost on your phone</h2>
  <div class="install-help">
    <p><strong>Android / Chrome:</strong> open this dashboard, then use the browser menu &rarr; "Add to Home screen" or "Install app".</p>
    <p><strong>iPhone / iPad (Safari):</strong> tap Share, then "Add to Home Screen". Push notifications only work once the app is opened from the Home Screen icon, not from Safari itself.</p>
    <p class="note">A public HTTPS hostname is required - browsers refuse to register a service worker or Web Push outside a secure context (loopback is exempt, for local testing).</p>
  </div>
</section>

<section aria-labelledby="session-h">
  <h2 id="session-h">Session</h2>
  <p>Authenticated via: <strong>${model.sessionVia ?? 'none'}</strong>. Session lifetime: ${String(model.dashboardSessionHours)}h.
    ${model.sessionVia === 'session' ? html`<a href="#" id="link-logout">Log out</a><form id="form-logout" method="post" action="/dashboard/logout" hidden><input type="hidden" name="_csrf" value="${attr(model.csrf)}"></form>` : ''}
  </p>
  <p class="note">An installed PWA has its own cookie jar - log in once inside the installed app. If your dashboard is used mostly from a phone, consider raising <code>DASHBOARD_SESSION_HOURS</code> (e.g. 720) so you are not asked to log in every 12 hours.</p>
</section>`;
}
