> Note (added at commit time): this spec was written against HEAD d422184 (schema user_version 3). A concurrent Phase 2.1 hardening pass (see docs/reports/phase2_review.md) may itself add migration 004. The implementer must renumber the Phase 3 migration to the next free number and adjust EXPECTED_SCHEMA accordingly; all other content stands.

# 06 — Phase 3 Implementation Spec

Target: a coding agent implements this directly, with no further design decisions required.
Same stack as Phases 1–2 (Node 22 + TypeScript strict + Fastify 5 + better-sqlite3 + vitest, ESM).
Phase 3 adds **no public URL requirement, no Gmail credential requirement and no bundler**: the
dashboard is server-rendered HTML + vendored htmx, every page is exercised with `app.inject()`, the
live-update DoD is proven with Playwright against a locally bound server (Chromium is preinstalled
at `/opt/pw-browsers`), and every Gmail call goes through an injectable client that tests fake.

---

## 0. Baseline: what Phases 1–2 actually shipped

This spec is written against the code in the tree, not against doc 03's prose. Carried-forward
facts that shape Phase 3:

| Fact (verified in the tree) | Consequence for Phase 3 |
|---|---|
| `EXPECTED_SCHEMA = 3` (`src/db/index.ts`); `003_phase2.sql` is the last migration | Phase 3 ships `004_phase3.sql`, `EXPECTED_SCHEMA = 4`. |
| `001_init.sql` created a `reminders` table that **no code ever reads or writes** (grep-verified), with columns `(id, message_id, recipient_id, condition, due_at, state, fired_at, created_at)` | 004 `DROP TABLE reminders` + rebuild, same precedent and safety argument as 003's `notifications` drop. No data can be lost. |
| `recipients.replied_at` exists since 001 and is **never written** | Phase 3 finally writes it, and adds the `replied` recipient state. |
| `recipients.thread_id` / `rfc822_msg_id` / `sent_at` are written per recipient by `markRecipientSent` (`src/db/repo.ts`) | Reply polling and `--draft` threading have exactly the ids they need, per recipient. |
| `recomputeRecipientCounters` **overwrites** `recipients.state` from `deriveRecipientState(counters)` | `deriveRecipientState` must learn about `replied_at`, or every recompute would erase a detected reply (§4.4). |
| SSE (`src/server/routes/stream.ts`) is registered under `/api` and gated by `isValidApiBearer` only | A browser `EventSource` cannot send an `Authorization` header ⇒ the stream route must also accept the dashboard session cookie (§2.4). |
| `NotifyTrigger = first_open | read_confirmed | click | prefetched`; `TrackingEvent.kind = 'open' | 'click'` | Widened with `reply` and `reminder` so both reuse the existing bus → SSE → queue → channels path unchanged (§2.7, §3.6). |
| `notifications.event_type` has no `CHECK` constraint | `'reminder'` / `'reply'` fit the existing queue with no schema change. |
| `GMAIL_SCOPES_BASE` already includes `gmail.readonly` | Reply detection needs **no new consent** for existing grants. Drafts need `gmail.compose` (new, opt-in). |
| `/api/stats` returns `accuracyReport(db, since)` verbatim | Phase 3 makes the response a **superset** (adds a `stats` key), so nothing that reads it today breaks (§5). |
| `npm run build` = `tsc && cp -r src/db/migrations dist/db/` | Extended with `cp -r src/server/assets dist/server/` (§6.1). |
| No `@fastify/static`, `@fastify/cookie`, `@fastify/formbody`, `htmx.org` or Playwright installed | §2.1 explains why none of the first four are added at all. |

196 existing tests must stay green. Phase 3 adds test cases **121–192**.

---

## 1. Goal and Definition of Done

