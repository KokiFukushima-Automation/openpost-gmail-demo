# Dashboard (Phase 3)

A local, server-rendered web dashboard at `/dashboard` - no build step, no bundler, no cloud
service, no framework. It is the same Fastify process `openpost serve` already runs (or, in the
split-process mode, `openpost dashboard` alone).

## Quick start

```bash
node dist/cli/index.js migrate
node dist/cli/index.js seed --demo --reset --json   # deterministic fixture data
export DASHBOARD_PASSWORD=letmein                   # only required off loopback
node dist/cli/index.js serve
```

Open `http://127.0.0.1:8787/dashboard`. On loopback with neither `DASHBOARD_PASSWORD` nor
`API_TOKEN` set, the dashboard works with no login at all (`via: 'open'`) - convenient for local
development, and safe because the process refuses to bind off loopback (or with `TRUST_PROXY`
enabled) without one of those two secrets configured (`ConfigError`, exit 2, naming the variable).

## Pages

| Path | What it shows |
|---|---|
| `/dashboard/messages` | Every message: sent time, subject, recipients, worst-case state badge, opens/clicks/replies, a pending-reminder marker. Filterable by `q` (subject/email substring), `status`, `state`, `has` (opens/clicks/replies/none), `since`/`until`; sortable; paginated (25/50/100). |
| `/dashboard/messages/:id` | Message header (status, transport, self-copy strategy, mute toggle) plus one recipient summary row and one detailed timeline section per recipient (opens, clicks, the reply if any, and any reminders), each event showing classification/confidence/rule-id chips. |
| `/dashboard/events/:kind/:id` | Full detail for one open/click event: redacted signals (`ip_hash`/`ip_net_hash` prefixes, UA, OS, "unknown (proxied)" where the classification implies a proxy), the rule documentation for every rule id that fired, and the override form. |
| `/dashboard/audit` | The append-only audit log, filterable by action/subject/since; a `reclassify.override` row renders as a compact `bot → human` diff. Audit rows never contain a raw address, IP or token. |
| `/dashboard/stats` | Open/click/reply rates, a time-to-open distribution and a `REPORT_TIMEZONE`-correct best-hour histogram, both as accessible inline SVG with a `<details>` data table fallback; an accuracy self-report summary. |
| `/dashboard/reminders` | Every reminder (pending/claimed/fired/skipped/cancelled/failed) with a cancel button for pending ones. |
| `/dashboard/export.csv` / `.json` | The same filter as the message list, one row per recipient, capped at `DASHBOARD_MAX_EXPORT_ROWS`. |
| `/dashboard/compose` | Phase 5 mobile compose form (also the GET Web Share Target) - see docs/mobile.md. Hidden entirely when `COMPOSE_ENABLED=false`. |
| `/dashboard/settings` | Phase 5: registered Web Push devices, install-on-phone help, and session info - see docs/mobile.md. |

At `<=480px` every table above collapses into a card list (`data-label` + `::before`, no JS) and a
fixed bottom nav (Messages/Compose/Campaigns/Reminders/Stats/More) replaces the header nav - see
docs/mobile.md for the full responsive/PWA story.

## The two-click override

