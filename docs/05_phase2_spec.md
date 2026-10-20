# 05 — Phase 2 Implementation Spec

Target: a coding agent implements this directly, with no further design decisions required.
Same stack as Phase 1 (Node 22 + TypeScript strict + Fastify 5 + better-sqlite3 + vitest, ESM).
Phase 2 adds **no public URL requirement and no Gmail credential requirement** for development or
CI: every feature is exercised locally with unit tests, `app.inject()`, injected `fetch`, injected
Gmail/IMAP clients and `curl` against `127.0.0.1`. Public exposure and real Gmail consent are
**operator-run procedures**, specified here and recorded in `docs/reports/phase2_smoke.md`.

---

## 0. Baseline: what Phase 1 actually shipped

This spec is written against the code in the tree, not against doc 04's prose. Carried-forward
facts and deviations (all are **kept**, not reverted):

| Fact | Consequence for Phase 2 |
|---|---|
| Transparent GIF is the standard **43-byte** GIF89a (`src/server/assets.ts`) | `doctor` asserts `Content-Length: 43`. |
| `loadConfig(env, { requireSecret })` has a second parameter | New commands pass `{ requireSecret: false }` only where they truly can run secretless (`doctor --offline`, `auth gmail`, `update-ranges`). |
| Dry-run artefacts are `<messageId>.<recipientId>.html/.eml` | Unchanged. |
| `TRUST_PROXY` exists and feeds Fastify `trustProxy` | §3 specifies exactly when it must be on. |
| `ClickClassificationKind` = `human \| scanner \| duplicate \| opt_out \| dnt` | §4.3 adds no new kind; the datacentre rule reuses `scanner`. |
| One `transport.send()` per recipient; `messages` stores only the **first** recipient's provider ids | Migration 002 adds per-recipient provider id columns; `send` now records them per recipient (§7.2). |
| `isAppleRelayIp` is hard-coded `false` in `src/server/context.ts` | §4.1 ships CIDR sets and wires them in; R4's IP branch becomes live. |
| Click tracking implemented but off by default; no back-fill | §4.3 turns it on by default and adds the back-fill. |
| `click_events` has no `confidence`/`reason`/`region`/`city`; the click route does **not** call `redactForMode` | Migration 002 adds the columns; §4.3 adds redaction (privacy parity with opens). |
| `notifications` table exists in 001 and is **never read or written** by any code | Migration 002 drops and rebuilds it as a real queue (no data loss possible). |
| Missing entirely: notifications, `forget`, reclassification API, geo, OAuth helper, `SELF_OPEN_STRATEGY=insert` | All specified below. Geo stays **out of scope** (Phase 3: optional local MaxMind DB; `country/region/city` columns stay NULL and every report labels proxied opens "unknown (proxied)"). |

62 existing tests must stay green. Phase 2 adds test cases **49–120**.

---

## 1. Goal and Definition of Done

**Goal.** Turn the Phase 1 recorder into something a person actually uses: the operator learns about
a real read *where they already are* (Slack / Discord / webhook / phone / terminal) within seconds,
the tracker can be reached from the public internet through a documented, spam-safe path, and the
numbers it reports are materially more accurate than Mailtrack's (MPP/proxy suppression backed by
shipped CIDR data, click→open back-fill, structural self-open elimination, human override).

**Definition of Done** (each item is binary and checkable):

1. `npm ci && npm run build && npm test` is green on a clean container with **no `.env`, no
   credentials, no network**; line coverage ≥ 90 % for `src/core/**` and ≥ 85 % for `src/notify/**`;
   test cases 49–120 all exist and pass.
2. `openpost migrate` upgrades a **populated** v1 database to v2 with zero row loss; `/healthz`
   reports `"schema": 2`; running it twice returns 2 and changes nothing.
3. A first counted open enqueues exactly **one** notification per enabled channel and the worker
   delivers it in under 5 s (asserted against a local HTTP receiver in an integration test).
4. A delivery that fails 3 consecutive attempts ends `status='failed'` with `last_error` set and
   produces exactly **one** `notification_dead_letters` row; `openpost notifications list --status
   failed` shows it and `--retry <id>` re-queues it.
5. A recipient whose only event is Apple MPP produces **zero** notifications and reports state
   `prefetched`.
6. A generic webhook delivery carries `X-Openpost-Signature: sha256=<hex>`; the Node verifier in
   `docs/notifications.md` accepts the delivery and rejects a body with one byte changed (automated,
   test 71b). The Python verifier sample is byte-compatible and verified manually in the smoke report.
7. `curl -N http://127.0.0.1:8787/api/events/stream` emits a `tracking` event within 1 s of a pixel
   hit and a `: ping` comment every `SSE_HEARTBEAT_SECONDS`.
8. A counted click by a recipient with no prior counted open creates exactly one back-filled
   `human` open with `reason` containing `implied_by_click`, moves the recipient to
   `read_confirmed`, and produces exactly **one** notification (not two).
9. `data/ranges/apple-relay.cidr` and `data/ranges/google-proxy.cidr` ship in the repo; an open from
   `17.1.1.1` inside the MPP window classifies `apple_mpp` via **R4** with `isAppleRelayIp = true`,
   with no Apple-Mail UA present.
10. `openpost doctor` exits 0 with every check `pass`/`warn` against a healthy local instance, and
    exits 1 naming the failing check when the pixel URL is unreachable, redirected, mis-typed,
    ETag-bearing or not 43 bytes.
11. `openpost forget <email>` deletes every event, recipient, click token, notification and
    dead-letter row for that address, deletes messages left with no recipients, writes exactly one
    `audit_log` row that contains **no raw address**, and a later hit on that recipient's old token
    records nothing (`token.orphan`).
12. `openpost reclassify <eventId> --to human` changes the stored classification, recomputes the
    recipient counters and state from the event table, writes a `reclassify.override` audit row with
    before/after, and emits **no** notification.
13. `openpost accuracy --json` reports per-rule hit counts for R0–R10 that match an independent SQL
    cross-check, plus classification, state and notification-outcome distributions.
14. `openpost auth gmail` completes a loopback OAuth flow against a fake authorization server in
    tests and writes `gmail-token.json` with mode `0600`; the real-credential run is documented as an
    operator procedure.
15. Every item above is reachable with `MAIL_TRANSPORT=dryrun`, no public URL and no Gmail
    credentials. Items that inherently need the internet (tunnel hostname, real Gmail consent, live
    `update-ranges` download) are documented operator procedures with `--from-file` / `--print-only`
    offline equivalents that **are** tested.

**Out of scope for Phase 2:** dashboard UI, reminders, reply detection, campaigns, geo lookup,
multi-account (Phases 3–4).

---

## 2. Notification subsystem

### 2.1 Shape

```
route (pixel.ts / click.ts)
  -> services/record.ts      recordOpen() / recordClick()   [one transaction]
       - classify + redact + insert event + bump counters + recompute recipients.state
       - build TrackingEvent { prevState, newState, isFirstCountedOpen, ... }
  -> bus.publish(TrackingEvent)          (in-process, synchronous, never throws)
       |-> SSE subscribers                (fan-out to /api/events/stream)
       |-> NotifyWorker.onTrackingEvent   (policy -> enqueue -> immediate tick)
                                          -> notifications table -> Notifier.deliver()
```

The bus is in-process only. The queue is the durable part: if the process dies between publish and
delivery, the pending row is picked up on the next tick after restart.

### 2.2 `src/notify/types.ts`

```ts
export type NotifyTrigger = 'first_open' | 'read_confirmed' | 'click' | 'prefetched';
export type ChannelName   = 'slack' | 'discord' | 'webhook' | 'ntfy';

export interface TrackingEvent {
  kind: 'open' | 'click';
  eventId: string;
  occurredAt: number;
  messageId: string;
  subject: string;
  recipientId: string;
  recipientEmail: string;
  classification: string;             // OpenClassificationKind | ClickClassificationKind
  reasons: string[];
  counted: boolean;
  backfilled: boolean;                // true for the implied_by_click open
  prevState: RecipientState;
  newState: RecipientState;
  counters: RecipientCounters;
  uaFamily: string | null;
  deviceType: string | null;
  linkUrl: string | null;             // clicks only
  muted: boolean;                     // message.notify_muted || recipient.notify_muted
}

export interface NotificationPayload {          // the wire format (webhook + SSE data)
  version: 1;
  id: string;                                   // notification id == X-Openpost-Delivery
  trigger: NotifyTrigger;
  occurredAt: number;                           // event time, epoch ms
  message:   { id: string; subject: string | null; sentAt: number | null };
  recipient: { id: string; email: string | null; state: RecipientState;
               openCount: number; clickCount: number };
  event:     { id: string; kind: 'open' | 'click'; classification: string; reasons: string[];
               counted: boolean; uaFamily: string | null; deviceType: string | null;
               country: string | null; linkUrl: string | null };
}

export interface DeliveryResult { ok: boolean; status?: number; error?: string;
                                  retryable: boolean; retryAfterMs?: number }

export type FetchLike = (url: string, init: {
  method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal;
}) => Promise<{ status: number; ok: boolean; headers: { get(n: string): string | null };
                text(): Promise<string> }>;

export interface NotifierDeps { fetch: FetchLike; timeoutMs: number; clock: () => number;
                                config: AppConfig }

export interface Notifier {
  readonly name: ChannelName;
  isConfigured(config: AppConfig): boolean;
  deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult>;
}
```

`NOTIFY_REDACT_EMAIL=true` replaces `recipient.email` with `a***@example.com` in **every** channel
and in SSE; `NOTIFY_INCLUDE_SUBJECT=false` replaces `message.subject` with `null`. Redaction happens
once, in `buildPayload()`, so no channel can leak what the others hide.

### 2.3 `src/notify/bus.ts`

```ts
export type Listener = (e: TrackingEvent) => void;
export class EventBus {
  constructor(bufferSize?: number);            // default 100
  subscribe(fn: Listener): () => void;         // returns unsubscribe
  publish(e: TrackingEvent): void;             // sync; each listener wrapped in try/catch
  recent(limit?: number): TrackingEvent[];     // newest last; for SSE catch-up
  size(): number;                              // subscriber count (tests)
}
```
A listener that throws is logged and **never** propagates: a broken notifier must not break pixel
recording.

### 2.4 `src/notify/policy.ts`

```ts
export interface NotifyPolicyConfig { on: NotifyTrigger[]; channels: ChannelName[] }
export function decideTriggers(e: TrackingEvent, cfg: NotifyPolicyConfig): NotifyTrigger[];
export function dedupeKey(trigger: NotifyTrigger, e: TrackingEvent, channel: ChannelName): string;
```

Transition semantics, evaluated in order, non-terminal (a single event may yield `first_open` **and**
`read_confirmed`; it never yields `first_open` and `click`):