**Goal.** Give the operator a real product surface: a local, zero-build web dashboard that shows
every message, recipient, event and classification (and lets a human correct one in two clicks),
updates live from the SSE stream that already exists, and reports honest aggregate numbers; plus the
two things Mailtrack charges for and openpost still lacks — **reminders** ("nudge me if nobody
replies in 3 days", optionally pre-writing a Gmail draft in the same thread) and **reply
detection**, which is also what makes "no reply" a truthful condition.

**Definition of Done** (each item is binary and checkable). Items 1–5 are the roadmap's:

1. The dashboard renders a seeded database (`openpost seed --demo`) and updates a row **live** when a
   `curl` pixel hit arrives, with no page reload (asserted twice: at SSE/fragment level with
   `app.inject()` + a real `EventSource`-shaped client, test 150–151, and end-to-end in Chromium,
   test 152).
2. Each event row shows its classification, confidence and rule ids, and can be overridden in **two
   clicks**; the override is visible in the audit view (tests 141, 144, 145).
3. A reminder created with `--in 1m` fires **once**, notifies, and never fires twice after a restart
   mid-window — proven by a test that SIGKILLs a child process between due-time and fire and then
   runs a fresh firing pass (test 176).
4. A reply in the thread sets `recipients.replied_at` within one poll interval, moves the recipient
   to state `replied`, and cancels the pending `no_reply` reminder (tests 178–181).
5. The dashboard **refuses to start** on a non-loopback bind with no auth secret configured
   (`ConfigError`, exit 2, naming the variable to set — test 133).

Added by this spec:

6. `npm ci && npm run build && npm test` green on a clean container with **no `.env`, no
   credentials, no network, no browser**; cases 121–192 present and passing; coverage stays ≥ 90 %
   for `src/core/**` and ≥ 85 % for `src/notify/**`, and adds ≥ 85 % for `src/server/views/**`.
7. **Zero new runtime npm dependencies** (§2.1). One new devDependency (`@playwright/test`) and one
   vendored static asset (`htmx.min.js`, checked in with its version and sha256 in a header comment).
8. `openpost migrate` upgrades a populated v3 database to v4 with zero row loss; `/healthz` reports
   `"schema": 4`; running it twice returns 4 and changes nothing (test 184).
9. Every dashboard HTML response carries the §2.3 CSP with **no `unsafe-inline`** anywhere, and the
   page works with scripts disabled except for live updates (test 191).
10. `GET /dashboard/export.csv` and `.json` honour the exact same filters as the list page, are
    byte-stable for a fixed seed, and are capped at `DASHBOARD_MAX_EXPORT_ROWS` (tests 147–149).
11. `/api/stats` returns open rate, click rate, time-to-open buckets and a best-hour histogram in
    `REPORT_TIMEZONE`, and every number matches an independent SQL cross-check (tests 153–159).
12. `openpost seed --demo` produces a deterministic database (same `--seed` ⇒ identical ids,
    timestamps and counts) that the Playwright run screenshots into `docs/reports/phase3/*.png`.
13. Everything above is reachable with `MAIL_TRANSPORT=dryrun`, no public URL and no Gmail
    credentials. The only operator-run steps are one real `--draft` reminder and one real reply,
    documented for `docs/reports/phase3_smoke.md`.

**Out of scope for Phase 3:** campaigns/mail-merge, multi-account, geo lookup, packaging, the Gmail
add-on/extension (all Phase 4). No dashboard *write* path other than reclassify, mute and reminder
cancel — the dashboard never sends mail.

---

## 2. Dashboard

### 2.1 Dependency budget and the three rejected packages

| Candidate | Verdict | Reason |
|---|---|---|
| `@fastify/static` | **rejected** | The dashboard ships exactly four static files. A 30-line allowlisted asset route (§2.2) with strong ETags and an immutable `Cache-Control` does the same job, avoids a directory-traversal surface entirely, and keeps the "one binary, one SQLite file" promise. |
| `@fastify/cookie` | **rejected** | Two functions, `parseCookies` (~10 lines) and `serializeCookie` (~15 lines), in `src/server/auth/session.ts`. Sessions are stateless and HMAC-signed with the key material that already exists. |
| `@fastify/formbody` | **rejected** | One `app.addContentTypeParser('application/x-www-form-urlencoded', …)` built on `URLSearchParams`, registered only inside the dashboard plugin scope. |
| `htmx.org` (npm) | **rejected as a dependency, vendored as a file** | We need one 48 KB minified file, not a package and a build step. `src/server/assets/htmx.min.js` is checked in with a header comment recording `htmx 2.0.4`, its upstream URL and its sha256; `openpost doctor` asserts that hash so a silently swapped asset is caught. |
| A template engine (eta/nunjucks/handlebars) | **rejected** | §2.5's `html` tagged template is ~45 lines, escapes by construction (the unsafe path must be spelled `raw(...)`), is fully type-checked by `tsc`, and composes as plain functions. A template engine would add a dependency, a cache, a file-loading path and a second syntax to review for XSS. |
| `@playwright/test` | **accepted, devDependency only** | The only way to prove DoD 1 in a real browser. Not a runtime dependency; `npm test` (vitest) never touches it. |

**Net: 0 new runtime dependencies, 1 new devDependency.**

### 2.2 Shape and routes

```
openpost serve
  └─ buildServer(deps)                       src/server/app.ts
       ├─ /o /c /u /healthz /api …           (unchanged)
       └─ registerDashboardRoutes(app, resolved)      when config.dashboardEnabled
            ├─ content-type parser (urlencoded), scoped to this plugin
            ├─ onRequest: security headers + auth guard (§2.3, §2.4)
            ├─ preHandler (POST only): CSRF (§2.4)
            └─ routes below
```

| Method + path | Purpose | Auth |
|---|---|---|
| `GET /dashboard` | message list (302 to `/dashboard/messages` preserving the query string) | session/bearer |
| `GET /dashboard/messages` | list: filters, pagination, per-message state/open/click/reply columns | session/bearer |
| `GET /dashboard/messages/:id` | detail: per-recipient timeline of opens + clicks + reply + reminders | session/bearer |
| `GET /dashboard/events/:kind/:id` | event detail: classification, confidence, rule ids, redacted signals, override UI | session/bearer |
| `GET /dashboard/audit` | audit view: filter by action/subject/since, paginated | session/bearer |
| `GET /dashboard/stats` | aggregate stats page, inline SVG charts (§5) | session/bearer |
| `GET /dashboard/reminders` | pending/fired/cancelled reminders, cancel button | session/bearer |
| `GET /dashboard/export.csv` / `.json` | export of the current filter (§2.8) | session/bearer |
| `GET /dashboard/fragments/recipient/:id` | one `<tr>` for live replacement | session/bearer |
| `GET /dashboard/fragments/message-row/:id` | one `<tr>` for live replacement | session/bearer |
| `GET /dashboard/fragments/event/:kind/:id` | one event `<li>` (post-override swap target) | session/bearer |
| `GET /dashboard/assets/:name` | `app.css`, `app.js`, `htmx.min.js`, `favicon.svg` | **public** (no data, immutable, hashed) |
| `GET /dashboard/login` | login form (only when `DASHBOARD_PASSWORD` is set) | public |
| `POST /dashboard/login` | password → session cookie | public + rate-limited |
| `POST /dashboard/logout` | clears the cookie | session + CSRF |
| `POST /dashboard/actions/reclassify` | calls `services/reclassify.reclassify` | session + CSRF |
| `POST /dashboard/actions/mute` | calls `repo.setMute` | session + CSRF |
| `POST /dashboard/actions/reminder-cancel` | cancels a pending reminder (§3) | session + CSRF |

`GET /dashboard/assets/:name` serves from a frozen `Map<string, {body: Buffer; type: string; etag: string}>`
built once at startup by `loadDashboardAssets(dir)` (`src/server/assets/index.ts`), reading
`dist/server/assets/*`. Unknown names ⇒ 404 with no filesystem access; there is no path join of user
input anywhere. Headers: `Cache-Control: public, max-age=31536000, immutable`, `ETag: "<sha256-16>"`,
`Content-Type` from the extension allowlist, and `304` on `If-None-Match`.

`openpost dashboard [--port <n>] [--host <addr>]` builds the *same* Fastify app with
`deps.mode = 'dashboard'`, which registers only `/healthz`, `/api`, `/dashboard` — no `/o`, `/c`,
`/u`. This is the recommended split when the tracker itself is exposed through a tunnel: the pixel
endpoint is public, the dashboard stays on loopback.

### 2.3 Security headers and CSP

Every dashboard **HTML** response (not assets) sets:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
  img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none';
  frame-ancestors 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Cache-Control: no-store
Cross-Origin-Opener-Policy: same-origin
Permissions-Policy: geolocation=(), camera=(), microphone=(), interest-cohort=()
```

There is **no** `unsafe-inline` and no nonce machinery: all CSS lives in `app.css`, all JS in
`app.js` + `htmx.min.js`, and inline SVG is markup (not `style-src`). Charts therefore carry CSS
classes, never `style=` attributes. `connect-src 'self'` is what lets `app.js` open
`/api/events/stream`.

### 2.4 Auth: bearer or single-password session, and CSRF

`src/server/auth/session.ts` (pure, unit-tested):

```ts
export interface SessionCookie { sid: string; issuedAt: number; expiresAt: number }
export function parseCookies(header: string | undefined): Record<string, string>;
export function serializeCookie(name: string, value: string,
  opts: { maxAgeSec: number; secure: boolean; httpOnly: boolean; sameSite: 'Strict' | 'Lax'; path: string }): string;

export function sessionKey(config: AppConfig): Buffer;         // HMAC(TRACKING_SECRET, 'openpost:dashboard-session:v1')
export function issueSession(config: AppConfig, nowMs: number): { cookie: string; csrfCookie: string; sid: string };
export function verifySession(config: AppConfig, raw: string | undefined, nowMs: number): SessionCookie | null;
export function csrfTokenFor(config: AppConfig, sid: string): string;   // HMAC(sessionKey, 'csrf:' + sid), base32, 26 chars
export function verifyCsrf(config: AppConfig, sid: string, submitted: string | undefined): boolean;  // timing-safe

export type DashboardAuth =
  | { ok: true; via: 'bearer' | 'session' | 'open'; sid: string | null }
  | { ok: false; reason: 'missing' | 'invalid' };
export function authenticateDashboard(config: AppConfig, req: { headers; }, nowMs: number): DashboardAuth;
```

Cookie format: `v1.<expEpochSec>.<sid>.<b32 HMAC-SHA256(sessionKey, "v1."+exp+"."+sid)[0..10]>`,
name `openpost_sess`, flags `HttpOnly; SameSite=Strict; Path=/dashboard;`
`Secure` when `DASHBOARD_SECURE_COOKIES=true`, or `auto` (default) resolving to true iff
`TRACKING_BASE_URL` is `https:`. `sid` is `newId()` (16 random bytes, base32). Sessions are
**stateless** — no table; revocation = rotate `TRACKING_SECRET` or wait for expiry
(`DASHBOARD_SESSION_HOURS`, default 12).

Acceptance order in `authenticateDashboard`:

1. `Authorization: Bearer <API_TOKEN>` (constant-time via the existing `isValidApiBearer`) ⇒
   `{ ok: true, via: 'bearer', sid: null }`. This is the scripting/`curl` path.
2. A valid, unexpired `openpost_sess` cookie ⇒ `{ ok: true, via: 'session', sid }`.
3. Neither configured **and** the effective bind is loopback **and** `TRUST_PROXY` is off ⇒
   `{ ok: true, via: 'open', sid: null }` — the zero-config local dev case.
4. Otherwise `{ ok: false }`: HTML requests get `302 → /dashboard/login?next=<encoded path>` when a
   password is configured, else `401` with a text body naming `DASHBOARD_PASSWORD` / `API_TOKEN`.

**Login.** `POST /dashboard/login` reads `password` + `next`, compares against
`DASHBOARD_PASSWORD` with `timingSafeEqual` over SHA-256 digests (same hash-then-compare trick as
`src/server/api-auth.ts`), and on success sets both cookies and redirects to a **validated** `next`
(must start with `/dashboard`, else `/dashboard`). Failures are rate-limited by an in-process
token bucket keyed on `hashIp(req.clientIp)` (reusing `src/core/privacy.ts`) at
`DASHBOARD_LOGIN_RATE_PER_MIN` (default 10), with a flat 250 ms delay on failure; exceeding it
returns 429. Every outcome writes an audit row: `dashboard.login` / `dashboard.login.failed`
(subject `ip_hash`, never a raw IP or the password).

**CSRF.** Double-submit, bound to the session:
* `openpost_csrf` cookie (readable by JS, `SameSite=Strict`, same `Path`/`Secure`) = `csrfTokenFor(config, sid)`.
* Every POST must carry the same value in a hidden `_csrf` field **or** the `X-Openpost-CSRF`
  header (htmx sends it via `hx-headers` on `<body>`), verified with `verifyCsrf` (timing-safe) —
  and because the token is an HMAC of the sid, a token minted for another session never validates.
* Additionally, if `Origin` is present it must equal the request's own origin; if absent, `Referer`
  (when present) must share the host. A mismatch is `403 {"error":"csrf"}`.
* Bearer-authenticated POSTs (`via: 'bearer'`) skip CSRF: they carry no ambient credential.

**Bind safety.** `src/config/env.ts` gains:

```ts
export function assertSafeToServeDashboard(config: AppConfig, effectiveBind: string): void;
```
Throws `ConfigError` when `dashboardEnabled` and
`(!isLoopbackAddress(effectiveBind) || config.trustProxy !== false)` and
`config.dashboardPassword === undefined && config.apiToken === undefined`, with the message:

```
DASHBOARD_PASSWORD (or API_TOKEN) is required when the dashboard is reachable off loopback
(BIND_ADDRESS=0.0.0.0 or TRUST_PROXY enabled) - refusing to serve a dashboard with no auth
```
It also throws when `DASHBOARD_BIND` is set to a non-loopback address that differs from the
effective bind (a configuration that cannot mean anything). Called by `openpost serve` and
`openpost dashboard` right after the existing `assertSafeToBind`. `DASHBOARD_BIND` defaults to
`BIND_ADDRESS`; setting it to a non-loopback value prints a one-line warning to stderr even when a
secret *is* configured.

### 2.5 HTML templating: a 45-line tagged template, no engine

`src/server/views/html.ts`:

```ts
export class SafeHtml { constructor(readonly value: string) {} toString(): string }
export function raw(s: string): SafeHtml;            // the ONLY way to inject unescaped markup
export function escapeHtml(s: string): string;       // & < > " ' /
export function attr(v: string): string;             // escapeHtml + always emitted inside "…"
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml;
export function join(parts: unknown[], sep?: string): SafeHtml;
export function classNames(map: Record<string, boolean>): string;
export function render(doc: SafeHtml): string;
```

Interpolation rules: `SafeHtml` passes through; `null`/`undefined`/`false` render as `''`; arrays are
joined with `''`; everything else is `String(v)` then `escapeHtml`. A URL-typed helper
`href(path, params)` builds query strings with `URLSearchParams` so no caller hand-concatenates.
**Rule enforced by review and by test 121–123:** a page module may never call `raw()` on anything
derived from the database; `raw()` exists for composing sub-templates and for SVG built by
`views/charts.ts`.

Views (all pure functions `(model) => SafeHtml`, taking already-presented data — never a `DB`):

```
src/server/views/layout.ts          layout({title, active, body, flash, csrf, live})
src/server/views/pages/messages.ts  messagesPage(model)
src/server/views/pages/message.ts   messagePage(model)        // per-recipient timeline
src/server/views/pages/event.ts     eventPage(model)          // classification + override
src/server/views/pages/audit.ts     auditPage(model)
src/server/views/pages/stats.ts     statsPage(model)
src/server/views/pages/reminders.ts remindersPage(model)
src/server/views/pages/login.ts     loginPage(model)
src/server/views/fragments.ts       recipientRow(), messageRow(), eventItem(), overrideForm(), flash()
src/server/views/charts.ts          barChart(), hourHistogram(), sparkline(), statTile()
src/server/views/format.ts          fmtTime(), fmtRelative(), fmtPercent(), stateBadge(), confidenceBar()
```

Because views are pure and take plain models, tests 121–126 assert their output as strings with zero
HTTP involved, and page routes stay thin (parse → query → present → render).

### 2.6 Pages, concretely

**Message list (`/dashboard/messages`).** Filter bar (a plain `<form method="get">`, so it works
without JS; htmx upgrades it to `hx-get` + `hx-push-url` for in-place updates):

| Param | Meaning | Validation |
|---|---|---|
| `q` | substring of subject **or** recipient email | ≤ 100 chars, `LIKE … ESCAPE '\'` with `% _ \` escaped |
| `status` | `draft|sent|dryrun|failed` | enum, else 400 |
| `state` | message has ≥ 1 recipient in `not_opened|prefetched|opened|read_confirmed|replied` | enum |
| `has` | `opens|clicks|replies|none` | enum |
| `since` / `until` | epoch ms or `7d`/`30d` shorthand (`parseDuration`) | else 400 |
| `limit` | 25 \| 50 \| 100 (default `DASHBOARD_PAGE_SIZE`) | enum |
| `offset` | ≥ 0, ≤ 1e6 | integer |
| `sort` | `sent_desc` (default) \| `sent_asc` \| `opens_desc` | enum |

Columns: `Sent` (absolute + relative), `Subject` (link), `To` (first + "+N"), `State` (worst-case
badge across recipients, text + icon, never colour alone), `Opens` (counted / total, machine opens
in a `title`), `Clicks`, `Replied`, `Reminder` (⏰ when one is pending). Pagination:
`« Prev / page N of M / Next »` plus a total row count from `countMessagesFiltered`. Export links
carry the identical query string.

**Message detail (`/dashboard/messages/:id`).** Header (subject, status, sent at, transport,
self-copy strategy, mute toggle), then one `<section>` per recipient containing:
* state badge, counters, `sent_at`, time-to-first-open, `replied_at`, thread id (when set);
* a `<ol class="timeline">` merging opens and clicks (and the reply and any reminder) sorted by
  `occurred_at`, each `<li>` showing time, kind, classification, `confidence` as a
  `<meter>`-styled bar with a numeric label, rule ids as `<code>` chips (`R4`, `apple_ip`,
  `implied_by_click`, `manual`), UA family / device type, and — for clicks — the target URL;
* an `overridden` marker with the original classification when `overridden_at` is set;
* a `<details class="override">` disclosure per event: **click 1** opens it, **click 2** is the
  classification button that POSTs (DoD 2, two clicks).

**Event detail (`/dashboard/events/:kind/:id`).** Everything the timeline shows plus the redacted
stored signals (`ip_hash` prefix only, `ip_net_hash` prefix, `ua`, `os`, `country/region/city` —
labelled "unknown (proxied)" where the classification implies a proxy), the full rule list with
one-line human explanations from a static `RULE_DOC: Record<string, string>` table in
`src/server/views/format.ts` (R0–R10, R6b, `apple_ip`, `implied_by_click`, `manual`), and the same
override form with a free-text `note`.

**Override POST** (`/dashboard/actions/reclassify`, fields `kind`, `eventId`, `classification`,
`counted?`, `note?`, `_csrf`): calls the existing
`reclassify(db, { …, actor: 'dashboard', atMs: Date.now() })` unchanged — no new service — maps
`ReclassifyInvalidError → 400`, `ReclassifyNotFoundError → 404`, and responds with
`fragments.eventItem(...)` for `hx-swap="outerHTML"` when `HX-Request: true`, otherwise `303` back
to the referring page with a flash message. No notification is emitted (existing guarantee).

**Audit view (`/dashboard/audit`).** Filters `action` (datalist of distinct actions), `subject`,
`since`, `limit`, `offset`; columns time / actor / action / subject type+id / detail. `detail_json`
is pretty-printed inside `<details>`; the page states in a `<p class="note">` that audit rows never
contain raw addresses, IPs or tokens. Reclassification rows render a compact
`bot → human (counted)` diff so DoD 2's "visible in the audit view" is unambiguous.

**Live updates.** `layout()` renders `<body hx-headers='{"X-Openpost-CSRF":"…"}' data-live="1">`, a
`<span id="live-status" role="status" aria-live="polite">` and `<div id="live-log" class="visually-hidden" aria-live="polite">`.
`app.js` (≈ 70 lines, no framework):

```js
const es = new EventSource('/api/events/stream');
es.addEventListener('tracking', (ev) => {
  const p = JSON.parse(ev.data);
  const row = document.querySelector(`[data-recipient-id="${CSS.escape(p.recipient.id)}"]`);
  if (row) htmx.ajax('GET', `/dashboard/fragments/recipient/${p.recipient.id}`, { target: row, swap: 'outerHTML' });
  const mrow = document.querySelector(`[data-message-id="${CSS.escape(p.message.id)}"]`);
  if (mrow) htmx.ajax('GET', `/dashboard/fragments/message-row/${p.message.id}`, { target: mrow, swap: 'outerHTML' });
  announce(`${p.event.kind} · ${p.event.classification} · ${p.recipient.email ?? 'recipient'}`);
});
es.onopen  = () => setStatus('live');
es.onerror = () => setStatus('reconnecting');   // EventSource retries on its own (retry: 3000)
```
Swapped rows get `class="flash"` for a 1.2 s CSS highlight, suppressed under
`@media (prefers-reduced-motion: reduce)`. When `data-live` is absent (JS off) the page renders a
`<meta http-equiv="refresh" content="60">`-free static view plus a "Refresh" button — nothing
breaks, it simply does not auto-update.

**Stream auth change.** `src/server/routes/stream.ts`'s `onRequest` hook becomes:

```ts
if (!isValidApiBearer(config, req.headers['authorization'])
    && authenticateDashboard(config, req, Date.now()).ok !== true) {
  reply.code(401).send({ error: 'unauthorized' });
}
```
This is the only change to an existing route's auth, it is read-only, `SameSite=Strict` prevents a
cross-site page from opening the stream with the ambient cookie, and test 88's behaviour (bearer
required, no cookie present ⇒ 401) is preserved.

