# 09 — Phase 5 Implementation Spec: mobile

Target: a coding agent implements this directly, with no further design decisions required. Same
stack as Phases 1–4 (Node 22 + TypeScript strict + Fastify 5 + better-sqlite3 + vitest, ESM, no
bundler, server-rendered HTML + vendored htmx). Phase 5 adds **no new runtime dependency, no public
URL requirement in tests, no browser requirement in `npm test`, and no network in tests**: the Web
Push channel is exercised against an injected fake push service and a locally generated subscriber
keypair, the PWA is exercised at a 390×844 Playwright viewport against the same in-process server
the Phase 3 e2e test already boots, and the Gmail add-on's *server* half is exercised with
`app.inject()` while its Apps Script half is shipped as source and never executed in CI.

> Research note. `developers.google.com` is blocked by this environment's egress proxy
> (`curl` → `CONNECT tunnel failed, response 403`; `WebFetch` → `EGRESS_BLOCKED`). `WebSearch`
> works, so every Google-platform claim in §6 is reconstructed from search-result summaries of
> Google's own pages plus prior knowledge, and each is tagged with a confidence level. Nothing in
> §2–§5 depends on any of it.

---

## 0. Baseline: what the tree actually contains

Written against the working tree at HEAD `bfff117` (schema 9, 602 tests), not against docs 03/08
prose. Facts that shape Phase 5:

