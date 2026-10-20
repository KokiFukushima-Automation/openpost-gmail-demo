import { html, join, raw, type SafeHtml } from './html.js';
import { flash } from './fragments.js';
import type { FlashMessage } from './fragments.js';
import { ICON_CAMPAIGNS, ICON_COMPOSE, ICON_MESSAGES, ICON_MORE, ICON_REMINDERS, ICON_STATS } from './icons.js';
import { VERSION } from '../../version.js';

export type { FlashMessage };

export type NavKey = 'messages' | 'campaigns' | 'audit' | 'stats' | 'reminders' | 'compose' | 'settings';

export interface LayoutModel {
  title: string;
  active: NavKey | null;
  body: SafeHtml;
  flash?: FlashMessage | null;
  csrf: string;
  /** When false (no session/bearer context worth live-updating, or JS explicitly unsupported),
   *  the page renders without the SSE wiring and a manual "Refresh" link instead (§2.6). */
  live: boolean;
  /** Phase 5 (§2.5/§2.6): PWA_ENABLED - emits the manifest/service-worker links and registers the
   *  worker. Defaults to true so every pre-Phase-5 call site (which never set this) is unaffected. */
  pwaEnabled?: boolean;
  /** Phase 5 (§2.6): COMPOSE_ENABLED - shows the Compose nav item at all. Defaults to true. */
  composeEnabled?: boolean;
  /** Phase 5 (§2.9): identifies the compose page so `app.js`/`compose.js` bootstraps draft autosave
   *  only there. */
  page?: 'compose' | undefined;
}

const NAV_ITEMS: Array<{ key: NavKey; label: string; href: string }> = [
  { key: 'messages', label: 'Messages', href: '/dashboard/messages' },
  { key: 'compose', label: 'Compose', href: '/dashboard/compose' },
  { key: 'campaigns', label: 'Campaigns', href: '/dashboard/campaigns' },
  { key: 'reminders', label: 'Reminders', href: '/dashboard/reminders' },
  { key: 'stats', label: 'Stats', href: '/dashboard/stats' },
  { key: 'audit', label: 'Audit', href: '/dashboard/audit' },
  { key: 'settings', label: 'Settings', href: '/dashboard/settings' },
];

/** §3.2: the bottom nav's six items (Messages, Compose, Campaigns, Reminders, Stats, More ->
 *  settings), each an inline SVG glyph (never database-derived, `views/icons.ts`) plus a label. */
function bottomNavItems(composeEnabled: boolean): Array<{ key: NavKey; label: string; href: string; icon: SafeHtml }> {
  const items: Array<{ key: NavKey; label: string; href: string; icon: SafeHtml }> = [
    { key: 'messages', label: 'Messages', href: '/dashboard/messages', icon: ICON_MESSAGES },
  ];
  if (composeEnabled) {
    items.push({ key: 'compose', label: 'Compose', href: '/dashboard/compose', icon: ICON_COMPOSE });
  }
  items.push(
    { key: 'campaigns', label: 'Campaigns', href: '/dashboard/campaigns', icon: ICON_CAMPAIGNS },
    { key: 'reminders', label: 'Reminders', href: '/dashboard/reminders', icon: ICON_REMINDERS },
    { key: 'stats', label: 'Stats', href: '/dashboard/stats', icon: ICON_STATS },
    { key: 'settings', label: 'More', href: '/dashboard/settings', icon: ICON_MORE },
  );
  return items;
}

function assetHref(name: string): string {
  return `/dashboard/assets/${name}?v=${VERSION}`;
}

/** The full-page shell (§2.6): skip link, header/nav landmarks, `<main id="main">`, footer, and the
 *  live-update wiring (`hx-headers` carrying the CSRF header value htmx sends on every POST, plus
 *  the status/announce regions `app.js` drives). Phase 5 additionally emits the PWA manifest/theme
 *  links, a mobile bottom nav, and `data-csrf` on `<body>` so `app.js` can read the CSRF token
 *  without parsing `hx-headers` (§2.6, §4.5). */
export function layout(model: LayoutModel): SafeHtml {
  const pwaEnabled = model.pwaEnabled ?? true;
  const composeEnabled = model.composeEnabled ?? true;
  const csrfEscaped = model.csrf.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  const bodyAttrParts: string[] = [];
  if (model.live) {
    bodyAttrParts.push(`hx-headers='{"X-Openpost-CSRF":"${csrfEscaped}"}'`, 'data-live="1"');
  }
  bodyAttrParts.push(`data-csrf="${csrfEscaped}"`);
  if (model.page) bodyAttrParts.push(`data-page="${model.page}"`);
  const bodyAttrs = raw(` ${bodyAttrParts.join(' ')}`);

  const pwaHead = pwaEnabled
    ? raw(
        '<link rel="manifest" href="/dashboard/assets/manifest.webmanifest">' +
          '<meta name="theme-color" content="#1b5fbf">' +
          '<link rel="apple-touch-icon" href="/dashboard/assets/apple-touch-icon-180.png">' +
          '<meta name="apple-mobile-web-app-capable" content="yes">',
      )
    : raw('');

  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${model.title} · openpost</title>
<link rel="icon" href="/dashboard/assets/favicon.svg">
<link rel="stylesheet" href="${assetHref('app.css')}">
<meta name="htmx-config" content='{"includeIndicatorStyles":false}'>
${pwaHead}
</head>
<body${bodyAttrs}>
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
  <p class="brand">openpost</p>
  <nav aria-label="Main">
    <ul>
      ${join(
        NAV_ITEMS.filter(item => item.key !== 'compose' || composeEnabled).map(
          (item) =>
            html`<li><a href="${item.href}" ${raw(model.active === item.key ? 'aria-current="page"' : '')}>${item.label}</a></li>`,
        ),
      )}
    </ul>
  </nav>
  <span id="live-status" role="status" aria-live="polite">${model.live ? 'connecting…' : ''}</span>
  ${model.live ? '' : html`<a href="" aria-label="Refresh this page">Refresh</a>`}
</header>
<main id="main">
${flash(model.flash)}
${model.body}
</main>
<div id="live-log" class="visually-hidden" aria-live="polite"></div>
<nav class="nav-bottom" aria-label="Main">
  ${join(
    bottomNavItems(composeEnabled).map(
      (item) =>
        html`<a href="${item.href}" ${raw(model.active === item.key ? 'aria-current="page"' : '')}>${item.icon}<span>${item.label}</span></a>`,
    ),
  )}
</nav>
<footer class="site-footer"><p>openpost - self-hosted.</p></footer>
${
  model.live || pwaEnabled
    ? raw(`<script src="${assetHref('htmx.min.js')}"></script><script src="${assetHref('app.js')}"></script>`)
    : raw('')
}
${model.page === 'compose' ? raw(`<script src="${assetHref('compose.js')}"></script>`) : raw('')}
</body>
</html>`;
}
