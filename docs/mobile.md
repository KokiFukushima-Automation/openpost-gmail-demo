# Mobile (Phase 5)

openpost's dashboard is installable as a PWA and can compose and send a fully tracked email from a
phone, entirely on its own - no Gmail UI involved. This document is the operator-facing half of
`docs/09_phase5_spec.md`; see that spec for the full design rationale and test list.

## Install on a phone

1. Serve the dashboard over HTTPS (or loopback, for local testing - see docs/deploy.md's "Mobile:
   HTTPS is doubly required"). A service worker and Web Push both refuse to register outside a
   secure context.
2. Open `https://your-host/dashboard` on the phone and log in once.
3. **Android/Chrome**: browser menu → "Add to Home screen" / "Install app".
   **iPhone/iPad (Safari)**: Share → "Add to Home Screen". Push notifications on iOS only work once
   the app is opened from the Home Screen icon, not from Safari itself.
4. Consider raising `DASHBOARD_SESSION_HOURS` (e.g. `720`) - an installed PWA has its own cookie
   jar, so you log in once inside it, and the default 12h session is a poor fit for something you
   open once and leave installed.

## Compose from a phone

`/dashboard/compose` - reachable from the bottom nav bar - sends through the exact same pipeline as
`openpost send` (`src/mail/send-run.ts`'s `runSend`, extracted verbatim from the CLI): full
per-recipient tracking, click tracking, suppression handling, and self-copy back-fill. The body is
plain text; openpost generates the HTML (escape → linkify bare URLs into `<a href>` → paragraph
wrapping) rather than shipping a WYSIWYG editor, so click tracking still works on every link you
type. Cc/Bcc are collapsed behind a `<details>` disclosure. There is no attachment support and no
scheduled sending (see the spec's "explicitly out of scope" list).

Limits (all overridable in `.env`): `COMPOSE_MAX_RECIPIENTS` (25), `COMPOSE_MAX_BODY_BYTES`
(256 KiB, enforced as a hard `413` at the Fastify route level), `COMPOSE_RATE_PER_HOUR` (20, per
session or per hashed IP in loopback "open" mode). `COMPOSE_ENABLED=false` removes the page and the
nav item entirely.

A draft autosaves to `localStorage` (never to the server - a phone draft is unsent, unencrypted
content the operator hasn't chosen to store) and is offered back if you leave and return within
7 days.

### Share into openpost

Android/Chrome: sharing a link or text from another app offers openpost as a target (the manifest's
`share_target`, a `GET`). iOS does not support share targets at all - this is a documented Android/
Chrome-only convenience, not a cross-platform feature.

## Push notifications

`/dashboard/settings` → "Enable on this device" walks through
`Notification.requestPermission()` → `pushManager.subscribe()` → registering the subscription with
the server. Setup:

```bash
openpost push keys --write-env      # generates a VAPID pair, appends VAPID_* to .env
# then set:
NOTIFY_CHANNELS=webpush
```

(`openpost init`'s wizard asks "Send notifications to your phone via Web Push?" and does this for
you.) Every subscribed device gets a push within seconds of a counted open, click, reply or fired
reminder - encrypted end to end (RFC 8291) straight to the browser's own push service, with no
relay of openpost's own in the loop and no third party ever seeing the plaintext. A push payload
carries a `/dashboard/...` **path**, never a full URL - tapping the notification opens exactly that
page, and the service worker refuses to navigate anywhere that doesn't start with `/dashboard/`.

A device that starts rejecting pushes (uninstalled app, revoked permission, expired subscription -
HTTP 404/410 from the push service) is disabled automatically and never retried; manage devices
(and remove stale ones) from `/dashboard/settings`, or via `openpost push list` / `openpost push
prune --yes`.

`openpost push keys --json` prints the full generated pair for scripting; the plain human-readable
form never prints the private key to the terminal.

## Zero-config alternative: email-to-self

If you'd rather not stand up Web Push at all, set:

```bash
NOTIFY_CHANNELS=email
NOTIFY_ON=read_confirmed,reply       # recommended - otherwise expect one email per prefetch
```

Every openpost install already has a working mail transport, so this needs no new keys. The
notification email carries `Auto-Submitted: auto-generated`, so it can never be mistaken for a real
reply by the reply-detection job, and it is built directly (never through the tracked-send
pipeline), so it structurally cannot itself become a tracked message.

Set `DIGEST_DAILY_AT=08:00` (and optionally `DIGEST_TIMEZONE`) for a once-a-day summary instead of -
or alongside - per-event notifications.

## Responsive design

Below 860px the header nav is replaced by a fixed bottom bar (Messages / Compose / Campaigns /
Reminders / Stats / More); below 480px every table becomes a card list and every input/button/link
gets at least a 44×44 CSS px touch target. Nothing above 860px changes. `openpost doctor`'s
`pwa.assets` check verifies the four generated icons haven't drifted from what
`scripts/gen-icons.mjs` deterministically produces.

## Offline behaviour

The service worker (`/dashboard/assets/sw.js`) caches **only** static assets (CSS/JS/icons/the
offline page itself) - cache-first. Every authenticated page navigation is network-only; if it
fails, you see an honest offline page, never a stale cached copy of a message list. **No recipient
data is ever written to on-device storage.** This is a deliberate trade-off: openpost's whole pitch
is that recipient data stays under the operator's control, even at the cost of a less capable
offline mode than a native app would have.

## The Gmail add-on (experimental, out of the box off)

`addon/` ships an alternative, **experimental** path: a Google Workspace add-on that stamps a
tracking pixel into a draft you compose inside Gmail itself, rather than in openpost. It is source
only (never executed by this repository's tests or CI), disabled by default
(`ADDON_ENABLED=false`), and its one open question - whether the compose card it needs even appears
in the Gmail *mobile* apps - could not be verified in the environment this was built in. See
`addon/README.md` for the full install checklist, the scopes it requests and why, and the
limitation table (message-level tracking only, no click tracking, no on-send hook). If your Gmail
client doesn't show the compose card, `/dashboard/compose` (above) is the supported path either
way.

## Doctor checks

`openpost doctor` gained five Phase 5 checks: `push.keys` (VAPID keys present and matching when
`webpush` is enabled), `push.secure_context` (warns off a non-HTTPS, non-loopback
`TRACKING_BASE_URL`), `push.subscriptions` (warns at zero registered devices), `pwa.assets` (the
four icons' sha256 against `scripts/gen-icons.mjs`'s deterministic output), and `addon.config`
(`ADDON_ENABLED=true` needs `API_TOKEN` and a non-loopback `TRACKING_BASE_URL` - Google's servers,
not your phone, make the add-on's `UrlFetchApp` calls).

## What's still missing

Attachments, a rich-text editor, server-side draft storage, native Android/iOS apps, a `POST` Web
Share Target, scheduled sending, and any hosted push relay of openpost's own - all deliberately out
of scope for this phase (see `docs/09_phase5_spec.md` §1's "explicitly out of scope" list).
