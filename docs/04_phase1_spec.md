# 04 — Phase 1 Implementation Spec

Target: a coding agent implements this directly, with no further design decisions required.
Stack: **Node 22 + TypeScript (strict) + Fastify 5 + better-sqlite3 + vitest**. ESM (`"type": "module"`).

---

## 1. Project setup

`package.json` (essentials):

```json
{
  "name": "openpost",
  "type": "module",
  "bin": { "openpost": "./dist/cli/index.js" },
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint .",
    "format": "prettier --write ."
  },
  "dependencies": {
    "better-sqlite3": "^11", "fastify": "^5", "commander": "^12",
    "cheerio": "^1", "nodemailer": "^6", "googleapis": "^144",
    "dotenv": "^16", "cli-table3": "^0.6"
  },
  "devDependencies": {
    "typescript": "^5.6", "vitest": "^2", "tsx": "^4",
    "@types/node": "^22", "@types/better-sqlite3": "^7", "@types/nodemailer": "^6",
    "eslint": "^9", "prettier": "^3"
  }
}
```

`tsconfig.json`: `target: ES2023`, `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`,
`noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `outDir: dist`, `rootDir: src`.

Migrations are `.sql` files: copy them to `dist` in the build (`"build": "tsc && cp -r src/db/migrations dist/db/"`)
and resolve their path relative to `import.meta.url`.

---

## 2. Environment variables

Loaded by `src/config/env.ts` via `dotenv`, validated at startup; the process exits with a clear
message listing every missing/invalid variable. `.env.example` must contain all of them.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `TRACKING_SECRET` | yes (server + send) | – | ≥ 32 chars. HMAC key for tokens. |
| `TRACKING_SECRET_PREVIOUS` | no | – | Accepted during key rotation (verify only). |
| `IP_SALT` | no | derived from `TRACKING_SECRET` | Salt base for daily IP hashing. |
| `TRACKING_BASE_URL` | yes (send) | `http://127.0.0.1:8787` | Public origin used to build pixel/click URLs. No trailing slash. |
| `DB_PATH` | no | `./data/openpost.db` | SQLite file. `:memory:` supported (tests). |
| `PORT` | no | `8787` | Server port. |
| `BIND_ADDRESS` | no | `127.0.0.1` | Server bind address. |
| `PRIVACY_MODE` | no | `balanced` | `off` \| `balanced` \| `strict`. |
| `RESPECT_DNT` | no | `true` | Honour `DNT:1` / `Sec-GPC:1`. |
| `OPEN_IGNORE_SECONDS` | no | `10` | Rule R1 window. |
| `PROXY_PREFETCH_SECONDS` | no | `60` | Rule R2 window. |
| `MPP_WINDOW_SECONDS` | no | `900` | Rule R4 window. |
| `DEDUPE_SECONDS` | no | `30` | Rule R8 window. |
| `SCANNER_FANOUT` | no | `5` | Rule R7 threshold. |
| `SELF_IP_HASHES` | no | – | Comma-separated ip_hash values (rule R5). |
| `SELF_UA_PATTERNS` | no | – | Comma-separated regex sources (rule R5). |
| `RETENTION_DAYS` | no | `365` | Pruning window. |
| `TRACKING_FALLBACK_URL` | no | – | Redirect target for unverifiable click tokens. |
| `OUT_DIR` | no | `./out` | Dry-run artefact directory. |
| `MAIL_TRANSPORT` | no | `dryrun` | `dryrun` \| `smtp` \| `gmail`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | if smtp | – / `587` / – / – / `false` | SMTP fallback (Gmail app password). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REFRESH_TOKEN` | if gmail | – | OAuth2 (`gmail.send`, `gmail.readonly`). |
| `FROM_EMAIL` / `FROM_NAME` | yes (send) | – | Sending identity. |
| `API_TOKEN` | no | – | Required for `/api/*` when `BIND_ADDRESS` is not loopback. |
| `LOG_LEVEL` | no | `info` | Pino level. |

---

## 3. Per-file responsibilities and signatures

### `src/types.ts`

```ts
export type PrivacyMode = 'off' | 'balanced' | 'strict';
export type TransportName = 'dryrun' | 'smtp' | 'gmail';
export type TokenPurpose = 'o' | 'c' | 'u';

export type OpenClassificationKind =
  | 'human' | 'google_proxy_prefetch' | 'apple_mpp' | 'self_open'
  | 'bot' | 'duplicate' | 'opt_out' | 'dnt' | 'unknown';

export interface OpenSignal {
  occurredAt: number;              // epoch ms
  ip: string | null;               // remote address, already un-proxied
  ua: string | null;
  method: 'GET' | 'HEAD';
  accept: string | null;
  dnt: boolean;                    // DNT:1 or Sec-GPC:1
}

export interface PriorEventSummary {
  occurredAt: number;
  ipNetHash: string | null;
  uaFamily: string | null;
  counted: boolean;
  classification: OpenClassificationKind;
}

export interface ClassifyContext {
  sentAt: number | null;
  optedOut: boolean;
  priorEvents: PriorEventSummary[];     // newest first, max 50
  ipHash: string | null;
  ipNetHash: string | null;
  uaInfo: UaInfo;
  fanoutCount: number;                   // distinct recipients seen from this ipNetHash in 10 min
  config: ClassifyConfig;
  selfIpHashes: Set<string>;
  selfUaPatterns: RegExp[];
  isAppleRelayIp: boolean;
}

export interface OpenClassification {
  classification: OpenClassificationKind;
  confidence: number;                    // 0..1
  counted: boolean;
  reasons: string[];                     // e.g. ['R2']
}

export interface UaInfo {
  family: string | null;                 // 'GoogleImageProxy' | 'AppleMail' | 'Chrome' | ...
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'proxy' | 'bot' | 'unknown';
  os: string | null;
  isGoogleProxy: boolean;
  isBot: boolean;
  isAppleMail: boolean;
}
```

### `src/config/env.ts`

```ts
export interface AppConfig { /* one field per env var, typed and defaulted */ }
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig;   // throws ConfigError
export class ConfigError extends Error { readonly issues: string[]; }
```
Rules: validate `TRACKING_SECRET.length >= 32` when the command needs it; normalise
`TRACKING_BASE_URL` (strip trailing `/`); parse ints with bounds; `PRIVACY_MODE` enum-checked.
`loadConfig` must be pure w.r.t. the passed object so tests can pass literals.

### `src/core/ids.ts`

```ts
export function newId(): string;                        // 16 random bytes -> 26-char Crockford base32
export function base32Encode(buf: Uint8Array): string;  // Crockford, no padding, uppercase->lowercase
export function base32Decode(s: string): Uint8Array;    // throws on invalid alphabet
```

### `src/core/token.ts`

```ts
export interface TokenParts { version: '1'; rid: string; }   // rid = base32 of 16 bytes