Every event on the message detail and event detail pages has a `<details>` disclosure: **click 1**
opens it, **click 2** is the "Override to `<classification>`" button, which `POST`s to
`/dashboard/actions/reclassify` - the exact same `reclassify()` service the CLI's `openpost
reclassify` uses, so there is no second source of truth. The override never emits a notification
(existing guarantee) and is visible in the audit view as a `before → after` diff.

## Auth and CSRF

- **Bearer**: `Authorization: Bearer <API_TOKEN>` - the scripting/`curl` path, and the only path
  usable from `curl`/CI. No CSRF token required (a bearer carries no ambient browser credential).
- **Session**: a single `DASHBOARD_PASSWORD` gets you a stateless, HMAC-signed `openpost_sess`
  cookie (`HttpOnly; SameSite=Strict; Path=/dashboard`, `Secure` when `TRACKING_BASE_URL` is
  `https:` or `DASHBOARD_SECURE_COOKIES=true`). Sessions are **stateless** - there is no session
  table, so rotating `TRACKING_SECRET` revokes every session immediately, and a session simply
  expires after `DASHBOARD_SESSION_HOURS`.
- **Open**: on loopback with neither secret configured, every request is treated as authenticated
  (`via: 'open'`) - the zero-config local dev case.
- **CSRF**: double-submit, bound to the session id (`openpost_csrf` cookie, readable by JS on the
  same origin). Every `POST` must carry the same value as a hidden `_csrf` field or the
  `X-Openpost-CSRF` header (htmx sends this automatically via `hx-headers` on `<body>`). Because the
  token is `HMAC(sessionKey, "csrf:" + sid)`, a token minted for a different session never
  validates. An `Origin` (or, failing that, `Referer`) that names a different host is rejected
  regardless. Bearer- and open-mode requests skip the CSRF check: neither carries an ambient cookie
  a hostile page could piggyback on.
- **Login rate limiting**: failed `POST /dashboard/login` attempts are throttled per hashed IP
  (`DASHBOARD_LOGIN_RATE_PER_MIN`, default 10/min), with a flat 250 ms delay on every failure and an
  audit row (`dashboard.login.failed`, subject `ip_hash` - never the IP or the password).

## Content Security Policy

Every dashboard **HTML** response (not the static assets, which get their own immutable caching
headers) carries:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none';
  frame-ancestors 'none'; manifest-src 'self'; worker-src 'self'
Referrer-Policy: same-origin
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cache-Control: no-store
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), interest-cohort=()
```

`manifest-src`/`worker-src` are Phase 5 additions for the PWA manifest and service worker (both
previously fell through to `default-src 'none'`, which blocks them outright). There is **no**
`unsafe-inline` anywhere, before or after. All CSS lives in `src/server/assets/app.css`, all JS in
`app.js`/`compose.js`/`sw.js` and the vendored `htmx.min.js` (htmx 2.0.4, sha256 recorded in that
file's own header comment and asserted by `openpost doctor`'s `dashboard.assets` check), and every
chart is inline SVG built with CSS classes, never a `style=` attribute. htmx's own default inline
`<style>` block for indicator transitions is turned off via `<meta name="htmx-config"
content='{"includeIndicatorStyles":false}'>` in the page head - the one place a third-party library
would otherwise have violated this CSP.

**`Referrer-Policy` is `same-origin`, not `no-referrer`, as of Phase 5.** The compose page's plain
`<form method="post">` (a genuine document navigation, not an htmx `fetch()`) exposed a real
Fetch/HTML-spec interaction: under `no-referrer`, a browser sends the literal `Origin: null` header
even on a same-origin POST navigation, which the CSRF preHandler's same-origin check cannot tell
apart from a cross-origin submission - every real compose send was rejected with 403. `same-origin`
keeps the actual privacy property (nothing is ever sent to a third-party origin) while restoring the
`Origin`/`Referer` headers a same-origin form POST needs to pass the CSRF check; every dashboard page
is same-origin with every other, so nothing new is disclosed anywhere.

## Live updates

`app.js` (~70 lines, no framework) opens `new EventSource('/api/events/stream')` - the exact same
SSE endpoint the CLI/API layer already exposes, now also accepting the dashboard session cookie
(a browser `EventSource` cannot send a bearer header). On a `tracking` frame it swaps in a fresh
`<tr>` for the affected recipient and message row via `htmx.ajax(...)`, flashes the swapped row for
1.2s (suppressed under `prefers-reduced-motion`), and announces a one-line summary in a
`aria-live="polite"` region throttled to at most once per second. With JavaScript disabled the page
still renders correctly; it just doesn't auto-update.

## Split-process mode

```bash
node dist/cli/index.js dashboard --port 8788 --host 127.0.0.1
```

Registers only `/healthz`, `/api/*` and `/dashboard/*` - no `/o`, `/c`, `/u`. Recommended when the
tracking server itself is exposed through a tunnel: keep the pixel/click endpoints public on
`openpost serve`, and run the dashboard on a second, loopback-only process.

## Everything is offline-testable

Every dashboard route is exercised with `app.inject()` (no real server, no browser); the one thing
that genuinely needs a browser - proving a pixel hit updates a row with no page reload - is proven
in real Chromium via Playwright (`tests/e2e/dashboard.spec.ts`, `npm run test:e2e`), which is
skipped automatically when `/opt/pw-browsers` (or `PLAYWRIGHT_CHROMIUM_PATH`) is absent.