| # | Condition | Trigger |
|---|---|---|
| P0 | `e.muted` | — (nothing, always) |
| P1 | `e.classification ∈ {opt_out, dnt, self_open, duplicate}` | — (never notify) |
| P2 | `e.backfilled === true` | — (the click that caused it notifies instead) |
| P3 | `!e.counted` and `prevState === 'not_opened'` and `newState === 'prefetched'` | `prefetched` (only if listed in `NOTIFY_ON`; **off by default**) |
| P4 | `e.kind === 'open'` and `e.counted` and `e.counters.openCount === 1` | `first_open` |
| P5 | `e.counted` and `newState === 'read_confirmed'` and `prevState !== 'read_confirmed'` | `read_confirmed` |
| P6 | `e.kind === 'click'` and `e.counted` | `click` |

Triggers not listed in `NOTIFY_ON` are dropped at the end. Default
`NOTIFY_ON=first_open,read_confirmed,click`.

Dedupe keys (backed by `UNIQUE(dedupe_key)`, so exactly-once survives races and restarts):

```
first_open      -> `${channel}:first_open:${recipientId}`
read_confirmed  -> `${channel}:read_confirmed:${recipientId}`
prefetched      -> `${channel}:prefetched:${recipientId}`
click           -> `${channel}:click:${eventId}`
```

### 2.5 `src/notify/queue.ts`

```ts
export interface NotificationRow { id; trigger; channel; message_id; recipient_id; event_type;
  event_id; dedupe_key; payload_json; status; attempts; next_attempt_at; last_error;
  created_at; sent_at }

export function enqueue(db: DB, input: {
  trigger: NotifyTrigger; channel: ChannelName; payload: NotificationPayload;
  messageId: string; recipientId: string; eventType: 'open' | 'click'; eventId: string;
  dedupeKey: string; atMs: number;
}): string | null;                       // null when dedupe_key already exists (INSERT OR IGNORE)

export function claimDue(db: DB, nowMs: number, limit: number): NotificationRow[];
export function markSent(db: DB, id: string, atMs: number): void;
export function markRetry(db: DB, id: string, error: string, nextAttemptAt: number): void;
export function markFailed(db: DB, id: string, error: string, atMs: number): void;  // + dead letter
export function listNotifications(db, { status?, limit?, since? }): NotificationRow[];
export function requeue(db: DB, id: string, atMs: number): boolean;                  // dead letter -> pending
export function backoffMs(attempt: number, baseMs: number, rand: () => number): number;
// base * 2^(attempt-1), capped at 300_000, multiplied by (0.8 + 0.4*rand())
```

`claimDue` selects `status='pending' AND next_attempt_at <= now ORDER BY next_attempt_at LIMIT n`
inside a transaction that bumps `attempts` and pushes `next_attempt_at` forward by the backoff, so
two workers can never double-send.

### 2.6 `src/notify/worker.ts`

```ts
export interface NotifyWorkerDeps {
  db: DB; config: AppConfig; bus: EventBus;
  notifiers?: Map<ChannelName, Notifier>;   // default: built from config
  fetch?: FetchLike;                        // default: globalThis.fetch
  clock?: () => number; rand?: () => number; log?: Logger;
}
export class NotifyWorker {
  constructor(deps: NotifyWorkerDeps);
  attach(): () => void;                     // subscribes to the bus; returns detach
  onTrackingEvent(e: TrackingEvent): void;  // policy -> buildPayload -> enqueue -> schedule tick
  start(): void;                            // setInterval(tickOnce, NOTIFY_TICK_SECONDS*1000).unref()
  stop(): Promise<void>;                    // clears the interval, awaits an in-flight tick
  tickOnce(): Promise<{ sent: number; retried: number; failed: number; skipped: number }>;
}
```
`onTrackingEvent` enqueues synchronously and then calls `void this.tickOnce()` so the first delivery
does not wait for the interval (DoD 3). Tests call `tickOnce()` directly and never start timers.
Max attempts `NOTIFY_MAX_ATTEMPTS` (default 4: the first try plus 3 retries — DoD 4). A
`DeliveryResult` with `retryable:false` (4xx other than 408/429) fails immediately without consuming
retries.

### 2.7 Channels — `src/notify/channels/*`

All four take the same `NotificationPayload` and use the injected `fetch` with an `AbortSignal`
timeout of `NOTIFY_TIMEOUT_MS` (default 5000). Network/abort errors are retryable; 5xx, 408 and 429
are retryable (429 honours `Retry-After` seconds into `retryAfterMs`); other 4xx are not.

**slack.ts** — `POST SLACK_WEBHOOK_URL`, `Content-Type: application/json`:
```json
{ "text": "Read: alice@example.com opened \"hello\"",
  "blocks": [
    { "type": "section", "text": { "type": "mrkdwn",
      "text": "*Read confirmed* — `alice@example.com`\n*hello*" } },
    { "type": "context", "elements": [ { "type": "mrkdwn",
      "text": "opened 2×, 1 click · Chrome / desktop · 2026-09-15 08:14 UTC · rules R9" } ] } ]
}
```
Success = HTTP 200. Slack markdown metacharacters in subject/email are escaped (`&`, `<`, `>`).

**discord.ts** — `POST DISCORD_WEBHOOK_URL`:
```json
{ "username": "openpost",
  "embeds": [ { "title": "Read confirmed", "description": "**hello**",
    "color": 5025616, "timestamp": "2026-09-15T08:14:02.000Z",
    "fields": [ { "name": "Recipient", "value": "alice@example.com", "inline": true },
                { "name": "State", "value": "read_confirmed", "inline": true },
                { "name": "Signals", "value": "R9 · Chrome · desktop", "inline": false } ] } ] }
```
Success = 200 or 204. Colours: `first_open` 3447003, `read_confirmed` 5025616, `click` 15844367,
`prefetched` 9807270.

**webhook.ts** — `POST WEBHOOK_URL` with the payload serialised **once** and signed byte-for-byte:
```
Content-Type: application/json
User-Agent: openpost/<version>
X-Openpost-Event: read_confirmed          # the trigger
X-Openpost-Delivery: <notification id>
X-Openpost-Timestamp: 1789459200          # unix SECONDS
X-Openpost-Signature: sha256=<hex>        # HMAC-SHA256(WEBHOOK_SECRET, `${timestamp}.${rawBody}`)
```
Success = any 2xx. `WEBHOOK_SECRET` is **required** when `WEBHOOK_URL` is set (config error
otherwise). Receivers must compare with a timing-safe compare and reject timestamps older than
5 minutes; both verifier samples do.

**ntfy.ts** — `POST ${NTFY_URL}/${NTFY_TOPIC}` (`NTFY_URL` default `https://ntfy.sh`), plain-text
body = the Slack `text` line, headers `Title`, `Priority` (`NTFY_PRIORITY`, default `default`),
`Tags: envelope`, and `Authorization: Bearer ${NTFY_TOKEN}` only when the token is set.
Success = 200.

### 2.8 SSE — `src/server/routes/stream.ts`

`GET /api/events/stream` (registered inside the `/api` prefix, so the bearer-auth hook of
`routes/api.ts` covers it — non-loopback bind without `API_TOKEN` ⇒ 401).

```
Content-Type: text/event-stream
Cache-Control: no-store
Connection: keep-alive
X-Accel-Buffering: no
```
Protocol: `reply.hijack()`, then write `retry: 3000\n\n`, then optional catch-up from
`bus.recent()` when `?since=<epochMs>` is given, then per event:
```
id: <eventId>
event: tracking
data: <NotificationPayload JSON, trigger="" when the event triggers nothing>
```
Heartbeat `: ping\n\n` every `SSE_HEARTBEAT_SECONDS` (default 15) via an `unref`'d interval; the
subscription and the interval are cleared on `req.raw.on('close')`. `SSE_MAX_CLIENTS` (default 16)
returns 503 beyond the limit. SSE is **unfiltered by policy** — the dashboard wants everything,
including machine classifications.

### 2.9 Environment variables (notifications)

| Variable | Default | Meaning |
|---|---|---|
| `NOTIFY_ENABLED` | `true` | Master switch for the worker (SSE is independent). |
| `NOTIFY_CHANNELS` | `` (empty) | Comma list of `slack,discord,webhook,ntfy`. Empty ⇒ queue only, no delivery. |
| `NOTIFY_ON` | `first_open,read_confirmed,click` | Subset of `first_open,read_confirmed,click,prefetched`. |
| `NOTIFY_MAX_ATTEMPTS` | `4` | Total attempts before dead-lettering. |
| `NOTIFY_BACKOFF_BASE_MS` | `1000` | First retry delay; doubles, capped at 300000, ±20 % jitter. |
| `NOTIFY_TICK_SECONDS` | `5` | Worker interval. |
| `NOTIFY_TIMEOUT_MS` | `5000` | Per-delivery HTTP timeout. |
| `NOTIFY_INCLUDE_SUBJECT` | `true` | `false` ⇒ subject is `null` everywhere. |
| `NOTIFY_REDACT_EMAIL` | `false` | `true` ⇒ `a***@example.com` everywhere. |
| `SLACK_WEBHOOK_URL` | – | Required when `slack` is in `NOTIFY_CHANNELS`. |
| `DISCORD_WEBHOOK_URL` | – | Required when `discord` is listed. |
| `WEBHOOK_URL` / `WEBHOOK_SECRET` | – | Both required when `webhook` is listed. |
| `NTFY_URL` / `NTFY_TOPIC` / `NTFY_TOKEN` / `NTFY_PRIORITY` | `https://ntfy.sh` / – / – / `default` | `NTFY_TOPIC` required when `ntfy` is listed. |
| `SSE_ENABLED` | `true` | Registers `/api/events/stream`. |
| `SSE_HEARTBEAT_SECONDS` | `15` | Heartbeat comment interval. |
| `SSE_MAX_CLIENTS` | `16` | Concurrent stream limit. |

### 2.10 Ops CLI

```
openpost notifications list [--status pending|sent|failed] [--limit 20] [--json]
openpost notifications retry <id>|--all-failed
openpost notifications purge [--days N]            # drops sent rows + old dead letters
openpost notify test [--channel slack|discord|webhook|ntfy] [--trigger first_open]
      # builds a synthetic payload for a fake message, delivers it NOW, prints status + body
openpost mute <messageId> [--recipient <recipientId>] [--off]
```

---

## 3. Public exposure: `tunnel`, `doctor`, and the `TRACKING_BASE_URL` / `TRUST_PROXY` contract

### 3.1 The contract

`TRACKING_BASE_URL` is the origin **baked into the outgoing HTML** at send time. It must be the
hostname the recipient's mail client will resolve. It is never derived from an inbound request
header (host-header injection would let a scanner mint URLs on another origin).

`TRUST_PROXY` decides where `req.clientIp` comes from. Getting it wrong silently destroys
classification: with it off behind a proxy, **every** open shares the proxy's IP hash, so R5
(self-open), R7 (fanout) and the Apple/Google range rules all misfire.