export function signToken(purpose: TokenPurpose, rid: string, secret: string): string;
// => `1<rid>.<sigB32>`  (sig = HMAC-SHA256(secret, purpose + "\0" + rid) truncated to 10 bytes)

export function verifyToken(
  purpose: TokenPurpose, token: string, secrets: { current: string; previous?: string }
): { ok: true; rid: string; usedPrevious: boolean } | { ok: false; reason: 'format' | 'signature' };
// timing-safe compare; never throws; tolerates the optional ".gif" suffix being stripped by the caller

export function pixelUrl(baseUrl: string, token: string, cacheBuster: string): string;
// `${baseUrl}/o/${token}.gif?v=${cacheBuster}`
export function clickUrl(baseUrl: string, token: string): string;     // `${baseUrl}/c/${token}`
export function optOutUrl(baseUrl: string, token: string): string;    // `${baseUrl}/u/${token}`
export function newCacheBuster(): string;                             // 8 base32 chars
```

### `src/core/ua.ts`

```ts
export function parseUserAgent(ua: string | null): UaInfo;
```
Pure regex table, no external dependency. Must detect at minimum: `GoogleImageProxy`, Apple Mail /
macOS Mail, iPhone/iPad, Outlook (`Microsoft Outlook`, `MSOffice`), Thunderbird, Yahoo, Chrome,
Firefox, Safari, Edge, and the bot list from doc 02 §5 R6. Unknown UA → `{family:null,
deviceType:'unknown', isBot:false, ...}`; `null` UA → `deviceType:'unknown'`, `isBot:true`
(a pixel fetch with no UA is a scanner).

### `src/core/privacy.ts`

```ts
export function dailySalt(ipSalt: string, atMs: number): string;      // `${ipSalt}:${YYYY-MM-DD}` (UTC)
export function hashIp(ip: string | null, ipSalt: string, atMs: number): string | null;   // 16 hex chars
export function netOf(ip: string): string | null;                     // /24 for v4, /48 for v6
export function hashNet(ip: string | null, ipSalt: string, atMs: number): string | null;
export function redactForMode<T extends EventRecordDraft>(rec: T, mode: PrivacyMode): T;
// balanced: ua -> null (keep uaFamily/deviceType/os), city -> null
// strict:   ip_hash, ip_net_hash, ua, ua_family, device_type, os, country, region, city -> null
```

### `src/core/classify.ts`

```ts
export function classifyOpen(signal: OpenSignal, ctx: ClassifyContext): OpenClassification;
export function classifyClick(signal: OpenSignal, ctx: ClassifyContext): OpenClassification;
export function deriveRecipientState(r: RecipientCounters):
  'not_opened' | 'prefetched' | 'opened' | 'read_confirmed';