### 2.7 Accessibility basics (asserted by test 191–192)

* `<!doctype html><html lang="en">`, one `<h1>` per page, landmarks (`<header>`, `<nav>`, `<main id="main">`, `<footer>`).
* A "Skip to content" link as the first focusable element.
* Tables are real tables with `<caption class="visually-hidden">`, `<th scope="col">`, and
  `aria-sort` on the active sort column.
* Every input has a bound `<label>`; the filter form has `<fieldset><legend>`; buttons say what they
  do ("Override to human"), never just an icon — icons are `aria-hidden="true"` decoration.
* State is conveyed by text + shape, never colour alone; `app.css` targets ≥ 4.5:1 contrast in both
  `prefers-color-scheme` modes; `:focus-visible` outline is never removed.
* SVG charts: `role="img"`, `aria-labelledby` pointing at `<title>` + `<desc>`, and each chart is
  followed by `<details><summary>Data table</summary>…` containing the same numbers.
* Live region politeness: `aria-live="polite"` (never `assertive`), throttled to at most one
  announcement per second.

### 2.8 Export

`GET /dashboard/export.csv|.json` reuses `parseMessageFilter` verbatim, ignores `limit`/`offset`,
and streams up to `DASHBOARD_MAX_EXPORT_ROWS` (default 50 000; beyond that, `413` naming the
variable). One row per **recipient** (the useful grain):

```
message_id,sent_at,subject,recipient_id,email,kind,state,open_count,machine_open_count,
first_open_at,last_open_at,click_count,first_click_at,replied_at,opted_out_at,
time_to_open_ms,thread_id,status
```

CSV: RFC 4180 (CRLF, `"` doubling), UTF-8 **with BOM** (Excel), `Content-Disposition: attachment;
filename="openpost-export-<ISO date>.csv"`, and a formula-injection guard — any cell starting with
`= + - @ \t \r` is prefixed with `'`. `.json` emits `{ generatedAt, filter, count, rows: [...] }`
with camelCase keys matching the presenters. Timestamps are epoch ms plus an ISO-8601 twin
(`sent_at_iso`) so a spreadsheet is readable without conversion. Tokens are **never** exported.

---

## 3. Reminders

### 3.1 CLI

```
openpost remind <message-id>
      [--recipient <recipientId|email>]        # default: every recipient of the message
      --if no-reply|no-open|always             # default REMINDER_DEFAULT_CONDITION (no-reply)
      (--in <3d|4h|90m|45s> | --at <ISO-8601>)
      [--draft] [--draft-subject <text>] [--draft-body-file <path>] [--draft-body <html>]
      [--note <text>] [--json]

openpost reminders list [--status pending|claimed|fired|skipped|cancelled|failed|all]
                        [--message <id>] [--due-before <iso|dur>] [--limit <n>] [--json]
openpost reminders cancel (<id> | --message <id> | --all-pending) [--yes] [--json]
openpost reminders run [--now <iso>] [--limit <n>] [--json]     # one firing pass, for cron + tests
```

`--in` / `--at` are mutually exclusive and mandatory (one of them). `--at` must parse as ISO-8601
and be in the future; both are rejected beyond `REMINDER_MAX_HORIZON_DAYS` (365). `--draft` requires
a Gmail refresh token with `gmail.compose`; without it the command still creates the reminder but
prints a warning naming `openpost auth gmail --with-compose` (exit 0), because the notification part
still works. `--recipient <email>` resolves within that message only, and is ambiguous-safe (errors
if the address appears twice). Exit codes unchanged: 0 / 1 / 2.

`src/core/time.ts` gains:

```ts
export function parseDuration(s: string): number | null;    // '45s' '90m' '4h' '3d' '2w'; null on garbage
export function parseWhen(opts: { in?: string; at?: string }, nowMs: number):
  { atMs: number } | { error: string };
export function hourInZone(ms: number, timeZone: string): number;    // Intl, DST-correct
export function dayKeyInZone(ms: number, timeZone: string): string;  // 'YYYY-MM-DD'
export function isValidTimeZone(tz: string): boolean;                // Intl.supportedValuesOf / try-catch
```

### 3.2 Table (migration 004)

```sql
DROP TABLE reminders;                      -- the 001 stub was never read or written (grep-verified)
CREATE TABLE reminders (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL REFERENCES messages(id)   ON DELETE CASCADE,
  recipient_id       TEXT          REFERENCES recipients(id) ON DELETE CASCADE,
  condition          TEXT NOT NULL,          -- no_reply | no_open | always
  due_at             INTEGER NOT NULL,
  status             TEXT NOT NULL,          -- pending | claimed | fired | skipped | cancelled | failed
  attempts           INTEGER NOT NULL DEFAULT 0,
  lease_owner        TEXT,
  lease_expires_at   INTEGER,
  claimed_at         INTEGER,
  fired_at           INTEGER,
  cancelled_at       INTEGER,
  cancel_reason      TEXT,                   -- replied | opened | manual | message_deleted
  last_error         TEXT,
  note               TEXT,
  draft              INTEGER NOT NULL DEFAULT 0,
  draft_subject      TEXT,
  draft_body_html    TEXT,
  draft_attempted_at INTEGER,                -- written BEFORE the Gmail call (at-most-once, §3.4)
  draft_id           TEXT,
  draft_thread_id    TEXT,
  draft_status       TEXT,                   -- created | uncertain | failed | skipped
  created_at         INTEGER NOT NULL,
  created_by         TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX idx_reminders_due       ON reminders(status, due_at);
CREATE INDEX idx_reminders_recipient ON reminders(recipient_id, status);
CREATE INDEX idx_reminders_message   ON reminders(message_id);
```

### 3.3 Crash-safe single firing: claim, lease, finalize

`src/db/reminders.ts`:

```ts
export interface ReminderRow { /* one field per column above */ }
export function createReminder(db, input): ReminderRow;
export function getReminder(db, id): ReminderRow | null;
export function listReminders(db, opts): ReminderRow[];
export function cancelReminder(db, id, atMs, reason): boolean;
export function cancelPendingForRecipient(db, recipientId, atMs, reason, conditions: string[]): number;

export function selectDue(db, nowMs: number, limit: number): ReminderRow[];
export function claim(db, id: string, owner: string, nowMs: number,
                      opts: { leaseMs: number; maxAttempts: number }): ReminderRow | null;
export function markFired(db, id: string, owner: string, atMs: number): boolean;
export function markSkipped(db, id: string, owner: string, atMs: number, reason: string): boolean;
export function markFailed(db, id: string, owner: string, atMs: number, error: string): boolean;
export function noteDraftAttempt(db, id: string, atMs: number): void;
export function recordDraft(db, id, d: { draftId: string|null; threadId: string|null; status: string }): void;
```

`selectDue`:

```sql
SELECT * FROM reminders
 WHERE due_at <= @now
   AND (status = 'pending'
        OR (status = 'claimed' AND lease_expires_at <= @now))
 ORDER BY due_at ASC LIMIT @limit
```

`claim` — one `BEGIN IMMEDIATE` transaction (better-sqlite3's `db.transaction(...)` with
`.immediate()`), a **single conditional UPDATE** whose `WHERE` re-checks everything `selectDue`
assumed, so the check and the mutation cannot be separated by another process:

```sql
UPDATE reminders
   SET status = 'claimed', lease_owner = @owner, lease_expires_at = @now + @leaseMs,
       claimed_at = @now, attempts = attempts + 1
 WHERE id = @id
   AND due_at <= @now
   AND (status = 'pending'
        OR (status = 'claimed' AND lease_expires_at <= @now AND attempts < @maxAttempts))
```
`result.changes === 1` ⇒ this process owns the reminder and re-reads the row; `0` ⇒ somebody else
owns it, or it is terminal, or it is out of attempts (a separate sweep marks
`attempts >= maxAttempts AND status='claimed' AND lease_expires_at <= now` as `failed` with
`last_error='lease expired after N attempts'`).

**The crash argument, precisely.** Consider a kill at each point:

| Killed… | State on disk | After restart |
|---|---|---|
| before `claim` | `pending` | claimed normally, fires once |
| inside `claim` (mid-transaction) | SQLite rolls the transaction back ⇒ `pending` | fires once |
| after `claim`, before any side effect | `claimed`, lease in the future | ignored until the lease expires, then re-claimed (attempt 2) and fires once |
| after the notification `enqueue`, before `markFired` | `claimed` + one `notifications` row | re-claimed after the lease; `enqueue` is `INSERT OR IGNORE` on `UNIQUE(dedupe_key)` with key `${channel}:reminder:${reminderId}` ⇒ **no second notification**; row then marked `fired` |
| after `markFired` | `fired` | never selected again (`status` is terminal) |
| after `noteDraftAttempt`, before `recordDraft` | `draft_attempted_at` set, `draft_id` NULL | §3.4's recovery path — the draft is **never blindly re-created** |

So the only durable "fire exactly once" claim rests on two facts that are both already in the tree:
a single conditional `UPDATE` under `BEGIN IMMEDIATE` (SQLite is one-writer, so this is a real CAS),
and the notification queue's `UNIQUE(dedupe_key)`. The `audit_log` may contain two `reminder.fire`
rows in the crash-recovery case — that is correct for an append-only attempt log and is documented
in `docs/reminders.md`; the *delivered* notification is still exactly one.

### 3.4 Firing job

`src/jobs/reminders.ts`:

```ts
export interface ReminderJobDeps {
  db: DB; config: AppConfig; bus: EventBus;
  draftClient?: DraftClient | null;      // null ⇒ --draft reminders record draft_status='skipped'
  clock?: () => number;
  owner?: string;                        // default `${hostname()}:${process.pid}:${newId().slice(0,6)}`
  onClaimed?: (r: ReminderRow) => void;  // TEST SEAM ONLY: the crash test SIGKILLs itself here
  log?: Logger;
}
export function createRemindersJob(deps: ReminderJobDeps): Job;   // name 'reminders'
export async function runRemindersOnce(deps: ReminderJobDeps, nowMs: number, limit: number):
  Promise<{ fired: number; skipped: number; failed: number; claimed: number }>;
```

Per claimed reminder:

1. Load recipient(s). A reminder whose recipient/message vanished ⇒ `cancelled`,
   `cancel_reason='message_deleted'`.
2. Evaluate the condition — **`no_reply`**: skip if `replied_at !== null`; **`no_open`**: skip if
   `open_count > 0`; **`always`**: never skips. Skip ⇒ `markSkipped` + audit `reminder.skip` with the
   reason; no notification.
3. `--draft` (§3.5), at most once, before the notification so the notification can link the draft.
4. Publish a `TrackingEvent` with `kind: 'reminder'` on the bus (SSE sees it; the worker enqueues the
   `reminder` trigger). `eventId = reminder.id`, `occurredAt = nowMs`,
   `classification = 'reminder'`, `reasons = ['reminder', condition]`,
   `counted = false`, `linkUrl = draft deep link or null`.
5. `markFired` + audit `reminder.fire` `{ reminderId, condition, recipientId, draftStatus }`.
   A throw anywhere in 3–4 ⇒ `markFailed` with the message; the next lease expiry retries up to
   `REMINDER_MAX_ATTEMPTS`.

Registered by `openpost serve` (and by `openpost dashboard`) when `REMINDERS_ENABLED=true`, with
`intervalMs = REMINDER_TICK_SECONDS * 1000` (default 30) — note the `Scheduler` ticks every 60 s by
default, so `serve` starts it with `scheduler.start(Math.min(60_000, config.reminderTickSeconds * 1000))`.