| Deployment | `TRACKING_BASE_URL` | `BIND_ADDRESS` | `TRUST_PROXY` | client IP source |
|---|---|---|---|---|
| Local dev / CI | `http://127.0.0.1:8787` | `127.0.0.1` | `false` | socket |
| Cloudflare Tunnel (recommended) | `https://t.example.com` | `127.0.0.1` | `true` | `X-Forwarded-For` from `cloudflared` |
| ngrok (test only) | `https://<random>.ngrok-free.app` | `127.0.0.1` | `true` | `X-Forwarded-For` |
| Fly.io | `https://<app>.fly.dev` or custom | `0.0.0.0` | `true` | `X-Forwarded-For` from fly-proxy |
| Direct port exposure | `https://t.example.com` | `0.0.0.0` | **`false`** | socket |

Hard rule enforced by `doctor`: `TRUST_PROXY=true` is safe **only** when the process is unreachable
except through the proxy — i.e. `BIND_ADDRESS` is loopback, or the platform terminates TLS in front
of it (Fly). `TRUST_PROXY=true` with a directly reachable non-loopback bind is a `fail`: anyone can
forge `X-Forwarded-For` and poison the IP hashes. The inverse (`TRUST_PROXY=false` while
`TRACKING_BASE_URL` is a non-loopback HTTPS origin) is also a `fail`.

### 3.2 `openpost tunnel`

A **planner**, not a daemon. It never installs anything; `--exec` only spawns a binary that is
already on `PATH`.

```
openpost tunnel [--provider cloudflare|ngrok|flyio] [--port 8787] [--hostname t.example.com]
                [--exec] [--json]
```

```ts
// src/core/tunnel.ts  (pure, unit-tested)
export type TunnelProvider = 'cloudflare' | 'ngrok' | 'flyio';
export interface TunnelPlan {
  provider: TunnelProvider;
  prerequisites: string[];     // binaries/accounts required
  commands: string[];          // run in order, verbatim
  envExports: string[];        // exact TRACKING_BASE_URL / TRUST_PROXY / BIND_ADDRESS lines
  verify: string[];            // the doctor invocation that proves it worked
  warnings: string[];          // spam/stability caveats
}
export function buildTunnelPlan(opts: { provider: TunnelProvider; port: number;
  hostname?: string; tunnelName?: string }): TunnelPlan;
export function detectBinary(name: string, which: (n: string) => string | null): string | null;
```

**Cloudflare Tunnel — recommended** (stable hostname on your own domain, free, no inbound port, a
real certificate, and the hostname is a subdomain of your sending domain, which is what doc 02 §3
requires for spam safety):
```
cloudflared tunnel login
cloudflared tunnel create openpost
cloudflared tunnel route dns openpost t.example.com
cloudflared tunnel run --url http://127.0.0.1:8787 openpost
# then, in the shell that runs openpost:
export TRACKING_BASE_URL=https://t.example.com
export TRUST_PROXY=true
export BIND_ADDRESS=127.0.0.1
openpost doctor --url https://t.example.com
```
**ngrok — 10-minute test only.** `ngrok http 8787` gives `https://<random>.ngrok-free.app`. Warning
emitted verbatim: *"`*.ngrok-free.app` is heavily blocklisted; never use it for a real send — use it
only to confirm that an inbound request reaches your pixel."*

**Fly.io — always-on self-hosting.** Documented in `docs/deploy.md`: one machine (SQLite tolerates
exactly one writer — `min_machines_running = 1`, autoscaling **off**), a persistent volume mounted
at `/data` with `DB_PATH=/data/openpost.db`, `internal_port = 8787`, `force_https = true`,
`fly secrets set TRACKING_SECRET=… WEBHOOK_SECRET=…`, `BIND_ADDRESS=0.0.0.0`, `TRUST_PROXY=true`.
Vercel is explicitly **not** supported for the main instance (no persistent SQLite); the roadmap's
"stateless edge pixel that forwards to the home instance" idea is deferred to Phase 4.

Without `--exec` the command prints the plan and exits 0 — so it works in a container with no
tunnel binaries, which is how it is tested.

### 3.3 `openpost doctor`

```
openpost doctor [--url <public base url>] [--timeout 5000] [--offline] [--json]
```
Exit 0 when no check is `fail`; exit 1 otherwise. `--offline` skips every network check.

```ts
// src/core/doctor.ts  (pure; all network I/O is injected)
export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckResult { id: string; status: CheckStatus; title: string; detail: string;
                               remedy?: string }
export interface PixelProbe { status: number; headers: Record<string, string>;
                              bodyLength: number; redirected: boolean; elapsedMs: number }
export function checkConfig(config: AppConfig, schemaVersion: number,
                            secretFingerprint: string | null): CheckResult[];
export function checkProxyContract(config: AppConfig): CheckResult[];
export function checkBaseUrl(url: string): CheckResult[];
export function checkRanges(sets: Map<string, RangeSet>, nowMs: number): CheckResult[];
export function checkNotifyConfig(config: AppConfig): CheckResult[];
export function checkPixelProbe(p: PixelProbe): CheckResult[];
export function summarise(results: CheckResult[]): { ok: boolean; pass: number; warn: number;
                                                    fail: number };
```

Checks:

| id | What it asserts | Fail when |
|---|---|---|
| `config.load` | `loadConfig` succeeds | ConfigError |
| `secret.length` | `TRACKING_SECRET` ≥ 32 chars | shorter / unset |
| `secret.fingerprint` | matches `settings.tracking_secret_fingerprint` | mismatch (**warn**: every existing token is now unverifiable) |
| `db.schema` | `user_version === 2` | lower (run `openpost migrate`) |
| `db.writable` | a `BEGIN IMMEDIATE; ROLLBACK` succeeds | read-only / locked |
| `base_url.scheme` | `https` unless host is loopback | http + public host |
| `base_url.host` | not `*.trycloudflare.com` / `*.ngrok-free.app` / `*.ngrok.io` | **warn** only |
| `proxy.contract` | §3.1 rule | both violations above |
| `ranges.loaded` | Apple + Google sets non-empty | empty (**fail**), older than 90 days (**warn**) |
| `notify.config` | each listed channel has its URL; `webhook` has a secret | missing |
| `dns.resolve` (needs `--url`) | A/AAAA records exist (`node:dns/promises`) | NXDOMAIN |
| `tls.cert` (needs `--url`, https) | `node:tls` handshake, ≥ 7 days validity left | expired / invalid chain; **warn** < 14 days |
| `pixel.reachable` (needs `--url`) | probe URL returns 200, `content-type: image/gif`, `content-length: 43`, `cache-control` contains `no-store`, **no** `etag`/`last-modified`, `redirected === false`, `elapsedMs < 2000` | any mismatch, each reported separately |
| `click.reachable` (needs `--url`) | `GET <url>/c/deadbeef` → 302 to `TRACKING_FALLBACK_URL` or 404 | 5xx or a hang |

The probe URL is a freshly signed token over a **synthetic rid** (`newId()` never inserted into the
DB), so a doctor run leaves one explainable `token.orphan` audit row and zero events — the `remedy`
text says so. `fetch` is called with `redirect: 'manual'`.

Header names are lower-cased before comparison; `checkPixelProbe` is pure, so the whole table is
unit-tested with literal probe objects, and the integration test drives it through `app.inject()`.

---

## 4. Accuracy upgrades

### 4.1 Shipped CIDR data

**Files** (committed, updatable): `data/ranges/apple-relay.cidr`, `data/ranges/google-proxy.cidr`,
`data/ranges/datacenter.cidr`. Format — a header block of `# key: value` lines, then one CIDR per
line, sorted, `#` comments and blank lines ignored:

```
# openpost-range-list: 1
# name: apple_relay
# source: https://mask-api.icloud.com/egress-ip-ranges.csv
# generated_at: 2026-09-15T00:00:00Z
# entries: 1043
17.0.0.0/8
172.224.0.0/12
2a01:b740::/32
```

`# name` must match the expected set name or the file is rejected (loaded as empty + a warning).
`apple-relay.cidr` ships at minimum `17.0.0.0/8` (Apple corporate) plus the iCloud Private Relay
egress snapshot; `google-proxy.cidr` ships the `goog.json` IPv4/IPv6 prefixes;
`datacenter.cidr` ships a small hand-curated set (AWS/GCP/Azure/DO egress blocks) used only to
reinforce click-scanner detection.

```ts
// src/core/cidr.ts  (pure)
export interface RangeEntry { start: bigint; end: bigint; v6: boolean }
export function ipToBigInt(ip: string): { value: bigint; v6: boolean } | null;  // handles ::ffff:1.2.3.4
export function parseCidr(cidr: string): RangeEntry | null;                     // null on malformed
export function mergeRanges(entries: RangeEntry[]): RangeEntry[];               // sort + coalesce
export class RangeSet {
  readonly name: string; readonly entries: RangeEntry[]; readonly sha256: string;
  readonly sourceUrl: string | null; readonly generatedAt: number | null;
  contains(ip: string | null): boolean;      // binary search; false for null/unparseable
  get size(): number;
}
export function parseRangeFile(name: string, text: string): RangeSet;           // never throws

// src/core/ranges.ts
export interface RangeIndex { apple: RangeSet; googleProxy: RangeSet; datacenter: RangeSet;
                              loadedAt: number }
export function loadRangeIndex(dir: string, read?: (p: string) => string): RangeIndex;
// a missing file yields an empty RangeSet and a logged warning - never a startup failure
export const EMPTY_RANGE_INDEX: RangeIndex;
```

**Wiring.** `ServerDeps` gains `ranges?: RangeIndex` (default `EMPTY_RANGE_INDEX`);
`buildClassifyContext(db, config, …, ranges)` sets

```ts
isAppleRelayIp:  ranges.apple.contains(signal.ip),
isGoogleProxyIp: ranges.googleProxy.contains(signal.ip),
isDatacenterIp:  ranges.datacenter.contains(signal.ip),
hasCountedOpen:  recipient.open_count > 0,
```

`src/types.ts` — `ClassifyContext` gains `isGoogleProxyIp: boolean`, `isDatacenterIp: boolean`,
`hasCountedOpen: boolean` (all required; the Phase 1 tests that build contexts are updated).

`src/core/classify.ts` changes, minimal and rule-preserving:

* R2/R3 test `ctx.uaInfo.isGoogleProxy || ctx.isGoogleProxyIp` instead of the UA flag alone.
* R4 already tests `ctx.isAppleRelayIp` — it simply becomes reachable. Reason id stays `R4`; when the
  IP branch fired, push `R4` and the marker `apple_ip` (`reasons: ['R4','apple_ip']`) so reports can
  distinguish IP evidence from UA evidence.
* `classifyClick` gains **R6b**, evaluated after R6: `ctx.isDatacenterIp && !ctx.hasCountedOpen` ⇒
  `scanner`, counted 0, confidence 0.85, `reasons: ['R6b']` (doc 02 §2.6).

**Updating** — `openpost update-ranges`:

```
openpost update-ranges [--source apple|google|all] [--from-file <path>] [--out-dir <dir>]
                       [--dry-run] [--json]
```
* apple: GET `https://mask-api.icloud.com/egress-ip-ranges.csv`, take field 1 of each row.
* google: GET `https://www.gstatic.com/ipranges/goog.json`, take `prefixes[].ipv4Prefix|ipv6Prefix`.
* `--from-file` parses a previously downloaded CSV/JSON — **this is the tested path** and the one
  that works in an offline container.
* Writes atomically (`<file>.tmp` + `rename`), refuses to shrink a set by > 50 % without `--force`,
  upserts `ip_range_sets`, and writes an `audit_log` row `ranges.update`
  `{ name, entries, sha256, source }`.
* `openpost doctor` reports set age; `serve` reloads the files when their mtime changes (job
  `ranges-reload`, hourly).

### 4.2 `SELF_OPEN_STRATEGY`

```
SELF_OPEN_STRATEGY = window | insert | imap-append          # default: window (Phase 1 behaviour)
```

`window` — R1 send-window + R5 fingerprint only (unchanged).

`insert` — **structural elimination**: the recipient gets the tracked MIME over SMTP (Gmail SMTP with
an app password writes **no** Sent copy), and an **untracked** copy is inserted into Sent through the
Gmail API. Config validation: `SELF_OPEN_STRATEGY=insert` requires `MAIL_TRANSPORT=smtp` plus Gmail
OAuth credentials, else `ConfigError: "SELF_OPEN_STRATEGY=insert requires MAIL_TRANSPORT=smtp
(users.messages.send always writes its own tracked Sent copy)"`.

```ts
// src/mail/selfcopy.ts
export interface SelfCopyInput {
  untracked: { raw: Buffer; messageId: string };   // built from the ORIGINAL html + original links
  sentAt: number;
}
export interface SelfCopyResult { strategy: 'insert' | 'imap-append' | 'none';
                                  providerMessageId: string | null; error?: string }
export async function insertSentCopy(client: GmailClient, input: SelfCopyInput): Promise<SelfCopyResult>;
export async function appendSentCopy(client: ImapLike, input: SelfCopyInput,
                                     mailbox: string): Promise<SelfCopyResult>;
export function buildUntrackedMime(args: BuildMimeInput & { rfc822MessageId: string }):
  Promise<{ raw: Buffer; messageId: string }>;      // same Message-ID/Date/To/Subject as delivered
```

Exact Gmail call:

```ts
await gmail.users.messages.insert({
  userId: 'me',
  internalDateSource: 'dateHeader',
  requestBody: { raw: base64url(untracked.raw), labelIds: ['SENT'] },
});
// -> { data: { id, threadId } }   stored in messages.self_copy_msg_id / thread_id
```
* Scopes: `https://www.googleapis.com/auth/gmail.send` (not used in this mode) plus
  **`https://www.googleapis.com/auth/gmail.insert`**. `labelIds:['SENT']` at insert time means
  `gmail.modify` is *not* required.
* The untracked MIME reuses the delivered copy's `Message-ID`, `Date`, `To`, `Subject`,
  `In-Reply-To`/`References`, so Gmail threads the Sent copy with the recipient's replies, and adds
  `X-Openpost-Self-Copy: 1` (present only in the sender's own mailbox; Phase 3 reply detection skips
  it).
* `internalDateSource: 'dateHeader'` keeps the Sent copy in the right chronological place.
* Failure policy: an insert failure **never** fails the send. It is audited as `selfcopy.failed` and
  surfaced in the CLI output and in `send --json` as `selfCopy: { ok: false, error }`.

`imap-append` — the SMTP-only alternative when the Gmail API is unavailable (Workspace policy, other
providers). APPENDs the same untracked MIME:
```ts
await client.append(IMAP_SENT_MAILBOX, untracked.raw, ['\\Seen'], new Date(sentAt));
```
`imapflow` is a **dynamic import** so it stays an optional dependency; tests inject a fake
`ImapLike { append(...) }`. Env: `IMAP_HOST` (default `imap.gmail.com`), `IMAP_PORT` (993),
`IMAP_USER`, `IMAP_PASS` (app password), `IMAP_SENT_MAILBOX` (default `[Gmail]/Sent Mail`).

### 4.3 Click tracking on by default + click→open back-fill

* `TRACK_CLICKS_DEFAULT=true` (new env). `openpost send` exposes `--no-track-clicks`; the effective
  value is `opts.trackClicks === false ? false : config.trackClicksDefault`. `--track-clicks` is kept
  as an accepted no-op alias for compatibility with Phase 1 scripts.
* The plain-text alternative keeps **original** URLs (already true — `htmlToText` runs on the
  pre-rewrite template; the implementation must keep generating text from `htmlTemplate`, not from
  the rewritten HTML).
* The click route now redacts exactly like the pixel route: `redactForMode({ip_hash, ip_net_hash, ua,
  ua_family, device_type, os, country, region, city}, PRIVACY_MODE)` before insert, and stores
  `confidence` + `reason` (new columns).

**Back-fill** (`src/server/services/record.ts`):

```ts
export function recordClick(deps, input): { eventId: string; backfilledOpenId: string | null;
                                            events: TrackingEvent[] };
```
Inside the same transaction as the click insert: if `classification.counted` **and**
`recipient.open_count === 0`, insert an open event with
```
classification = 'human', confidence = 0.8, counted = 1,
reason = 'R10,implied_by_click', occurred_at = <the click's occurred_at>
```
copying the redacted ip/ua fields from the click, bump the open counters, recompute
`recipients.state`. **R10** is added to the rule table as *"a counted click implies a human open"*.
The back-filled `TrackingEvent` carries `backfilled: true`, so policy rule **P2** suppresses its
notification and the click's own `click` (plus `read_confirmed`) notification is the only one — DoD 8.
Idempotence: the guard is `open_count === 0`, so a second click never back-fills again.

### 4.4 Manual reclassification

```
POST /api/events/:kind/:eventId/reclassify        kind ∈ open | click
body: { "classification": "human", "counted": true, "note": "confirmed by reply", "actor": "me" }
200 -> { eventId, kind, before: { classification, counted, confidence, reason },
         after:  { ... }, recipient: { id, openCount, machineOpenCount, clickCount, state } }
400 -> classification not in the enum for that kind        404 -> unknown event
```
(This supersedes doc 01 §5's `POST /api/messages/:id/recipients/:rid/reclassify`, which cannot
address a single event; the deviation is recorded here.)

```ts
// src/server/services/reclassify.ts
export interface ReclassifyInput { kind: 'open' | 'click'; eventId: string;
  classification: string; counted?: boolean; note?: string; actor: string; atMs: number }
export function reclassify(db: DB, input: ReclassifyInput): ReclassifyResult;  // throws NotFound/Invalid

// src/db/repo.ts additions
export function getOpenEvent(db, id): OpenEventRow | null;
export function getClickEvent(db, id): ClickEventRow | null;
export function updateEventClassification(db, kind, id, patch: { classification; counted;
  confidence; reason; originalClassification; overriddenAt }): void;
export function recomputeRecipientCounters(db, recipientId: string): RecipientCounters & { state: RecipientState };
```
Semantics:
* `counted` defaults to `true` for `human`, `false` for every machine classification.
* `confidence` is set to `1`, `reason` becomes `manual`, `original_classification` keeps the old
  value (only on the first override) and `overridden_at` is set.
* Counters are **recomputed from the event tables**, never patched by delta, then
  `recipients.state` is rewritten. This is the single source of truth and is also what `forget` and
  `prune` rely on.
* Demoting a counted click to `scanner` also removes a still-unused back-filled open (an open whose
  `reason` contains `implied_by_click` when no other counted open exists), so the two stay consistent.
* One `audit_log` row `reclassify.override` with `{ kind, eventId, before, after, note, actor }`.
* **No notification is ever emitted** from a reclassification (documented; test 89).

CLI: `openpost reclassify <eventId> --kind open|click --to <classification> [--counted|--not-counted]
[--note <text>] [--json]`.

### 4.5 Accuracy report

```
openpost accuracy [--since 30d] [--json]
```
```ts
// src/db/report.ts
export interface AccuracyReport {
  since: number; generatedAt: number;
  messages: { total: number; sent: number; dryrun: number; failed: number };
  recipients: { total: number; byState: Record<RecipientState, number> };
  opens: { total: number; counted: number; machine: number;
           byClassification: Record<string, number> };
  clicks: { total: number; counted: number; byClassification: Record<string, number> };
  rules: Record<string, number>;          // 'R0'..'R10','R6b','apple_ip','implied_by_click','manual'
  derived: { countedOpenRate: number; prefetchSuppressionRate: number;
             backfilledOpens: number; overrides: number; medianTimeToOpenMs: number | null };
  notifications: { sent: number; pending: number; failed: number; deadLettered: number };
}
export function accuracyReport(db: DB, sinceMs: number): AccuracyReport;
```
`rules` is built by splitting every `reason` on `,` and counting each token, so an event with
`['R4','apple_ip']` increments both. Human output is three `cli-table3` tables (classification,
rules, states) plus the derived line; `--json` prints the object above verbatim.

---

## 5. Privacy and ops

### 5.1 `openpost forget <email>`

```
openpost forget <email> [--dry-run] [--yes] [--purge-bodies] [--full] [--json]
```
One transaction, in this order (all matching on `lower(trim(email))`):

1. Collect `recipient_ids` for the address.
2. `DELETE FROM click_events  WHERE recipient_id IN (…)`
3. `DELETE FROM open_events   WHERE recipient_id IN (…)`
4. `DELETE FROM click_tokens  WHERE recipient_id IN (…)`
5. `DELETE FROM notifications WHERE recipient_id IN (…)`
6. `DELETE FROM notification_dead_letters WHERE recipient_id IN (…)`
7. `DELETE FROM recipients    WHERE id IN (…)`
8. `DELETE FROM messages WHERE id IN (affected) AND NOT EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = messages.id)` (cascades `links`)
9. `--purge-bodies`: `UPDATE messages SET body_html = NULL, body_text = NULL` for the surviving
   affected messages (their bodies may contain the address).
10. `addSuppression(email, 'erasure')` — kept by default so future sends to that address are
    untracked; `--full` deletes the suppression row too and prints the trade-off.
11. Exactly one audit row:
    `action='forget.execute'`, `subject_type='email_hash'`,
    `subject_id = sha256(IP_SALT ‖ ':' ‖ email).slice(0,16)`,
    `detail = { recipients, openEvents, clickEvents, clickTokens, notifications, deadLetters,
    messagesDeleted, bodiesPurged, suppressionKept }` — **counts only, never the address**.

Without `--yes` the command prints the counts and asks for confirmation on stdin (`--dry-run`
prints them and exits 0 changing nothing). `--json` implies `--yes`.