| Fact (verified in the tree) | Consequence for Phase 5 |
|---|---|
| `EXPECTED_SCHEMA = 9`; `009_phase4_1.sql` is the last migration | Phase 5 ships `010_phase5.sql`, `EXPECTED_SCHEMA = 10`. |
| The dashboard CSP is `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` (`src/server/routes/dashboard.ts:46`) | `manifest-src 'self'` and `worker-src 'self'` must be **added** — both currently fall through to `default-src 'none'`, which blocks a manifest and a service worker outright. No `'unsafe-inline'` is introduced anywhere. |
| `registerDashboardAssetRoutes` is a **separate plugin scope** with none of the auth/CSP hooks (`src/server/routes/dashboard-assets.ts`), serving a frozen `Map` built at startup from `ASSET_NAMES` | `sw.js`, `manifest.webmanifest`, the icons and `offline.html` go in that map: public, CSP-header-free (a `default-src 'none'` response header on a SW script would apply to the worker's own global scope and break its `fetch`), no path join of user input. |
| That route serves **every** asset `Cache-Control: public, max-age=31536000, immutable` with no content hash in the URL | Latent bug, and phones make it much worse: after an upgrade a device keeps the old `app.css`/`app.js` for a year. §2.6 adds `?v=<version>` to asset links and a per-asset cache policy (`sw.js`/`manifest` → `no-cache`). |
| `layout.ts` already emits `<meta name="viewport" content="width=device-width, initial-scale=1">` and `app.css` already has one `@media (max-width: 700px)` block that sets `table, thead, tbody, th, td, tr { display: block }` **and `thead { display: none }`** | The card fallback already exists but is unlabelled — on a phone today a message row renders as eight anonymous lines. §3 adds `data-label` attributes + `td::before { content: attr(data-label) }`. |
| The whole interactive send pipeline is still inline in `send.ts`'s commander action (lines ~144–615), with **every** `process.stdout.write` confined to lines 620–642 | The pipeline is cleanly extractable: move lines 144–615 verbatim into `runSend()` and leave the printing in the action. This is what lets the mobile compose page send with *full* per-recipient semantics instead of re-implementing them (§2.3). |
| `src/mail/send-message.ts` deliberately handles **exactly one** recipient (`addresses.length !== 1` throws) and is the campaign path | It cannot serve a compose form with Cc/Bcc: `buildSendPlan` over a one-element list produces empty `headerCc`. Do **not** widen it; use `runSend`. |
| `sendMessage`/`send.ts` single mode creates one addressee row per address plus exactly one `is_aggregate=1` row with `email='(all recipients)'` carrying the pixel (`send.ts:364–392`) | The Gmail add-on's message-level tracking is **exactly** this shape. `/api/addon/track` reuses it; no new tracking concept is invented (§6.4). |
| `FetchLike` (`src/notify/types.ts:110`) types `body?: string` | Web Push bodies are binary. Widen to `body?: string \| Uint8Array` — additive, every existing caller still type-checks. |
| `NotifierDeps` carries `{fetch, timeoutMs, clock, config}` only | The email-to-self channel needs a mail transport. Add an optional `transport?: Transport` supplied by `NotifyWorker` from an injectable factory (§5.2). |
| `ChannelName = 'slack' \| 'discord' \| 'webhook' \| 'ntfy'`, validated in `env.ts` against a `CHANNELS` array, dispatched from a single `ALL` array in `channels/index.ts` | Two new channels are a pure addition: union + `CHANNELS` + `ALL` + `TRIGGER_LABEL` + `summaryLine`. |
| `stream.ts`'s `ALL_TRIGGERS` must be widened by hand whenever `NotifyTrigger` grows — the exact bug the Phase 3 smoke run caught and the Phase 4 spec warns about twice | `daily_digest` (§5.3) **must** be added there. Test 413 asserts it. |
| The notify queue is per-`(trigger, channel)` with `UNIQUE(dedupe_key)`, claim-lease, backoff, dead-letter and audit rows | Web Push reuses it unchanged: one queue row per notification per channel; the *fan-out to N devices* happens inside `deliver()`. |
| `notifications.last_error` is scrubbed through `redactSecretUrls` before persistence (finding #9) | A push endpoint URL (which is a bearer-equivalent capability) must be added to that scrub list (§4.7). |
| Session cookie is stateless HMAC, `Path=/dashboard`, `SameSite=Strict`, default 12 h (`DASHBOARD_SESSION_HOURS`) | An installed PWA on iOS has its own cookie jar: the user logs in once *inside* the installed app. 12 h is hostile on a phone — docs recommend `DASHBOARD_SESSION_HOURS=720`; the default is not changed. |
| CSRF: bearer skips, `open` mode does same-origin only, session mode compares `_csrf` body field **or** the `x-openpost-csrf` header; `openpost_csrf` cookie is non-`HttpOnly` | A `fetch()`-based JSON POST from `app.js` works today by sending the header. `layout.ts` gains `data-csrf` on `<body>` so JS reads it without parsing `hx-headers`. |
| `better-sqlite3` is a native addon; `imapflow`/`mmdb-lib` are `optionalDependencies` loaded by dynamic `import()` | Precedent exists for optional deps, but Phase 5 adds **zero** (§7.3). |
| Playwright is already a devDependency with one Chromium project, one spec (`tests/e2e/dashboard.spec.ts`), and a loud failure when Chromium is missing unless `OPENPOST_ALLOW_E2E_SKIP=1` | The mobile viewport pass is a second Playwright project + a second spec, reusing the same boot-server-in-process pattern. |
| 602 tests green; the highest numbered case is 345-ish (Phase 4) plus 4.1 findings | Phase 5 adds cases **360–441** and must leave every earlier case green in intent. |
| `docs/reports/mailtrack_comparison.md` §3 names the two decisive usability losses: "you cannot compose in Gmail's UI and have it tracked" and "no mobile/desktop notification without standing up ntfy or Slack" | Phase 5 attacks the second one outright (§4, §5) and attacks the first one *for the phone* by moving compose into openpost (§2) rather than into Gmail (§6, experimental). |

---

## 1. Goal and Definition of Done

**Goal.** Make openpost usable from a phone, end to end, without a laptop: compose and send a fully
tracked email from a phone browser, get a push notification on that phone the moment somebody
actually reads it, tap the notification to land on the message, and set a reminder — all on the
dashboard the operator already runs, with no third party in the middle and no native app store.
The Gmail add-on (§6) is shipped as an **experimental, operator-installed sub-project**, because the
one thing it depends on — an add-on compose surface inside the Gmail *mobile* apps — cannot be
verified here and may not exist (§6.1).

**Definition of Done** (each item binary and checkable):

1. **Compose in ≤4 taps.** In the mobile Playwright project (390×844, `hasTouch`), starting from an
   authenticated `/dashboard/messages`, exactly four `tap()` calls — bottom-nav **Compose**, the
   **To** field, the **Body** field, **Send** (Subject reached with `Tab`) — produce a `303` to
   `/dashboard/messages/<id>` and a `messages` row with one `recipients` row bearing a pixel token
   (test 437).
2. **No horizontal scroll anywhere.** For each of `/dashboard/{messages, messages/:id,
   events/open/:id, campaigns, campaigns/:id, reminders, stats, audit, compose, settings}` at
   390×844: `document.scrollingElement.scrollWidth <= clientWidth + 1`, and every `<a>`/`<button>`/
   `<input>`/`<select>` in the viewport has a bounding box of at least 44×44 CSS px (test 438).
3. **Installable.** `GET /dashboard/manifest.webmanifest` is `200 application/manifest+json` with
   `scope:"/dashboard/"`, `start_url:"/dashboard/messages"`, `display:"standalone"` and 192/512 PNG
   icons; `navigator.serviceWorker.getRegistration('/dashboard/')` resolves with
   `registration.scope` ending `/dashboard/` (tests 374, 439).
4. **Push within 10 s.** With one registered subscription and a fake push service, a counted open
   causes exactly one POST to the subscription endpoint within 10 s of the pixel hit, carrying
   `Content-Encoding: aes128gcm`, a `TTL`, and an `Authorization: vapid t=…, k=…` header; the body
   decrypts (RFC 8291, with the subscriber private key held only by the test) to the expected JSON
   `{title, body, url, tag, ts}` (tests 392, 396, 402).
5. **Self-healing subscriptions.** A `410 Gone` (and a `404`) disables exactly that subscription row
   and no other; the same notification still counts as delivered if any other device took it; a
   subsequent tick posts only to the survivors (tests 397, 398).
6. **Zero-config notification surface.** `NOTIFY_CHANNELS=email` with `MAIL_TRANSPORT=dryrun` writes
   exactly one `.eml` per counted open to `OUT_DIR`, addressed to `NOTIFY_EMAIL_TO` (default
   `FROM_EMAIL`), carrying `Auto-Submitted: auto-generated` and `X-Openpost-Notification: 1`, with
   no pixel and no `messages` row (tests 407–410).
7. **Compose is not an attack surface.** A cross-origin POST to `/dashboard/compose/send` is `403`;
   a POST with no/incorrect `_csrf` under a session is `403`; a body above `COMPOSE_MAX_BODY_BYTES`
   is `413`; more than `COMPOSE_RATE_PER_HOUR` sends in an hour is `429`; more than
   `COMPOSE_MAX_RECIPIENTS` addresses is `400` naming `openpost campaign` (tests 366–370).
8. **Offline is honest.** With the network killed, an in-scope navigation renders
   `/dashboard/offline.html`; after browsing four authenticated pages the SW's Cache Storage
   contains **zero** `text/html` entries (only `/dashboard/assets/*` and the offline page)
   (test 440).
9. **Migration.** Checked-in fixture DBs at schema 1–9 migrate to 10 with zero row loss, empty
   `PRAGMA foreign_key_check`, `integrity_check = ok`; `/healthz` and `doctor` report 10
   (tests 427–429).
10. **Add-on, honestly scoped.** `POST /api/addon/track` mints a message-level tracked message
    (addressee rows + one aggregate row + pixel URL) and `POST /api/addon/link` binds it to a real
    Gmail message id/thread id idempotently; an add-on message never linked within
    `ADDON_LINK_TIMEOUT_HOURS` is reaped to `status='abandoned'`; both endpoints are `404` unless
    `ADDON_ENABLED=true` and `401` without the bearer. **No Apps Script runs in CI** (tests
    415–426).
11. **Dependency budget.** **Zero** new runtime dependencies and **zero** new devDependencies
    (§7.3). RFC 8291/8292 are implemented in `src/core/webpush.ts` on `node:crypto` and validated
    against the RFC's own test vector plus a local encrypt→decrypt round trip.
12. **CSP intact.** No `'unsafe-inline'`, no `'unsafe-eval'`, no inline `<script>`/`<style>`
    anywhere new; the mobile Playwright run records zero CSP console violations across every page
    (test 441).
13. `npm ci && npm run build && npm test` green on a clean container with no `.env`, no
    credentials, no network, no browser; cases 360–436 present and passing; `src/core/**` (which
    gains `webpush.ts`) stays ≥ 90 % lines.

**Explicitly out of scope for Phase 5** (with reasons in the named section): attachments in mobile
compose (§2.8), rich-text/WYSIWYG composing (§2.4), a server-side draft store (§2.9), native
Android/iOS apps, a POST Web Share Target (§2.7), the Chrome MV3 extension (still deferred —
`docs/extension.md` is unchanged), scheduled sending, and any hosted push relay of our own.

---

## 2. Mobile compose + PWA

### 2.1 Shape

```
GET  /dashboard/compose                 the form (also the GET Web Share Target)
POST /dashboard/compose/send            CSRF + rate-limited; runs the real send pipeline
GET  /dashboard/settings                push devices, install help, session info
POST /dashboard/actions/push-subscribe  JSON, CSRF header
POST /dashboard/actions/push-unsubscribe
GET  /dashboard/assets/manifest.webmanifest   public
GET  /dashboard/assets/sw.js                  public, Service-Worker-Allowed: /dashboard/
GET  /dashboard/offline.html                  public (served from the asset map)
```

`/dashboard/compose` and `/dashboard/settings` live inside the existing authenticated plugin scope,
so they inherit the auth hook, the CSRF preHandler, the CSP and every security header with no new
code path.

### 2.2 The compose page — `src/server/views/pages/compose.ts`

Model:

```ts
export interface ComposePageModel {
  to: string; cc: string; bcc: string; subject: string; body: string;  // prefill (share target / redisplay)
  accounts: Array<{ ref: string; label: string; email: string; isDefault: boolean }>;
  selectedAccount: string | null;
  transport: TransportName;          // rendered read-only, so "dryrun" is never a surprise
  trackClicks: boolean;
  dryRunForced: boolean;             // MAIL_TRANSPORT=dryrun
  error: string | null;
  csrf: string;
  maxBodyBytes: number; maxRecipients: number;
}
```

Markup rules:

- One `<form method="post" action="/dashboard/compose/send" enctype="application/x-www-form-urlencoded">`
  with `<input type="hidden" name="_csrf">`.
- `To` is `<input type="email" multiple inputmode="email" autocapitalize="none" autocorrect="off"
  spellcheck="false" enterkeyhint="next" required>`; comma/space separated, same
  `collectRepeatable` splitting rule the CLI uses.
- `Cc`/`Bcc` live inside `<details class="compose-extra"><summary>Cc / Bcc</summary>` — collapsed by
  default, zero JS.
- `Subject` `<input type="text" enterkeyhint="next" required maxlength="512">`.
- `Body` `<textarea name="body" rows="10" enterkeyhint="send">` — **plain text**. §2.4 explains why.
- A `<select name="account">` only when ≥ 2 accounts exist (otherwise a hidden input), a
  `<input type="checkbox" name="trackClicks" checked>`, and a single `<button type="submit"
  class="btn-primary btn-send">Send</button>`.
- Under the button, a static line naming the effective transport and, when
  `MAIL_TRANSPORT=dryrun`, a `flash-info` reading *"dry run: this writes files to OUT_DIR and sends
  nothing"* — the phone is exactly where a silent dry run would mislead.
- No inline handlers, no inline styles. `compose.js` is a separate asset (§2.9).

### 2.3 The send path — extract `runSend`, do not re-implement it

**New file `src/mail/send-run.ts`.** Move `src/cli/commands/send.ts` lines ~144–615 verbatim into:

```ts
export interface RunSendInput {
  to: string[]; cc: string[]; bcc: string[];
  subject: string;
  html: string; text?: string | undefined;
  from?: string | undefined;            // or fromAccountRef
  fromAccountRef?: string | undefined;
  track: boolean; trackClicks: boolean | undefined;  // undefined = config default
  optOutLink: boolean; mute: boolean;
  transport?: TransportName | undefined;  // undefined = config
  recipientMode?: RecipientModeOption | undefined;
  outDir?: string | undefined;
}
export interface RunSendResult {
  messageId: string; mode: RecipientMode; transport: TransportName;
  recipients: RecipientResult[];        // the existing type, moved with it
  errors: string[];
  singleSuppressedReason: string | null;
  selfCopy: { ok: boolean; strategy: string; error?: string } | null;
}
export async function runSend(deps: { db: DB; config: AppConfig; clock?: () => number }, input: RunSendInput): Promise<RunSendResult>
```

`src/cli/commands/send.ts` keeps its option parsing, its file reads, its `--json`/human printing
(lines 620–642) and `shouldRunSelfCopy`, and calls `runSend`. **Nothing else changes.** This is
safe because the send pipeline's contract is asserted end to end by CLI-driving integration tests
(`tests/integration/send-dryrun.test.ts`, `recipient-semantics.test.ts`, which call
`createProgram().parseAsync(...)`); if the extraction is wrong, those tests fail, not a new test.

`POST /dashboard/compose/send` then:

1. Parses/normalises addresses (`splitAddresses(s)` in `src/core/addresses.ts`, new, pure: splits on
   `,`/`;`/whitespace, trims, lowercases the domain, rejects anything without exactly one `@` or
   containing CR/LF — header-injection guard, test 371).
2. Enforces the limits of §2.6, then calls `runSend` with `track: true`,
   `trackClicks: body.trackClicks === 'on'`, `optOutLink: false`, `recipientMode: undefined`
   (so `RECIPIENT_MODE`/`auto` decides, exactly as the CLI does — including the loud refusal on
   `per-recipient` + `MAIL_TRANSPORT=gmail`, rendered as a form error rather than a stack trace).
3. On success: `audit(db, {actor:'dashboard', action:'send', subjectType:'message', subjectId})`,
   `303 → /dashboard/messages/<id>?flash=sent`.
4. On a per-recipient partial failure: `303` to the message page with `?flash=sent_partial`; the
   detail page already shows per-recipient status.
5. On a validation/config failure: re-render the compose page (HTTP 400) with the submitted values
   preserved and `error` set — never a blank form.

New `FLASH_MESSAGES` keys: `sent`, `sent_partial`, `push_enabled`, `push_disabled`,
`compose_discarded`.

### 2.4 Body handling: plain text in, HTML out

The textarea is plain text and the server builds the HTML part itself:

```ts
// src/core/html.ts (additions, pure)
export function linkifyText(text: string): string   // bare http(s) URLs -> <a href="…">…</a>, escaped first
export function textToHtml(text: string): string    // escape -> linkify -> paragraphs -> <html><body>…</body></html>
```

Rationale, stated in the page and in `docs/dashboard.md`: a WYSIWYG editor on a phone means either a
contenteditable sanitiser (a new XSS surface inside our own CSP) or a dependency; and click tracking
needs real `<a href>` elements, which `linkifyText` produces deterministically. `textToHtml` output
is the `html` argument to `runSend`, and the original plain text is the `text` argument, so the
text part keeps the original URLs exactly as `send.ts` already guarantees (§4.3 of doc 04).

`linkifyText` rules (tested, cases 372–373): only `http://`/`https://` schemes; escape before
linkifying so a body containing `<a href=x>` is inert; trailing `.,;:!?)` and a closing `)` with no
opener are excluded from the URL; a URL already inside the tracking host is left alone (the
`skipHosts` rule downstream then does the rest).

### 2.5 Manifest, service worker, icons

**`src/server/assets/manifest.webmanifest`** (static file, served from the asset map):

```json
{
  "name": "openpost", "short_name": "openpost",
  "id": "/dashboard/", "scope": "/dashboard/", "start_url": "/dashboard/messages",
  "display": "standalone", "orientation": "any",
  "background_color": "#ffffff", "theme_color": "#1b5fbf",
  "icons": [
    { "src": "/dashboard/assets/icon-192.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/dashboard/assets/icon-512.png", "sizes": "512x512", "type": "image/png" },
    { "src": "/dashboard/assets/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "share_target": { "action": "/dashboard/compose", "method": "GET",
    "params": { "title": "subject", "text": "body", "url": "shared_url" } },
  "shortcuts": [
    { "name": "Compose", "url": "/dashboard/compose" },
    { "name": "Messages", "url": "/dashboard/messages" }
  ]
}
```

`layout.ts` adds `<link rel="manifest" href="/dashboard/assets/manifest.webmanifest">`,
`<meta name="theme-color" content="#1b5fbf">` (plus a dark variant via `media`),
`<link rel="apple-touch-icon" href="/dashboard/assets/apple-touch-icon-180.png">` and
`<meta name="apple-mobile-web-app-capable" content="yes">`.

**Service worker scope.** `sw.js` is served from `/dashboard/assets/sw.js` (the public, CSP-header-free
scope) with `Service-Worker-Allowed: /dashboard/`, and `app.js` registers it as
`navigator.serviceWorker.register('/dashboard/assets/sw.js', { scope: '/dashboard/' })`. Serving it
from the authenticated scope instead would (a) put `default-src 'none'` on the worker's own global
and (b) make the SW script a 302-to-login for a logged-out install.

**`src/server/assets/sw.js`** — ~90 lines, no build step:

- `install`: `caches.open('openpost-static-v<VERSION>')` and precache exactly
  `['/dashboard/assets/app.css','/dashboard/assets/app.js','/dashboard/assets/compose.js',
  '/dashboard/assets/htmx.min.js','/dashboard/assets/favicon.svg','/dashboard/assets/icon-192.png',
  '/dashboard/offline.html']`, then `skipWaiting()`.
- `activate`: delete every cache whose name ≠ the current one, then `clients.claim()`.
- `fetch`: **only** handles `GET`. `/dashboard/assets/*` → cache-first. A `navigate` request →
  network-only with `catch(() => caches.match('/dashboard/offline.html'))`. Everything else →
  `return;` (browser default). **No authenticated HTML is ever written to a cache** — a phone is a
  lost-and-found item, and openpost's entire pitch is that recipient data does not leave the
  operator's control. This is DoD 8.
- `push`: `event.waitUntil(self.registration.showNotification(title, {body, tag, data:{url}, icon,
  badge, timestamp}))`, with a hard guard: if `event.data` is absent or unparsable, show a generic
  *"openpost: new activity"* (`userVisibleOnly` forbids a silent push).
- `notificationclick`: `event.notification.close()`; take `data.url`, **reject it unless it starts
  with `/dashboard/` and not `//`** (the same `isSafeNextPath` rule the login redirect uses), then
  focus an existing client on that origin (`clients.matchAll({type:'window', includeUncontrolled:true})`)
  and `navigate(url)`, else `clients.openWindow(url)`.
- `pushsubscriptionchange`: re-subscribe with the same `applicationServerKey` and POST the new
  subscription to `/dashboard/actions/push-subscribe` with `{ oldEndpoint }` so the server swaps
  rather than duplicates.

**Icons without a design tool or a dependency.** `scripts/gen-icons.mjs` (new, ~110 lines, uses only
`node:zlib` for the deflate stream and a hand-rolled CRC32) rasterises a rounded square in
`--accent` with a white ring glyph from pure distance maths and writes the four PNGs into
`src/server/assets/`. The generated files are **committed**; test 380 re-runs the generator in
memory and asserts byte equality with the committed files, and `assets/index.ts` records their
sha256 next to `HTMX_EXPECTED_SHA256` with a `doctor` check (`pwa.assets`) asserting it — the exact
pattern the vendored htmx already uses.

### 2.6 CSP, cache policy, limits

**CSP** (`src/server/routes/dashboard.ts`), the only change:

```
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none';
manifest-src 'self'; worker-src 'self'
```

**Asset cache policy.** `DashboardAsset` gains `cacheControl: string`; `assets/index.ts` sets
`'public, max-age=31536000, immutable'` for hashed-content assets and
`'no-cache, max-age=0, must-revalidate'` for `sw.js` and `manifest.webmanifest`. `layout.ts` appends
`?v=${VERSION}` (from `src/version.ts`) to `app.css`, `app.js`, `compose.js` and `htmx.min.js` hrefs
so an upgrade is picked up immediately. The asset route ignores the query string (the `Map` is keyed
by `:name` only) — no code change there beyond the extra header (test 379).

**Limits** (all in `AppConfig`, §7.3):

| Limit | Env | Default | Behaviour on breach |
|---|---|---|---|
| Request body | `COMPOSE_MAX_BODY_BYTES` | 262144 | route-level Fastify `bodyLimit` → `413`, rendered as a form error |
| Recipients | `COMPOSE_MAX_RECIPIENTS` | 25 | `400`, message names `openpost campaign` |
| Subject | — | 512 chars | `400` |
| Sends per session per hour | `COMPOSE_RATE_PER_HOUR` | 20 | `429`; bucket keyed by `sid` (or IP hash in `open` mode), same module-level sweep pattern as the login limiter, with a `_resetComposeRateLimiterForTests()` export |

`COMPOSE_ENABLED` (default `true`) removes the route and the nav item entirely — an operator whose
dashboard is exposed may not want a send button behind one password.

### 2.7 Web Share Target

`GET /dashboard/compose` accepts `?subject=&body=&shared_url=&to=`; `shared_url` is appended to the
body on its own line when present. Values are length-capped and rendered through the normal escaping
path (they are attacker-controllable — any app on the phone can share into us). GET-only: a POST
share target needs `multipart/form-data` parsing and a `FormData`-reading fetch handler in the SW for
no benefit here. Android/Chrome supports GET share targets; iOS does not support share targets at all
(stated in `docs/dashboard.md`, not asserted as a feature).

### 2.8 Attachment policy

**No attachments.** `buildMime` has no attachment support, Fastify has no multipart parser in the
tree, and storing uploaded files introduces a retention/erasure surface that `openpost forget` would
have to learn about. The compose page says so in one line. Revisit only with a real use case.

### 2.9 Draft autosave

`src/server/assets/compose.js` (new, loaded only on the compose page via a `data-page="compose"`
attribute on `<body>` that `app.js` checks — or simply a second `<script src>` emitted by
`layout.ts` when `model.page === 'compose'`):

- Debounced 500 ms, writes `{to, cc, bcc, subject, body, savedAt}` to
  `localStorage['openpost.compose.draft.v1']`.
- On load, if the form is empty and a draft exists, restores it and shows a non-modal
  *"Draft restored · Discard"* line (the Discard button clears the key and the fields).
- Clears the key on `submit`.
- Drops drafts older than 7 days on load.

Server-side draft storage is deliberately rejected: a phone draft is unsent, unencrypted content the
operator has not chosen to store, and a `compose_drafts` table would need retention, erasure and
migration for a feature `localStorage` does in 30 lines. The trade-off (a draft is lost if site data
is cleared, and it sits in plaintext on the device) is documented in `docs/dashboard.md`.

---

## 3. Responsive pass

### 3.1 Breakpoints

| Range | Name | Layout |
|---|---|---|
| ≤ 480 px | phone | single column, tables → cards, bottom nav, 16 px base font (prevents iOS zoom-on-focus), full-width buttons |
| 481–860 px | tablet | single column, tables kept but horizontally scrollable inside `.table-wrap`, top nav wraps |
| > 860 px | desktop | today's layout, byte-for-byte unchanged above the breakpoint |

`app.css` is edited in place (one file, no second request). The existing `@media (max-width: 700px)`
block is **replaced** by the two blocks above. `main { max-width: 1100px }` is unchanged; phone
padding drops to `0.75em`.

### 3.2 Navigation

- ≤ 860 px: the header keeps the brand and `#live-status` only; `nav[aria-label="Main"]` gets
  `class="nav-bottom"` styling — `position: fixed; inset-inline: 0; bottom: 0;
  padding-bottom: env(safe-area-inset-bottom); display: grid; grid-auto-flow: column;` with six
  items (Messages, Compose, Campaigns, Reminders, Stats, More→`/dashboard/settings`), each a
  48 px-tall flex column of an inline SVG glyph + a 0.7em label. `body { padding-bottom: 4.5rem }`
  at that width so the footer is never hidden behind it.
- The glyphs are inline `<svg>` built by a new `src/server/views/icons.ts` (`raw()`-wrapped constant
  strings, never database-derived) — no icon font, no extra request.
- `aria-current="page"` already marks the active item; the bottom nav styles it with weight + a top
  border, never colour alone (the file's existing WCAG 1.4.1 rule).
- `NavKey` gains `'compose'` and `'settings'`.

### 3.3 Tables → cards

Every `<td>` in `fragments.ts` and in `views/pages/*.ts` gains `data-label="<column header>"`.
At ≤ 480 px:

```css
@media (max-width: 480px) {
  .table-wrap table, .table-wrap thead, .table-wrap tbody,
  .table-wrap th, .table-wrap td, .table-wrap tr { display: block; }
  .table-wrap thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0,0,0,0); }
  .table-wrap tr { border: 1px solid var(--border); border-radius: 8px; padding: 0.6em 0.8em; margin-bottom: 0.6em; }
  .table-wrap td { border: 0; padding: 0.15em 0; display: flex; gap: 0.75em; justify-content: space-between; }
  .table-wrap td::before { content: attr(data-label); color: var(--muted); font-size: 0.8em; }
  .table-wrap td:empty { display: none; }
}
```

`thead` is visually hidden rather than `display:none` so screen readers keep the header association
(the current rule loses it). Every table is wrapped in `<div class="table-wrap">` (a one-line change
in each page module) so 481–860 px can scroll it instead.

Other page-level rules: `.filter-form` collapses into `<details><summary>Filters</summary>` below
860 px (a server-rendered `<details>` — no JS, `open` when any filter is active); `.stat-tiles`
becomes a 2-column grid; `.chart-svg { max-width: 100% }`; `.campaign-actions` buttons go full
width; pagination links become 44 px tall.

### 3.4 Touch and input hygiene

`input, select, button, textarea { font-size: 16px; min-height: 44px }` at ≤ 480 px; `button`
gets `touch-action: manipulation`. The two-click reclassify override buttons (`btn-override`) get
`min-width: 44px` and 0.4em spacing so they are not a mis-tap trap. The live-update flash animation
already respects `prefers-reduced-motion`.

---

## 4. Web Push channel

### 4.1 Decision: hand-rolled RFC 8291/8292, zero dependencies

`web-push` would be one direct dependency plus a transitive tree (JWT + HTTPS agent helpers) for
roughly 250 lines of crypto that `node:crypto` already exposes natively: `createECDH('prime256v1')`,
`createHmac('sha256')`, `createCipheriv('aes-128-gcm')`, and — critically —
`crypto.sign('sha256', data, { key, dsaEncoding: 'ieee-p1363' })`, which emits the raw 64-byte
`r||s` ES256 signature JOSE wants with no DER surgery. The tree already hand-rolls scrypt +
AES-256-GCM (`core/secretbox.ts`), base32 (`core/ids.ts`), HMAC tokens (`core/token.ts`) and MIME
(`mail/mime.ts`) under the same reasoning. Decisive factor: RFC 8291 §5 publishes a full worked
example with fixed keys and salt, so the implementation has a **known-answer test** that runs
offline — a property a wrapper dependency would not give us.

### 4.2 `src/core/webpush.ts` (new, pure + `node:crypto`)

```ts
export interface VapidKeys { publicKey: string; privateKey: string }        // base64url
export function generateVapidKeys(): VapidKeys
export function vapidPublicKeyFromPrivate(privateKey: string): string
export function vapidAuthorization(a: { endpoint: string; subject: string; keys: VapidKeys; nowSec: number; ttlSec?: number }): string
export interface PushSubscriptionKeys { endpoint: string; p256dh: string; auth: string }
export function encryptPush(a: { plaintext: Uint8Array; sub: PushSubscriptionKeys; salt?: Uint8Array; serverPrivateKey?: Uint8Array }): Uint8Array
export function decryptPush(a: { body: Uint8Array; uaPrivateKey: Uint8Array; uaPublicKey: Uint8Array; auth: Uint8Array }): Uint8Array   // exported for tests and for `openpost push test --self-check`
export const MAX_PUSH_PLAINTEXT = 3993
export class PushPayloadTooLargeError extends Error {}
```

`encryptPush`, exactly (RFC 8291 §3.4 / RFC 8188):

```
ecdh      = createECDH('prime256v1'); as_public = ecdh.getPublicKey()            // 65 bytes
shared    = ecdh.computeSecret(ua_public)
PRK_key   = HMAC(auth_secret, shared)
key_info  = "WebPush: info\0" || ua_public || as_public
IKM       = HMAC(PRK_key, key_info || 0x01)                                      // 32 bytes
PRK       = HMAC(salt16, IKM)
CEK       = HMAC(PRK, "Content-Encoding: aes128gcm\0" || 0x01)[0..16]
NONCE     = HMAC(PRK, "Content-Encoding: nonce\0"     || 0x01)[0..12]
record    = plaintext || 0x02
ct        = AES-128-GCM(CEK, NONCE, record) || tag16
body      = salt16 || uint32be(4096) || 0x41 || as_public || ct
```

`vapidAuthorization` builds `header={"typ":"JWT","alg":"ES256"}`,
`payload={"aud": <origin of endpoint>, "exp": nowSec + (ttlSec ?? 43200), "sub": subject}` (`exp`
clamped to ≤ 24 h, `sub` must be `mailto:` or `https:` — else a named `ConfigError`), and returns
`vapid t=<jwt>, k=<base64url publicKey>`.

### 4.3 Data model — `push_subscriptions` (migration 010)

```sql
CREATE TABLE push_subscriptions (
  id             TEXT PRIMARY KEY,
  endpoint       TEXT NOT NULL UNIQUE,
  p256dh         TEXT NOT NULL,          -- base64url, 65-byte uncompressed point
  auth           TEXT NOT NULL,          -- base64url, 16 bytes
  label          TEXT,                   -- operator-supplied, e.g. "Pixel 8"
  ua_family      TEXT,                   -- from the existing core/ua.ts parser
  device_type    TEXT,
  created_at     INTEGER NOT NULL,
  last_ok_at     INTEGER,
  last_error     TEXT,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  disabled_at    INTEGER,
  disabled_reason TEXT                   -- gone_404 | gone_410 | manual | expired
);
CREATE INDEX idx_push_subs_active ON push_subscriptions(disabled_at) WHERE disabled_at IS NULL;
```

`src/db/push.ts` (new): `upsertSubscription`, `listActiveSubscriptions`, `countActiveSubscriptions`,
`markSubscriptionOk`, `recordSubscriptionFailure`, `disableSubscription(id, reason)`,
`deleteSubscription(endpoint)`, `swapSubscription(oldEndpoint, next)`. Upsert is keyed on
`endpoint` (`INSERT … ON CONFLICT(endpoint) DO UPDATE`) so re-subscribing the same device never
duplicates and always clears `disabled_at`/`failure_count`.

These rows describe the **operator's own devices**, never a recipient, so `openpost forget` is
untouched (asserted by test 434, a negative test, so a future reader does not have to wonder).
`openpost prune` deletes subscriptions disabled longer than `RETENTION_DAYS`.

### 4.4 VAPID keys: env, not the database

`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` (default `mailto:${FROM_EMAIL}`), written
into the `0600` `.env` by `openpost init` — the same treatment `TRACKING_SECRET` gets. Putting the
private key in the DB would mean `secretbox` + a master key for something that is not
recipient data and that must be readable before the DB is even open (the subscribe page embeds the
public key).

Load-time validation in `env.ts`: if `NOTIFY_CHANNELS` includes `webpush` then both keys must be
present, must base64url-decode to 65 and 32 bytes respectively, and must agree
(`vapidPublicKeyFromPrivate(priv) === pub`) — otherwise a `ConfigError` naming
`openpost push keys`. A `webpush` channel with valid keys but a non-HTTPS, non-loopback
`TRACKING_BASE_URL` is a **warning** at startup and a `doctor` warn, because the browser will refuse
to register a service worker outside a secure context.

### 4.5 Subscription lifecycle

1. `/dashboard/settings` renders a **Notifications** section: the VAPID public key in a
   `data-vapid-public-key` attribute on the section element, an *Enable on this device* button, and
   a table of registered devices (label, UA family, created, last OK, state) with an *Unsubscribe*
   button each.
2. `app.js` (extended, still no inline script): on click → `Notification.requestPermission()` →
   `registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` →
   `fetch('/dashboard/actions/push-subscribe', {method:'POST', headers:{'Content-Type':'application/json','X-Openpost-CSRF': csrf}, body: JSON.stringify(sub.toJSON())})`
   → reload with `?flash=push_enabled`. Every failure path (`denied`, no `PushManager`, insecure
   context, iOS-not-installed) renders a specific sentence, not "something went wrong"; the
   iOS one says *"On iPhone/iPad, add openpost to your Home Screen first (Share → Add to Home
   Screen), then open it from there."*
3. `POST /dashboard/actions/push-subscribe` validates: `endpoint` is an absolute `https:` URL ≤ 2048
   chars (or `http://127.0.0.1…` when the config is loopback, so tests and local fakes work),
   `keys.p256dh` decodes to 65 bytes starting `0x04`, `keys.auth` to 16 bytes. Then `upsertSubscription`
   + `audit('push.subscribe')`. `409` if `countActiveSubscriptions >= PUSH_MAX_SUBSCRIPTIONS`
   (default 10).
4. `POST /dashboard/actions/push-unsubscribe` deletes by id, audits `push.unsubscribe`.
5. Any `404`/`410` from the push service disables the row with `disabled_reason` and audits
   `push.gone`. `failure_count >= PUSH_MAX_FAILURES` (default 10) disables with `expired`.

### 4.6 The notifier — `src/notify/channels/webpush.ts`

```ts
export const webpushNotifier: Notifier = {
  name: 'webpush',
  isConfigured: (c) => c.vapidPublicKey !== undefined && c.vapidPrivateKey !== undefined,
  async deliver(payload, deps) { /* fan out over every active subscription */ }
}
```

- `buildPushPayload(payload, config)` → `{ v:1, title, body, url, tag, ts }`:
  `title = triggerLabel(payload.trigger)`; `body = summaryLine(payload)` truncated to 240 chars —
  so the existing redaction knobs (`NOTIFY_REDACT_EMAIL`, `NOTIFY_INCLUDE_SUBJECT`) and the
  `messageLevelPhrase` wording are inherited verbatim, and a digest never names a recipient;
  `url = '/dashboard/messages/' + id` (a **path**, never an absolute URL — the SW re-validates it,
  which closes the open-redirect/phishing hole an absolute URL would open, and makes a
  `DASHBOARD_BASE_URL` variable unnecessary); `tag = payload.message.id` so repeated activity on
  one message coalesces into one notification instead of stacking.
- Refuses (`retryable:false`) if the JSON exceeds `MAX_PUSH_PLAINTEXT`; in practice a truncated body
  guarantees it cannot.
- Per subscription: `encryptPush` + `vapidAuthorization`, then
  `deps.fetch(endpoint, { method:'POST', redirect:'error', headers:{ TTL, 'Content-Encoding':'aes128gcm',
  'Content-Type':'application/octet-stream', Urgency, Authorization }, body })` — `redirect:'error'`
  matching the finding-#9 rule every other channel follows.
- Result folding:

| Per-endpoint status | Action | Contribution |
|---|---|---|
| 200/201/202 | `markSubscriptionOk` | success |
| 404, 410 | `disableSubscription(gone_*)`, audit | neither (a dead device is not a delivery failure) |
| 413 | audit `push.too_large` | non-retryable failure |
| 429 | honour `Retry-After` (seconds or HTTP-date, capped at 1 h) | retryable, carries `retryAfterMs` |
| 4xx other | `recordSubscriptionFailure` | non-retryable failure |
| 5xx / network / timeout | `recordSubscriptionFailure` | retryable |

  Row result: `ok` if ≥ 1 success **or** if every subscription was disabled during this attempt
  **or** if there were zero active subscriptions (a no-op must not dead-letter the row and fill the
  audit log). Otherwise `retryable` = any retryable contributor, with the smallest `retryAfterMs`.
  `error` text is `"<n> of <m> endpoints failed: <first status>"` — endpoint URLs are **never**
  persisted (they are bearer-equivalent); `redactSecretUrls` gains a rule that strips anything
  matching a known push host path, and test 401 greps `notifications.last_error` for the endpoint
  substring and asserts zero hits.

`TTL` = `PUSH_TTL_SECONDS` (default 3600 — a read notification older than an hour is noise),
`Urgency` = `high` for `read_confirmed`/`reply`, `normal` otherwise.

### 4.7 Testing with a fake push service

`tests/helpers/fake-push.ts` (new):

- `makeSubscriber()` → generates a P-256 keypair with `node:crypto` plus 16 random auth bytes, and
  returns `{ subscription, decrypt(body) }`. This is a *real* subscriber: the round trip proves the
  bytes on the wire are decryptable by something that is not our own encrypt function inverted.
- `makeFakePushService({ responses })` → a `FetchLike` that records every `{url, headers, body}` and
  replies per-endpoint with a scripted status, including `410`, `429 Retry-After: 30` and a network
  throw.

Tests assert the `Authorization` header parses as `vapid t=…, k=…`, that the JWT's `aud` equals the
endpoint's origin, `exp` is in the future and ≤ 24 h out, that the body's first 16 bytes are the
salt and bytes 21 and 22–86 are `0x41` and an uncompressed point, and that the decrypted plaintext
round-trips the expected JSON.

---

## 5. Email-to-self channel (and the daily digest)

### 5.1 Why

`docs/reports/mailtrack_comparison.md` §5 item 4: Mailtrack's *free* tier gives desktop alerts plus
a daily report with no configuration, and openpost has no channel that works without first standing
up Slack, Discord or ntfy. Every openpost install already has a working mail transport. An email to
yourself is the zero-config surface, works on every phone's existing mail app, and needs no keys.

### 5.2 `src/notify/channels/email.ts`

`NotifierDeps` gains `transport?: Transport`; `NotifyWorkerDeps` gains
`transportFactory?: (config: AppConfig) => Transport | Promise<Transport>` defaulting to
`resolveTransport` (dynamically imported inside the notifier so the notify path does not pull
nodemailer/googleapis at startup in a dashboard-only process). Tests inject a fake transport
directly.

`deliver()`:

- `to = config.notifyEmailTo ?? config.fromEmail`; missing both → `{ok:false, retryable:false}`
  naming `NOTIFY_EMAIL_TO`.
- Subject: `[openpost] ${summaryLine(payload)}` truncated to 200 chars.
- Body: an HTML part (no pixel, no click rewriting, no tracking of any kind — it is built with
  `buildMime` directly, never through `runSend`/`sendMessage`, so there is structurally no way for a
  notification email to become a tracked message) with the same fields the Slack block shows, plus a
  `<a href>` to `/dashboard/messages/<id>` rendered as the full `TRACKING_BASE_URL`-based URL, and a
  text part.
- Headers: `Auto-Submitted: auto-generated`, `X-Openpost-Notification: 1`, `Precedence: bulk`.
  The first two matter: `src/mail/threads.ts` already filters `Auto-Submitted` when detecting
  replies, so a notification landing in the same mailbox can never be mistaken for a recipient's
  reply (test 411 asserts exactly that, using the real detector).
- Loop safety: refuses (`retryable:false`) when `to` equals a `recipients.email` on the message the
  notification is about — you can track a mail to yourself, but we will not then email you about it.

`docs/notifications.md` recommends `NOTIFY_ON=read_confirmed,reply` for this channel, and the
compose/settings page repeats it, because one email per prefetch is how people turn notifications off.

### 5.3 Daily digest (small, and the first thing to cut)

`src/jobs/daily-digest.ts` — a `Job` at 60 s interval that fires once per local day at
`DIGEST_DAILY_AT` (`HH:MM`, unset = off) in `DIGEST_TIMEZONE` (default `REPORT_TIMEZONE`), builds a
payload from the existing `statsReport(db, {sinceMs, untilMs, timeZone})`, and enqueues one row per
configured channel with `trigger: 'daily_digest'` and dedupe key
`${channel}:daily_digest:${yyyy-mm-dd}` — so a restart, a clock jump or two processes cannot
double-send it. Payload gains an optional `digest?: { windowFrom, windowTo, sent, opened, clicked,
replied, openRate, topMessages: Array<{id, subject|null, opens}> }`; subjects appear only when
`NOTIFY_INCLUDE_SUBJECT`.

Touch list for the new trigger — all four places, or it silently half-works (the Phase 3 bug):
`NotifyTrigger` union, `TRIGGER_LABEL`, `summaryLine`/`contextLine`, `dedupeKey`'s exhaustive
switch, `env.ts`'s `TRIGGERS` array, and `stream.ts`'s `ALL_TRIGGERS`.

---

## 6. Gmail add-on (experimental, `addon/`)

### 6.1 Feasibility, honestly

Network access to `developers.google.com` is blocked here (`403` at the egress proxy for both
`curl` and `WebFetch`); `WebSearch` result summaries of Google's own pages were readable. Claims and
confidence:

| Claim | Verdict | Confidence | Basis |
|---|---|---|---|
| A Google Workspace add-on can define `gmail.composeTrigger` and return `UpdateDraftBodyAction` with `ContentType.MUTABLE_HTML` / `IMMUTABLE_HTML` / `PLAIN_TEXT` and an `UpdateDraftBodyType` insert position | **Yes** | High | Documented `CardService.UpdateDraftBodyAction` / `ContentType` classes; multiple corroborating summaries |
| The compose trigger can read the draft's To/Cc/Bcc via `e.draftMetadata` when the manifest sets `draftAccess: "METADATA"` | **Yes** | Medium-high | Documented manifest field; not re-verified against the live page |
| There is **no on-send trigger** in Apps Script / Gmail add-ons | **Correct** | High | Explicit in search summaries: "There is no 'On Send Email' event available in Apps Script"; the recommended workaround is a time-driven trigger that polls |
| `UpdateDraftBodyAction` can only **insert** content — it cannot rewrite or replace existing body text | **Correct** | Medium-high | The API surface is `addUpdateContent` + `setUpdateType` (insert at cursor/start/end); there is no replace-body operation. **Consequence: no click tracking from the add-on.** |
| Add-ons appear in the Gmail **mobile** apps (Android and iOS) for *message-reading* (contextual) surfaces | **Yes** | High | "Once installed in the web version, they'll also be accessible in the Gmail app for iOS and Android… all installed add-ons appear at the bottom of an opened email" |
| The **compose** surface is available inside the Gmail mobile apps | **Unverified, treat as probably not** | Low | Google's 2018 compose-actions launch post says compose actions "work in Gmail across mobile and web", but every current description of the mobile surface describes the *opened-message* card only, and the docs page could not be fetched. My own knowledge of the Gmail Android/iOS compose UI is that it exposes no add-on entry point. |
| Gmail preserves a remote `<img>` in a composed HTML body through send | **Mostly yes, with real risk** | Medium | Remote images in sent HTML are normal and are what Gmail's read-time proxy then fetches; but the compose editor sanitises/normalises markup and may drop a hidden 1×1. Unverifiable without a live send. |
| `UrlFetchApp`: 20 000 calls/day on a consumer `gmail.com` account, 100 000 on Workspace; time-driven trigger runtime 90 min/day consumer, 6 h Workspace | **Yes** | Medium-high | Multiple 2026 quota summaries agree. A 5-minute linker at ~2 s/run is ~10 min/day and ~300 fetches/day — comfortable. |
| An unpublished add-on can be installed on the author's own account via the Apps Script editor's test deployment, with no Marketplace review | **Yes** | Medium-high | Standard Apps Script behaviour; the install checklist's step 0 verifies it rather than assuming it. |

**Verdict.** Option A cannot be sold as "tracked compose on a phone": the single load-bearing
assumption (a compose card in the Gmail mobile apps) is the one thing that could not be checked, and
the balance of evidence is against it. It *can* be sold as "if your Gmail client shows add-on
compose actions — certainly on Gmail web, possibly on Android — openpost can stamp a message-level
tracking pixel into the draft you are writing there." So: ship the Apps Script source, ship and
fully test the server endpoints it needs, and gate the whole thing behind `ADDON_ENABLED=false` by
default, with an operator checklist whose **step 1 is "does the card appear on your phone at all?"**
and an instruction to stop if it does not. Mobile compose that is actually guaranteed to work is
§2 — that is why §2 is the centre of this phase and §6 is a sub-project.

### 6.2 What the add-on can and cannot do

| | |
|---|---|
| Tracking granularity | **Message-level only** (`recipient_mode='single'`): the add-on knows the draft's current addressees, but the user can add more after the card runs, and there is no send hook to re-read them. Every surface says "recipient unknown, N on thread" — the vocabulary doc 07 §4.5 already defines. |
| Click tracking | **None.** The API inserts, it does not rewrite. |
| Unsubscribe footer | None (this is one-to-one mail, not a campaign). |
| Self-open elimination | None beyond the `R1` send window and `R5` sender fingerprint — no untracked Sent copy is possible. |
| Reply detection | **Works**, once the linker binds the Gmail `threadId` (§6.5). |
| Reminders | Work, from the dashboard, once linked. |
| Failure mode if Gmail strips the pixel | The message exists in openpost as sent-and-never-opened, indistinguishable from a genuine non-open. The install checklist therefore includes a *"Show original → grep for your tracking host"* step, and `openpost show <id>` prints the pixel URL so it can be compared. |

### 6.3 Files under `addon/` (shipped, never executed in CI)

| File | Contents |
|---|---|
| `addon/appsscript.json` | `timeZone`, `runtimeVersion: "V8"`, `oauthScopes`, `addOns.common` (name, logoUrl, `layoutProperties`), `addOns.gmail.composeTrigger` = `{ selectActions: [{ text: "Track with openpost", runFunction: "onComposeTrack" }], draftAccess: "METADATA" }`, `addOns.gmail.homepageTrigger` for a status card |
| `addon/Setup.gs` | `setup(baseUrl, token)` writes `PropertiesService.getUserProperties()` keys `OPENPOST_BASE_URL`, `OPENPOST_TOKEN`; `installLinker()` creates the 5-minute `ScriptApp.newTrigger('linkSentMessages').timeBased()`; `teardown()` removes both |
| `addon/Code.gs` | `onComposeTrack(e)` — read `e.draftMetadata.{toRecipients,ccRecipients,bccRecipients,subject}`, POST `/api/addon/track`, build `CardService.newUpdateDraftActionResponseBuilder().setUpdateDraftBodyAction(CardService.newUpdateDraftBodyAction().addUpdateContent(res.pixelHtml, CardService.ContentType.IMMUTABLE_HTML).setUpdateType(CardService.UpdateDraftBodyType.IN_PLACE_INSERT)).build()`; on any non-2xx, return a card with the server's error text and insert **nothing** (a half-tracked draft is worse than an untracked one); remember `{token, subject, createdAt}` in user properties under `pending.<token>` |
| `addon/Linker.gs` | `linkSentMessages()` — for each pending token < 48 h old: `GmailApp.search('in:sent newer_than:2d subject:"…"')`, take the newest thread whose message body contains the token string, POST `/api/addon/link` with `{token, gmailMessageId, threadId, sentAt}`, delete the pending key; drop pending keys older than 48 h |
| `addon/README.md` | The install checklist (§6.6), scopes and what each is for, quota numbers, and the limitation table from §6.2 verbatim |

Scopes requested: `…/gmail.addons.execute`, `…/gmail.addons.current.action.compose`,
`…/script.external_request`, and — **only for `Linker.gs`** — `…/gmail.readonly` +
`…/script.scriptapp`. The README states plainly that `gmail.readonly` is a broad grant and that
`Linker.gs` is optional: without it, add-on-tracked messages stay unlinked (no reply detection, no
thread lookup) and are reaped after the timeout. Doing the polling inside the *user's* Apps Script
rather than server-side is deliberate: it keeps openpost's own Gmail OAuth scopes exactly as they
are today (metadata-only `threads.get`), instead of adding `gmail.readonly` to the server.

### 6.4 `POST /api/addon/track`

Bearer-gated by the existing `/api` auth hook; additionally `404` unless `ADDON_ENABLED=true`.

```jsonc
// request
{ "subject": "Q3 numbers", "to": ["a@x.com"], "cc": [], "bcc": [], "draftId": "r-123…" }
// response 200
{ "messageId": "…", "token": "…",
  "pixelUrl": "https://t.example.com/p/<signed>?c=<cb>",
  "pixelHtml": "<img src=\"https://t.example.com/p/…\" width=\"1\" height=\"1\" alt=\"\" style=\"display:none\">" }
```

Implementation (`src/server/services/addon.ts`, tested via `app.inject()`):

1. Validate: subject ≤ 512 chars, ≤ 100 addresses total, every address through `splitAddresses`'
   validator, `draftId` ≤ 128 chars of `[A-Za-z0-9_-]`.
2. Rate limit `ADDON_RATE_PER_HOUR` (default 120) keyed on the bearer token's sha256 prefix.
3. `ensureAccount` for `FROM_EMAIL` (or the default account), `createMessage` with
   `status:'draft'`, `recipient_mode:'single'`, `tracking_enabled:1`,
   `click_tracking_enabled:0`, `source:'addon'`, `addon_draft_id`.
4. One `addRecipient` per address (`is_aggregate:0`, own token, never embedded) plus exactly one
   aggregate row `email:'(all recipients)'`, `name:'<n> recipients'` — byte-for-byte the shape
   `send.ts:364–392` produces.
5. If **any** address is suppressed → the message is created with `tracking_enabled:0` and the
   response carries `pixelHtml: ""` plus `"suppressed": true`; doc 07 §3.4's all-or-nothing rule,
   applied identically (test 419).
6. `audit('addon.track')` with the message id and address count — never the addresses.

### 6.5 `POST /api/addon/link` and the reaper

```jsonc
{ "token": "…", "gmailMessageId": "18f…", "threadId": "18f…", "rfc822MessageId": "<x@y>", "sentAt": 1789… }
```

- Resolves the message by the **aggregate** recipient token; `404` if unknown, `409` if the message
  is not `source='addon'`.
- Stamps `provider_msg_id`/`thread_id`/`rfc822_msg_id`/`sent_at` on **every** row (aggregate
  included) via `markRecipientSent`, then `markMessageSent` — the same "single mode stamps one set
  of ids on every row" rule doc 07 §4.3 fixed.
- Idempotent: a repeat with identical ids is `200 {"linked": true, "changed": false}`; a repeat with
  a *different* `gmailMessageId` is `409` and audits `addon.link.conflict` (never silently rebinds a
  tracked message to another Gmail message).
- `sentAt` is clamped to `[created_at, now + 5 min]` — the client supplies it, so it is not trusted
  to reorder history or defeat the `R1` self-open window.
- `audit('addon.link')`.

`src/jobs/addon.ts` → `createAddonReaperJob({db, timeoutHours})`: every 15 min, add-on messages
still `status='draft'` and older than `ADDON_LINK_TIMEOUT_HOURS` (default 48) become
`status='abandoned'` with `error='addon: never linked to a sent message'`, audited once. The
dashboard message list gains `abandoned` to its status filter and renders it as a muted badge with
the tooltip *"drafted in Gmail, never confirmed sent"*. Fully tested with a fake clock; no network.

`GET /api/addon/config` returns `{version, trackingBaseUrl, linkPollMinutes, pixelTemplate}` so the
script carries no hard-coded knowledge but the base URL and its token.

### 6.6 Install checklist (in `addon/README.md`, operator-run)

0. `ADDON_ENABLED=true`, `API_TOKEN` set, instance reachable over HTTPS from Google's servers
   (`UrlFetchApp` calls come from Google, not from the phone — a loopback-only instance cannot work
   here, unlike the Chrome extension).
1. Create an Apps Script project, paste the four files, set the manifest, run `setup()` once,
   `Deploy → Test deployments → Install`.
2. **Open the Gmail app on your phone, start composing, and look for the add-on icon.** If there is
   none, stop: the compose surface is not available on your client, and §2's compose page is the
   supported path. Record the result (client, OS version, present/absent) in
   `docs/reports/phase5_smoke.md` — this is the one data point that resolves §6.1's open question.
3. On Gmail web: compose → add-on → *Track with openpost* → confirm a new row appears in
   `/dashboard/messages` within 2 s.
4. Send to yourself; in Gmail, `Show original`, and confirm the tracking host appears in the raw
   HTML. If it does not, Gmail stripped the pixel: report it and stop.
5. Wait one linker cycle; confirm the dashboard row flips from `draft` to `sent` with a thread id.
6. Open the mail from another device and confirm exactly one counted open (and that your own read
   is classified `self_open`, not a false positive).
7. Revoke the script's authorisation and confirm no further tracking rows are created.

---

## 7. Change list, migration, env, CLI, tests, acceptance

### 7.1 Per-file change list

**New files**

| Path | Contents |
|---|---|
| `src/core/webpush.ts` | RFC 8291/8292 on `node:crypto` (§4.2) |
| `src/core/addresses.ts` | `splitAddresses`, `isValidAddress`, header-injection guard (§2.3) |
| `src/db/push.ts` | `push_subscriptions` repo (§4.3) |
| `src/db/migrations/010_phase5.sql` | §7.2 |
| `src/mail/send-run.ts` | `runSend` — the pipeline extracted verbatim from `send.ts` (§2.3) |
| `src/notify/channels/webpush.ts` | the Web Push notifier (§4.6) |
| `src/notify/channels/email.ts` | the email-to-self notifier (§5.2) |
| `src/jobs/daily-digest.ts` | `createDailyDigestJob` (§5.3) |
| `src/jobs/addon.ts` | `createAddonReaperJob` (§6.5) |
| `src/server/services/addon.ts` | `addonTrack`, `addonLink` (§6.4–6.5) |
| `src/server/routes/compose.ts` | `GET /dashboard/compose`, `POST /dashboard/compose/send` |
| `src/server/views/pages/compose.ts` | the compose form (§2.2) |
| `src/server/views/pages/settings.ts` | push devices, install help, session info |
| `src/server/views/icons.ts` | inline SVG nav glyphs, `raw()` constants only |
| `src/server/assets/{sw.js, compose.js, manifest.webmanifest, offline.html}` | §2.5 |
| `src/server/assets/{icon-192.png, icon-512.png, icon-maskable-512.png, apple-touch-icon-180.png}` | generated + committed (§2.5) |
| `src/cli/commands/push.ts` | `push keys\|list\|test\|prune` (§7.4) |
| `scripts/gen-icons.mjs` | deterministic PNG generator, `node:zlib` only |
| `addon/{appsscript.json, Setup.gs, Code.gs, Linker.gs, README.md}` | §6.3 |
| `tests/helpers/fake-push.ts` | subscriber keypair + scripted push service (§4.7) |
| `tests/fixtures/webpush/rfc8291.json` | the RFC's §5 worked example, copied verbatim from the RFC text |
| `tests/fixtures/db/v9.sqlite` | binary fixture at schema 9 (produced by `scripts/make-migration-fixtures.mjs`) |
| `tests/e2e/mobile.spec.ts` | the 390×844 pass (tests 437–441) |
| `docs/mobile.md` | install-on-phone, push setup, offline behaviour, threat notes |

**Modified files**

| Path | Change |
|---|---|
| `src/db/index.ts` | `EXPECTED_SCHEMA = 10` |
| `src/db/repo.ts` | `createMessage` accepts `source`/`addonDraftId`; `listMessagesFiltered` accepts `status='abandoned'` and a `source` filter |
| `src/db/erase.ts` | **no change**; test 434 asserts `push_subscriptions` is deliberately untouched |
| `src/cli/commands/send.ts` | becomes option parsing + printing over `runSend` |
| `src/cli/commands/serve.ts` | register the `daily-digest` and `addon-reaper` jobs; pass `transportFactory` to `NotifyWorker` |
| `src/cli/commands/init.ts`, `src/cli/wizard.ts` | "Enable phone push notifications?" → generate and write `VAPID_*`; `renderEnvFile` emits them |
| `src/cli/commands/doctor.ts`, `src/core/doctor.ts` | checks `push.keys`, `push.subscriptions`, `push.secure_context`, `pwa.assets`, `addon.config` (§7.5) |
| `src/cli/program.ts` | register `push` |
| `src/config/env.ts` | everything in §7.3; `CHANNELS` += `webpush`,`email`; `TRIGGERS` += `daily_digest` |
| `src/core/html.ts` | `linkifyText`, `textToHtml` |
| `src/notify/types.ts` | `ChannelName` += `'webpush' \| 'email'`; `NotifyTrigger` += `'daily_digest'`; `FetchLike.body?: string \| Uint8Array`; `NotifierDeps.transport?`; `NotificationPayload.digest?` |
| `src/notify/policy.ts` | `dedupeKey` arm for `daily_digest` |
| `src/notify/channels/index.ts` | register both notifiers |
| `src/notify/channels/util.ts` | `TRIGGER_LABEL`/`summaryLine`/`contextLine` for `daily_digest`; `redactSecretUrls` scrubs push endpoints |
| `src/notify/worker.ts` | `transportFactory`; pass `transport` into `NotifierDeps` |
| `src/server/app.ts` | register compose/settings/push-action routes; pass the reaper job |
| `src/server/routes/api.ts` | `POST /addon/track`, `POST /addon/link`, `GET /addon/config` |
| `src/server/routes/dashboard.ts` | CSP += `manifest-src`/`worker-src`; new `FLASH_MESSAGES`; `GET /settings` |
| `src/server/routes/dashboard-actions.ts` | `push-subscribe`, `push-unsubscribe` |
| `src/server/routes/dashboard-assets.ts` | per-asset `Cache-Control`; `Service-Worker-Allowed` on `sw.js` |
| `src/server/assets/index.ts` | new `ASSET_NAMES`, `.png`/`.webmanifest`/`.html` content types, per-asset cache policy, icon sha256 constants |
| `src/server/assets/app.css` | the whole of §3 |
| `src/server/assets/app.js` | SW registration, push subscribe/unsubscribe, `data-csrf` read, compose-page bootstrap |
| `src/server/views/layout.ts` | manifest/theme/apple-touch links, `data-csrf`, `?v=` on assets, `NavKey` += `compose`/`settings`, bottom-nav markup |
| `src/server/views/fragments.ts`, `views/pages/*.ts` | `data-label` on every `<td>`, `.table-wrap` wrappers, `<details>` filter forms |
| `src/server/routes/stream.ts` | `ALL_TRIGGERS` += `daily_digest` |
| `playwright.config.ts` | second project `mobile` (`devices['Pixel 5']`, `hasTouch`, 390×844) |
| `README.md`, `docs/dashboard.md`, `docs/notifications.md`, `docs/deploy.md`, `docs/03_roadmap.md`, `docs/extension.md` | mobile section, two new channels, PWA/HTTPS requirement, the add-on's experimental status |

### 7.2 Migration `src/db/migrations/010_phase5.sql` (schema_version = 10)

```sql
-- 010_phase5.sql (schema_version = 10)
--
-- docs/09_phase5_spec.md. Mobile: Web Push subscriptions, a provenance column on messages, and the
-- Gmail add-on's draft back-reference. Every statement is a CREATE or an ADD COLUMN with a default,
-- so a populated v9 database upgrades with zero row loss and no table rebuild.

-- ---------- Web Push subscriptions (§4.3) ---------------------------------
-- These rows describe the OPERATOR's own devices, never a recipient: `openpost forget` deliberately
-- does not touch this table (test 434 asserts that, so the omission reads as a decision).
CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  label           TEXT,
  ua_family       TEXT,
  device_type     TEXT,
  created_at      INTEGER NOT NULL,
  last_ok_at      INTEGER,
  last_error      TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  disabled_at     INTEGER,
  disabled_reason TEXT                      -- gone_404 | gone_410 | manual | expired
);
CREATE INDEX idx_push_subs_active ON push_subscriptions(disabled_at) WHERE disabled_at IS NULL;

-- ---------- message provenance (§2, §6) -----------------------------------
-- cli | campaign | dashboard | addon.  Existing rows are 'cli' (or 'campaign' where campaign_id is
-- set), which is exactly what they were.
ALTER TABLE messages ADD COLUMN source         TEXT NOT NULL DEFAULT 'cli';
ALTER TABLE messages ADD COLUMN addon_draft_id TEXT;
UPDATE messages SET source = 'campaign' WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_messages_source ON messages(source, created_at DESC);
```

No change to `notifications` (the two new channels are values in an existing `TEXT` column), none to
`recipients`, none to `audit_log`.

### 7.3 Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `COMPOSE_ENABLED` | `true` | serve `/dashboard/compose` and the nav item |
| `COMPOSE_MAX_RECIPIENTS` | `25` | above this, the error names `openpost campaign` |
| `COMPOSE_MAX_BODY_BYTES` | `262144` | route-level Fastify `bodyLimit` |
| `COMPOSE_RATE_PER_HOUR` | `20` | per session (or per IP hash in `open` mode) |
| `PWA_ENABLED` | `true` | emit the manifest/SW links; assets are always served |
| `VAPID_PUBLIC_KEY` | — | base64url, 65 bytes; required iff `webpush` is enabled |
| `VAPID_PRIVATE_KEY` | — | base64url, 32 bytes; must match the public key |
| `VAPID_SUBJECT` | `mailto:${FROM_EMAIL}` | JWT `sub`; must be `mailto:` or `https:` |
| `PUSH_TTL_SECONDS` | `3600` | `TTL` header |
| `PUSH_URGENCY` | `normal` | overridden to `high` for `read_confirmed`/`reply` |
| `PUSH_MAX_SUBSCRIPTIONS` | `10` | subscribe returns `409` above it |
| `PUSH_MAX_FAILURES` | `10` | consecutive failures before a subscription is disabled |
| `NOTIFY_EMAIL_TO` | `FROM_EMAIL` | the email channel's recipient |
| `NOTIFY_EMAIL_FROM` | `FROM_EMAIL` | envelope/header From for notification mail |
| `DIGEST_DAILY_AT` | — (off) | `HH:MM` local; enables the daily digest |
| `DIGEST_TIMEZONE` | `REPORT_TIMEZONE` | IANA zone, validated by `isValidTimeZone` |
| `ADDON_ENABLED` | `false` | `/api/addon/*` are `404` when off |
| `ADDON_RATE_PER_HOUR` | `120` | per bearer |
| `ADDON_LINK_TIMEOUT_HOURS` | `48` | unlinked add-on drafts become `abandoned` |

Validation rules with their own test: `webpush` in `NOTIFY_CHANNELS` without a valid key pair →
`ConfigError` naming `openpost push keys`; keys that do not agree → `ConfigError`;
`VAPID_SUBJECT` with a bad scheme → `ConfigError`; `DIGEST_DAILY_AT` not `HH:MM` → `ConfigError`;
`ADDON_ENABLED=true` without `API_TOKEN` → `ConfigError` (never an unauthenticated token-minting
endpoint — the same rule `API_CORS_ORIGINS` already follows).

### 7.4 CLI

```
openpost push keys [--json] [--write-env]     # generate a VAPID pair; --write-env appends to .env (0600, backed up)
openpost push list [--json]                   # devices, state, last OK, failure count
openpost push test [--id <id>] [--trigger read_confirmed]   # enqueue a synthetic notification to one/all devices
openpost push prune [--disabled-only] [--yes] # delete disabled subscriptions
openpost notify test --channel webpush|email  # existing command, two new channel values
```

`openpost init` gains a wizard step ("Send notifications to your phone? [y/N]") that generates the
pair and writes `NOTIFY_CHANNELS=webpush`.

### 7.5 New `doctor` checks

| id | pass / warn / fail |
|---|---|
| `push.keys` | pass when both keys decode to the right lengths and agree; fail when `webpush` is enabled and they do not; skip when the channel is off |
| `push.secure_context` | pass on `https:` or loopback; **warn** otherwise ("browsers refuse to register a service worker outside a secure context") |
| `push.subscriptions` | pass with ≥ 1 active; **warn** at 0 with `webpush` enabled ("no device has subscribed yet — open /dashboard/settings on your phone") |
| `pwa.assets` | fail when any of `sw.js`, `manifest.webmanifest` or the four icons is missing or its sha256 differs from the recorded constant |
| `addon.config` | fail when `ADDON_ENABLED=true` with no `API_TOKEN`, or with a loopback `TRACKING_BASE_URL` ("Google's servers, not your phone, make the UrlFetchApp call") |

### 7.6 Test cases (vitest, 360–436; Playwright, 437–441)

**Compose + pipeline extraction (360–373)** — 360 `runSend` produces byte-identical `.eml`/`.html`
artefacts to the pre-extraction CLI for a fixed clock/id seed (golden-file regression on the
refactor); 361 the CLI `send --json` output shape is unchanged; 362 `GET /dashboard/compose` renders
with CSRF and 200; 363 a valid POST creates one message + N recipients and 303s to the detail page;
364 per-recipient mode over `dryrun` writes one artefact per addressee; 365 `MAIL_TRANSPORT=gmail` +
2 recipients renders the loud refusal as a form error, not a 500; 366 cross-origin POST → 403;
367 missing/incorrect `_csrf` → 403; 368 body over the limit → 413; 369 the 21st send in an hour →
429; 370 26 recipients → 400 naming `campaign`; 371 an address containing `\r\n` is rejected
(header injection); 372 `linkifyText` table (20 cases incl. trailing punctuation, existing markup,
tracking-host URLs); 373 `textToHtml` output round-trips through `collectLinks`/`rewriteLinks` so
click tracking actually applies to a linkified body.

**PWA assets (374–381)** — 374 manifest is valid JSON with the required keys and `scope`/`start_url`
inside `/dashboard/`; 375 `sw.js` is served `no-cache` with `Service-Worker-Allowed: /dashboard/`;
376 icons/manifest/offline page are served without any CSP header and without auth; 377 the
dashboard CSP contains `manifest-src 'self'` and `worker-src 'self'` and no `unsafe-inline`;
378 an unknown asset name is still 404 with no filesystem access; 379 `?v=` is ignored by the asset
route but present in `layout` output; 380 `gen-icons.mjs` re-run in memory is byte-identical to the
committed PNGs and matches the recorded sha256; 381 `offline.html` contains no script and no
data.

**Responsive rendering (382–388)** — server-side assertions on rendered HTML: 382 every `<td>`
emitted by `fragments.ts` carries a non-empty `data-label`; 383 every table is inside
`.table-wrap`; 384 the bottom nav lists exactly the six `NavKey`s and marks the active one with
`aria-current`; 385 `thead` is visually hidden, not `display:none`, at the phone breakpoint (CSS
text assertion); 386 the filter form renders `<details open>` when a filter is active and closed
otherwise; 387 every page module still renders identically above the breakpoint (golden snapshots
unchanged for the desktop layout); 388 no page emits an inline `style=` or `<script>` without
`src`.

**Web Push crypto (389–396)** — 389 `generateVapidKeys` round-trips through
`vapidPublicKeyFromPrivate`; 390 the JWT header/payload decode correctly, `aud` is the endpoint
origin, `exp` ≤ 24 h, and the signature verifies with `crypto.verify` + `ieee-p1363`;
391 `encryptPush` against the **RFC 8291 §5 vector** (fixed salt and keys) produces the RFC's exact
body; 392 encrypt → `decryptPush` with an independently generated subscriber keypair round-trips a
3 KiB payload; 393 the body framing is `salt(16) || rs=4096 || idlen=0x41 || 65-byte point || ct`;
394 a plaintext over `MAX_PUSH_PLAINTEXT` throws `PushPayloadTooLargeError`; 395 a tampered
ciphertext byte fails to decrypt (GCM tag); 396 two encryptions of the same plaintext differ (fresh
salt and ephemeral key).

**Web Push channel (397–406)** — 397 a `410` disables exactly that subscription and leaves the other
active; 398 with 3 devices where one is `410` and two succeed, the row is `sent` and the next
notification posts to exactly 2 endpoints; 399 a `429 Retry-After: 30` marks the row retryable with
a 30 s delay; 400 a `413` dead-letters non-retryably and audits `push.too_large`; 401 no endpoint
URL ever appears in `notifications.last_error` (grep assertion); 402 the payload honours
`NOTIFY_REDACT_EMAIL`/`NOTIFY_INCLUDE_SUBJECT` and a `single`-mode event renders the
`messageLevelPhrase` wording; 403 `url` is always a `/dashboard/`-prefixed path; 404 zero active
subscriptions → row `sent`, zero fetches, no dead letter; 405 subscribe validation rejects a
non-HTTPS endpoint, a short `p256dh`, a wrong-length `auth` and an over-long endpoint;
406 `PUSH_MAX_SUBSCRIPTIONS` → 409.

**Email channel + digest (407–414)** — 407 one counted open writes one `.eml` to `OUT_DIR` addressed
to `NOTIFY_EMAIL_TO`; 408 that `.eml` contains no `<img` from the tracking host and creates no
`messages` row; 409 `Auto-Submitted`/`X-Openpost-Notification` headers are present; 410 no
`NOTIFY_EMAIL_TO`/`FROM_EMAIL` → non-retryable failure naming the variable; 411 the real reply
detector ignores a notification email in the same thread; 412 a transport throw is retryable and
backs off; 413 `stream.ts`'s `ALL_TRIGGERS` contains every member of `NotifyTrigger` (a reflection
test that cannot be forgotten next time); 414 the daily digest fires once per local day, dedupes
across a restart, and names counts only.

**Add-on server half (415–426)** — 415 `/api/addon/*` are 404 with `ADDON_ENABLED=false`;
416 401 without the bearer; 417 `track` creates addressee rows + exactly one aggregate row and
returns a pixel URL whose token resolves to that aggregate row; 418 `pixelHtml` is well-formed and
contains no quote-escaping bug (parsed with cheerio); 419 one suppressed addressee → whole message
untracked, `suppressed:true`, empty `pixelHtml`; 420 `link` stamps ids on every row and flips the
status; 421 an identical re-link is a 200 no-op; 422 a conflicting re-link is 409 and audited;
423 a `sentAt` in the far future/past is clamped; 424 the reaper marks only unlinked add-on drafts
older than the timeout and audits once; 425 a source-text guard over `addon/*.gs`: the scripts POST
only to the two documented paths, never `Logger.log` the token, and never call `drafts.send`;
426 the rate limiter returns 429 above `ADDON_RATE_PER_HOUR`.

**Config, migration, CLI, doctor (427–436)** — 427 fixture DBs v1–v9 → 10 with zero row loss and an
empty `foreign_key_check`; 428 `/healthz` reports 10; 429 a v10 DB opened by a v9 binary fails
loudly (existing rule, re-asserted); 430 every new env var parses with its default and rejects its
bad values; 431 `webpush` without keys is a `ConfigError` naming the CLI remedy; 432 `ADDON_ENABLED`
without `API_TOKEN` is a `ConfigError`; 433 `openpost push keys --json` prints a usable pair and
never the private key in human mode; 434 `openpost forget` leaves `push_subscriptions` untouched
(deliberate); 435 `openpost prune` deletes subscriptions disabled beyond `RETENTION_DAYS`;
436 the five new `doctor` checks pass/warn/fail as specified with `--offline`.

**Playwright, `mobile` project at 390×844 (437–441)** — 437 the four-tap compose DoD; 438 the
no-horizontal-scroll + 44 px-target sweep over ten pages, with screenshots to
`docs/reports/screenshots/mobile-*.png`; 439 the SW registers with scope `/dashboard/` and the
manifest parses in-browser; 440 offline navigation renders the offline page and Cache Storage holds
no `text/html` beyond it; 441 zero CSP console violations across the whole mobile sweep. The
existing desktop project and `tests/e2e/dashboard.spec.ts` are unchanged, and the "fail loudly when
Chromium is missing" guard is copied verbatim into the new spec.

### 7.7 Acceptance

1. `npm ci && npm run build && npm test` green offline, no `.env`, no credentials, no browser;
   cases 360–436 present.
2. `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers npm run test:e2e` green for **both** projects; the
   five mobile screenshots are refreshed in `docs/reports/screenshots/`.
3. `npm run lint` and `npm run format` clean; `tsc` strict with no new `any`, no new `!` on a
   database read.
4. `git diff --stat package.json` shows **no** change to `dependencies` or `devDependencies`.
5. `openpost doctor --offline` returns no `fail` on a fresh `openpost init --yes` tree with
   `NOTIFY_CHANNELS=webpush` and generated keys.
6. `docs/reports/phase5_smoke.md` exists, recording: a real phone install (browser, OS), a real push
   notification screenshot, a real tracked send composed on the phone, and §6.6 step 2's answer
   (does the Gmail mobile compose surface show add-ons — yes/no/which client). Items requiring a
   real phone, a real push service and a real Gmail add-on install are operator-run and listed as
   such, exactly as `docs/reports/phase4_smoke.md` lists its Docker step.

---

## 8. Mailtrack parity scorecard: updated and new rows

| Feature | Mailtrack free | Mailtrack paid | openpost after Phase 5 | Verdict |
|---|---|---|---|---|
| Real-time notification of a read | desktop (extension) | + mobile push, email alerts | Slack, Discord, signed webhook, ntfy, SSE, **Web Push to the phone (VAPID, self-hosted, no third party)**, **email-to-self**, optional daily digest | **parity**, ahead on privacy (no vendor sees the alert) and on `prefetched` suppression; still behind on "works the second you install it" |
| Mobile app | yes (native) | yes (native) | **installable PWA**: dashboard, message detail, stats, campaigns, reminders, **compose and send a fully tracked mail from the phone**, push, offline fallback | **near parity**; behind on native-app polish, app-store distribution and background sync; ahead on per-recipient attribution and click tracking from the phone |
| Dashboard | in-Gmail + hosted reports | hosted web dashboard | local server-rendered dashboard, **mobile-first at ≤480 px, 44 px targets, bottom nav, no horizontal scroll on any page** | **parity** on "works from any device", still ahead on privacy |
| In-Gmail UI (checkmarks, compose integration) | yes | yes | no extension; server contract shipped since Phase 4; **an experimental, operator-installed Gmail add-on** that stamps a message-level pixel into a compose draft — desktop-verified path, mobile compose surface unverified and possibly absent | **behind** (unchanged verdict; the add-on narrows it only if the surface exists) |
| Compose a tracked mail on a phone | yes (in Gmail) | yes | yes — **in openpost**, not in Gmail: four taps, full per-recipient tracking, click tracking, CC/BCC semantics | parity on outcome, **behind on habit**: you compose in openpost, not in the app you already use |
| Zero-config notification surface | desktop alerts + daily report, no setup | + mobile push | email-to-self needs only an already-configured transport; Web Push needs one `openpost push keys` + one tap | **near parity** (was: behind, decisively) |
| Works offline | n/a (SaaS) | n/a | installed PWA shows an honest offline page; **no recipient data is ever cached on the device** | ahead on the privacy trade-off, behind on offline usefulness — deliberately |
| Onboarding effort | install extension, click Allow | same | unchanged: Node, build, `init`, **a public HTTPS hostname** (now doubly required — service workers and push both demand a secure context), transport choice, doctor | **behind, decisively** (unchanged) |
| Attachment / PDF view tracking | no | yes | none | behind (unchanged) |
| Scheduled sending | no | yes | none | behind (unchanged) |

---

## 9. Decision summary

1. **The phone gets a first-class openpost, not a shim inside Gmail.** §2–§5 are deterministic,
   offline-testable and entirely under our control; §6 is not.
2. **Compose lives on the dashboard** (`/dashboard/compose`), reusing the real send pipeline via a
   verbatim `runSend` extraction from `send.ts` — full per-recipient tracking, click tracking and
   CC/BCC semantics, not a reduced mobile mode.
3. **Plain-text in, generated HTML out**: no contenteditable sanitiser, no editor dependency, and
   `linkifyText` still yields real `<a href>` for click tracking.
4. **Web Push is hand-rolled** on `node:crypto` (RFC 8291/8292), validated against the RFC's own
   test vector and a local encrypt→decrypt round trip: **zero new runtime dependencies**, versus one
   direct plus transitives for `web-push`.
5. **Push payloads carry a path, never a URL**, and the service worker re-validates it — the
   notification-click surface cannot become an open redirect.
6. **The service worker caches assets only.** No authenticated HTML ever reaches device storage;
   offline degrades to an honest offline page. This is a DoD item, not a footnote.
7. **Email-to-self is the zero-config channel** Mailtrack's free tier has and openpost lacked; it
   carries `Auto-Submitted` so reply detection can never mistake it for a recipient's reply.
8. **The Gmail add-on ships as source under `addon/`, disabled by default**, with its server half
   (`/api/addon/track|link`, the reaper) fully tested with fakes. Its tracking is message-level and
   pixel-only: the API inserts content, it cannot rewrite a body, so click tracking is impossible,
   and there is no on-send trigger, so linking is polled by the user's own Apps Script rather than by
   widening openpost's Gmail scopes.
9. **The load-bearing unknown is stated, not buried**: whether the Gmail *mobile* apps expose an
   add-on compose surface at all could not be verified here (egress to `developers.google.com` is
   blocked), and the balance of evidence says probably not. Step 2 of the install checklist exists to
   answer it in one minute, and §2 is the supported path either way.
10. **Budget: schema 10, one migration, zero new dependencies, ~82 new test cases (360–441), CSP
    unchanged except two additive directives.** The daily digest (§5.3) is the one item to cut first
    if the phase runs long.

---

## 10. Phase 5.1 amendments (post-review hardening)

An independent review (`docs/reports/phase5_review.md`, commits e122413..d68ca0e) found 15 issues
in the phase, none in the cryptographic core (RFC 8291/8292 was verified byte-for-byte against the
RFC's own §5 worked example, and the "recalled from memory" caveat on that vector has since been
removed from `src/core/webpush.ts` as unwarranted). All 15 are fixed, each with a regression test.
No env var, CLI flag, or on-wire JSON shape changed except where noted below (backward compatible).

1. **Compose transport display could disagree with the transport actually used.** The compose route
   now resolves the effective transport once, via `resolveAccount(...).transport` for the selected
   account (falling back to `config.mailTransport` when no account applies) — the same resolution
   `runSend` performs — and renders that value. It also passes that same transport explicitly into
   `runSend`, so the send is guaranteed to go out over exactly what the page displayed.
   (`src/server/routes/compose.ts`, `tests/integration/compose.test.ts`)
2. **`PUSH_MAX_SUBSCRIPTIONS` was bypassable via a bare `oldEndpoint` field.** A request now counts
   as a replacement only when `oldEndpoint` resolves to an existing row; the cap is re-checked after
   the old row is deleted, so a genuine replacement (net row count unchanged) never trips it, and a
   sham `oldEndpoint` no longer bypasses it. (`src/server/routes/dashboard-actions.ts`,
   `tests/integration/push-actions.test.ts`)
3. **The service worker's own re-subscribe POST could never pass CSRF.** `sw.js` now reads the
   non-`HttpOnly` `openpost_csrf` cookie via the Cookie Store API where available, falling back to
   asking an open client page for it over a `MessageChannel`, and sends it as `X-Openpost-CSRF`.
   (`src/server/assets/sw.js`, `src/server/assets/app.js`, `tests/integration/push-actions.test.ts`)
4. **Push subscription endpoints skipped the project's own SSRF policy.** `isValidPushEndpoint` now
   applies `isPrivateOrLoopbackHost` to `https:` endpoints (and the `http:` loopback carve-out is now
   gated behind `NOTIFY_ALLOW_PRIVATE_URLS`, same as every other notify URL), exported for direct
   unit testing. (`src/server/routes/dashboard-actions.ts`, `src/config/env.ts`)
5. **Web Push delivery had no per-endpoint timeout.** Each subscription's `fetch` is now wrapped in
   an `AbortController` timer set to `deps.timeoutMs`, mirroring `deliverHttp`; an abort is
   classified retryable like any other network throw. (`src/notify/channels/webpush.ts`)
6. **The Gmail add-on's sent-mail linker could bind to a forward/reply instead of the original
   send.** `findSentMessageForToken_` now walks messages oldest-first and requires the token to
   appear inside the pixel's own `<img src=…>` markup, not merely anywhere in the body (so a quoted
   forward carrying the same pixel is skipped in favour of the original). (`addon/Linker.gs`,
   `tests/unit/addon-linker-logic.test.ts` — runs the real `.gs` source under Node's `vm` module.)
7. **`send --json` gained a new `"selfCopy":null` key.** Restored the pre-refactor shape: the key is
   included only when a self-copy actually ran. (`src/cli/commands/send.ts`)
8. **`label`/`uaFamily`/`deviceType` were stored unbounded and untyped.** Each is now coerced to a
   string and truncated to 200 characters, or `null` for a non-string. (`src/server/routes/dashboard-actions.ts`)
9. **`PUSH_ENDPOINT_RE`/`redactPushEndpoint` comments overstated their coverage.** The regex backstop
   now matches any `https://` URL (not just `/fcm/send`, `/wp/`, `/push/` paths), and
   `redactPushEndpoint` applies the exact-endpoint split first, then that broadened backstop.
   (`src/notify/channels/util.ts`)
10. **A vacuous unit test asserted `URL`/`Buffer` trivia instead of project code.** Replaced with a
    real `isValidPushEndpoint` test; the 402/403 payload test now also asserts the recipient address
    is redacted under `notifyRedactEmail: true`. (`tests/unit/notify-webpush-channel.test.ts`)
11. **The service worker's asset cache never invalidated and never actually cached anything.**
    `CACHE_VERSION` is now derived from the release `VERSION` at asset-load time (a placeholder
    substitution, no build step); the fetch handler opens that versioned cache, matches with
    `ignoreSearch: true` (so the page's own `?v=` query still hits the precached entry), and writes a
    genuine cache miss into the cache. (`src/server/assets/sw.js`, `src/server/assets/index.ts`)
12. **Compose drafts persisted in `localStorage` across logout**, contradicting the offline page's
    "nothing is cached" claim. The draft is now cleared on logout and only after a successful send
    (keyed off the compose route's own `?flash=sent`/`sent_partial` redirect target, since a 400
    re-renders the same page with no flash param); the offline page names the compose draft as the
    one deliberate exception. (`src/server/assets/app.js`, `src/server/assets/compose.js`,
    `src/server/assets/offline.html`)
13. **The email digest channel linked to `/dashboard/messages/` with an empty message id.** It now
    mirrors the webpush channel's `isDigest` branch and links to the message list.
    (`src/notify/channels/email.ts`)
14. **`PUSH_URGENCY` was unvalidated.** `loadConfig` now rejects any value other than
    `very-low|low|normal|high` (RFC 8030), matching the treatment already given `NOTIFY_CHANNELS`.
    (`src/config/env.ts`)
15. **`runSend` could silently disagree with itself when both `input.transport` and
    `fromAccountRef` were set** (the recorded/returned transport name came from the input, the actual
    `Transport` object was forced from the account). `runSend` now throws if the two disagree.
    (`src/mail/send-run.ts`)

Re-run smoke steps are recorded in `docs/reports/phase5_smoke.md` under "Phase 5.1 re-run".