### 3.5 `--draft`: a Gmail draft in the same thread, never sent

`src/mail/draft.ts`:

```ts
export interface DraftClient {
  createDraft(input: { raw: Buffer; threadId: string }): Promise<{ draftId: string; messageId: string | null; threadId: string | null }>;
  findDraftByHeader(threadId: string, headerName: string, headerValue: string): Promise<{ draftId: string } | null>;
}
export function gmailDraftClient(client: GmailClient): DraftClient;
export interface ReminderDraftInput {
  from: MimeAddress; to: MimeAddress[];
  originalSubject: string; subject?: string; html: string; text?: string;
  threadId: string; rfc822MessageId: string; reminderId: string;
}
export async function buildReminderDraftMime(input: ReminderDraftInput): Promise<BuiltMime>;
export async function createReminderDraft(client: DraftClient, input: ReminderDraftInput):
  Promise<{ draftId: string; threadId: string | null }>;
```

MIME (via the existing `buildMime`, which already accepts `inReplyTo`/`references`/`headers`):

```
Subject:     input.subject ?? (/^re:/i.test(orig) ? orig : `Re: ${orig}`)
In-Reply-To: <recipient.rfc822_msg_id>
References:  <recipient.rfc822_msg_id>
X-Openpost-Reminder: <reminderId>
```
Body default when no `--draft-body*` is given: a two-line, deliberately boring follow-up
(`"Just following up on my message below — did this reach you?"`) plus a `<blockquote>` of nothing
(the thread already carries the quote in Gmail's UI). The body is stored in
`reminders.draft_body_html` at creation time, so firing never re-reads a file that may have moved.

Exact Gmail call:

```ts
await gmail.users.drafts.create({
  userId: 'me',
  requestBody: { message: { threadId, raw: base64url(mime.raw) } },
});
// -> { data: { id: '<draftId>', message: { id, threadId } } }
```
`threadId` on the **message** is what makes Gmail thread it; `In-Reply-To`/`References` make every
other client thread it too. **`users.drafts.send` is never called anywhere in the codebase** — a
grep assertion in test 175 enforces that.

Scope: `GMAIL_SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose'`, added to
`src/mail/oauth.ts`; `openpost auth gmail --with-compose` requests it, `openpost auth status` reports
`hasComposeScope`, and `doctor` warns when any pending `--draft` reminder exists without it.

At-most-once discipline: `noteDraftAttempt` (its own committed transaction) → API call →
`recordDraft`. On a re-claim where `draft_attempted_at` is set and `draft_id` is NULL, the job calls
`findDraftByHeader(threadId, 'X-Openpost-Reminder', reminderId)` (`users.drafts.list` +
`users.drafts.get(format:'metadata')`): a hit is adopted (`draft_status='created'`), a miss with a
readable thread is re-created once, and an unreadable thread ⇒ `draft_status='uncertain'` plus a
notification line "a draft may already exist in this thread — check Gmail Drafts". A draft failure
**never** suppresses the reminder notification (`draft_status='failed'`, `last_error` set).

### 3.6 Notification integration

`src/notify/types.ts`:
```ts
export type NotifyTrigger = 'first_open' | 'read_confirmed' | 'click' | 'prefetched' | 'reply' | 'reminder';
// TrackingEvent.kind widens to 'open' | 'click' | 'reply' | 'reminder'
// NotificationPayload.event.kind widens identically; `version` stays 1 (additive enum values only)
```
`src/notify/policy.ts` — two rules, inserted so the existing P0–P6 table is untouched:

| # | Condition | Trigger |
|---|---|---|
| P7 | `e.kind === 'reminder'` | `reminder` — **evaluated before P0**: an operator who explicitly scheduled a nudge gets it even on a muted message (documented; `--mute` silences tracking noise, not the operator's own alarm) |
| P8 | `e.kind === 'reply'` (after P0/P1, so mute still applies) | `reply` |

P5 widens to `newState ∈ {read_confirmed, replied} && prevState ∉ {read_confirmed, replied}`, so a
reply does not double-fire `read_confirmed` afterwards.

Dedupe keys: `${channel}:reminder:${reminderId}` and `${channel}:reply:${recipientId}`.
`NOTIFY_ON` default becomes `first_open,read_confirmed,click,reply,reminder` (no existing test
asserts the old default — verified).

`src/notify/channels/util.ts` gains labels and summary lines:
```
reminder → 'Reminder'  "Reminder: no reply from alice@example.com to \"hello\" after 3d"
reply    → 'Reply'     "Reply: alice@example.com replied to \"hello\""
```
Discord colours: `reply` 3066993, `reminder` 16776960. The Slack context line for a reminder shows
the condition, the age since `sent_at` and the draft status; for a reply, the delay since `sent_at`.

---

## 4. Reply detection

### 4.1 Selection, interval and quota budgeting

Job `reply-poll`, `src/jobs/replies.ts`, registered by `serve` when
`REPLY_DETECTION !== 'off'` and a reader is available.

Candidate SQL (per tick):

```sql
SELECT r.id, r.message_id, r.thread_id, r.rfc822_msg_id, r.sent_at, r.reply_checked_at,
       r.reply_check_count, m.subject, a.email AS sender_email
  FROM recipients r
  JOIN messages m ON m.id = r.message_id
  JOIN accounts a ON a.id = m.account_id
 WHERE r.replied_at IS NULL
   AND r.thread_id IS NOT NULL            -- gmail mode; imap mode uses r.rfc822_msg_id IS NOT NULL
   AND r.sent_at IS NOT NULL
   AND r.sent_at >= @now - @watchMs       -- REPLY_WATCH_DAYS (14)
   AND (r.reply_checked_at IS NULL OR r.reply_checked_at <= @now - @minGapMs)
 ORDER BY r.sent_at DESC
 LIMIT @batch                             -- REPLY_POLL_BATCH (25)
```
`@minGapMs` is age-tiered (computed per row in JS after a slightly wider SQL fetch, or as a `CASE`
expression — the spec's reference implementation uses a `CASE`):

| Age since `sent_at` | Poll every |
|---|---|
| < 2 h | `REPLY_POLL_SECONDS` (default 300 s) |
| 2 h – 24 h | 15 min |
| 1 – 3 d | 1 h |
| 3 – 14 d | 6 h |
| > `REPLY_WATCH_DAYS` | never (watch closed; `reply_check_count` frozen) |

Quota budget: `users.threads.get` costs **10 quota units**; the job holds a token bucket of
`REPLY_QUOTA_UNITS_PER_MIN` (default 300 ⇒ ≤ 30 thread reads/minute, ≈ 43 200/day, far under
Gmail's per-user ceiling) refilled continuously, and stops the tick when the bucket is empty.
On `429` / `403 rateLimitExceeded|userRateLimitExceeded`, the job sets
`settings['reply_poll_backoff_until'] = now + backoff` with backoff doubling 1 → 2 → 4 → … → 60 min
(jittered ±20 %, reusing `backoffMs`'s shape) and audits `reply.backoff`; a clean tick resets it.
Any other error marks the job `error` in the `jobs` table via the existing `Scheduler` and is not
retried within the tick.

### 4.2 Reader abstraction (injectable, offline-testable)

`src/mail/threads.ts`:

```ts
export interface ThreadMessageMeta {
  id: string; threadId: string; internalDate: number;
  from: string | null; to: string | null; messageIdHeader: string | null;
  inReplyTo: string | null; references: string | null;
  labelIds: string[]; isSelfCopy: boolean;        // X-Openpost-Self-Copy: 1 present
}
export interface ThreadReader {
  readonly kind: 'gmail' | 'imap';
  readonly unitCost: number;                      // 10 for gmail threads.get
  fetchThread(ref: { threadId: string; rfc822MessageId: string; sinceMs: number }):
    Promise<ThreadMessageMeta[]>;                 // [] when the thread is gone (404 ⇒ closes the watch)
}
export function gmailThreadReader(client: GmailClient): ThreadReader;
export function imapThreadReader(client: ImapLike, mailbox: string): ThreadReader;

export interface ReplyDecision { isReply: boolean; reason: string; messageId?: string; atMs?: number }
export function detectReply(messages: ThreadMessageMeta[],
  ctx: { senderEmail: string; sentAt: number; ownProviderMsgId: string | null; skewMs?: number }): ReplyDecision;
```

Exact Gmail call:

```ts
await gmail.users.threads.get({
  userId: 'me', id: threadId, format: 'metadata',
  metadataHeaders: ['From', 'To', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'X-Openpost-Self-Copy'],
});
```

`detectReply` (pure, unit-tested — this is the rule that matters) declares a reply for the **first**
message satisfying **all** of:

1. `internalDate > sentAt + skewMs` (`skewMs` default 1000, absorbing clock skew);
2. its `From` address, normalised (`lower(trim())`, angle-brackets stripped), **≠** the sender
   account address and ∉ `REPLY_IGNORE_SENDERS` (comma list, e.g. aliases);
3. `labelIds` does not contain `SENT` or `DRAFT`;
4. `isSelfCopy === false` (the `SELF_OPEN_STRATEGY=insert` copy carries `X-Openpost-Self-Copy: 1`,
   as Phase 2 §4.2 promised, and is skipped here — this is exactly the "Phase 3 reply detection
   skips it" note in doc 05);
5. `id !== ownProviderMsgId` (the recipient's own `provider_msg_id`).

Everything else — auto-replies, bounces, the operator's own follow-up — is rejected with a named
reason, recorded in the audit detail, so a false negative is diagnosable.

**SMTP-mode alternative (IMAP).** `imapThreadReader` uses the already-optional `imapflow` (dynamic
import, same pattern as `src/mail/imap.ts`): `client.mailboxOpen(IMAP_ALL_MAIL_MAILBOX)` then
`client.search({ or: [ { header: { 'in-reply-to': rfc822MessageId } }, { header: { references: rfc822MessageId } } ], since: new Date(sinceMs) })`,
then `client.fetch(uids, { envelope: true, headers: ['message-id','in-reply-to','references','x-openpost-self-copy'] })`
mapped into `ThreadMessageMeta` (`internalDate` from the envelope date, `labelIds: []`). `unitCost`
is 1 (no Gmail quota) but the same token bucket paces it to avoid hammering IMAP.

`REPLY_DETECTION=auto` resolves to `gmail` when `resolveRefreshToken(config, process.env)` returns a
token with the `gmail.readonly` scope, else `imap` when `IMAP_USER`/`IMAP_PASS` are set, else `off`
(logged once at startup). Tests always inject a fake `ThreadReader`; **no test ever constructs a
real Gmail or IMAP client.**

### 4.3 What happens on a detected reply

One transaction (`withTx`):

1. `UPDATE recipients SET replied_at = @atMs, reply_msg_id = @id, reply_checked_at = @now, reply_check_count = reply_check_count + 1 WHERE id = @rid AND replied_at IS NULL` — the `AND replied_at IS NULL` makes a concurrent double-detection a no-op.
2. `recomputeRecipientCounters(db, rid)` ⇒ state becomes `replied` (§4.4).
3. `cancelPendingForRecipient(db, rid, atMs, 'replied', ['no_reply'])` — cancels pending/claimed-and-expired `no_reply` reminders (`no_open` and `always` are untouched; a `no_open` reminder is about images, not replies).
4. `audit(db, { actor: 'server', action: 'reply.detected', subjectType: 'recipient', subjectId: rid, detail: { messageId, delayMs, remindersCancelled, reason } })` — **no address, no subject, no snippet**.

Then, after commit, `bus.publish({ kind: 'reply', … })` ⇒ SSE frame (dashboard row flips live) and
the `reply` notification trigger. A non-reply poll writes only `reply_checked_at` /
`reply_check_count` (outside any transaction of consequence) so the backoff advances.

Message bodies and snippets are **never** fetched or stored: `format=metadata` cannot return them,
which is a privacy property, not an accident. `docs/privacy` text says so.

### 4.4 `replied` as a first-class state

* `src/types.ts`: `RecipientState = 'not_opened' | 'prefetched' | 'opened' | 'read_confirmed' | 'replied'`.
* `src/core/classify.ts`:
  ```ts
  export function deriveRecipientState(r: RecipientCounters, opts?: { repliedAt?: number | null }): RecipientState;
  ```
  `repliedAt != null` wins over everything (returned first). The parameter is **optional**, so every
  existing call site and test (`tests/unit/classify.test.ts:291+`) compiles and passes unchanged.
* `src/db/repo.ts`: `recomputeRecipientCounters` reads `replied_at` in its aggregate query and passes
  it through — without this, the next open/click/override would silently erase a detected reply. This
  is the single most important one-line consequence of adding the state.
* `src/db/report.ts`: `byState` gains `replied: 0` in its initialiser.
* `src/server/present.ts`: no change needed (it returns the stored state) beyond the widened type;
  `PresentedRecipient` gains `repliedAt` (already on the row).
* Migration 004 back-fills `UPDATE recipients SET state='replied' WHERE replied_at IS NOT NULL`
  (a no-op on today's data, correct for any hand-edited database).

---

## 5. Aggregate stats service

`src/db/stats.ts` — pure over a `DB`, no HTTP, no config beyond a timezone string.

```ts
export interface StatsBucket { key: string; label: string; fromMs: number; toMs: number | null; count: number }
export interface StatsReport {
  since: number; until: number; timeZone: string; generatedAt: number;
  totals: { messages: number; recipients: number; opened: number; clicked: number; replied: number;
            prefetchedOnly: number; notOpened: number; optedOut: number };
  rates:  { openRate: number; clickRate: number; clickToOpenRate: number; replyRate: number;
            prefetchSuppressionRate: number };                     // 0..1, 4 decimals
  timeToOpen: { buckets: StatsBucket[]; medianMs: number | null; p90Ms: number | null; sampleSize: number };
  bestHour:   { timeZone: string; hours: Array<{ hour: number; count: number }>; peakHour: number | null };
  byDay:      Array<{ day: string; sent: number; opened: number; clicked: number; replied: number }>;
  topMessages: Array<{ id: string; subject: string; recipients: number; openRate: number; clickRate: number; replyRate: number }>;
}
export function statsReport(db: DB, opts: { sinceMs: number; untilMs: number; timeZone: string }): StatsReport;
```

**Denominator.** Recipients of `sent`/`dryrun` messages whose effective send time falls in the
window — never "events", so the rates cannot exceed 1 and an unsent draft never dilutes them:

```sql
WITH base AS (
  SELECT r.id, r.message_id, r.state, r.open_count, r.machine_open_count, r.click_count,
         r.replied_at, r.first_open_at, r.opted_out_at,
         COALESCE(r.sent_at, m.sent_at, m.created_at) AS eff_sent_at
    FROM recipients r JOIN messages m ON m.id = r.message_id
   WHERE m.status IN ('sent','dryrun')
     AND COALESCE(r.sent_at, m.sent_at, m.created_at) BETWEEN @since AND @until
)
SELECT COUNT(*)                                           AS recipients,
       SUM(CASE WHEN open_count  > 0 THEN 1 ELSE 0 END)   AS opened,
       SUM(CASE WHEN click_count > 0 THEN 1 ELSE 0 END)   AS clicked,
       SUM(CASE WHEN replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
       SUM(CASE WHEN open_count = 0 AND machine_open_count > 0 THEN 1 ELSE 0 END) AS prefetched_only,
       SUM(CASE WHEN open_count = 0 AND machine_open_count = 0 THEN 1 ELSE 0 END) AS not_opened,
       SUM(CASE WHEN opted_out_at IS NOT NULL THEN 1 ELSE 0 END) AS opted_out
  FROM base;
```
`openRate = opened/recipients`, `clickRate = clicked/recipients`,
`clickToOpenRate = clicked/opened`, `replyRate = replied/recipients`,
`prefetchSuppressionRate = prefetched_only/(opened + prefetched_only)` — each 0 when its denominator
is 0 (never `NaN`; test 156 asserts the empty-database case explicitly).

**Time-to-open buckets** (first *counted* open only, so a prefetch never lands in the histogram):

```sql
SELECT CASE
         WHEN d <        60000 THEN 'lt_1m'
         WHEN d <       300000 THEN 'm1_5'
         WHEN d <      1800000 THEN 'm5_30'
         WHEN d <      7200000 THEN 'm30_2h'
         WHEN d <     21600000 THEN 'h2_6'
         WHEN d <     86400000 THEN 'h6_24'
         WHEN d <    259200000 THEN 'd1_3'
         ELSE 'gt_3d' END AS bucket,
       COUNT(*) AS n
  FROM (SELECT (first_open_at - eff_sent_at) AS d FROM base
         WHERE first_open_at IS NOT NULL AND first_open_at >= eff_sent_at)
 GROUP BY bucket;
```
Buckets are emitted in fixed order with explicit zeros. `medianMs`/`p90Ms` come from the same `d`
list sorted in JS (the existing `median()` helper in `src/db/report.ts` is exported and reused).

**Best-hour histogram** is computed over *counted open events*, not first opens ("when do people
actually read?"), and bucketed **in JS**, because SQLite has no timezone database and
`strftime('%H', …, 'localtime')` would silently use the server's `TZ` and get DST wrong:

```sql
SELECT oe.occurred_at FROM open_events oe
  JOIN recipients r ON r.id = oe.recipient_id
 WHERE oe.counted = 1 AND oe.occurred_at BETWEEN @since AND @until
```
→ `hourInZone(ms, timeZone)` (`Intl.DateTimeFormat(tz, { hour: 'numeric', hour12: false })`) into 24
buckets; `peakHour` is the argmax (null when empty; ties break to the earliest hour).
`byDay` uses `dayKeyInZone` the same way. `REPORT_TIMEZONE` is validated at config load
(`isValidTimeZone`) so a typo fails fast with `ConfigError` instead of silently reporting UTC.

**Exposure.** `GET /api/stats` (existing bearer auth, plus the dashboard session as of §2.4) returns
a **superset** of today's response:

```jsonc
{ /* every AccuracyReport field, unchanged and at the top level */,
  "stats": { /* StatsReport */ } }
```
Query params: `since` (epoch ms or `7d`), `until`, `tz` (defaults to `REPORT_TIMEZONE`; validated,
400 on an unknown zone), `view=all|accuracy|stats` (default `all`). `/dashboard/stats` calls
`statsReport` directly (no HTTP hop) and renders §2.6's charts; `openpost stats [--since 30d]
[--tz <zone>] [--json]` prints the same object, with `cli-table3` tables for human output.

---

## 6. Change list, migration, env, CLI, tests, smoke, acceptance

### 6.1 Per-file change list

**New files**

| Path | Contents |
|---|---|
| `src/server/views/html.ts` | `html` tagged template, `raw`, `escapeHtml`, `attr`, `join`, `href` (§2.5) |
| `src/server/views/layout.ts` | `layout()` shell: head, CSP-compatible asset links, nav, flash, live status |
| `src/server/views/pages/{messages,message,event,audit,stats,reminders,login}.ts` | the seven pages |
| `src/server/views/fragments.ts` | `recipientRow`, `messageRow`, `eventItem`, `overrideForm`, `pager`, `flash` |
| `src/server/views/charts.ts` | `barChart`, `hourHistogram`, `sparkline`, `statTile` — inline SVG, no library |
| `src/server/views/format.ts` | `fmtTime`, `fmtRelative`, `fmtPercent`, `stateBadge`, `confidenceBar`, `RULE_DOC` |
| `src/server/auth/session.ts` | cookies, session HMAC, CSRF, `authenticateDashboard` (§2.4) |
| `src/server/query.ts` | `parseMessageFilter`, `parseAuditFilter`, `filterToQueryString`, LIKE escaping |
| `src/server/routes/dashboard.ts` | pages + fragments + guard hook + security headers |
| `src/server/routes/dashboard-actions.ts` | login/logout, reclassify, mute, reminder-cancel (CSRF-guarded) |
| `src/server/routes/dashboard-assets.ts` | allowlisted asset route with ETag/immutable caching |
| `src/server/assets/index.ts` | `loadDashboardAssets(dir)` → frozen `Map` with sha256 ETags |
| `src/server/assets/{app.css,app.js,htmx.min.js,favicon.svg}` | vendored assets (htmx pinned + hashed) |
| `src/server/export.ts` | `toCsv(rows, columns)` (RFC 4180 + formula guard), `exportRows(db, filter)` |
| `src/db/stats.ts` | `statsReport` (§5) |
| `src/db/reminders.ts` | reminder repo incl. `selectDue`/`claim`/`markFired` (§3.3) |
| `src/db/seed.ts` | `seedDemo(db, opts)` — deterministic fixture generator |
| `src/jobs/reminders.ts` | `createRemindersJob`, `runRemindersOnce` (§3.4) |
| `src/jobs/replies.ts` | `createReplyPollJob`, `runReplyPollOnce`, token bucket + tiered backoff (§4) |
| `src/mail/draft.ts` | `DraftClient`, `gmailDraftClient`, `buildReminderDraftMime`, `createReminderDraft` (§3.5) |
| `src/mail/threads.ts` | `ThreadReader`, `gmailThreadReader`, `imapThreadReader`, `detectReply` (§4.2) |
| `src/db/migrations/004_phase3.sql` | §6.2 |
| `src/cli/commands/{remind,reminders,seed,stats,dashboard}.ts` | §6.4 |
| `playwright.config.ts` | Chromium project, `webServer`, `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` |
| `tests/e2e/dashboard.spec.ts` | DoD 1 in a real browser + screenshots |
| `scripts/curl-smoke-phase3.sh`, `scripts/reminder-crash-child.mjs` | §6.6 |
| `docs/dashboard.md`, `docs/reminders.md` | operator guides (auth, CSP, exports; reminder/reply semantics + quota) |

**Modified files**

| Path | Change |
|---|---|
| `src/types.ts` | `RecipientState` gains `replied`; `RECIPIENT_STATES` runtime array exported for filter validation |
| `src/core/classify.ts` | `deriveRecipientState(counters, opts?: { repliedAt })` — replied wins |
| `src/core/time.ts` | `parseDuration`, `parseWhen`, `hourInZone`, `dayKeyInZone`, `isValidTimeZone` |
| `src/config/env.ts` | ~22 new variables (§6.3), `assertSafeToServeDashboard`, `REPORT_TIMEZONE` validation, `NOTIFY_ON` default gains `reply,reminder` |
| `src/db/index.ts` | `EXPECTED_SCHEMA = 4` |
| `src/db/repo.ts` | `+listMessagesFiltered`, `+countMessagesFiltered`, `+listAuditLog`, `+countAuditLog`, `+listRecipientsForExport`, `+setRepliedAt`, `+touchReplyCheck`, `+listReplyCandidates`; `recomputeRecipientCounters` passes `replied_at` into `deriveRecipientState` |
| `src/db/report.ts` | `byState` initialiser gains `replied`; `median` exported for reuse |
| `src/db/erase.ts` | `forget` also deletes `reminders` for the recipient's ids (and its counts appear in the audit detail) |
| `src/server/app.ts` | `ServerDeps` gains `mode?: 'full' | 'dashboard'`; registers dashboard + asset routes when `config.dashboardEnabled`; skips `/o /c /u` in `dashboard` mode |
| `src/server/routes/stream.ts` | accepts a valid dashboard session cookie in addition to the bearer (§2.4) |
| `src/server/routes/api.ts` | `/api/stats` becomes the §5 superset; `+GET /api/reminders`, `+GET /api/recipients/:id` |
| `src/server/present.ts` | `PresentedRecipient` gains `repliedAt`, `threadId`, `timeToOpenMs`; `PresentedEvent` gains `overriddenAt` |
| `src/notify/{types,policy,payload}.ts` | `reply` + `reminder` triggers, widened `kind`, P7/P8, dedupe keys (§3.6) |
| `src/notify/channels/util.ts` (+ `slack.ts`, `discord.ts`) | labels, summary lines, colours for the two new triggers |
| `src/jobs/scheduler.ts` | unchanged API; `serve` now starts it with a tick of `min(60s, REMINDER_TICK_SECONDS)` |
| `src/cli/program.ts` | registers `remind`, `reminders`, `seed`, `stats`, `dashboard` |
| `src/cli/commands/serve.ts` | `assertSafeToServeDashboard`; registers the reminders and reply-poll jobs; prints the dashboard URL |
| `src/cli/commands/auth.ts` / `src/mail/oauth.ts` | `GMAIL_SCOPE_COMPOSE`, `--with-compose`, `hasComposeScope` in `auth status` |
| `src/cli/commands/show.ts` | shows `replied_at` and pending reminders per recipient |
| `src/core/doctor.ts` / `src/cli/commands/doctor.ts` | `db.schema` expects 4; new checks `dashboard.auth`, `dashboard.assets` (htmx sha256), `reminders.pending`, `reply.reader` |
| `package.json` | `"build": "tsc -p tsconfig.json && cp -r src/db/migrations dist/db/ && cp -r src/server/assets dist/server/"`; `"test:e2e": "playwright test"`; devDependency `@playwright/test ^1.48`. **No new runtime dependency.** |
| `.env.example`, `README.md` | every new variable, the dashboard quick start, reminder/reply semantics, the Gmail scope note |

### 6.2 Migration `src/db/migrations/004_phase3.sql` (schema_version = 4)

```sql
-- 004_phase3.sql (schema_version = 4)
--
-- The `reminders` table created by 001_init.sql was never read or written by any Phase 1/2 code
-- (grep-verified before this migration was written), exactly like the `notifications` stub that
-- 003 replaced, so dropping and rebuilding it cannot lose data.

DROP TABLE reminders;
CREATE TABLE reminders (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL REFERENCES messages(id)   ON DELETE CASCADE,
  recipient_id       TEXT          REFERENCES recipients(id) ON DELETE CASCADE,
  condition          TEXT NOT NULL,          -- no_reply | no_open | always
  due_at             INTEGER NOT NULL,
  status             TEXT NOT NULL,          -- pending | claimed | fired | skipped | cancelled | failed
  attempts           INTEGER NOT NULL DEFAULT 0,
  lease_owner        TEXT,
  lease_expires_at   INTEGER,
  claimed_at         INTEGER,
  fired_at           INTEGER,
  cancelled_at       INTEGER,
  cancel_reason      TEXT,
  last_error         TEXT,
  note               TEXT,
  draft              INTEGER NOT NULL DEFAULT 0,
  draft_subject      TEXT,
  draft_body_html    TEXT,
  draft_attempted_at INTEGER,
  draft_id           TEXT,
  draft_thread_id    TEXT,
  draft_status       TEXT,
  created_at         INTEGER NOT NULL,
  created_by         TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX idx_reminders_due       ON reminders(status, due_at);
CREATE INDEX idx_reminders_recipient ON reminders(recipient_id, status);
CREATE INDEX idx_reminders_message   ON reminders(message_id);

-- reply detection bookkeeping (per recipient; thread_id/rfc822_msg_id already exist from 003)
ALTER TABLE recipients ADD COLUMN reply_checked_at  INTEGER;
ALTER TABLE recipients ADD COLUMN reply_check_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipients ADD COLUMN reply_msg_id      TEXT;
CREATE INDEX idx_recipients_reply_watch ON recipients(replied_at, sent_at);

-- `replied` becomes a first-class state; keep any hand-set replied_at consistent
UPDATE recipients SET state = 'replied' WHERE replied_at IS NOT NULL;

-- dashboard/report query support
CREATE INDEX idx_messages_created   ON messages(created_at DESC);
CREATE INDEX idx_audit_action_at    ON audit_log(action, at DESC);
```
No table is rewritten; every other statement is additive `ALTER TABLE … ADD COLUMN` or a new index.
`src/db/index.ts` sets `EXPECTED_SCHEMA = 4`; `/healthz` reports `schema: 4`.

### 6.3 New environment variables

| Variable | Default | Meaning |
|---|---|---|
| `DASHBOARD_ENABLED` | `true` | Register the `/dashboard` routes at all. |
| `DASHBOARD_BIND` | = `BIND_ADDRESS` | Address the dashboard may be reached on; a non-loopback value warns, and requires a secret (§2.4). |
| `DASHBOARD_PORT` | `8788` | Used only by `openpost dashboard` (the split-process mode). |
| `DASHBOARD_PASSWORD` | – | Single password for the cookie session. Required off loopback unless `API_TOKEN` is set. |
| `DASHBOARD_SESSION_HOURS` | `12` | Session cookie lifetime. |
| `DASHBOARD_SECURE_COOKIES` | `auto` | `auto` ⇒ `Secure` iff `TRACKING_BASE_URL` is https. |
| `DASHBOARD_PAGE_SIZE` | `25` | Default rows per page (25/50/100 selectable). |
| `DASHBOARD_MAX_EXPORT_ROWS` | `50000` | Export cap; exceeding it is a 413 naming this variable. |
| `DASHBOARD_LOGIN_RATE_PER_MIN` | `10` | Failed-login token bucket per hashed IP. |
| `REPORT_TIMEZONE` | `UTC` | IANA zone for the best-hour histogram and day buckets; validated at load. |
| `REMINDERS_ENABLED` | `true` | Register the `reminders` job. |
| `REMINDER_TICK_SECONDS` | `30` | Firing-pass interval. |
| `REMINDER_LEASE_MS` | `120000` | Claim lease; a crashed process's reminder is retried after this. |
| `REMINDER_MAX_ATTEMPTS` | `3` | Claims before a reminder is marked `failed`. |
| `REMINDER_MAX_HORIZON_DAYS` | `365` | Rejects `--in`/`--at` beyond this. |
| `REMINDER_DEFAULT_CONDITION` | `no_reply` | Used when `--if` is omitted. |
| `REPLY_DETECTION` | `auto` | `auto | off | gmail | imap` (§4.2). |
| `REPLY_POLL_SECONDS` | `300` | Floor of the tiered poll interval. |
| `REPLY_POLL_BATCH` | `25` | Threads inspected per tick. |
| `REPLY_WATCH_DAYS` | `14` | After this, a recipient is never polled again. |
| `REPLY_QUOTA_UNITS_PER_MIN` | `300` | Gmail quota token bucket (threads.get = 10 units). |
| `REPLY_IGNORE_SENDERS` | – | Comma list of your own aliases that must not count as a reply. |
| `IMAP_ALL_MAIL_MAILBOX` | `[Gmail]/All Mail` | Mailbox searched by `imapThreadReader`. |

### 6.4 CLI additions (full spec)

```
openpost dashboard [--port <n>] [--host <addr>]
    Serves ONLY /healthz, /api and /dashboard (no pixel/click/opt-out routes). Same bind safety
    rules; prints the URL and whether auth is bearer, password or open-loopback.

openpost remind <message-id> [--recipient <id|email>] --if no-reply|no-open|always
                (--in <dur> | --at <iso>) [--draft] [--draft-subject <s>]
                [--draft-body-file <p> | --draft-body <html>] [--note <t>] [--json]

openpost reminders list [--status <s>] [--message <id>] [--due-before <iso|dur>] [--limit <n>] [--json]
openpost reminders cancel (<id> | --message <id> | --all-pending) [--yes] [--json]
openpost reminders run [--now <iso>] [--limit <n>] [--json]

openpost stats [--since 30d] [--until <iso>] [--tz <zone>] [--json]

openpost seed --demo [--seed <n>] [--now <iso>] [--messages <n>] [--reset] [--force] [--json]
    Deterministic fixtures for screenshots/manual testing. Refuses to run against a database that
    contains non-seeded rows unless --reset (wipes first) or --force. Writes a `seed.demo` audit row
    and settings['demo_seed'] = {seed, at, counts}. All addresses are @example.com.
```
Exit codes unchanged: `0` ok, `1` runtime error, `2` bad usage/config.

`seedDemo` determinism: a seeded xorshift128 PRNG, ids derived as
`base32(sha256(seed || ':' || kind || ':' || index)[0..16])` rather than `newId()`, and every
timestamp expressed as an offset from `--now` (default `1789000000000`). Same inputs ⇒ byte-identical
database (test 186 asserts equal ids and counts across two runs). Default shape: 12 messages, 27
recipients covering all five states, 41 open events across every classification (including
`apple_mpp`, `google_proxy_prefetch`, a `duplicate`, a `self_open`, a `bot`), 9 clicks (one
`scanner` via R6b, one back-filled `implied_by_click`), 2 replies, 3 reminders (pending / fired /
cancelled), 1 manual override, and the matching audit rows.

### 6.5 Test plan — cases 121–192

All offline, `DB_PATH=':memory:'`, fake clock, injected `fetch`/Gmail/IMAP, `app.inject()`.
New files: `tests/unit/{views-html,views-charts,session,query,duration,stats,detect-reply,reminders-claim,draft}.test.ts`,
`tests/integration/{dashboard,dashboard-auth,dashboard-live,export,reminders-flow,reply-flow,seed,migrate-v4,notify-phase3}.test.ts`,
`tests/e2e/dashboard.spec.ts` (Playwright, not run by vitest).

**views-html.test.ts**
121. `html` escapes `& < > " '` in interpolations; `raw()` passes through; arrays join without separators; `null`/`undefined`/`false` render empty.
122. A subject of `"><script>alert(1)</script>` renders escaped in the list, the detail page and the CSV-adjacent JSON export, and never re-appears as markup.
123. `href('/dashboard/messages', {q:'a&b', offset:25})` produces a correctly percent-encoded query string; `attr()` output is quote-safe.
124. `layout()` emits `<html lang="en">`, a skip link, one `<h1>`, `<main id="main">`, and links only `/dashboard/assets/*` (no external origins).
125. `fragments.recipientRow()` carries `data-recipient-id` and `data-message-id` and renders state as text + icon (not colour alone).
126. `format.RULE_DOC` has an entry for every rule id the classifier can emit (`R0`–`R10`, `R6b`, `apple_ip`, `implied_by_click`, `manual`) — asserted against the rule ids exported by `classify.ts`.

**session.test.ts**
127. `issueSession` → `verifySession` round-trips; a cookie with one character changed, a truncated MAC, or a future-dated `exp` beyond the max lifetime all verify as `null`.
128. An expired cookie (clock advanced past `DASHBOARD_SESSION_HOURS`) verifies as `null`.
129. `csrfTokenFor` differs per `sid`; `verifyCsrf` rejects another session's token and is length-mismatch-safe.
130. `parseCookies` handles quoting, whitespace, duplicates (first wins) and a missing header; `serializeCookie` emits `HttpOnly; SameSite=Strict; Path=/dashboard` and `Secure` exactly when asked.
131. `authenticateDashboard` precedence: valid bearer wins; valid cookie next; loopback with no secret ⇒ `via:'open'`; non-loopback with no secret ⇒ `{ok:false}`.
132. A session cookie issued under a different `TRACKING_SECRET` does not verify (key rotation revokes sessions).

**dashboard-auth.test.ts (integration)**
133. `assertSafeToServeDashboard` throws `ConfigError` for `BIND_ADDRESS=0.0.0.0` with neither `DASHBOARD_PASSWORD` nor `API_TOKEN`, and for `TRUST_PROXY=1` likewise; passes with either secret; `openpost serve` exits 2 printing the variable name (**DoD 5**).
134. With a password set: `GET /dashboard` → 302 `/dashboard/login?next=…`; a correct `POST /dashboard/login` sets both cookies and redirects to the validated `next`; `next=https://evil.example` is rewritten to `/dashboard`.
135. A wrong password returns the login page with an error, writes `dashboard.login.failed`, and the 11th attempt inside a minute returns 429.
136. `POST /dashboard/actions/reclassify` without `_csrf` → 403; with another session's token → 403; with a mismatched `Origin` → 403; with the correct token → 200/303.
137. Bearer-authenticated `POST` (no cookies) succeeds without a CSRF token.

**dashboard.test.ts (integration, `app.inject`)**
138. `GET /dashboard/messages` on a seeded DB returns 200 `text/html`, the CSP of §2.3 with no `unsafe-inline`, `no-store`, and one `<tr>` per message.
139. Filters: `q` matches subject and recipient email (and escapes `%`/`_` literally), `status`, `state=replied`, `has=clicks` and `since=7d` each narrow the set; an invalid enum returns 400.
140. Pagination: `limit=25&offset=25` returns the second page, the pager reports the true total, and the Prev/Next links preserve every other filter.
141. `GET /dashboard/messages/:id` renders one timeline entry per open/click/reply in `occurred_at` order, each showing classification, confidence and rule-id chips (**DoD 2, part 1**).
142. `GET /dashboard/events/open/:id` shows the rule documentation, the redacted signals and the override form; an unknown id returns 404 as an HTML page (not a stack trace).
143. `/dashboard/assets/app.css` returns 200 with `immutable` + a strong `ETag`, `304` on `If-None-Match`, and `/dashboard/assets/../../package.json` returns 404.
144. Override via `POST /dashboard/actions/reclassify` (bot → human): the event row swaps to the new classification, counters and state are recomputed, and **zero** notifications are enqueued.
145. The override appears in `GET /dashboard/audit` as a `reclassify.override` row with a `bot → human` diff (**DoD 2, part 2**).
146. `GET /dashboard/reminders` lists pending/fired/cancelled; `POST /dashboard/actions/reminder-cancel` cancels a pending one and the row moves to `cancelled`.

**export.test.ts**
147. `/dashboard/export.csv` honours the same filters as the list, emits CRLF + BOM + RFC-4180 quoting, and one row per recipient with the §2.8 columns.
148. A subject of `=cmd|' /c calc'!A0` is prefixed with `'` in CSV; embedded `"` and newlines round-trip through a reference CSV parser.
149. `.json` matches the documented shape; a filter selecting more than `DASHBOARD_MAX_EXPORT_ROWS` returns 413 naming the variable; tokens appear in neither format.

**dashboard-live.test.ts**
150. With a real listening server: open `/api/events/stream` with a session cookie (no bearer) → 200 (bearer-only access still works; no credential at all off loopback → 401).
151. A pixel hit produces a `tracking` frame; fetching `/dashboard/fragments/recipient/:id` afterwards returns a row whose state/open count reflect the new event (the exact two steps `app.js` performs).
152. **Playwright** (`tests/e2e/dashboard.spec.ts`, `npm run test:e2e`, skipped when `/opt/pw-browsers` is absent): log in, open `/dashboard/messages`, `curl`-equivalent `fetch` of a pixel URL from the test, assert the row's open counter changes **without a navigation** (`page.waitForFunction` on the cell text, `page.on('framenavigated')` never fires), assert no CSP violations were reported, and save `docs/reports/phase3/{messages,message,stats}.png` (**DoD 1**).

**stats.test.ts / views-charts.test.ts**
153. `statsReport` open/click/reply rates match an independent SQL cross-check on a seeded DB; drafts and failed messages are excluded from the denominator.
154. Time-to-open buckets are exhaustive and ordered; a recipient with `first_open_at < sent_at` (clock skew) is excluded, not negative-bucketed; median and p90 match a JS reference.
155. `bestHour` respects `REPORT_TIMEZONE`: the same event lands in a different hour for `UTC` vs `America/New_York`, and a DST-boundary timestamp is bucketed by `Intl`, not by a fixed offset.
156. An empty window yields all-zero counts, `0` rates (never `NaN`), `medianMs: null`, `peakHour: null`.
157. `GET /api/stats` still contains every `AccuracyReport` top-level field **and** the new `stats` key; `?view=stats` returns only the latter; an invalid `tz` → 400.
158. `barChart`/`hourHistogram` output parses as XML, carries `role="img"` + `aria-labelledby` → `<title>`/`<desc>`, uses no `style=` attribute, and scales to the max value (zero-data ⇒ an empty-state message, no division by zero).
159. Each chart on `/dashboard/stats` is accompanied by a `<details>` data table containing the same numbers.

**duration.test.ts**
160. `parseDuration` accepts `45s 90m 4h 3d 2w`, rejects `''`, `3`, `d3`, `-1d`, `1.5d`, `99999d` (overflow); `parseWhen` rejects both-or-neither of `--in`/`--at`, a past `--at`, and beyond-horizon values.
161. `hourInZone`/`dayKeyInZone` agree with `Intl` for UTC, `Asia/Tokyo` and a US DST transition.
162. `isValidTimeZone` accepts `UTC`/`Europe/Berlin`, rejects `Mars/Phobos`, and `loadConfig` raises `ConfigError` for a bad `REPORT_TIMEZONE`.

**reminders-claim.test.ts**
163. `createReminder` + `selectDue`: a future reminder is not selected; a due one is; a `cancelled`/`fired` one never is.
164. `claim` returns the row once; a second `claim` with a different owner before the lease expires returns `null`; after the lease expires it succeeds and `attempts` is 2.
165. `attempts >= REMINDER_MAX_ATTEMPTS` with an expired lease ⇒ swept to `failed` with `last_error`, never re-claimed.
166. `markFired`/`markSkipped`/`markFailed` only succeed for the current `lease_owner` (a stale owner's write is a no-op).
167. Two `runRemindersOnce` calls with distinct owners over the same due reminder produce exactly one `fired` row and one notification.
168. Condition evaluation: `no_reply` skips when `replied_at` is set, `no_open` skips when `open_count > 0`, `always` never skips; skips write `reminder.skip` and enqueue nothing.
169. A reminder whose message was deleted is `cancelled` with `cancel_reason='message_deleted'` (FK cascade + job guard).
170. `cancelPendingForRecipient` cancels only `no_reply` reminders and leaves `no_open`/`always` pending.

**reminders-flow.test.ts / draft.test.ts**
171. `openpost remind <id> --if no-reply --in 3d --json` prints `{reminderId, dueAt, condition}` and inserts one row; `--at` in the past exits 2.
172. `openpost reminders list/cancel` filter and cancel correctly; `--all-pending` cancels only pending rows and reports the count.
173. A fired reminder enqueues exactly one notification per configured channel with trigger `reminder`, dedupe key `${channel}:reminder:${id}`, and the Slack/Discord bodies carry the condition and the age.
174. A muted message still fires its reminder (P7), while a muted message's reply does **not** notify (P8 after P0).
175. `createReminderDraft` calls `users.drafts.create` with `message.threadId` set, a `raw` that decodes to a MIME with `In-Reply-To`/`References` = the recipient's `rfc822_msg_id`, subject `Re: …` (never `Re: Re:`), and `X-Openpost-Reminder: <id>`; a repo-wide grep asserts `drafts.send` appears nowhere; a draft failure leaves the reminder `fired` with `draft_status='failed'` and the notification still delivered.
176. **Crash safety (DoD 3):** a file-backed DB gets a reminder due "now"; `scripts/reminder-crash-child.mjs` runs one firing pass with `onClaimed` calling `process.kill(process.pid,'SIGKILL')`; the parent asserts the row is `claimed` with a live lease and zero notifications; the clock is advanced past `REMINDER_LEASE_MS`; a fresh pass fires it; final assertions: exactly one `fired` row, exactly one `notifications` row, and a second pass adds nothing.

**reply-flow.test.ts / detect-reply.test.ts**
177. `detectReply` accepts a message from another address after `sent_at`; rejects: one from the sender, one with `X-Openpost-Self-Copy: 1`, one labelled `SENT`/`DRAFT`, one at `sent_at` (skew), one whose id equals `provider_msg_id`, and any address listed in `REPLY_IGNORE_SENDERS` — each with its own named reason.
178. One poll with a fake `ThreadReader` sets `replied_at`, `reply_msg_id`, state `replied`, and writes one `reply.detected` audit row containing no address and no snippet (**DoD 4, part 1**).
179. The same poll cancels the recipient's pending `no_reply` reminder with `cancel_reason='replied'` (**DoD 4, part 2**).
180. The reply publishes a `reply` `TrackingEvent`: an SSE frame appears and exactly one `reply` notification is enqueued; a second poll of the same thread enqueues nothing (`replied_at IS NULL` guard + dedupe key).
181. A later counted open on a replied recipient does **not** reset the state: `recomputeRecipientCounters` keeps `replied` (the `deriveRecipientState(counters, {repliedAt})` regression).
182. Scheduling: candidate selection honours the tiered interval (a recipient checked 1 minute ago at age 3 h is skipped; at age 30 min it is polled), stops after `REPLY_WATCH_DAYS`, and never exceeds `REPLY_POLL_BATCH`.
183. Quota: a reader whose `unitCost` exhausts `REPLY_QUOTA_UNITS_PER_MIN` stops the tick early; a thrown `429` sets `reply_poll_backoff_until`, audits `reply.backoff`, doubles on the next failure and resets after a clean tick; `imapThreadReader` is exercised against a fake `ImapLike` with a `References` search.

**migrate-v4 / seed / notify-phase3**
184. `migrate` on a **populated** v3 DB → 4 with every pre-existing row intact, `reminders` empty, the new recipient columns defaulted, `state='replied'` back-filled for any `replied_at`, and a second run returning 4 and changing nothing; `/healthz` reports `schema: 4`.
185. `openpost seed --demo` populates every state, classification and reminder status; it refuses a non-empty non-seeded DB without `--reset`/`--force`; `--reset` leaves exactly the seeded counts.
186. Two `seed --demo --seed 7` runs against fresh databases produce identical ids, timestamps and row counts (screenshot determinism).
187. `decideTriggers` for a `reminder` event returns `['reminder']` even when muted, and `[]` when `reminder` is absent from `NOTIFY_ON`.
188. `decideTriggers` for a `reply` event returns `['reply']`, returns `[]` when muted, and a subsequent counted open does not produce a second `read_confirmed` (widened P5).
189. `buildPayload` for both new triggers honours `NOTIFY_REDACT_EMAIL`/`NOTIFY_INCLUDE_SUBJECT`, and the SSE stream payload for a `reply`/`reminder` event parses to a valid `NotificationPayload`.
190. `openpost forget <email>` also deletes that recipient's reminders and reports the count in the single audit row (still address-free).
191. Every dashboard HTML route sets the exact §2.3 CSP, `nosniff`, `no-referrer`, `DENY`, `no-store`; a scan of the rendered HTML finds **zero** `<script>` without `src`, zero `style=` attributes and zero `on*=` handlers.
192. Accessibility smoke over every page's HTML: `lang` present, exactly one `<h1>`, every `<input>`/`<select>` has a matching `<label for>`, every `<table>` has a `<caption>` and `<th scope>`, every `<img>`/`role="img"` has an accessible name, and the live region is `polite`.

### 6.6 Manual verification — `scripts/curl-smoke-phase3.sh`

```bash
# 0) build, migrate to v4, seed deterministic demo data
export TRACKING_SECRET=$(node -e "console.log(require('crypto').randomBytes(36).toString('base64'))")
export TRACKING_BASE_URL=http://127.0.0.1:8787
export DASHBOARD_PASSWORD=letmein
npm run build && node dist/cli/index.js migrate            # 3 -> 4
node dist/cli/index.js seed --demo --reset --json

# 1) serve, then log in and keep the cookie jar
node dist/cli/index.js serve &
curl -s -c jar.txt -o /dev/null -w '%{http_code}\n' \
     -d 'password=letmein' -d '_csrf=' http://127.0.0.1:8787/dashboard/login   # 302

# 2) the list, a detail page and the CSP header
curl -s -b jar.txt -D - -o /dev/null http://127.0.0.1:8787/dashboard/messages | grep -i content-security
curl -s -b jar.txt "http://127.0.0.1:8787/dashboard/messages?q=hello&state=read_confirmed" | grep -c '<tr'

# 3) live update: watch SSE in one shell, hit a pixel in another, then re-fetch the fragment
curl -N -b jar.txt http://127.0.0.1:8787/api/events/stream &
PIXEL=$(node dist/cli/index.js show <messageId> --json | jq -r '.recipients[0].pixelUrl')
curl -s -o /dev/null -A "Mozilla/5.0 … Chrome/129.0 Safari/537.36" "$PIXEL"
curl -s -b jar.txt http://127.0.0.1:8787/dashboard/fragments/recipient/<rid>

# 4) two-click override, then the audit view
CSRF=$(grep openpost_csrf jar.txt | awk '{print $7}')
curl -s -b jar.txt -X POST -d "kind=open&eventId=<eid>&classification=human&_csrf=$CSRF" \
     http://127.0.0.1:8787/dashboard/actions/reclassify
curl -s -b jar.txt 'http://127.0.0.1:8787/dashboard/audit?action=reclassify.override' | grep -c 'bot'

# 5) export + stats
curl -s -b jar.txt -o out.csv 'http://127.0.0.1:8787/dashboard/export.csv?state=read_confirmed'
node dist/cli/index.js stats --since 30d --tz Europe/Berlin

# 6) reminders (offline: dryrun transport, no --draft)
node dist/cli/index.js remind <messageId> --if no-reply --in 1m --json
node dist/cli/index.js reminders list --status pending --json
sleep 65 && node dist/cli/index.js reminders run --json      # fires exactly once
node dist/cli/index.js reminders run --json                  # {"fired":0,...}

# 7) screenshots (Chromium is preinstalled)
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e
```
Operator-only (documented, not run in CI): `openpost auth gmail --with-compose`, one
`openpost remind … --draft` against a real thread (verify the draft appears in Gmail, threaded, and
is **never** sent), and one real reply to confirm `replied_at` lands within a poll interval. Results,
including anything that behaved differently from this spec, go into `docs/reports/phase3_smoke.md`
in the style of the Phase 1/2 reports.

### 6.7 Acceptance criteria (Phase 3 sign-off)

1. `npm ci && npm run build && npm test` green offline with no credentials and no browser; cases
   121–192 present and passing; the 196 Phase 1–2 tests still pass unmodified in intent; coverage
   thresholds of DoD 6 met.
2. `openpost migrate` upgrades a populated v3 DB to v4 with zero row loss; `/healthz` shows
   `schema: 4`; `doctor` expects 4.
3. `package.json` gained **no runtime dependency**; `@playwright/test` is the only new devDependency;
   `htmx.min.js` is vendored with its version and sha256 recorded and asserted by `doctor`.
4. The dashboard renders list, detail, event, audit, stats and reminders pages from a seeded DB;
   filters, pagination and CSV/JSON export share one filter parser; a row updates live over SSE with
   no reload (asserted in Chromium).
5. Every event row shows classification, confidence and rule ids and is overridable in two clicks
   through the existing `reclassify` service, with the override visible in the audit view and zero
   notifications emitted.
6. Auth: bearer **or** password session; CSRF on every POST (double-submit bound to the session +
   Origin check); `SameSite=Strict`, `HttpOnly`, `Secure` when https; the process refuses to serve a
   dashboard off loopback without a secret.
7. The §2.3 CSP is present on every HTML response with no `unsafe-inline`, and the accessibility
   checklist of §2.7 passes (test 192).
8. `openpost remind` creates reminders that fire exactly once under the claim/lease protocol, survive
   a SIGKILL between due-time and fire, cancel themselves on a reply, and can create a threaded Gmail
   draft that is never sent.
9. Reply detection sets `replied_at`, the `replied` state, cancels `no_reply` reminders and emits one
   `reply` notification, driven entirely by an injectable reader in tests, with a documented poll
   ladder, quota budget and backoff, plus an IMAP path for SMTP-only setups.
10. `/api/stats` exposes open rate, click rate, time-to-open buckets and a timezone-correct best-hour
    histogram as a **superset** of the existing accuracy payload, and the dashboard renders them as
    dependency-free inline SVG with data-table fallbacks.
11. No raw email address, IP, token, secret, password or message body appears in any `audit_log` row,
    log line or export added by Phase 3 (asserted in tests 149, 178, 190).
12. `README.md`, `docs/dashboard.md` and `docs/reminders.md` document every new variable, the auth and
    CSRF model, the reminder semantics and the Gmail scopes, and restate that Phase 3 remains fully
    testable with no public URL and no Gmail credentials.

---

## 7. Mailtrack parity scorecard

| Feature | Mailtrack | openpost after Phase 2 | openpost after Phase 3 |
|---|---|---|---|
| Open tracking (pixel) | yes | yes | yes |
| Per-recipient tracking | paid tiers | yes | yes |
| Real-time notification of a read | yes (extension + push + email) | Slack, Discord, signed webhook, ntfy, SSE | unchanged, **+ dashboard live rows** |
| Notification of a *confirmed* read | no | yes (`read_confirmed`) | yes |
| Click tracking | paid | on by default | on by default, surfaced per link in the UI |
| Click → open back-fill | no | yes | yes, shown as `implied_by_click` in the timeline |
| Gmail-proxy / Apple-MPP filtering | no | shipped CIDR sets | yes, and the dashboard says *why* (rule chips) |
| Explicit "prefetched, read not confirmed" state | no | yes | yes, a first-class column and a stats bucket |
| Self-open elimination | time window | window + fingerprint + untracked Sent copy | unchanged (and the self-copy is skipped by reply detection) |
| Explainable classification (rule ids per event) | no | yes (API/CLI) | **yes, in the UI, with per-rule documentation** |
| Human override of a classification | no | API + CLI | **+ two clicks in the UI, audited and visible** |
| **Web dashboard** | yes (hosted SaaS) | CLI + SSE only | **yes — local, server-rendered, no build step, no cloud** |
| Live updates without reload | yes | n/a | yes (SSE + htmx, no polling) |
| Filters / search / pagination | yes | CLI only | yes |
| CSV / JSON export | partial (paid) | `--json` per command | yes, filter-aware, injection-safe |
| **Reminders ("no reply in N days")** | yes (paid) | no | **yes — `no_reply`/`no_open`/`always`, crash-safe single firing** |
| Auto-draft follow-up in the same thread | no | no | **yes (`--draft`, never auto-sends)** |
| **Reply detection** | yes (paid) | no | **yes — Gmail `threads.get` metadata or IMAP, quota-budgeted** |
| Reply state + auto-cancelled reminders | partial | no | yes |
| Aggregate stats (open/click rate, best hour) | yes (paid) | accuracy report only | **yes — rates, time-to-open distribution, best-hour histogram in your timezone** |
| Charts without a JS chart library | n/a | n/a | yes (inline SVG, accessible, dark-mode aware) |
| Accuracy self-report | no | yes | yes |
| Location reporting | shows the proxy datacentre as "location" | not stored | still not stored; the UI prints "unknown (proxied)" |
| Public JSON API + CLI | no | yes + SSE + reclassify | + stats, reminders, recipients, export |
| Self-hosted, data never leaves your box | no | yes | yes |
| "Sent with Mailtrack" signature | yes on free tier | never | never |
| Raw IP storage | yes | never | never (and reply metadata stores no bodies) |
| Recipient opt-out / DNT / GPC | no | yes | yes |
| Retention + one-command erasure | no | scheduled prune + `forget` | + reminders erased with the recipient |
| Append-only audit log | no | yes | + login, override-from-UI, reminder, reply rows |
| Price / limits | per-seat subscription, tracked-mail caps | free, self-hosted | free, self-hosted |

**Remaining Mailtrack advantages after Phase 3 → Phase 4 backlog**

1. In-Gmail checkmarks (Chrome extension / Gmail add-on talking only to the operator's instance).
2. Mail merge / campaigns with per-row variables, throttling and crash-resume, plus per-campaign
   stats and A/B subject testing.
3. Multi-account sending with encrypted per-account OAuth tokens.
4. Zero-setup onboarding: single-binary (Node SEA) + Docker image + `systemd` unit + `npx openpost
   init`, so a public hostname and a tunnel are the only manual steps.
5. Backup/restore round-trip and v1→vN migration tests.
6. Optional local geo (MaxMind) so "unknown (proxied)" can become a real city where it is honest to
   do so.

---

## 8. Summary of key decisions

1. **Zero new runtime dependencies.** `@fastify/static`, `@fastify/cookie`, `@fastify/formbody` and a
   template engine are each replaced by 10–45 lines in-tree; htmx is vendored as one hash-pinned file.
   The only new devDependency is Playwright, used solely to prove the live-update DoD in Chromium.
2. **Rendering is a tagged template, not an engine.** `html\`…\`` escapes by construction and forces
   the unsafe path to be spelled `raw()`, so XSS review is a grep, and `tsc` type-checks every view.
3. **Stateless HMAC sessions + double-submit CSRF bound to the session id**, with `SameSite=Strict`
   and an `Origin` check — no session table, no new schema, and rotating `TRACKING_SECRET` revokes
   every session.
4. **The dashboard reuses, never forks, the Phase 2 services**: overrides call `reclassify()`, live
   updates ride the existing `EventBus`/SSE, mute calls `setMute` — the UI adds no second source of
   truth. The single auth change is that the SSE route also accepts the session cookie, because a
   browser `EventSource` cannot send a bearer header.
5. **CSP with no `unsafe-inline` is the design constraint that shapes the assets**: all CSS/JS in
   files, charts as inline SVG with classes, no `style=` and no `on*=` anywhere.
6. **Reminders fire exactly once by construction**: a single conditional `UPDATE` under
   `BEGIN IMMEDIATE` is a real compare-and-swap on SQLite's one writer, a lease makes a killed
   process recoverable rather than stuck, and the notification queue's `UNIQUE(dedupe_key)` makes the
   only observable side effect idempotent across the crash window.
7. **The one irreversible side effect (a Gmail draft) is at-most-once, not at-least-once**: the
   attempt is journalled before the API call and recovery *searches* for the draft by
   `X-Openpost-Reminder` instead of blindly re-creating it; `drafts.send` exists nowhere in the tree.
8. **A reply is defined by evidence, not by heuristics**: `format=metadata` only (no bodies ever
   fetched or stored), a message after `sent_at`, from someone other than the sender, not labelled
   `SENT`/`DRAFT` and not carrying `X-Openpost-Self-Copy` — closing the loop on Phase 2's own note.
9. **`replied` becomes a first-class state, which forces `deriveRecipientState` to learn about
   `replied_at`** — otherwise the very next open or override would silently erase a detected reply.
   That one-line coupling is the highest-risk change in Phase 3 and has a dedicated regression test.
10. **Timezone-correct stats without a dependency**: rates and buckets in SQL, hour/day bucketing in
    JS via `Intl`, because SQLite's `localtime` would silently use the server's `TZ` and mis-handle
    DST — and `/api/stats` stays a superset so nothing that reads it today breaks.

## Phase 3.1 amendments

Findings from `docs/reports/phase3_review.md` where this spec's own text was wrong, incomplete, or
silent on the safer choice. Each line is the amendment; the code fix lives in the commit named.

- **H1 (SSE route vs. cookie path).** §2.4's session cookie is `Path=/dashboard`, but §2.8 places
  the live-update stream at `GET /api/events/stream` — a browser `EventSource` never actually sends
  that cookie there. The stream is additionally served at `GET /dashboard/events/stream` (same
  handler, same auth), and `assets/app.js`'s `EventSource` points there; `/api/events/stream`
  remains for bearer-only API clients. The cookie's `Path` is not widened to `/` (that would also
  require adding CSRF/Origin checks to every state-changing `/api` route, since a session cookie
  would then ride along with it).
- **M1 (`via: 'open'` CSRF reasoning).** §2.4's CSRF preHandler reasoned that only a session cookie
  is an "ambient credential" and skipped the whole check (Origin/Referer included) for the
  zero-config `open` mode. That is wrong: `open` mode has no secret at all, so *any* request that
  reaches the process is implicitly trusted, which is exactly what makes a same-origin check still
  necessary there — only the `_csrf` token comparison (which `open` mode has no token for) is
  legitimately skippable. Fixed in `fix(dashboard): serve SSE under /dashboard, restore CSRF origin
  check, harden query/flash/referer handling`.
- **H2 (missing auto-reply/bounce rules).** §4.2's reply rules (sender-address match, `SENT`/`DRAFT`
  labels, `X-Openpost-Self-Copy`, `ownProviderMsgId`) never accounted for an automated message from
  the *other* party — a vacation autoresponder or a bounce/DSN satisfies every one of those rules
  and would be recorded as a real reply. Amended: reject `Auto-Submitted` not absent/`no`,
  `Precedence` in `{bulk, auto_reply, junk, list}`, any `X-Autoreply`/`X-Autorespond` header, and a
  `mailer-daemon@`/`postmaster@` sender (by `From` or `Return-Path`) — each with its own named
  rejection reason. `METADATA_HEADERS` (Gmail) and the IMAP header fetch list both request these
  headers now. Fixed in `fix(replies): auto-reply/bounce detection, no permanent wedge on a bad
  candidate, PII-safe audit`.
- **Stats denominator (§5).** The review's "Confirmed correct" section suggested amending §5 so
  stats denominators exclude untracked/opted-out recipients — this spec was silent on the point,
  and the implementation counted them. An opted-out recipient can never register a counted open or
  click again (the pixel/click routes always record `opt_out`, uncounted) regardless of whether
  they otherwise would have, so including them in the rate denominator silently deflates
  open/click/reply rates by however many people opted out — a fact about consent, not about how
  engaging the message was. Amended: `openRate`/`clickRate`/`replyRate` (both the overall report and
  each `topMessages` entry) divide by *tracked* recipients (window recipients minus opted-out);
  `totals.recipients` still reports the full window count for context, and `totals.optedOut` is
  unchanged. Fixed in `fix(stats/seed): worst-state badge, bounded/SQL-aggregated stats, safe
  --reset, input hardening`.
- **M6 (stats window, unstated in §5).** §5 never states a default or maximum window for
  `/dashboard/stats` / `/api/stats?view=stats`; the implementation defaulted to all-time. Amended:
  both default to the last `STATS_DEFAULT_WINDOW_DAYS` (90) days and cap any explicit window at
  `STATS_MAX_WINDOW_DAYS` (366) — a single stats request can no longer be made to aggregate an
  unbounded number of recipient rows. `/api/stats`'s `accuracy` half (Phase 2, a different report)
  keeps its historical all-time default; only the newer `stats` key gets the bounded window.