```
Implements rules R0–R9 of doc 02 §5 **in order**, first terminal match wins, pushing rule ids into
`reasons`. No I/O, no `Date.now()` — all time comes from `signal.occurredAt` / `ctx.sentAt`.
`classifyClick` reuses R0/R6/R8 and otherwise returns `human`.

### `src/core/html.ts`

```ts
export interface PixelInjectionResult { html: string; injected: boolean; }
export function injectPixel(html: string, pixelSrc: string): PixelInjectionResult;
// inserts <img src="..." width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />
// immediately before </body> (case-insensitive); if no </body>, append to the end;
// if a pixel with the same origin already exists, do not add a second one (injected=false).

export interface RewriteLinkTarget { url: string; label: string | null; position: number; }
export function collectLinks(html: string): RewriteLinkTarget[];
export function rewriteLinks(html: string, map: (t: RewriteLinkTarget) => string | null): string;
// map returns the replacement href, or null to leave the link untouched.
// Skips non-http(s), the tracking domain, [data-no-track], and anchors inside <style>/<script>.

export function htmlToText(html: string): string;
// block-level newlines, <br> -> \n, links rendered as "label <url>" with the ORIGINAL url,
// entities decoded, whitespace collapsed, trailing newline.
```

### `src/db/index.ts`

```ts
export function openDb(path: string): Database;      // WAL + foreign_keys ON + busy_timeout 5000
export function migrate(db: Database): number;       // applies pending .sql by user_version, returns new version
export function withTx<T>(db: Database, fn: () => T): T;
```

### `src/db/repo.ts`

One module, all SQL. Prepared statements cached per Database instance.

```ts
export function ensureAccount(db, { email, displayName, transport }): AccountRow;
export function createMessage(db, input: CreateMessageInput): MessageRow;
export function addRecipient(db, { messageId, email, name, kind, token }): RecipientRow;
export function markMessageSent(db, id, { providerMsgId, threadId, rfc822MsgId, sentAt }): void;
export function markMessageFailed(db, id, error: string): void;
export function findRecipientByToken(db, rid: string): (RecipientRow & { sentAt: number|null }) | null;
export function recentEventsForRecipient(db, recipientId: string, limit = 50): PriorEventSummary[];
export function fanoutCount(db, ipNetHash: string|null, sinceMs: number): number;
export function insertOpenEvent(db, rec: OpenEventInsert): string;      // returns event id
export function bumpRecipientOpenCounters(db, recipientId, { counted, atMs }): void;
export function isSuppressed(db, email: string): boolean;
export function addSuppression(db, email: string, reason: string): void;
export function listMessages(db, { limit, offset, status? }): MessageListRow[];   // with aggregates
export function getMessageDetail(db, id: string): MessageDetail | null;
export function audit(db, entry: { actor, action, subjectType?, subjectId?, detail?: unknown }): void;
export function pruneEvents(db, olderThanMs: number, dryRun: boolean): { opens: number; clicks: number };
```
`insertOpenEvent` + `bumpRecipientOpenCounters` must run inside one transaction.

### `src/server/assets.ts`

```ts
export const TRANSPARENT_GIF: Buffer;   // 43 bytes, from the base64 constant in doc 02 §1.3
```

### `src/server/app.ts`

```ts
export interface ServerDeps { db: Database; config: AppConfig; clock?: () => number; logger?: ... }
export function buildServer(deps: ServerDeps): FastifyInstance;
```
Registers routes, sets `trustProxy` from config, adds an `onRequest` hook that computes
`req.clientIp` (respecting `X-Forwarded-For` only when `TRUST_PROXY=true`). Must be usable via
`app.inject()` without listening.

### `src/server/routes/pixel.ts`

`GET|HEAD /o/:token` (the route strips a trailing `.gif`).

Handler order — **respond first, record second**:
1. Build headers + send `TRANSPARENT_GIF` (empty body for HEAD).
2. `verifyToken('o', token, secrets)`; on failure → `audit('token.reject')`, stop.
3. `findRecipientByToken`; if missing → `audit('token.orphan')`, stop.
4. Gather `ClassifyContext` (`sentAt`, prior events, suppression, ip/net hashes, UA info, fanout).
5. `classifyOpen` → `redactForMode` → `insertOpenEvent` (+ counter bump when `counted`).
6. `audit('open.record', { eventId, classification, reasons })`.
Any throw inside 2–6 is caught and logged; the response has already been sent.

### `src/server/routes/click.ts`

`GET /c/:token` — verify (`purpose 'c'`), look up the click token → `(link, recipient)`, record,
then `302` to the stored URL with `Referrer-Policy: no-referrer`, `Cache-Control: no-store`.
Unverifiable/unknown → `302 TRACKING_FALLBACK_URL` or `404` when unset. On internal error with a known
URL: still redirect.

### `src/server/routes/optout.ts`, `health.ts`, `api.ts`

- `GET /u/:token` → verify (`'u'`), `addSuppression`, set `recipients.opted_out_at`, audit,
  return a minimal HTML confirmation (200).
- `GET /healthz` → `{ ok, version, schema, db: 'ok'|'error', uptimeMs }`.
- `GET /api/messages`, `GET /api/messages/:id` → JSON; when `BIND_ADDRESS` is not loopback, require
  `Authorization: Bearer ${API_TOKEN}` (401 otherwise).

### `src/mail/mime.ts`

```ts
export interface BuildMimeInput {
  from: { email: string; name?: string };
  to: { email: string; name?: string }[];
  cc?: ...; bcc?: ...;
  subject: string; html: string; text: string;
  headers?: Record<string, string>;
  inReplyTo?: string; references?: string[];
}
export async function buildMime(input: BuildMimeInput): Promise<{ raw: Buffer; messageId: string }>;
```
`multipart/alternative`, text part first. Uses nodemailer `MailComposer`. No `X-Mailer` header.

### `src/mail/transport.ts` + `dryrun.ts` / `smtp.ts` / `gmail.ts`

```ts
export interface SendResult {
  providerMessageId: string | null; threadId: string | null;
  rfc822MessageId: string; sentAt: number; artifacts?: { htmlPath: string; emlPath: string };
}
export interface Transport { readonly name: TransportName; send(mime: {raw: Buffer; messageId: string},
  meta: { to: string[]; subject: string; html: string }): Promise<SendResult>; }

