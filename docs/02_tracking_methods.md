# 02 — Tracking Methods

How opens and clicks are detected, how false positives are removed, and what we refuse to store.

---

## 1. Pixel embedding

### 1.1 URL design

```
https://<TRACKING_DOMAIN>/o/<token>.gif?v=<cachebuster>
```

Rules:

- **Path prefix `/o/`** — two characters, no words like `track`, `pixel`, `open`, `beacon`, `spy`.
- **`.gif` suffix** — mail clients and proxies treat it as an image; some corporate proxies refuse
  extension-less image URLs.
- **`?v=` cache-buster** — 8 random base32 chars generated at *send* time, per recipient. It does not
  defeat the Gmail proxy cache (see 1.3) but defeats intermediate corporate caches and Outlook's
  local cache, and makes each recipient's URL globally unique.
- **HTTPS only.** A plain-http pixel is stripped or blocked by most clients and is a spam signal.
- **No query parameters that carry meaning.** All state is inside the token; `v` is ignored by the
  server (accepted and discarded) so that a truncated or rewritten query string cannot break tracking.
- Hostname should be a subdomain of the sending domain when possible (`t.example.com` for
  `you@example.com`) — see §4.

### 1.2 HMAC-signed tokens

Tokens are **opaque + signed**: opaque so nothing about the recipient leaks into the URL, signed so
forged or scanned tokens are rejected without touching the database.

```
token      = "1" + BASE32( rid )  + "." + BASE32( sig )
rid        = 16 random bytes (CSPRNG)                     -> 26 chars
sig        = HMAC_SHA256( key = TRACKING_SECRET,
                          msg = "o" | "c" | "u" ‖ 0x00 ‖ rid )[0..9]   -> 10 bytes -> 16 chars
```

- Total token length ≈ 44 chars; full URL ≈ 90 chars. Short enough not to trigger line-wrapping
  mangling in quoted-printable bodies (we still encode with base64 for the HTML part, see §4).
- The **purpose byte** (`o` open / `c` click / `u` opt-out) is part of the signed message, so an open
  token can never be replayed as a click or opt-out token.
- `rid` is the primary key material: `recipients.token` for opens, `click_tokens.id`
  (Phase 2: `links` × `recipients`) for clicks. Verification is **verify signature first, then a
  single indexed lookup** — invalid tokens cost one HMAC and no I/O.
- Comparison uses `crypto.timingSafeEqual`.
- `TRACKING_SECRET` is ≥ 32 bytes, stored only in the environment. A SHA-256 fingerprint of it is
  written to `settings` at `init` so the server can warn loudly when the secret changes (all existing
  tokens become unverifiable).
- **Key rotation** is supported by a version prefix (`"1"`), plus `TRACKING_SECRET_PREVIOUS`: verify
  against current, then previous; new tokens always sign with current.

### 1.3 Response and cache-busting headers

```
HTTP/1.1 200 OK
Content-Type: image/gif
Content-Length: 43
Cache-Control: no-store, no-cache, must-revalidate, max-age=0, private
Pragma: no-cache
Expires: 0
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

Body: the canonical 43-byte fully transparent 1×1 GIF89a
(`R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7`), served from a module-level constant.

- **No ETag, no Last-Modified.** Either one invites `304 Not Modified` replies, and a 304 is not an
  open we can count reliably.
- **Always `200`.** Invalid token, opted-out recipient, unknown token: still 200 + GIF. A 404 tells a
  probing recipient exactly which URLs are live.
- Handler writes the response **before** persisting the event (fire-and-forget insert on the next
  tick) so pixel latency stays < 5 ms; a failed insert is logged to `audit_log`, never surfaced.

### 1.4 The Gmail image proxy

Gmail rewrites every `<img src>` to
`https://ci[0-9].googleusercontent.com/meips/.../https://t.example.com/o/<token>.gif`
and fetches through it. Consequences:

| Behaviour | Impact | Our handling |
|---|---|---|
| The request comes from Google's network, not the recipient. | Recipient IP and real UA are **unavailable** for Gmail-web/Android/iOS readers. Geo and device for Gmail users is therefore *unknowable* by pixel alone. | We record `ua_family='GoogleImageProxy'`, `device_type='proxy'`, and **report location as "unknown (proxied)" rather than inventing Google's datacentre location** — this is where Mailtrack shows a wrong city. |
| UA is the fixed string containing `GoogleImageProxy` (typically `Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)`). | Easy, reliable identification. | Regex `/GoogleImageProxy/i` → `google_proxy`. |
| Gmail fetches images **when the message is rendered**, not on delivery — *except* that the proxy warms its cache in some paths (notably when the message is opened in the tab-preview/prefetch or by Gmail's own scanning). | A fetch seconds after send, before any human could read it, is usually **not** a human open. | Rule `R1` (§6) drops opens inside `OPEN_IGNORE_SECONDS` of `sent_at` and labels them `google_proxy_prefetch`. |
| The proxy **caches** the image. Repeat opens by the same reader often do not reach us. | Open *counts* for Gmail recipients are a lower bound. | `no-store` + unique `?v=` maximise revalidation; the UI labels repeat counts for proxied readers as "≥ n". We never claim exact counts for proxied opens. |
| The proxy follows redirects and strips cookies. | Cookie-based sender identification is impossible on the pixel path. | Self-open detection uses time + token provenance instead (§3). |

### 1.5 Self-opens (the sender reading their own Sent copy)

Three layers, in order of strength:

1. **Don't track the sender's copy at all.** When sending through the Gmail API we control the exact
   MIME. Preferred path: `users.messages.send` with the tracked HTML (the recipient must receive the
   pixel), then — Phase 2 — reconcile: the Sent copy is the same MIME, so instead we mark the window.
   The clean variant, implemented in Phase 2 behind `SELF_OPEN_STRATEGY=insert`: send the tracked
   message via SMTP and insert an **untracked** copy into the Sent label with
   `users.messages.insert`. Cost: one extra API call and a `gmail.modify`-class scope; benefit: the
   sender's own opens are structurally impossible.
2. **Send-window suppression** (default, Phase 1): any open with `occurred_at - sent_at <
   OPEN_IGNORE_SECONDS` (default 10) is classified `google_proxy_prefetch`/`self_open` and not
   counted. This alone kills the majority of "it said read the moment I sent it" complaints.
3. **Sender fingerprint suppression** (Phase 2): the CLI/dashboard registers the operator's current
   public IP-hash and UA family (`SELF_IP_HASHES`, `SELF_UA_PATTERNS`). A **direct** (non-proxied)
   pixel fetch matching them is classified `self_open`. Only works for non-Gmail-proxied fetches, so
   it complements, not replaces, rule 2.

### 1.6 Apple Mail Privacy Protection (MPP) and other prefetchers

Since iOS 15 / macOS Monterey, Apple Mail (when MPP is on) **downloads every remote image shortly
after delivery, through an Apple relay**, regardless of whether the human ever opens the message.
Signals:

- Source IP belongs to Apple's relay/iCloud Private Relay egress ranges (maintained as a local,
  updatable CIDR list `data/apple-relay.cidr`; also `17.0.0.0/8` for Apple corporate).
- UA is a plausible desktop Safari/Mac UA, often identical across events.
- Timing: one fetch a few seconds to a few minutes after delivery, then silence.
- Pattern: **all** remote resources in the message are fetched in one burst (pixel + every image +
  nothing else), and the click endpoint is never touched.

Handling:

- Classify as `apple_mpp`, `counted = 0`, confidence 0.9.
- Show it in the UI as **"Delivered (image prefetch — not a confirmed read)"**, a state Mailtrack
  does not distinguish. This is a headline differentiator.
- Same treatment for other machine fetchers: Proofpoint/Mimecast/Barracuda link-and-image scanners,
  `curl`, `python-requests`, `HeadlessChrome`, `bot|crawler|spider|preview` UAs → `bot`.
- Heuristic reinforcement: if a single `ip_net_hash` produces opens for **many distinct recipients of
  different messages** within a short window, it is a scanner, not a person (rule `R7`).

---

## 2. Link rewriting (click tracking)

Applied only when `click_tracking_enabled` (CLI `--track-clicks`, default off in Phase 1, default on
in Phase 2 profiles).

**Algorithm** (`core/html.ts: rewriteLinks`):

1. Parse HTML with `cheerio` (`decodeEntities: false` to preserve the original markup).
2. For each `a[href]` in document order:
   - Skip if scheme is not `http:`/`https:` (`mailto:`, `tel:`, `sms:`, `#anchor`, `data:`).
   - Skip if the host equals `TRACKING_DOMAIN` (never rewrite our own pixel/opt-out links).
   - Skip if the anchor carries `data-no-track` or is inside `[data-no-track]`.
   - Skip `List-Unsubscribe` / opt-out links.
   - Insert a `links` row (message, url, anchor text ≤ 120 chars, position) once per distinct URL.
   - Replace `href` with `https://<TRACKING_DOMAIN>/c/<token>` where the token signs
     (`purpose='c'`, `rid = click_token_id`) and the click token row binds `(link_id, recipient_id)`.
