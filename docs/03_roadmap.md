# 03 — Roadmap

Four phases. Each phase is independently useful and shippable, and each has a binary
Definition of Done. Phase 1 is fully specified in `04_phase1_spec.md`.

---

## Phase 1 — Foundation (tracking server + SQLite + CLI send + local verification)

**Scope**

- TypeScript project skeleton, strict mode, vitest, ESLint/Prettier, `openpost` bin.
- SQLite schema v1 + migration runner (`user_version`), WAL, foreign keys.
- `core/token.ts` — HMAC-signed opaque tokens with purpose separation and rotation support.
- `core/html.ts` — pixel injection + `htmlToText`; link rewriting implemented but **off by default**.
- `core/classify.ts` — full rule table R0–R9 (§5 of doc 02).
- `core/privacy.ts` — daily-salted IP hashing, three privacy modes.
- Fastify server: `GET|HEAD /o/:token.gif`, `GET /c/:token`, `GET /u/:token`, `GET /healthz`,
  `GET /api/messages`, `GET /api/messages/:id`.
- Transports: **DryRun** (mandatory), **SMTP** (app password), **Gmail API** (OAuth2, `gmail.send` +
  `gmail.readonly`).
- CLI: `init`, `migrate`, `serve`, `send` (with `--dry-run`), `list`, `show`, `prune`.
- Tests: unit + integration, all green with **zero credentials and no network**.
- `scripts/curl-smoke.sh` + documented manual curl steps.

**Out of scope:** notifications, dashboard UI, reminders, mail merge, public exposure.

**Definition of Done**

1. `npm ci && npm run build && npm test` passes on a clean container with no `.env` secrets and no
   network access; coverage of `src/core/**` ≥ 90 % lines.
2. `openpost init` creates `data/openpost.db` at schema version 1 and prints the generated
   `TRACKING_SECRET` guidance; running it twice is idempotent.
3. `openpost send --to a@example.com --subject X --html-file body.html --dry-run` writes
   `out/<message-id>.html` and `out/<message-id>.eml`, inserts `messages` + `recipients` rows with
   `status='dryrun'`, and the written HTML contains exactly one pixel `<img>` whose token verifies.
4. `openpost serve` starts on `127.0.0.1:8787`; `curl -I http://127.0.0.1:8787/healthz` → 200 JSON.
5. `curl -s -o /dev/null -D - "<pixel url from the dry-run html>"` → `200`, `Content-Type: image/gif`,
   `Content-Length: 43`, `Cache-Control: no-store…`; a second identical request within 30 s is stored
   as `duplicate`; `openpost show <message-id>` reflects both events with classifications.
6. A request made within `OPEN_IGNORE_SECONDS` of `sent_at` is recorded with `counted=0`; a request
   with the `GoogleImageProxy` UA after the window is `human` with `device_type='proxy'`.
7. A tampered token (one character changed) returns `200` + GIF, stores **no** event, and appends a
   `token.reject` row to `audit_log`.
8. SMTP and Gmail transports are exercised by tests against injected fakes; the real paths are
   documented in the README but not required to run for CI.

---

## Phase 2 — Real-time notifications, click tracking, accuracy hardening

**Scope**

- Click tracking on by default: `links` + click tokens + `/c/:token`, click→open back-fill.
- Notifier pipeline with retry/backoff and the `notifications` table: generic **webhook** (signed
  with `X-Openpost-Signature: sha256=…`), **Slack** (incoming webhook + Block Kit), **Discord**,
  **ntfy/Gotify**, and **SSE** at `/api/events/stream`.
- Notification policy: notify only on `read_confirmed` / first counted open (configurable), never on
  machine classifications; per-message mute; daily digest option.
- `SELF_OPEN_STRATEGY=insert` — untracked Sent copy via `users.messages.insert`.
- Apple relay + datacentre CIDR lists shipped and refreshable (`openpost update-ranges`).
- `POST /api/.../reclassify` manual override + audit entry.
- Public exposure documented and scripted: **Cloudflare Tunnel** (recommended for a stable custom
  hostname on your own domain, free, no inbound ports), **ngrok** (fastest for a 10-minute test,
  random hostname, do not use for real sends), **Fly.io** (recommended for always-on self-hosting: one
  small machine + a persistent volume for the SQLite file, the whole binary deploys as-is), **Vercel**
  (viable only for a stateless pixel edge function that forwards events to the home instance — SQLite
  does not live there). Decision table + TLS + custom-domain steps in `docs/deploy.md`.
- `openpost forget <email>`, retention pruning job wired to the scheduler.

**Definition of Done**

1. A click on a rewritten link lands on the exact original URL (byte-for-byte, including query and
   fragment) and records one counted click; a `HEAD` on the same URL records `scanner`, counted 0.
2. A counted click with no prior open back-fills one `human` open with `reason='implied_by_click'`.
3. First counted open delivers exactly one Slack/Discord/webhook notification within 5 s; a delivery
   failure retries 3× with backoff and ends `status='failed'` with `last_error` set.
4. A message opened only by Apple MPP produces **zero** notifications and shows state `prefetched`.
5. Webhook signature verification sample (node + python) in the docs; replaying a body with a wrong
   signature is rejected by the sample verifier.