```ts
// src/db/erase.ts
export interface ForgetPlan { email: string; recipientIds: string[]; counts: ForgetCounts;
                              messagesToDelete: string[]; messagesToKeep: string[] }
export function planForget(db: DB, email: string): ForgetPlan;
export function executeForget(db: DB, plan: ForgetPlan,
  opts: { purgeBodies: boolean; keepSuppression: boolean; ipSalt: string; atMs: number }): ForgetCounts;
```

### 5.2 Scheduler and retention pruning

```ts
// src/jobs/scheduler.ts
export interface Job { name: string; intervalMs: number;
                       run(nowMs: number): Promise<{ detail?: unknown }> }
export class Scheduler {
  constructor(deps: { db: DB; clock?: () => number; log?: Logger });
  register(job: Job): void;
  runDue(nowMs: number): Promise<Array<{ name: string; status: 'ok' | 'skipped' | 'error' }>>;
  start(tickMs?: number): void;   // default 60_000, unref'd
  stop(): Promise<void>;
}
```
Bookkeeping uses the existing `jobs` table: a job runs when
`last_run_at === null || nowMs - last_run_at >= intervalMs`; `last_status`/`last_error` are written
after each run; a throwing job is recorded `error` and never stops the scheduler.

Registered by `openpost serve`:

| job | interval | action |
|---|---|---|
| `prune` | `PRUNE_INTERVAL_HOURS` (24) | `pruneEvents(db, now - RETENTION_DAYS*86400_000, false)`, then `VACUUM` when more than `PRUNE_VACUUM_THRESHOLD` (10000) rows were deleted; audits `prune.run` with counts. Skipped when `PRUNE_ENABLED=false`. |
| `notify` | `NOTIFY_TICK_SECONDS` (5) | `NotifyWorker.tickOnce()` (owned by the worker's own interval, listed here for completeness). |
| `ranges-reload` | 1 h | reload `data/ranges/*` when mtime changed; audits `ranges.reload`. |
| `notifications-purge` | 24 h | delete `sent` notifications older than `RETENTION_DAYS` and dead letters older than 90 days. |

`PRUNE_ON_START=false` (default) — set true to run the prune job once at startup.

### 5.3 Audit actions added in Phase 2

`notify.enqueue`, `notify.deliver`, `notify.fail`, `notify.deadletter`, `notify.retry`,
`reclassify.override`, `forget.execute`, `prune.run`, `ranges.update`, `ranges.reload`,
`selfcopy.insert`, `selfcopy.failed`, `auth.gmail.grant`, `auth.gmail.revoke`, `doctor.run`.
Payloads never contain a raw email address, a raw IP, a token, a secret or an OAuth token — only ids,
counts and fingerprints. `notify.deliver` records `{ channel, trigger, status, elapsedMs }`.

---

## 6. Gmail OAuth helper — `openpost auth gmail`

Google does **not** allow the device-code flow for Gmail scopes, so this is the **loopback
redirect** flow for an OAuth client of type *Desktop app* (PKCE S256, `access_type=offline`,
`prompt=consent`).

```
openpost auth gmail [--port 0] [--with-insert] [--no-browser] [--print-only] [--json]
openpost auth status [--json]
openpost auth revoke [--yes]
```

```ts
// src/mail/oauth.ts
export const GMAIL_SCOPES_BASE = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
] as const;
export const GMAIL_SCOPE_INSERT = 'https://www.googleapis.com/auth/gmail.insert';

export interface GmailTokenStore { version: 1; clientIdFingerprint: string; refreshToken: string;
  scopes: string[]; obtainedAt: number; account: string | null }

export function tokenStorePath(env: NodeJS.ProcessEnv): string;
// `${OPENPOST_CONFIG_DIR ?? `${os.homedir()}/.config/openpost`}/gmail-token.json`
export function readTokenStore(path: string): GmailTokenStore | null;   // null when absent/corrupt
export function writeTokenStore(path: string, store: GmailTokenStore): void;
// mkdir 0700 -> write `${path}.tmp` with mode 0600 -> rename; refuses a group/world-writable dir
export function buildAuthUrl(opts: { clientId: string; redirectUri: string; scopes: string[] }):
  { url: string; state: string; codeVerifier: string };
export function exchangeCode(opts: { clientId: string; clientSecret: string; redirectUri: string;
  code: string; codeVerifier: string }, deps: { fetch: FetchLike; clock: () => number }):
  Promise<GmailTokenStore>;
export function resolveRefreshToken(config: AppConfig, env: NodeJS.ProcessEnv):
  { token: string; source: 'env' | 'file'; scopes: string[] } | null;
export class GmailAuthError extends Error { readonly remedy: string }
```

Flow:

1. Require `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (a Desktop-app client; the secret is not a
   real secret for this client type but Google still requires it in the exchange).
2. Start a bare `node:http` server on `127.0.0.1:<port>` (`--port 0` ⇒ ephemeral); redirect URI is
   `http://127.0.0.1:<actualPort>/oauth2callback`, which loopback clients may register dynamically.
3. Authorization URL:
   `https://accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=…&response_type=code
   &scope=<space-joined>&access_type=offline&prompt=consent&include_granted_scopes=true
   &state=<32 random base32>&code_challenge=<S256(verifier)>&code_challenge_method=S256`.
   Printed; opened with the platform opener unless `--no-browser`/`--print-only`.
4. The callback validates `state` (constant-time), answers a small HTML "you can close this tab"
   page, and shuts the server down. A mismatched `state` or an `error=` parameter writes nothing and
   exits 2.
5. Exchange at `https://oauth2.googleapis.com/token` (`grant_type=authorization_code`, plus
   `code_verifier`). The response must contain `refresh_token`; if it does not (user had already
   granted), the command re-runs with `prompt=consent` once and then fails with a clear message.
6. `account` is read from `gmail.users.getProfile({userId:'me'}).emailAddress` (best-effort).
7. Store written to `tokenStorePath()` with mode `0600`; the command prints only
   `refresh token stored (fingerprint sha256:1a2b3c…, scopes: …)` — never the token. Audit
   `auth.gmail.grant` with the fingerprint and scopes.

Precedence at send time: `GOOGLE_REFRESH_TOKEN` (env) **>** the token file. `openpost auth status`
prints which source is active, the scopes, the account, the age, and whether
`SELF_OPEN_STRATEGY=insert` has the `gmail.insert` scope it needs.

Refresh handling: `GmailTransport` builds `new google.auth.OAuth2(clientId, clientSecret)`, sets
`{ refresh_token }`, and subscribes `auth.on('tokens', t => { if (t.refresh_token) persist(t) })`.
Access tokens live only in memory. A `400 invalid_grant` (revoked/expired refresh token) is
re-thrown as `GmailAuthError` with `remedy: "run `openpost auth gmail` to re-authorise"`; the send
fails with exit code 1 and that single line.

`openpost auth revoke` POSTs `https://oauth2.googleapis.com/revoke?token=<refresh token>`
(`application/x-www-form-urlencoded`), deletes the file, audits `auth.gmail.revoke`.

**Operator procedure** (documented in `README.md`, run outside this container): create a Google
Cloud project → enable the Gmail API → OAuth consent screen (External, Testing, add yourself as a
test user) → Credentials → *Create OAuth client ID* → **Desktop app** → put the client id/secret in
`.env` → `openpost auth gmail`. Test-mode refresh tokens expire after 7 days; publishing the app (or
using an Internal Workspace app) removes that limit. This is in `docs/reports/phase2_smoke.md` once
run for real.

---

## 7. Change list, migration, env, CLI, tests

### 7.1 Migration `src/db/migrations/002_phase2.sql` (schema_version = 2)

`notifications` is dropped and rebuilt: no code in Phase 1 ever read or wrote it (verified by grep),
so no data can be lost. Everything else is additive `ALTER TABLE ... ADD COLUMN`, which SQLite
applies without a table rewrite.

```sql
-- 002_phase2.sql (schema_version = 2)

-- click events reach parity with open events (explainability + privacy redaction)
ALTER TABLE click_events ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
ALTER TABLE click_events ADD COLUMN reason TEXT;
ALTER TABLE click_events ADD COLUMN region TEXT;
ALTER TABLE click_events ADD COLUMN city TEXT;

-- manual reclassification
ALTER TABLE open_events  ADD COLUMN original_classification TEXT;
ALTER TABLE open_events  ADD COLUMN overridden_at INTEGER;
ALTER TABLE click_events ADD COLUMN original_classification TEXT;
ALTER TABLE click_events ADD COLUMN overridden_at INTEGER;

-- per-recipient send bookkeeping (Phase 1 sent per recipient but stored only the first ids)
ALTER TABLE recipients ADD COLUMN provider_msg_id TEXT;
ALTER TABLE recipients ADD COLUMN thread_id       TEXT;
ALTER TABLE recipients ADD COLUMN rfc822_msg_id   TEXT;
ALTER TABLE recipients ADD COLUMN sent_at         INTEGER;
ALTER TABLE recipients ADD COLUMN state           TEXT NOT NULL DEFAULT 'not_opened';
ALTER TABLE recipients ADD COLUMN notify_muted    INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_recipients_state ON recipients(state);

-- self-copy + mute bookkeeping
ALTER TABLE messages ADD COLUMN self_copy_strategy TEXT;
ALTER TABLE messages ADD COLUMN self_copy_msg_id   TEXT;
ALTER TABLE messages ADD COLUMN notify_muted       INTEGER NOT NULL DEFAULT 0;

-- back-fill the materialised state for existing rows
UPDATE recipients SET state = CASE
  WHEN open_count = 0 AND machine_open_count = 0 THEN 'not_opened'
  WHEN open_count = 0                            THEN 'prefetched'
  WHEN click_count > 0                           THEN 'read_confirmed'
  WHEN open_count >= 2 AND COALESCE(last_open_at,0) - COALESCE(first_open_at,0) > 60000
                                                 THEN 'read_confirmed'
  ELSE 'opened' END;
UPDATE recipients SET sent_at = (SELECT m.sent_at FROM messages m WHERE m.id = recipients.message_id);

-- notification queue (the 001 stub was never used)
DROP TABLE notifications;
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  trigger         TEXT NOT NULL,       -- first_open | read_confirmed | click | prefetched
  channel         TEXT NOT NULL,       -- slack | discord | webhook | ntfy
  message_id      TEXT REFERENCES messages(id)   ON DELETE CASCADE,
  recipient_id    TEXT REFERENCES recipients(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,       -- open | click
  event_id        TEXT,
  dedupe_key      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL,       -- pending | sent | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(dedupe_key);
CREATE INDEX idx_notifications_due   ON notifications(status, next_attempt_at);
CREATE INDEX idx_notifications_recip ON notifications(recipient_id);

CREATE TABLE notification_dead_letters (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  recipient_id    TEXT,
  channel         TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  attempts        INTEGER NOT NULL,
  last_error      TEXT,
  failed_at       INTEGER NOT NULL
);
CREATE INDEX idx_dead_letters_failed ON notification_dead_letters(failed_at DESC);

CREATE TABLE ip_range_sets (
  name        TEXT PRIMARY KEY,        -- apple_relay | google_proxy | datacenter
  source_url  TEXT,
  generated_at INTEGER,
  updated_at  INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  sha256      TEXT NOT NULL
);
```
`src/db/index.ts` gains `export const EXPECTED_SCHEMA = 2;` used by `doctor` and `/healthz`.
`notification_dead_letters.recipient_id` carries no FK on purpose (it must survive the notification
row) — `forget` deletes by it explicitly.

### 7.2 Per-file change list

**New files**

| Path | Contents |
|---|---|
| `src/notify/types.ts` | §2.2 types |
| `src/notify/bus.ts` | `EventBus` (§2.3) |
| `src/notify/policy.ts` | `decideTriggers`, `dedupeKey` (§2.4) |
| `src/notify/payload.ts` | `buildPayload(e, notificationId, config)` incl. redaction |
| `src/notify/queue.ts` | queue SQL + `backoffMs` (§2.5) |
| `src/notify/worker.ts` | `NotifyWorker` (§2.6) |
| `src/notify/channels/{slack,discord,webhook,ntfy,index}.ts` | notifiers + `buildNotifiers(config)` |
| `src/core/cidr.ts`, `src/core/ranges.ts` | CIDR parsing + `RangeIndex` (§4.1) |
| `src/core/doctor.ts` | pure check functions (§3.3) |
| `src/core/tunnel.ts` | `buildTunnelPlan` (§3.2) |
| `src/server/services/record.ts` | `recordOpen`/`recordClick`: classify → redact → insert → counters → state → `TrackingEvent[]` |
| `src/server/services/reclassify.ts` | §4.4 |
| `src/server/routes/stream.ts` | SSE (§2.8) |
| `src/server/routes/reclassify.ts` | `POST /api/events/:kind/:id/reclassify` |
| `src/jobs/scheduler.ts`, `src/jobs/prune.ts`, `src/jobs/ranges.ts` | §5.2 |
| `src/db/erase.ts` | `planForget` / `executeForget` |
| `src/db/report.ts` | `accuracyReport` |
| `src/mail/oauth.ts`, `src/mail/selfcopy.ts`, `src/mail/imap.ts` | §6, §4.2 |
| `src/db/migrations/002_phase2.sql` | §7.1 |
| `src/cli/commands/{doctor,tunnel,auth,update-ranges,reclassify,forget,accuracy,notifications,notify-test,mute}.ts` | §7.4 |
| `data/ranges/{apple-relay,google-proxy,datacenter}.cidr` | shipped data (§4.1) |
| `scripts/curl-smoke-phase2.sh`, `scripts/fake-receiver.mjs` | §7.6 |
| `docs/deploy.md`, `docs/notifications.md` | tunnel/Fly guide; payload schema + Node and Python verifiers |

**Modified files**

| Path | Change |
|---|---|
| `src/types.ts` | `ClassifyContext`: `+isGoogleProxyIp`, `+isDatacenterIp`, `+hasCountedOpen`. Re-export `RecipientState` helpers used by notify. |
| `src/config/env.ts` | ~30 new variables (§7.3) + cross-field validation (webhook secret, channel URLs, `SELF_OPEN_STRATEGY=insert` ⇒ smtp, `imap-append` ⇒ IMAP creds). |
| `src/core/classify.ts` | R2/R3 accept `isGoogleProxyIp`; R4 pushes `apple_ip`; `classifyClick` gains R6b; rule-id table comment updated with R10. |
| `src/server/app.ts` | `ServerDeps` gains `bus?`, `ranges?`, `notifyWorker?`, `scheduler?`; registers `stream.ts` and `reclassify.ts`; creates a default `EventBus` when none is injected. |
| `src/server/context.ts` | `buildClassifyContext(..., ranges, hasCountedOpen)`; the "Phase 1 ships no CIDR lists" comment is deleted. |
| `src/server/routes/pixel.ts` | Body replaced by a call to `recordOpen()`; publishes to the bus after the transaction commits. |
| `src/server/routes/click.ts` | Calls `recordClick()` (redaction + confidence/reason + back-fill); redirect behaviour unchanged. |
| `src/server/routes/api.ts` | `GET /api/recipients/:id/events`, `GET /api/stats?since`, `DELETE /api/messages/:id`; auth hook now also guards the SSE and reclassify routes. |
| `src/db/repo.ts` | `+markRecipientSent`, `+getOpenEvent/getClickEvent`, `+updateEventClassification`, `+recomputeRecipientCounters`, `+setRecipientState`, `+setMute`, `+hasCountedOpen`, `+upsertRangeSet`; `insertClickEvent` writes `confidence/reason/region/city`; `pruneEvents` unchanged. |
| `src/db/index.ts` | `EXPECTED_SCHEMA`. |
| `src/server/routes/health.ts` | reports `expectedSchema` and `rangesLoaded`. |
| `src/server/present.ts` | recipient presenter returns the stored `state`; event presenters expose `overridden`, `originalClassification`, click `confidence`/`reasons`. |
| `src/cli/program.ts` | registers the 10 new commands. |
| `src/cli/commands/send.ts` | click tracking on by default; recipient row created once before the tracking branches; the injected pixel URL is the one reported (no second cache-buster); per-recipient provider ids via `markRecipientSent`; self-copy hook after the last recipient; `--mute`. |
| `src/cli/commands/serve.ts` | builds `RangeIndex`, `EventBus`, `NotifyWorker` (attach + start) and `Scheduler`; shutdown stops both before closing the DB. |
| `src/cli/commands/show.ts` | shows overrides, click reasons and notification status per recipient. |
| `src/mail/transport.ts` / `gmail.ts` | refresh token resolved via `resolveRefreshToken`; `invalid_grant` → `GmailAuthError`; `GmailTransport` exposes its raw client for `selfcopy`. |
| `package.json` | `imapflow ^1.0` as an **optional** dependency (dynamic import); no other runtime deps (Node 22 `fetch`, `node:dns`, `node:tls`). |
| `.env.example`, `README.md` | every new variable, the notification quick start, the tunnel/doctor procedure, the OAuth procedure. |

### 7.3 New environment variables (beyond §2.9)

| Variable | Default | Meaning |
|---|---|---|
| `TRACK_CLICKS_DEFAULT` | `true` | Click tracking on unless `--no-track-clicks`. |
| `CLICK_BACKFILL_OPENS` | `true` | Enable the click→open back-fill. |
| `RANGES_DIR` | `./data/ranges` | Directory holding the `.cidr` files. |
| `RANGES_ENABLED` | `true` | `false` ⇒ `EMPTY_RANGE_INDEX` (Phase 1 behaviour). |
| `SELF_OPEN_STRATEGY` | `window` | `window` \| `insert` \| `imap-append`. |
| `IMAP_HOST` / `IMAP_PORT` / `IMAP_USER` / `IMAP_PASS` / `IMAP_SENT_MAILBOX` | `imap.gmail.com` / `993` / – / – / `[Gmail]/Sent Mail` | Required for `imap-append`. |
| `PRUNE_ENABLED` | `true` | Scheduled retention pruning. |
| `PRUNE_INTERVAL_HOURS` | `24` | Prune job interval. |
| `PRUNE_ON_START` | `false` | Run the prune job once at startup. |
| `PRUNE_VACUUM_THRESHOLD` | `10000` | Rows deleted before a `VACUUM`. |
| `JOBS_ENABLED` | `true` | Master switch for the scheduler. |
| `OPENPOST_CONFIG_DIR` | `~/.config/openpost` | OAuth token store location. |
| `DOCTOR_TIMEOUT_MS` | `5000` | Per-network-check timeout. |

### 7.4 CLI additions (full spec)

```
openpost doctor [--url <base>] [--timeout <ms>] [--offline] [--json]
    Runs the §3.3 check table. Exit 0 unless a check fails. --json prints {ok, checks[]}.

openpost tunnel [--provider cloudflare|ngrok|flyio] [--port <n>] [--hostname <host>]
                [--exec] [--json]
    Prints prerequisites, commands, env exports, the verify command and warnings.
    --exec runs the provider binary if it is already on PATH; otherwise exits 2 with an install hint.

openpost auth gmail [--port <n>] [--with-insert] [--no-browser] [--print-only] [--json]
openpost auth status [--json]
openpost auth revoke [--yes]

openpost update-ranges [--source apple|google|all] [--from-file <path>] [--out-dir <dir>]
                       [--force] [--dry-run] [--json]

openpost reclassify <eventId> --kind open|click --to <classification>
                    [--counted|--not-counted] [--note <text>] [--json]

openpost forget <email> [--dry-run] [--yes] [--purge-bodies] [--full] [--json]

openpost accuracy [--since 30d] [--json]

openpost notifications list [--status pending|sent|failed] [--limit <n>] [--json]
openpost notifications retry <id> | --all-failed
openpost notifications purge [--days <n>]

openpost notify test [--channel <name>] [--trigger <name>] [--json]

openpost mute <messageId> [--recipient <recipientId>] [--off]
```
Exit codes unchanged: `0` ok, `1` runtime error, `2` bad usage/config.

### 7.5 Test plan — cases 49–120

All offline, `DB_PATH=':memory:'`, fake clock, injected `fetch`, `app.inject()`. New files:
`tests/unit/{cidr,doctor,tunnel,notify-policy,notify-channels,notify-queue,oauth}.test.ts`,
`tests/integration/{notify-flow,sse,click-backfill,reclassify,forget,jobs,doctor-flow,selfcopy,
update-ranges,migrate-v2,accuracy}.test.ts`, `tests/fixtures/{apple-egress.csv,goog.json,
ranges/*.cidr}`.

**cidr.test.ts**
49. `parseCidr` maps `10.0.0.0/24` and `2a01:b740::/32` to the right start/end bigints; `/0` and `/32` edges.
50. `contains` is inclusive at both boundaries and false one address outside, v4 and v6.
51. Comments, header lines, blank lines and malformed entries are skipped without throwing.
52. `loadRangeIndex` on a missing directory returns empty sets and does not throw.
53. Shipped `apple-relay.cidr` contains `17.1.2.3` and not `8.8.8.8`; `google-proxy.cidr` contains a known `goog.json` prefix.
54. `mergeRanges` coalesces overlapping/adjacent ranges and leaves the list sorted.
55. `parseRangeFile` records `sha256`, `entries` and `generated_at` from the header; a `# name` mismatch yields an empty set plus a warning.

**classify.test.ts (extended)**
56. Apple relay IP, non-Apple UA, 2 min after send → `apple_mpp`, counted 0, reasons `['R4','apple_ip']`.
57. Google-proxy IP with a plain browser UA outside the prefetch window → `human` via R3, counted 1.
58. Click from a datacentre IP with `hasCountedOpen=false` → `scanner`, counted 0, reasons `['R6b']`.
59. Same click with `hasCountedOpen=true` → `human`, counted 1.

**notify-policy.test.ts**
60. First counted open → `['first_open']`; counters `openCount===1`.
61. Second counted open with no state change → `[]`.
62. Transition `opened → read_confirmed` → `['read_confirmed']`.
63. Counted click → `['click']`; with the state also flipping → `['read_confirmed','click']`, deduped per channel.
64. Click with no prior open: the back-filled open yields `[]` (P2) and the click yields one trigger ⇒ exactly one notification.
65. `apple_mpp` only → `[]`; with `NOTIFY_ON` including `prefetched` and `not_opened→prefetched` → `['prefetched']`.
66. `opt_out`, `dnt`, `self_open`, `duplicate`, `bot` → `[]` in every configuration.
67. `message.notify_muted` or `recipient.notify_muted` → `[]`.
68. `dedupeKey` is stable for the same (trigger, recipient) and differs per channel and per click event.

**notify-channels.test.ts** (injected `fetch` recorder)
69. Slack body has `text` + two blocks; `<`, `>`, `&` in the subject are escaped; `NOTIFY_REDACT_EMAIL=true` yields `a***@example.com`.
70. Discord body has one embed with title/description/color/fields; `429` + `Retry-After: 2` → `{retryable:true, retryAfterMs:2000}`.
71. Webhook sends exactly the headers of §2.7; `X-Openpost-Signature` equals `sha256=` + HMAC over `${ts}.${body}`.
71b. The verifier snippet from `docs/notifications.md` accepts that delivery and rejects a body with one byte changed and a timestamp 10 minutes old.
72. Webhook `500` → retryable; `400` → not retryable; `408`/`429` → retryable.
73. ntfy posts to `${NTFY_URL}/${NTFY_TOPIC}` with `Title`/`Priority`/`Tags`; `Authorization` only when `NTFY_TOKEN` is set.
74. A `fetch` that never resolves is aborted after `NOTIFY_TIMEOUT_MS` and returns a retryable error.

**notify-queue.test.ts**
75. `backoffMs` yields 1s, 2s, 4s, 8s before jitter, caps at 300s, stays within ±20 %.
76. `enqueue` twice with the same dedupe key → second returns `null`, one row exists.
77. `claimDue` returns only pending rows with `next_attempt_at <= now`, ordered, limited; claiming bumps `attempts`.
78. Three consecutive retryable failures → `status='failed'`, `last_error` set, exactly one dead-letter row.
79. Failure then success → `status='sent'`, `sent_at` set, no dead letter.
80. A non-retryable failure fails on the first attempt without consuming the retry budget.

**notify-flow.test.ts (integration)**
81. Pixel hit after the ignore window with a browser UA → one delivery per configured channel within one `tickOnce()`; `notify.deliver` audit rows present.
82. Apple-MPP-only recipient → zero notifications, recipient state `prefetched` (DoD 5).
83. Worker restart: a pending row enqueued by a previous "process" is delivered by a fresh worker instance.
84. `notifications retry --all-failed` moves a dead letter back to `pending` and the next tick delivers it.

**sse.test.ts**
85. `GET /api/events/stream` returns `text/event-stream` + `no-store` and writes `retry: 3000` first.
86. A pixel hit produces an `event: tracking` frame whose `data` parses to a `NotificationPayload` with the right `event.id`.
87. Advancing the clock emits `: ping`; closing the request unsubscribes (`bus.size()` returns to 0).
88. Non-loopback bind without a bearer token → 401; with it → 200.

**click-backfill.test.ts**
89. Counted click with no prior open → 302 to the exact original URL, one counted click, one open with `reason` containing `implied_by_click`, `open_count=1`, state `read_confirmed`.
90. `HEAD` on the click URL → `scanner`, counted 0, no back-fill.
91. A second counted click adds no second implied open.
92. Click events are redacted per `PRIVACY_MODE` (balanced: `ua` null, `ua_family` kept; strict: all identity columns null) and store `confidence`/`reason`.
93. `--no-track-clicks` produces HTML with no `/c/` links; default send rewrites them.

**reclassify.test.ts**
94. `POST /api/events/open/:id/reclassify` bot→human: counters recomputed, state changes, one `reclassify.override` audit row with before/after, **zero** notifications enqueued.
95. Click human→scanner also removes the orphaned implied open and decrements `click_count`.
96. Unknown id → 404; a classification outside the enum → 400; a second override keeps the first `original_classification`.
97. `openpost reclassify --json` prints `{before, after, recipient}`.

**forget.test.ts**
98. `--dry-run` reports counts and changes nothing.
99. Real run deletes events, click tokens, notifications, dead letters and recipients; a message left with no recipients is deleted; a shared message survives.
100. Exactly one audit row; its JSON contains no raw address and `subject_id` is the 16-char hash.
101. `--purge-bodies` nulls the bodies of surviving messages; `--full` also drops the suppression row.
102. After `forget`, a pixel hit on the old token → 200 + GIF, zero events, one `token.orphan`.

**jobs.test.ts**
103. `runDue` runs the prune job once, writes the `jobs` row, and skips it before the interval elapses.
104. A throwing job records `last_status='error'` and the scheduler keeps running the others.
105. `PRUNE_ENABLED=false` ⇒ the job is never registered.

**doctor-flow.test.ts / doctor.test.ts / tunnel.test.ts**
106. `checkPixelProbe` passes on a correct probe and fails separately for: wrong content-type, length ≠ 43, present `ETag`, `redirected: true`, status ≠ 200.
107. `checkProxyContract` fails for `TRUST_PROXY=true` + non-loopback bind and for `TRUST_PROXY=false` + public https base URL.
108. `checkBaseUrl` warns on `*.trycloudflare.com` / `*.ngrok-free.app`.
109. End-to-end doctor against the inject-driven app with an injected fetch → `ok:true`, exit 0; unreachable URL → exit 1 naming `pixel.reachable`.
110. `buildTunnelPlan('cloudflare')` returns the four `cloudflared` commands, the `TRACKING_BASE_URL`/`TRUST_PROXY` exports and the doctor verify line; `ngrok` carries the blocklist warning; `flyio` names the volume and `min_machines_running = 1`.

**oauth.test.ts**
111. `buildAuthUrl` contains `access_type=offline`, `prompt=consent`, `code_challenge_method=S256`, the loopback `redirect_uri` and every requested scope (`gmail.insert` only with `--with-insert`).
112. `exchangeCode` against a fake token endpoint writes the store; `fs.statSync(path).mode & 0o777 === 0o600`.
113. A `state` mismatch writes no file and reports an error; a response without `refresh_token` fails with the documented message.
114. `resolveRefreshToken` prefers `GOOGLE_REFRESH_TOKEN` over the file and reports the source.
115. A Gmail `invalid_grant` is surfaced as `GmailAuthError` carrying the remedy string.

**selfcopy.test.ts**
116. `insertSentCopy` calls `users.messages.insert` with `internalDateSource:'dateHeader'`, `labelIds:['SENT']`, and a `raw` that decodes to a MIME with **no** `/o/` pixel, original `href`s, the same `Message-ID` as the delivered copy and `X-Openpost-Self-Copy: 1`.
117. An insert failure leaves the send successful and writes a `selfcopy.failed` audit row.
118. `loadConfig` rejects `SELF_OPEN_STRATEGY=insert` with `MAIL_TRANSPORT=gmail`, and `imap-append` without IMAP credentials.
119. `appendSentCopy` calls `append('[Gmail]/Sent Mail', raw, ['\\Seen'], date)` on the injected client.

**migrate-v2 / update-ranges / accuracy**
120. (a) `migrate` on a **populated** v1 DB → 2 with every pre-existing row intact, new columns defaulted, `recipients.state` back-filled correctly for all four shapes, `notifications` empty; running it again returns 2. (b) `update-ranges --from-file tests/fixtures/apple-egress.csv` writes a valid `.cidr` (header + sorted entries), upserts `ip_range_sets`, audits `ranges.update`; `--dry-run` writes nothing; a > 50 % shrink is refused without `--force`. (c) `accuracyReport` rule counts match an independent SQL cross-check on a seeded DB, `--since 7d` filters, and `--json` matches the documented shape.

### 7.6 Manual verification (curl) — `scripts/curl-smoke-phase2.sh`

```bash
# 0) prepare (same as Phase 1, plus a local receiver and a webhook secret)
export TRACKING_SECRET=$(node -e "console.log(require('crypto').randomBytes(36).toString('base64'))")
export TRACKING_BASE_URL=http://127.0.0.1:8787
export FROM_EMAIL=you@example.com
export WEBHOOK_URL=http://127.0.0.1:9099/hook WEBHOOK_SECRET=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
export NOTIFY_CHANNELS=webhook NOTIFY_ON=first_open,read_confirmed,click
npm run build && node dist/cli/index.js migrate        # schema: 1 -> 2

# 1) a receiver that prints headers and verifies the signature
node scripts/fake-receiver.mjs 9099 &                  # prints VALID/INVALID per delivery

# 2) send (click tracking is on by default now)
node dist/cli/index.js send --to alice@example.com --subject "hello" \
  --html '<p>Hi <a href="https://example.com/x?a=1#f">link</a></p>' --dry-run --json

# 3) serve + subscribe to SSE in another shell
node dist/cli/index.js serve
curl -N http://127.0.0.1:8787/api/events/stream

# 4) a human-looking open after the ignore window -> expect one SSE frame and one VALID delivery
sleep 11
PIXEL=$(node dist/cli/index.js show <messageId> --json | jq -r '.recipients[0].pixelUrl')
curl -s -o /dev/null -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36" \
     -H 'Accept: image/avif,image/webp,*/*' "$PIXEL"

# 5) click -> exact original URL, counted click, and (if no open yet) one back-filled open
CLICK=$(node dist/cli/index.js show <messageId> --json | jq -r '.recipients[0].links[0].clickUrl')
curl -s -D - -o /dev/null "$CLICK"        # 302, location: https://example.com/x?a=1#f

# 6) notification bookkeeping + a deliberate failure
node dist/cli/index.js notifications list --json | jq '.[0] | {trigger,channel,status,attempts}'
kill %1 && curl -s -o /dev/null "$PIXEL"  # receiver down -> retries -> failed + dead letter
node dist/cli/index.js notifications list --status failed

# 7) accuracy, doctor, ranges
node dist/cli/index.js accuracy --since 1d
node dist/cli/index.js doctor --url http://127.0.0.1:8787            # all pass/warn, exit 0
node dist/cli/index.js update-ranges --source apple --from-file tests/fixtures/apple-egress.csv --dry-run

# 8) privacy
node dist/cli/index.js forget alice@example.com --dry-run
node dist/cli/index.js forget alice@example.com --yes
curl -s -o /dev/null -D - "$PIXEL"        # still 200 + 43-byte GIF, zero events, token.orphan
```
Operator-only (documented, not run in CI): `openpost tunnel --provider cloudflare --hostname
t.example.com`, then `openpost doctor --url https://t.example.com`, then `openpost auth gmail`, then
one real send with `MAIL_TRANSPORT=smtp SELF_OPEN_STRATEGY=insert`. Results go into
`docs/reports/phase2_smoke.md` in the same style as the Phase 1 report, including anything that
behaved differently from this spec.

### 7.7 Acceptance criteria (Phase 2 sign-off)

1. `npm ci && npm run build && npm test` green offline with no credentials; coverage thresholds of
   DoD 1 met; cases 49–120 present and passing; the 62 Phase 1 tests still pass unmodified in intent.
2. `openpost migrate` upgrades a populated v1 DB to v2 with zero row loss; `/healthz` shows
   `schema: 2`.
3. One counted open ⇒ exactly one notification per channel, delivered < 5 s, `notify.deliver`
   audited; retries back off 1s/2s/4s and dead-letter after 4 attempts with `last_error`.
4. Apple-MPP-only and bot-only recipients produce zero notifications and never report `opened`.
5. Signed webhook deliveries verify with both shipped verifier samples; a tampered body fails.
6. SSE streams a `tracking` frame per event plus heartbeats, and is auth-gated off loopback.
7. Click tracking is on by default, redirects byte-for-byte, back-fills exactly one implied open,
   and never produces two notifications for one click.
8. Apple/Google ranges ship, load at startup, appear in `doctor`, and drive R4/R3/R6b.
9. `SELF_OPEN_STRATEGY=insert` inserts an untracked Sent copy with the documented Gmail call and
   never breaks a send when it fails.
10. `reclassify`, `forget`, `accuracy`, `doctor`, `tunnel`, `auth gmail`, `update-ranges`,
    `notifications` and `mute` all exist with the flags above, exit-code conventions and `--json`
    output.
11. No raw email address, IP, token or secret appears in any `audit_log` row added by Phase 2
    (asserted automatically in the forget and notify tests).
12. `README.md`, `docs/deploy.md` and `docs/notifications.md` document every new variable, the
    tunnel decision table, the signature scheme with two verifier samples, and the statement that
    Phase 2 remains fully testable with no public URL and no Gmail credentials.

---

## 8. Mailtrack parity scorecard

| Feature | Mailtrack | openpost after Phase 1 | openpost after Phase 2 |
|---|---|---|---|
| Open tracking (pixel) | yes | yes | yes |
| Per-recipient tracking | paid tiers | yes | yes |
| Real-time notification of a read | yes (extension + push + email) | **no** | yes — Slack, Discord, signed webhook, ntfy, SSE |
| Notification of a *confirmed* read (not a prefetch) | no | n/a | yes (`read_confirmed` trigger) |
| Click tracking | paid | implemented, off by default | **on by default** |
| Click → open back-fill (image blockers) | no | no | yes (`implied_by_click`) |
| Gmail-proxy / Apple-MPP false-positive filtering | no (counted as opens) | rules present; Apple IP branch dead | yes — shipped, updatable Apple + Google CIDR sets |
| Explicit "prefetched, read not confirmed" state | no | yes | yes, and it is what suppresses the notification |
| Self-open elimination | time window only | send window + fingerprint | + structural untracked Sent copy (`insert` / `imap-append`) |
| Explainable classification (rule ids per event) | no | yes | yes |
| Human override of a classification | no | no | yes (API + CLI + audit) |
| Accuracy self-report | no | no | yes (`openpost accuracy`) |
| Location reporting | shows proxy datacentre as "location" | not stored | still not stored; proxied opens labelled "unknown (proxied)" |
| Real-time desktop/phone without an extension | no | no | yes (ntfy / Slack / Discord) |
| Public JSON API + CLI | no | yes | yes + SSE + reclassify + stats |
| Dashboard | yes (web app) | CLI only | CLI + SSE stream (UI in Phase 3) |
| Reminders / reply detection | yes (paid) | no | no (Phase 3) |
| Mail merge / campaigns | yes (paid) | no | no (Phase 4) |
| Self-hosted, data never leaves your box | no | yes | yes |
| "Sent with Mailtrack" signature injection | yes on free tier | never | never |
| Raw IP storage | yes (server-side) | never (daily-salted hashes) | never |
| Recipient opt-out that disables future tracking | no | yes | yes |
| DNT / GPC honoured | no | yes | yes |
| Enforced retention + one-command erasure | no | prune command | prune **scheduled** + `openpost forget` |
| Append-only audit log | no | yes | yes (+ notify, override, erasure, ranges) |
| Dry-run rendering of the exact outgoing MIME | no | yes | yes |
| Price / limits | per-seat subscription, tracked-mail caps | free, self-hosted | free, self-hosted |

Remaining Mailtrack advantages after Phase 2: in-Gmail checkmarks (browser extension, Phase 4),
a hosted web dashboard (Phase 3), reminders and campaign tooling (Phases 3–4), and zero-setup
onboarding — openpost needs a public HTTPS hostname, which §3 reduces to four `cloudflared`
commands plus `openpost doctor`.

---

## 9. Summary of key decisions

1. Notifications are a **durable queue, not an emitter**: an in-process bus fans out to SSE and to a
   SQLite-backed queue with dedupe keys, so delivery is exactly-once per (channel, trigger,
   recipient) and survives restarts.
2. Notification policy is expressed as **state transitions** (`prevState → newState`) plus
   `isFirstCountedOpen`, never as raw event counts, so prefetches and duplicates can never page you.
3. The click→open back-fill publishes a `backfilled` event that policy suppresses, so one human
   click produces exactly one notification.
4. Migration 002 is additive except for the never-used `notifications` stub, which is dropped and
   rebuilt; `recipients.state` is materialised so transitions are cheap and the dashboard is trivial.
5. Accuracy data (Apple relay, Google proxy, datacentre) ships **in the repo** as plain `.cidr` files
   with a header and a checked update path (`--from-file` is the tested one), so a fresh clone is
   accurate offline and `isAppleRelayIp` stops being a dead branch.
6. `SELF_OPEN_STRATEGY=insert` is defined precisely as *SMTP delivery + `users.messages.insert` with
   `labelIds:['SENT']` and `internalDateSource:'dateHeader'`*, and is rejected at config time with
   `MAIL_TRANSPORT=gmail`, because `messages.send` always writes its own tracked Sent copy.
7. Reclassification **recomputes counters from the event tables** rather than patching deltas, which
   makes overrides, erasure and pruning mutually consistent by construction.
8. Public exposure is planned, not automated: `openpost tunnel` prints verbatim commands and
   `openpost doctor` proves the result, with a hard `TRUST_PROXY` safety rule so a misconfiguration
   fails loudly instead of silently poisoning every IP hash.
9. Gmail consent is the **loopback + PKCE** flow (device flow is not allowed for Gmail scopes), with
   a `0600` token file, env-over-file precedence, and `invalid_grant` surfaced as one actionable line.
10. Everything remains testable with no public URL and no Gmail credentials: pure cores plus injected
    `fetch`, Gmail and IMAP clients; the only operator-run steps are the tunnel, the real OAuth
    consent and one live send, each documented for `docs/reports/phase2_smoke.md`.

---

## 10. Phase 2.1 amendments

Following an independent code review (`docs/reports/phase2_review.md`), this spec is amended as
follows; the implementation follows these amended rules, not the original text above where they
conflict.

1. **R3 no longer accepts the IP-only Google signal** (finding #3): §4.1's "R2/R3 test
   `ctx.uaInfo.isGoogleProxy || ctx.isGoogleProxyIp` instead of the UA flag alone" is wrong for R3.
   The IP-only signal (`isGoogleProxyIp`) remains valid, non-terminal evidence for R2 (same-window
   prefetch suppression) - a proxy fetch with an unusual UA string is still worth suppressing - but
   R3's counted-human-open branch now requires the actual `GoogleImageProxy` UA
   (`ctx.uaInfo.isGoogleProxy`) on its own. A shipped Google-owned range can carry arbitrary
   customer/scanner traffic; crediting *any* hit from one as a counted human open, ahead of R5/R6/R7
   in rule order, let a bot-shaped UA (e.g. `curl/8.0`) from that range be counted as human before
   the bot check ever ran. Test #57 (§8, "Google-proxy IP with a plain browser UA... → `human` via
   R3") is corrected: that scenario now falls through to an ordinary R9 human open, not R3.
2. **`google-proxy.cidr` ships only real Gmail image-proxy egress** (finding #3, same root cause):
   `64.233.160.0/19`, `66.102.0.0/20`, `66.249.64.0/19`, `2001:4860::/32`. The two `goog.json`-derived
   general-GCP prefixes previously shipped here (`34.64.0.0/10`, `35.190.0.0/17`) moved to
   `datacenter.cidr` instead, where they reinforce click-scanner detection (R6b) without ever
   granting the R3 "this is Gmail's proxy" credit. Test #53 is corrected accordingly.
3. **IPv6 parsing only treats the exact `::ffff:a.b.c.d` / bare `::a.b.c.d` shorthand as IPv4**
   (finding #4): `src/core/cidr.ts`'s `ipToBigInt` (and `src/core/privacy.ts`'s `netOf`, same class of
   bug) previously took *everything after the last colon* as an embedded IPv4 literal, so a genuine
   IPv6 address that merely ends in a dotted quad (e.g. `dead:beef::17.1.1.1`) was silently reduced to
   its bare v4 octets and could borrow a v4 CIDR match (or a v4-keyed fanout/dedupe bucket) it was
   never actually inside. Every other IPv6 literal is now parsed as a genuine 128-bit value. The CIDR
   parser also now rejects a leading-zero IPv4 octet (avoids an octal/decimal parser mismatch) and a
   `::` that doesn't actually elide any group.
4. **Schema is now v4** (finding #6): `004_notify_sending_state.sql` adds `notifications.claimed_at`
   and a `sending` status distinct from `pending`, so a row actively leased for delivery is
   observable as such (`notifications list`/doctor) instead of looking identical to one merely
   waiting its turn. `EXPECTED_SCHEMA` is `4`; doctor/`/healthz` are unchanged otherwise.
5. **Notifications are enqueued inside the same transaction as the event they're for** (finding #6):
   `recordOpen`/`recordClick` (`src/server/services/record.ts`) take an `onEvent` hook that
   `NotifyWorker.enqueueForEvent` is wired into from the pixel/click routes when a worker is
   attached, so the event row and its notification row(s) commit or roll back together. The
   bus-published, `NotifyWorker.attach()`-driven path (§2.3) is kept as well, both for backward
   compatibility with any caller that only wires up the bus and as a harmless (dedupe-key-guarded)
   backstop.
6. **P6 supersedes P5 on the same event** (finding #2): §2.4's policy table produces exactly one
   trigger, `click`, for a counted click that also flips the recipient into `read_confirmed` -
   never `[read_confirmed, click]`. An *open* event's own P5 is unaffected. Tests #63/#64 are
   corrected accordingly (DoD 8's "one click, one notification" was already the intent; the
   implementation just didn't honour it for this specific transition).