3. The **original URL is stored verbatim** (query string, fragment, encoding). The redirect returns it
   byte-for-byte; we never re-encode, because re-encoding breaks signed URLs (S3 presigned, OAuth).
4. The plain-text alternative keeps **original, unrewritten** URLs. Rewritten URLs in plain text look
   like phishing and are the single biggest spam-score contributor of click tracking.
5. Redirect handler: verify → record → `302` with `Location`, `Referrer-Policy: no-referrer`,
   `Cache-Control: no-store`. On any internal error, still redirect to the original URL — **tracking
   failure must never break the user's link**. If the token is unverifiable we cannot know the target,
   so we send `302` to `TRACKING_FALLBACK_URL` (default: the sending domain root) or `404`.
6. Click classification: `HEAD` requests, known scanner UAs, and a click arriving *before* any open
   with a datacentre-range IP are `scanner`, `counted = 0`. A click always implies a human open even
   when the pixel never fired (blocked images) — so a counted click **back-fills** an
   `open_events` row with `classification='human'`, `reason='implied_by_click'` if the recipient has
   no counted open yet. Mailtrack does not do this; it is a real accuracy gain for image-blocking
   clients like Outlook-with-images-off.

---

## 3. Spam avoidance

**Domain and infrastructure**

- Use a **subdomain of the sending domain** for `TRACKING_DOMAIN` (`t.example.com`). Alignment with
  the From domain avoids the "links point to an unrelated domain" heuristic that shared tracking
  domains (mailtrack.email, etc.) trip.
- Never use a URL shortener, never use a free tunnel hostname (`*.ngrok-free.app`,
  `*.trycloudflare.com`) for production sends — those hostnames are heavily blocklisted. Tunnels are
  for **local testing only**.
- Valid TLS certificate, no redirects on the pixel URL, fast response (< 200 ms).
- Publish SPF, DKIM, DMARC for the sending domain. Gmail-API sends inherit Gmail's own DKIM.
- Keep volume low and human-paced (Phase 4 throttling: default ≤ 20 msg/min, jittered).

**Pixel and HTML structure**

- Path `/o/`, filename `<token>.gif` — avoid `open.gif`, `track.png`, `pixel.gif`, `t.php`.
- Markup: `<img src="…" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />`
  placed **just before `</body>`**, after the signature.
  - Do **not** use `display:none`, `visibility:hidden`, `opacity:0`, or 1-pixel white-on-white
    trickery — hidden-content heuristics score those.
  - Do **not** use `<div style="height:0">` wrappers.
- Always send `multipart/alternative` with a real `text/plain` part generated from the HTML
  (`htmlToText`). HTML-only mail is a strong spam signal.
- Keep a sane text-to-HTML ratio; no `<script>`, no `<iframe>`, no `<form>`, no remote CSS.
- One tracking pixel per message. Two pixels (some tools add a fallback) is a known signature.
- Add `List-Unsubscribe` + `List-Unsubscribe-Post` headers for bulk sends (Phase 4); for 1:1 mail
  omit them (they make personal mail look like marketing).
- `X-Mailer` header: omit entirely rather than advertising the tool.

---

## 4. Privacy

| Concern | Rule |
|---|---|
| **Raw IP** | Never persisted. On receipt: `ip_hash = HMAC_SHA256(IP_SALT ‖ yyyy-mm-dd, ip)[0..15]` hex, plus `ip_net_hash` over the /24 (IPv4) or /48 (IPv6) for device-grouping. The daily salt rotation means hashes are not linkable across days and are not reversible by dictionary attack on the IPv4 space (the salt is secret). Raw IP exists only in memory for the duration of the request, and geo lookup (if enabled) happens before hashing. |
| **User-Agent** | Stored raw only when `PRIVACY_MODE=off`. In `balanced` (default) we store only the parsed `ua_family` / `device_type` / `os`. In `strict` we store neither. |
| **Geo** | Optional and local-only (MaxMind GeoLite2 country/city DB on disk, no third-party API calls ever). `balanced` → country + region. `strict` → nothing. Proxied opens → always "unknown (proxied)". |
| **PRIVACY_MODE=strict** | Records only `(recipient_id, occurred_at, classification, counted)`. Everything else is NULL. Tracking still works; forensic detail does not exist. |
| **Opt-out** | Every tracked message may carry (`--optout-link`, mandatory for bulk in Phase 4) a footer link `https://t.example.com/u/<token>`. Visiting it: inserts into `suppressions`, sets `recipients.opted_out_at`, and from then on **every** pixel/click hit for that email address is recorded as `classification='opt_out'`, `counted=0` — and future sends to that address are sent **without any tracking** (the send path checks `suppressions` before injecting). |
| **DNT / GPC** | A request with `DNT: 1` or `Sec-GPC: 1` is recorded with `counted=0`, `classification='dnt'` when `RESPECT_DNT=true` (default true). |
| **Retention** | `RETENTION_DAYS` (default 365). The `prune` job deletes `open_events`/`click_events` older than the window and vacuums; aggregate counters on `recipients` survive. `openpost prune --dry-run` shows what would go. |
| **Erasure** | `openpost forget <email>` removes every event, recipient row and message body referencing that address, and writes a single `audit_log` entry recording that an erasure happened (no PII in the entry — the address is hashed). |
| **Audit** | Every send, every classification decision, every token rejection and every data deletion is appended to `audit_log`. The operator can prove what the system did and when; Mailtrack offers no equivalent. |