export function resolveTransport(config: AppConfig): Transport;
```
- `DryRunTransport`: writes `${OUT_DIR}/${messageDbId}.html` and `.eml`, returns a synthetic
  `providerMessageId = null`. **Never** touches the network. Creates `OUT_DIR` if absent.
- `SmtpTransport`: `nodemailer.createTransport({host,port,secure,auth})`, `sendMail({raw})` via
  `raw` envelope; returns the SMTP message id.
- `GmailTransport`: `google.auth.OAuth2` with refresh token → `gmail.users.messages.send({userId:'me',
  requestBody:{ raw: base64url(mime.raw) }})`; returns `id` + `threadId`.
  Scopes: `gmail.send` (required), `gmail.readonly` (requested now, used in Phase 3).

### `src/cli/index.ts` + `src/cli/commands/*`

Commander program named `openpost`, global options `--db <path>`, `--json`, `--verbose`.
Every command exits non-zero with a one-line error on failure.

---

## 4. CLI command spec

```
openpost init [--force]
  Creates DB_PATH (with parent dirs), runs migrations, seeds `settings`
  (schema note + TRACKING_SECRET fingerprint). Prints a generated 48-char secret suggestion when
  TRACKING_SECRET is unset. Idempotent: re-running without --force does not destroy data.

openpost migrate
  Applies pending migrations. Prints "schema: N -> M" (or "up to date").

openpost serve [--port <n>] [--host <addr>]
  Starts the Fastify server. Logs the public pixel base URL. SIGINT/SIGTERM: close server, close db.

openpost send
  --to <email...>              repeatable / comma-separated (required)
  [--cc <email...>] [--bcc <email...>]
  --subject <text>             (required)
  (--html-file <path> | --html <string> | --text-file <path> | --text <string>)   at least one body
  [--from <email>]             defaults to FROM_EMAIL
  [--no-track]                 do not inject the pixel
  [--track-clicks]             rewrite links (Phase 1: implemented, off by default)
  [--optout-link]              append an opt-out footer link
  [--transport <dryrun|smtp|gmail>]  overrides MAIL_TRANSPORT
  [--dry-run]                  force dryrun transport; write artefacts; never sends
  [--out <dir>]                overrides OUT_DIR
  [--json]                     machine-readable result

  Behaviour: one `messages` row; one `recipients` row per address with its own token and
  cache-buster, so each recipient's HTML differs (personalised pixel). Addresses present in
  `suppressions` are sent to WITHOUT tracking (and reported as "suppressed: tracking disabled").
  Missing text body => generated with htmlToText. Missing html body => a minimal HTML wrapper.
  Prints: message id, per-recipient token, pixel URL(s), transport, artefact paths.

openpost list [--limit 20] [--status sent|dryrun|failed] [--json]
  Table: id (short), sent_at, subject, to, opens (counted/total), clicks, state.

openpost show <message-id> [--json] [--events]
  Message header + per-recipient rows + (with --events) every event with
  occurred_at, classification, confidence, counted, reasons, ua_family, device_type, country.

openpost prune [--days N] [--dry-run]
  Deletes events older than N days (default RETENTION_DAYS); prints counts.
```

Exit codes: `0` ok, `1` runtime error, `2` bad usage/config.

---

## 5. Test plan

All tests run with `DB_PATH=':memory:'`, a fixed fake clock, and **no network, no credentials, no
port binding** (`app.inject()`).

### Unit — `tests/unit/`

**token.test.ts**
1. `signToken`→`verifyToken` round-trip succeeds for each purpose.
2. Token signed with purpose `o` fails verification as `c` (reason `signature`).
3. Flipping one character of the signature → `{ok:false, reason:'signature'}`.
4. Malformed input (`''`, `'1'`, `'x.y.z'`, non-base32 chars) → `reason:'format'`, no throw.
5. Rotation: token signed with the previous secret verifies with `usedPrevious:true`; unknown secret fails.
6. `pixelUrl` output matches `^https?://.+/o/[0-9a-z]+\.gif\?v=[0-9a-z]{8}$`.

**html.test.ts**
7. `injectPixel` inserts exactly one `<img>` immediately before `</body>`.
8. No `</body>` → appended at the end; `injected===true`.
9. Running `injectPixel` twice with the same origin does not add a second pixel.
10. Injected markup contains `width="1" height="1" alt=""` and **does not** contain `display:none`
    or `visibility:hidden`.
11. `collectLinks` finds http/https anchors in document order and ignores `mailto:`, `tel:`,
    `#anchor`, `data:`, and `[data-no-track]`.
12. `rewriteLinks` preserves query string and fragment of the original in the stored target and
    leaves untouched links byte-identical.
13. `htmlToText` renders `<a href="https://x/y?a=b">Click</a>` as `Click <https://x/y?a=b>` (original URL).

**classify.test.ts** — table-driven over fixtures:
14. Open 3 s after send, proxy UA → `google_proxy_prefetch`, counted false (R1).
15. Open 30 s after send, proxy UA → `google_proxy_prefetch` (R2, within 60 s).
16. Open 5 min after send, proxy UA → `human`, counted true, `deviceType==='proxy'` (R3).
17. Apple relay IP, first event, 2 min after send → `apple_mpp`, counted false (R4).
18. UA/ip matching `SELF_*` → `self_open` (R5).
19. `curl/8.5.0`, `python-requests`, `HeadlessChrome`, null UA, `HEAD` method → `bot` (R6).
20. Fanout 6 distinct recipients from one net in 10 min → `bot` (R7).
21. Second identical open 10 s after a counted one → `duplicate` (R8); 60 s later → counted (R9).
22. `DNT:1` with `RESPECT_DNT=true` → `dnt`, counted false; with `false` → normal path.
23. Opted-out recipient → `opt_out`, counted false, regardless of other signals.
24. `deriveRecipientState` returns the four states for the four counter shapes.

**privacy.test.ts**
25. `hashIp` is stable within a UTC day and differs across days for the same IP.
26. `hashIp(null)` → null; IPv6 net is /48, IPv4 net is /24.
27. `redactForMode('strict')` nulls ua/ua_family/device_type/os/country/region/city/ip_hash/ip_net_hash.
28. `redactForMode('balanced')` keeps `ua_family`/`device_type` and nulls raw `ua` and `city`.

**ua.test.ts**
29. Fixture table of ≥ 15 real UA strings → expected `{family, deviceType, isGoogleProxy, isBot,
    isAppleMail}`.

**mime.test.ts**
30. `buildMime` produces `multipart/alternative` with both parts, a valid `Message-ID`,
    correct `To`/`Subject` (RFC 2047 encoded for non-ASCII), and no `X-Mailer`.

**env.test.ts**
31. Missing `TRACKING_SECRET` → `ConfigError` listing it; short secret → error.
32. Defaults applied; `TRACKING_BASE_URL` trailing slash stripped; invalid `PRIVACY_MODE` rejected.

### Integration — `tests/integration/`

**send-dryrun.test.ts**
33. `send --dry-run` to 2 recipients creates 1 message + 2 recipients with **distinct** tokens and
    writes 2 artefact HTML files (one per recipient) + `.eml`.
34. Each artefact's pixel token verifies and resolves to the matching recipient row.
35. `--no-track` produces HTML with no pixel and no `open_events` possible.
36. A suppressed address is sent without a pixel and is reported as suppressed.

**pixel-flow.test.ts** (via `app.inject()`)
37. `GET /o/<valid>.gif` → 200, `content-type: image/gif`, `content-length: 43`,
    `cache-control` contains `no-store`, no `etag`, no `last-modified`.
38. Event row is created with the expected classification; recipient counters updated only when counted.
39. `GET /o/<tampered>.gif` → 200 + GIF, **zero** new `open_events`, one `token.reject` audit row.
40. `HEAD /o/<valid>.gif` → 200, no body, no event stored.
41. Unknown-but-well-signed rid → 200, no event, `token.orphan` audit row.
42. `GET /c/<valid>` → 302 with `location` exactly equal to the original URL (query+fragment intact)
    and one click event.
43. `GET /u/<valid>` → 200 HTML, suppression row created, recipient `opted_out_at` set; a subsequent
    pixel hit is `opt_out`, counted 0.
44. `GET /healthz` → 200 `{ok:true, schema:1}`.
45. `/api/messages` on a non-loopback bind without bearer → 401; with bearer → 200.

**db-migrate.test.ts**
46. `migrate` on a fresh `:memory:` DB sets `user_version=1`; running twice is a no-op returning 1.
47. Foreign keys cascade: deleting a message deletes its recipients and events.

**prune.test.ts**
48. Events older than the window are deleted, newer survive, counters on `recipients` unchanged.

### Manual verification (curl) — `scripts/curl-smoke.sh` + README

```bash
# 0) prepare
export TRACKING_SECRET=$(head -c 36 /dev/urandom | base64)
export TRACKING_BASE_URL=http://127.0.0.1:8787
export FROM_EMAIL=you@example.com
npm run build
node dist/cli/index.js init

# 1) dry-run send
node dist/cli/index.js send --to alice@example.com \
  --subject "hello" --html '<p>Hi <a href="https://example.com/x?a=1#f">link</a></p>' \
  --track-clicks --dry-run --json
#    -> prints messageId + pixelUrl; artefacts in ./out/

# 2) start the server (separate shell)
node dist/cli/index.js serve

# 3) health
curl -s http://127.0.0.1:8787/healthz | jq .

# 4) the pixel: expect 200, image/gif, 43 bytes, no-store, no ETag
PIXEL=$(node dist/cli/index.js show <messageId> --json | jq -r '.recipients[0].pixelUrl')
curl -s -D - -o /dev/null "$PIXEL"

# 5) immediately after send it must NOT count (R1). Wait > OPEN_IGNORE_SECONDS and repeat:
sleep 11 && curl -s -o /dev/null "$PIXEL"

# 6) simulate the Gmail image proxy (should be human + device=proxy after the window)
curl -s -o /dev/null -A "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)" "$PIXEL"

# 7) simulate a scanner (expect classification=bot, counted=0)
curl -s -o /dev/null -A "python-requests/2.32.0" "$PIXEL"

# 8) tampered token -> still 200 + GIF, but no event
curl -s -D - -o /dev/null "${PIXEL%.gif*}X.gif"

# 9) click redirect: expect 302 to the exact original URL
CLICK=$(node dist/cli/index.js show <messageId> --json | jq -r '.recipients[0].links[0].clickUrl')
curl -s -D - -o /dev/null "$CLICK"

# 10) inspect
node dist/cli/index.js show <messageId> --events
```

---

## 6. Acceptance criteria (Phase 1 sign-off)

1. `npm ci && npm run build && npm test` is green on a clean container with **no `.env`, no
   credentials and no network**; `src/core/**` line coverage ≥ 90 %.
2. All 48 test cases above exist and pass.
3. `openpost init` is idempotent and produces a schema-v1 database at `DB_PATH`.
4. `openpost send --dry-run` writes per-recipient HTML + `.eml` artefacts containing exactly one
   verifiable pixel each, and never opens a socket.
5. `openpost serve` + the 10 curl steps above produce the documented status codes, headers and
   classifications.
6. Invalid, tampered or replayed tokens never cause a 4xx/5xx on `/o/` and never create events, and
   every rejection is in `audit_log`.
7. No raw IP address appears anywhere in the database in any privacy mode (grep the DB dump for the
   test IP in the integration suite — this is an automated assertion, test #39b).
8. Every recorded event carries a non-empty `reason` (rule ids) and a `confidence`.
9. `openpost show --events` renders classifications and reasons in a human-readable table, and
   `--json` output is stable and documented.
10. README documents: env vars, quick start, the curl smoke test, the Gmail OAuth setup, the SMTP
    app-password fallback, and an explicit statement that no public URL is required for Phase 1.

---

## 7. Phase 1.1 amendments

Following an independent code review (`docs/reports/phase1_review.md`), this spec is amended as
follows; the implementation follows these amended rules, not the original text above where they
conflict.

1. **`/api/*` auth** (finding #2) is keyed on whether `API_TOKEN` is configured at all, not on
   `BIND_ADDRESS` being non-loopback - a loopback bind reached through a tunnel or reverse proxy is
   still remotely reachable. The server now refuses to start (`openpost serve`) when `BIND_ADDRESS`
   is non-loopback or `TRUST_PROXY` is enabled and `API_TOKEN` is unset.
2. **`/api/messages` and `/api/messages/:id`** omit signed pixel/opt-out/click token URLs by
   default (they let the bearer forge opens or suppress a recipient); pass `?tokens=1` to include
   them, still subject to the same bearer check.
3. **`TRUST_PROXY`** accepts `false` (default), `true` (collapsed to hop count 1, with a startup
   warning), an integer hop count, or a comma-separated CIDR/IP allowlist - not a plain boolean that
   trusts every hop.
4. **R6 / HEAD requests** (finding #17): `GET|HEAD /o/:token` now runs *every* request, HEAD
   included, through the same verify -> classify -> redact -> insert -> audit pipeline as GET,
   instead of returning immediately after the response for HEAD. A HEAD hit is classified `bot`
   (R6, uncounted) and audited like any other bot signal, rather than leaving zero trace anywhere.
   Test #40 is updated accordingly.
5. **R6 / Accept header** (finding #17): a missing or empty `Accept` header is explicitly *not*
   treated as "lacks an image type" - only an `Accept` header that is present but names no image
   MIME type trips this branch of R6. Many real mail/image-loading clients never send an `Accept`
   header for an `<img>` fetch at all.
6. **Schema is now v2** (finding #16): `recipients.cache_buster` persists the cache-buster
   generated at send time, so the pixel URL reported by `show`/`/api` is the same URL that was
   actually embedded, instead of a fresh one minted on every read. Tests #44 and #46 are updated to
   expect schema version 2.
7. **`openpost prune`** (finding #6) also prunes `audit_log` rows older than the retention window
   (reported as a third `audit` count alongside `opens`/`clicks`) and `VACUUM`s when anything was
   deleted; unauthenticated rejection audits (`token.reject`/`token.orphan`/`token.disabled`) are
   additionally rate-limited so a scripted scan cannot grow `audit_log` without bound.
8. **IP hashing** (finding #13) is HMAC (`HMAC-SHA256`, daily-rotating key derived from `IP_SALT` via
   `HMAC(IP_SALT, date)`), not `sha256(salt ‖ ip)`; the default `IP_SALT` (when unset) is itself
   HMAC-derived from `TRACKING_SECRET` with a fixed label, rather than reusing the secret's raw
   bytes.