6. End-to-end test through a Cloudflare Tunnel hostname documented with real output.

---

## Phase 3 — Local web dashboard + reminders + reply detection

**Scope**

- Server-rendered dashboard at `/dashboard` (Fastify + `@fastify/static` + htmx; no SPA build step):
  message list with open/click/state columns, per-recipient timeline, event detail with the rule ids
  that produced each classification, live updates over SSE, filters and CSV/JSON export.
- Auth: bearer token or a single-password session; binds to `127.0.0.1` unless
  `DASHBOARD_BIND=0.0.0.0` is set explicitly (with a warning).
- Reminders: `openpost remind <message-id> --if no-reply --in 3d`; scheduler fires, notifies, and can
  auto-draft a follow-up in the same Gmail thread (`--draft` creates a Gmail draft, never auto-sends).
- Reply detection via `gmail.readonly`: poll `users.threads.get` for tracked threads, set
  `recipients.replied_at`, auto-cancel pending reminders.
- Aggregate stats: open rate, click rate, time-to-open distribution, best-hour histogram.

**Definition of Done**

1. Dashboard renders a seeded database (fixtures) and updates a row live when a curl pixel hit
   arrives, with no page reload.
2. Each event row shows its classification, confidence and rule ids, and can be overridden in two
   clicks; the override is visible in the audit view.
3. A reminder created with `--in 1m` fires once, notifies, and never fires twice after a restart
   mid-window (crash-safety test kills the process between due time and fire).
4. A reply in the Gmail thread sets `replied_at` within one poll interval and cancels the reminder.
5. Dashboard refuses to start on a non-loopback bind without an auth secret configured.

---

## Phase 4 — Campaigns, multi-account, packaging

**Scope**

- Mail merge: `openpost campaign --csv people.csv --template body.html.hbs` with per-row variables,
  preview mode, suppression check, throttle + jitter, resumable on crash.
- Multi-account: several `accounts` rows, `--from` selection, per-account OAuth tokens encrypted at
  rest with a key derived from `MASTER_KEY`.
- A/B subject testing and per-campaign stats.
- Packaging: single-binary build (Node SEA) + a minimal Docker image + `systemd` unit; one-command
  bootstrap (`npx openpost init`).
- Optional plugins: Gmail add-on/Chrome extension showing tracking state inside the Gmail UI (parity
  with Mailtrack's checkmarks) that talks only to the operator's own instance.
- Backup/restore command, schema migration tests from v1 → vN.

**Definition of Done**

1. A 500-row CSV campaign sends in dry-run with 500 distinct tokens, zero duplicates, suppressed rows
   skipped, and a resumed run after a kill sends each remaining row exactly once.
2. `openpost backup` → `openpost restore` round-trips a database with events intact.
3. Single binary runs on a clean container with no Node installed; Docker image < 150 MB.
4. Extension/add-on shows per-thread open state from the local instance (documented as optional).

---

## Differentiators — how we beat Mailtrack

1. **Fully self-hosted.** Your mail metadata never leaves your box. One binary, one SQLite file.
2. **No branding, ever.** Mailtrack's free tier injects "Sent with Mailtrack" into your signature.
3. **Automatic Google-proxy and Apple-MPP false-positive filtering** with an explicit
   `prefetched` state ("delivered, image auto-loaded — read not confirmed"). Mailtrack shows these as
   real opens; this is the single most common complaint about every tracker on the market.
4. **Structural self-open elimination** (untracked Sent copy via `messages.insert`), not just a
   time window.
5. **Honest location reporting.** Proxied opens are labelled "unknown (proxied)" instead of showing
   Google's datacentre city as the recipient's location.
6. **Every classification is explainable and overridable** — each event carries the rule ids that
   produced it, and a human can correct it; the correction is audited.
7. **Notifications where you actually are**: Slack, Discord, generic signed webhook, ntfy, SSE, and
   (Phase 5) **Web Push straight to your phone** (self-hosted VAPID, no third-party push relay in
   the loop) plus a zero-config **email-to-self** channel and an optional daily digest — no browser
   extension required, no third-party push service ever sees the plaintext.
8. **Privacy by construction**: no raw IPs (daily-salted hashes only), three privacy modes including
   a `strict` mode that stores nothing but a timestamp, recipient opt-out that also disables future
   tracking for that address, DNT/GPC respected, enforced retention TTL, one-command erasure.
9. **Append-only SQLite audit log** of sends, classifications, rejections and deletions — provable
   behaviour, useful for compliance review.
10. **Scriptable**: a real CLI and a local JSON API, plus a mandatory **dry-run mode** that renders
    the exact outgoing HTML/MIME to disk so you can inspect what your recipients will receive.
11. **Click→open back-fill**: recipients who block images but click a link are correctly counted as
    having read the message.
12. **Local dashboard** with live SSE updates, no cloud account, no per-seat pricing, no send limits
    other than Gmail's own — and, from Phase 5, **installable as a PWA** with a mobile compose page
    (compose and send a fully tracked message from a phone in four taps), an honest offline
    fallback, and no recipient data ever cached on the device. See `docs/09_phase5_spec.md` and
    `docs/mobile.md`.