---

## 5. Accuracy heuristics

Implemented in `core/classify.ts` as a pure function — no I/O, fully unit-testable:

```ts
classifyOpen(input: OpenSignal, ctx: ClassifyContext): OpenClassification
```

`OpenSignal`: `{ occurredAt, ip, ua, headers }`.
`ClassifyContext`: `{ sentAt, priorEvents, config, selfIpHashes, selfUaPatterns, appleRanges,
datacenterRanges }`.
Output: `{ classification, confidence, counted, reasons: string[] }`.

Rules, evaluated in order; first terminal match wins:

| id | Condition | Result |
|---|---|---|
| R0 | Recipient is opted out, or `DNT:1`/`Sec-GPC:1` and `RESPECT_DNT` | `opt_out` / `dnt`, counted 0 |
| R1 | `occurredAt - sentAt < OPEN_IGNORE_SECONDS` (default **10**) | `google_proxy_prefetch` if proxy UA else `self_open`; counted 0, conf 0.8 |
| R2 | UA matches `/GoogleImageProxy/i` **and** `occurredAt - sentAt < PROXY_PREFETCH_SECONDS` (default 60) | `google_proxy_prefetch`, counted 0, conf 0.7 |
| R3 | UA matches `/GoogleImageProxy/i` (later than R2 window) | `human`, counted 1, conf 0.75, `device_type='proxy'`, location suppressed. *(A Gmail proxy fetch outside the prefetch window means the message was actually rendered.)* |
| R4 | Source IP in Apple relay ranges, or (Apple-Mail UA **and** first event **and** `< MPP_WINDOW_SECONDS`, default 900) | `apple_mpp`, counted 0, conf 0.9 |
| R5 | `ip_hash ∈ SELF_IP_HASHES` or UA matches `SELF_UA_PATTERNS` | `self_open`, counted 0, conf 0.95 |
| R6 | UA matches bot/scanner list (`curl`, `wget`, `python-requests`, `Go-http-client`, `HeadlessChrome`, `bot`, `crawler`, `spider`, `preview`, `Slackbot`, `Proofpoint`, `Mimecast`, `Barracuda`), or method is `HEAD`, or `Accept` header lacks any image type | `bot`, counted 0, conf 0.9 |
| R7 | Same `ip_net_hash` produced opens for `> SCANNER_FANOUT` (default 5) distinct recipients across distinct messages within 10 minutes | `bot`, counted 0, conf 0.8 (and the earlier events from that net are re-flagged) |
| R8 | An event with the same `(recipient, ip_net_hash, ua_family)` occurred within `DEDUPE_SECONDS` (default 30) | `duplicate`, counted 0, conf 0.99 |
| R9 | otherwise | `human`, counted 1, conf 0.6 (0.85 if it is not the first event and R1–R8 never matched for this recipient) |

Additional derived states surfaced by the UI/CLI, so the operator sees **truth, not a green tick**:

- `not_opened` — no events at all.
- `prefetched` — only machine-classified events (MPP/proxy prefetch/bot). Shown as
  "delivered, image auto-loaded — read not confirmed".
- `opened` — ≥ 1 counted human open.
- `read_confirmed` — ≥ 1 counted open **and** (a counted click, or ≥ 2 counted opens separated by
  > 60 s). This is the state worth notifying on by default.

All thresholds are environment variables, all rules emit their `id` into `open_events.reason`, and
Phase 2 exposes `POST /api/.../reclassify` so a human can override a decision — with the override
appended to `audit_log`. Because classification is pure and deterministic, the whole rule table is
covered by table-driven unit tests using recorded UA/IP fixtures and a fake clock: **no Gmail
credentials, no network, no port binding.**
