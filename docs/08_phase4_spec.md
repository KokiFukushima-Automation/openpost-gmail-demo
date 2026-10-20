# 08 — Phase 4 Implementation Spec

Target: a coding agent implements this directly, with no further design decisions required.
Same stack as Phases 1–3 (Node 22 + TypeScript strict + Fastify 5 + better-sqlite3 + vitest, ESM,
no bundler, server-rendered HTML + vendored htmx). Phase 4 adds **no public URL requirement, no
Gmail credential requirement, no browser, and no network in tests**: campaigns run end to end on
`MAIL_TRANSPORT=dryrun`, every account secret is exercised against a temp keyfile, backup/restore
round-trips a temp file, migrations run against checked-in fixture databases, and geo is decided
against an injected lookup.

> Prerequisite: this spec assumes `docs/07_recipient_semantics.md` has landed
> (`src/mail/recipients.ts`, `buildSendPlan`, `RECIPIENT_MODE`, `gmail-smtp`, migration
> `006_recipient_semantics.sql`, `EXPECTED_SCHEMA = 6`, tests 200–227). Phase 4's migration is
> therefore **`007_phase4.sql`** and `EXPECTED_SCHEMA` becomes **7**. If 006 has *not* landed when
> this work starts, stop and land it first — §2.6 and §3.4 both build directly on `buildSendPlan`.

---

## 0. Baseline: what the tree actually contains

Written against the working tree at HEAD `a89e23b` + the in-flight doc-07 branch, not against doc
03's prose. Facts that shape Phase 4:

| Fact (verified in the tree) | Consequence for Phase 4 |
|---|---|
| `EXPECTED_SCHEMA = 6` after 006; `006_recipient_semantics.sql` is the last migration | Phase 4 ships `007_phase4.sql`, `EXPECTED_SCHEMA = 7`. |
| An `accounts` table has existed since `001_init.sql` — `(id, email UNIQUE, display_name, transport, created_at)` — and every `messages` row already has `account_id` | Multi-account is an **extension** of an existing table, not a new one. No table rebuild; `UNIQUE(email)` stays. |
| `messages.account_id REFERENCES accounts(id) **ON DELETE CASCADE**` | `openpost accounts remove` must never `DELETE` by default — it would silently destroy every message and event ever sent from that address (§3.5). |
| `ensureAccount(db, {email, displayName, transport})` dedupes by email and **ignores transport drift** (returns the existing row unchanged) | Replaced at the send path by `resolveAccount()`; `ensureAccount` stays for `seed.ts` and back-compat. |
| `resolveTransport(config)` reads only globals (`config.smtp*`, `config.google*`, `resolveRefreshToken(config, process.env)`) | Needs a per-account sibling `resolveTransportForAccount()`; the old signature keeps working via the synthetic env account. |
| The whole send pipeline lives inline in `send.ts`'s commander action (~250 lines: template → per-copy loop → tokens → links → pixel → MIME → transport → `markRecipientSent` → self-copy) | Must be extracted into `src/mail/send-message.ts` before campaigns can reuse it. This is the single highest-risk refactor in Phase 4 (§2.6, §7.1). |
| `open_events`/`click_events` already carry `country`, `region`, `city` (`001_init.sql`), always written `NULL`; `TrackingEvent.country` exists with a comment saying "the field exists so the wire format is stable once Phase 3 geo lands" | Geo is a **producer-only** change: no migration, no wire-format change, no dashboard schema change (§5). |
| `/u/:token` exists as **GET only**; `optOutUrl()` is already generated per recipient | RFC 8058 one-click unsubscribe needs a `POST /u/:token` handler (§2.5). Campaigns require it. |
| `reminders` claim/lease (`src/db/reminders.ts`: single conditional `UPDATE` under `BEGIN IMMEDIATE`, `lease_owner`/`lease_expires_at`/`attempts`, `sweepExhaustedLeases`) | Copied verbatim in shape for `campaign_rows` (§2.7). Precedent, not a new invention. |
| Phase 3 decided the Gmail draft is **at-most-once** (journal the attempt before the API call, never blind-retry) | The same rule applies, with more force, to sending mail: §2.7's "indeterminate" row state. |
| `notifications` has `UNIQUE(dedupe_key)`; `decideTriggers` is a pure function over one `TrackingEvent` | Campaign digests reuse the queue unchanged; the policy gains one rule (P9) and one trigger (§2.9). |
| `Scheduler` runs registered `Job`s off the `jobs` table with an overlap guard | Campaign draining, digests and scheduled backups are three new `Job`s — no new process model. |
| `src/server/export.ts` has `toCsv(rows, columns)` (RFC 4180 + formula guard); there is **no CSV reader** anywhere | `src/core/csv.ts` is new, in-tree, ~90 lines (§2.2). |
| `imapflow` is an `optionalDependency` loaded by dynamic `import()` and degraded gracefully when absent | Exact precedent for `mmdb-lib` (§5.2). |
| `htmx.min.js` is vendored with its version + sha256 in a header comment and asserted by `openpost doctor` | Exact precedent for the vendored geo test fixture (§5.6). |
| `tests/integration/migrate-v2.test.ts` / `migrate-v5.test.ts` build old schemas by **re-running a subset of migration files**, not from fixture files; `tests/fixtures/` holds two non-DB files | Phase 4 adds real binary fixture DBs (§4.5) so a future migration bug against a *real* v1 file is caught, not just against a replayed one. |
| `package.json` is `"private": true`, has `bin.openpost` → `dist/cli/index.js`, no `files` key | `npx openpost init` requires publishing changes (§4.2). Honest note: the npm name may be taken. |
| No `Dockerfile`, no `compose.yaml`, no `packaging/`, no SEA script | All new (§4.3, §4.4). |
| better-sqlite3 v11 exposes `db.backup(path)` (the SQLite online backup API) | `openpost backup` needs **no** new dependency (§4.6). |
| better-sqlite3 is a **native addon** (`build/Release/better_sqlite3.node`) | Node SEA cannot produce a genuine single file. SEA is deferred with a written rationale (§4.7). |
| `erase.ts` deletes per-recipient rows across 7 tables inside one transaction and writes one address-free audit row | Must learn about `campaign_rows` (which store `email` + `vars_json`, i.e. PII) — §2.10, test 338. |
| 336 vitest tests green today; doc 07 adds 200–227 | Phase 4 adds cases **230–345** and must leave all earlier cases green in intent. |

---

## 1. Goal and Definition of Done

**Goal.** Turn openpost from "a very good tracker for one person's one mailbox" into something you
would run for a team: **campaigns** (the single biggest thing Mailtrack charges for that openpost
cannot do at all), **multi-account sending with secrets encrypted at rest**, **onboarding and
packaging that do not require reading three docs**, **backup/restore you can trust**, and
**optional honest geo**. Everything stays local, offline-testable and dependency-thin.

**Definition of Done** (each item binary and checkable):

1. A **500-row CSV campaign** in dry-run produces 500 messages with 500 distinct pixel tokens and
   500 distinct opt-out tokens, zero duplicates, suppressed/opted-out rows `skipped` (not sent),
   and completes with `status='completed'` (tests 260, 261, 269).
2. **Crash-resume, two flavours, both proven:** a `SIGKILL` *between* rows leaves every remaining
   row `pending` and a fresh `campaign run` sends each of them exactly once; a `SIGKILL` *after
   submit began* leaves exactly one row `failed` with `last_error` starting `indeterminate:` which
   is **never** re-sent without `--retry-indeterminate` (tests 265, 266, 267, using a real child
   process, the `scripts/reminder-crash-child.mjs` precedent).
3. `campaign pause` stops sending within one row; `resume` continues from the exact next row;
   `cancel` is terminal and leaves already-sent rows intact (tests 262–264).
4. Every campaign message carries an unsubscribe footer **and** `List-Unsubscribe` +
   `List-Unsubscribe-Post` headers; `POST /u/:token` returns 200 and suppresses the address; there
   is **no flag, env var or code path** that sends a campaign message without them (tests 256, 257,
   275).
5. A 50-row campaign with 30 opens produces **one** digest notification per channel per window, not
   30 (test 278), and the digest names counts only — never a recipient list.
6. A/B: with two subject variants and a fixed campaign id, `assignVariant` is deterministic and
   stable across resume, splits within ±3 % of the requested weights over 1000 addresses, and
   `campaign stats` reports per-variant open/click rates (tests 253–255, 276).
7. **Secrets at rest:** after `openpost accounts add --app-password-stdin`, `grep -a` for the
   plaintext over the whole `.db`, `.db-wal` and `.db-shm` files finds **nothing**; the stored value
   matches `^op\.sb\.v1\.`; a wrong master key produces a named `SecretKeyError` (not a stack trace
   or a decrypt loop); the keyfile is refused unless mode `0600` (tests 288–299).
8. `--from-account <ref>` on `send` and `campaign create` selects transport, FROM address, display
   name, self-open strategy and recipient mode from that account; with **no** account rows the tree
   behaves exactly as it does today, from env (tests 292, 293).
9. `openpost backup` → `openpost restore` round-trips a populated database: identical `user_version`,
   identical row counts for every table, `PRAGMA integrity_check` = `ok`, `PRAGMA foreign_key_check`
   empty, and the manifest's sha256 matches (tests 300–307).
10. `openpost migrate` upgrades **checked-in fixture databases at schema 1, 2, 3, 4, 5 and 6** to 7
    with zero row loss and no `foreign_key_check` violations; `/healthz` and `doctor` report 7
    (tests 308–315).
11. `openpost init --yes --base-url … --from …` on an empty directory writes a `0600` `.env` with a
    freshly generated `TRACKING_SECRET`, creates the DB at schema 7, and `openpost doctor --offline`
    then returns **no** `fail` check (tests 316–319). The interactive wizard is the same code path
    driven through injected readline streams (test 320).
12. A `docker build` produces an image that serves `/healthz` with a mounted volume and survives
    `docker compose down && up` with its data intact; the measured image size is recorded in
    `docs/reports/phase4_smoke.md` (operator step, §7.6).
13. **Geo honesty:** with a fixture lookup, a non-proxied open records a country; a
    `google_proxy_prefetch` / `apple_mpp` / datacentre-range open records `NULL` and the UI still
    prints "unknown (proxied)"; `PRIVACY_MODE=strict` records nothing; `PRIVACY_MODE=balanced` caps
    at country (tests 324–331).
14. **Dependency budget:** exactly **one** new runtime dependency, `mmdb-lib`, declared under
    `optionalDependencies`; **zero** new devDependencies; no bundler anywhere (§7.3).
15. `npm ci && npm run build && npm test` green on a clean container with no `.env`, no credentials,
    no network, no browser; cases 230–345 present and passing; existing coverage thresholds hold and
    `src/core/**` (which gains `csv.ts`, `template.ts`, `secretbox.ts`, `geo.ts`, `subject.ts`)
    stays ≥ 90 % lines.

**Explicitly out of scope for Phase 4** (with reasons in the named section): the packaged Chrome
extension (§6), the Node SEA single binary (§4.7), attachments, scheduled campaign start times,
per-row send times, body A/B (subject only), re-send-to-non-openers, an accounts page in the web UI
(§3.7), ASN/ISP geo, and any hosted component.

---

## 2. Campaigns / mail merge

### 2.1 Shape

```
openpost campaign create …      parse CSV → validate template → insert campaigns + campaign_rows (all 'pending')
openpost campaign preview …     render N rows to disk; no DB writes, no send
openpost campaign run <id>      claim → preflight → render → sendMessage → mark → pace → repeat
  (or the `campaigns` scheduler job inside `openpost serve`, which does the same thing)
openpost campaign pause|resume|cancel|list|show|stats|rows
```

A campaign is *N single-recipient sends*, not one multi-recipient send. Every row goes through
`buildSendPlan({addresses:[{email,kind:'to'}], mode:'per-recipient', …})` — exactly the path
`openpost send --to one@example.com` already takes, so per-recipient attribution, the header
contract, click tokens and the self-copy rules are inherited with no new semantics. The runner
asserts `addresses.length === 1`; a campaign can never enter single/aggregate mode.

### 2.2 CSV reader — `src/core/csv.ts` (new, pure)

```ts
export interface CsvParseOptions { delimiter?: ',' | ';' | '\t'; maxRows?: number; maxCellBytes?: number }
export interface CsvTable { headers: string[]; rows: Array<Record<string, string>>; delimiter: string }
export class CsvError extends Error { readonly line: number; readonly column: number | null }
export function parseCsv(text: string, opts?: CsvParseOptions): CsvTable;
export function normalizeHeader(h: string): string;          // trim, strip BOM, lowercase, collapse ws
export function pickEmailColumn(headers: string[], explicit?: string): string;  // 'email'|'e-mail'|'address'
```

RFC 4180: quoted fields, embedded delimiter/CRLF/`""`, CRLF or LF line endings, leading BOM
stripped. Rules and edge cases:

- Delimiter auto-detected from the **header line only** (most frequent of `,`/`;`/`\t`), overridable.
- Rows are built with `Object.create(null)` — a CSV column literally named `__proto__` or
  `constructor` must not reach `Object.prototype` (test 236).
- Ragged rows: fewer cells than headers → missing keys are absent (which later makes the template
  render fail loudly); more cells → `CsvError` naming the line.
- `maxRows` default `CAMPAIGN_MAX_ROWS` (10 000) and `maxCellBytes` 8 192 — both fail with the line
  number, so a 2 GB file cannot be streamed into memory by accident.
- Duplicate headers after normalisation → `CsvError`.
- An empty file, or a file with headers and no rows → `CsvError('no data rows')`.
- Cells are **never** trimmed except the email column (which is trimmed and lowercased for
  suppression matching, while `vars_json` keeps the original text for display).

### 2.3 Templating — `src/core/template.ts` (new, pure)

```ts
export type TemplateMode = 'html' | 'text' | 'subject';
export class TemplateError extends Error { readonly key: string | null; readonly offset: number }
export function collectVars(src: string): string[];                       // sorted, unique
export function renderTemplate(src: string, vars: Record<string, string>,
                               opts: { mode: TemplateMode; allowRaw?: boolean }): string;
export function sanitizeHeaderValue(v: string): string;
```

Syntax is deliberately tiny: `{{ key }}` and `{{{ key }}}`. No conditionals, no loops, no filters,
no partials, no expression language — because every one of those is a sandbox to get wrong, and a
mail merge does not need them.

| Rule | Behaviour |
|---|---|
| `{{key}}` in `mode:'html'` | HTML-escaped with the existing escaper (`& < > " '`). |
| `{{key}}` in `mode:'text'` / `'subject'` | inserted verbatim, then (subject only) `sanitizeHeaderValue`. |
| `{{{key}}}` | raw, **only** when `allowRaw`; `campaign create` sets it only under `--allow-raw`, which also prints a warning and records `campaigns.allow_raw = 1`. Without it, `{{{…}}}` is a `TemplateError` at create time, not at send time. |
| unknown key | `TemplateError` — always. There is no silent empty substitution, in any mode. |
| `{{` with no closing `}}` | `TemplateError` naming the byte offset. |
| a value containing `{{other}}` | inert: rendering is single-pass, output is never re-scanned (test 245). |
| key charset | `/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/`; anything else is a `TemplateError`. |

`sanitizeHeaderValue` strips `\r`, `\n`, `\0`, collapses runs of whitespace, and truncates to 900
bytes (below RFC 5322's 998 line limit, leaving room for `Subject: ` and folding). **This is the
header-injection defence**: a CSV cell `Hi\r\nBcc: attacker@evil.com` must never reach `buildMime`
intact (test 249).

Additionally, after rendering the HTML body the runner calls `assertSafeHrefs(html)` (new, in
`src/core/html.ts`, using the already-present cheerio): every `href`/`src` must be `http:`,
`https:`, `mailto:` or a `cid:` — a `javascript:`/`data:` URL from a CSV cell is a hard failure for
that row (`skip_reason='unsafe_href'`), not a sent message (test 250).

### 2.4 Variables available to every row

`vars` = the CSV row's own columns, plus these reserved keys injected by the runner (a CSV column
of the same name is a `TemplateError` at create time, test 244):

| key | value |
|---|---|
| `email` | the row's address |
| `campaign_name` | `campaigns.name` |
| `sender_name` / `sender_email` | resolved from the account |
| `unsubscribe_url` | the row's opt-out URL — lets a template place the link itself; the footer is appended anyway unless the template already used this key (§2.5) |

### 2.5 Unsubscribe is mandatory, and it is one-click

Non-negotiable, by construction:

1. `sendMessage` gains `optOutFooter: boolean` **and** `listUnsubscribe: boolean`; the campaign
   runner passes `true` for both and there is no CLI flag to pass `false`. `campaigns` has no
   column for it either (an operator editing SQLite by hand is out of the threat model, but the
   runner re-asserts before submit: `assertUnsubscribePresent(html, headers)`, test 275).
2. Footer placement: if the rendered body used `{{unsubscribe_url}}`, no second footer is appended;
   otherwise the existing `appendOptOutFooter` runs.
3. Headers added by `sendMessage` (via `BuildMimeInput.headers`, which already exists):
   ```
   List-Unsubscribe: <https://…/u/TOKEN>, <mailto:FROM_EMAIL?subject=unsubscribe>
   List-Unsubscribe-Post: List-Unsubscribe=One-Click
   ```
4. **New route** `POST /u/:token` in `src/server/routes/optout.ts`: same verification, same
   `addSuppression` + `setRecipientOptedOut` + audit as the GET, returns `200 text/plain OK`, is
   idempotent, accepts any body, and is **exempt from every CSRF consideration** because it carries
   no ambient credential (it is an unauthenticated, token-bearing endpoint, exactly like the GET).
   Rate-limited by the existing token-rejection audit path.
5. `openpost send` (non-campaign) is unchanged: `--optout-link` stays opt-in there.

### 2.6 Extracting the send path — `src/mail/send-message.ts` (new)

The linchpin refactor. `send.ts`'s action body becomes: parse args → resolve account → build
`SendMessageInput` → `await sendMessage(deps, input)` → print. Nothing else moves.

```ts
export interface SendMessageInput {
  account: ResolvedAccount;                 // §3.3
  addresses: AddressInput[];                // docs/07 §6.1
  subject: string;
  html: string;
  text?: string | undefined;
  track: boolean;
  trackClicks: boolean;
  optOutFooter: boolean;
  listUnsubscribe: boolean;
  recipientMode: RecipientModeOption;
  mute?: boolean | undefined;
  /** Pre-allocated so the caller can journal it BEFORE any network I/O (§2.7). */
  messageId?: string | undefined;
  campaignId?: string | undefined;
  campaignRowId?: string | undefined;
  extraHeaders?: Record<string, string> | undefined;
}
export interface SendMessageDeps {
  db: DB; config: AppConfig; transport: Transport; clock: () => number;
  /** Injected so tests never touch googleapis/imapflow; defaults to the real implementation. */
  selfCopy?: (args: SelfCopyArgs) => Promise<SelfCopyResult>;
}
export interface SendMessageOutcome {
  messageId: string;
  status: 'sent' | 'dryrun' | 'failed';
  recipients: RecipientResult[];            // unchanged shape, re-exported
  selfCopy?: SelfCopyResult | undefined;
  errors: string[];
}
export async function sendMessage(deps: SendMessageDeps, input: SendMessageInput): Promise<SendMessageOutcome>;
```

Behavioural contract for the extraction (tests 258, 259 are pure regressions): identical DB writes,
identical dry-run artefacts, identical `--json` output for `openpost send` before and after. The
only additions are `campaign_id` on the message row, `extraHeaders`/`listUnsubscribe` passthrough,
and `messageId` pre-allocation (when omitted, `createMessage` mints one as today).

### 2.7 The runner, claiming, and at-most-once

`src/jobs/campaigns.ts`:

```ts
export interface CampaignRunOptions {
  limit?: number; maxSeconds?: number; owner?: string;
  sleep?: (ms: number) => Promise<void>;   // injected in tests
  random?: () => number;                   // injected in tests
  shouldStop?: () => boolean;              // SIGINT handler
}
export interface CampaignRunResult {
  campaignId: string; claimed: number; sent: number; skipped: number; failed: number;
  stopped: 'completed' | 'paused' | 'cancelled' | 'limit' | 'time' | 'daily_cap' | 'signal' | 'not_running';
}
export function recoverCampaign(db: DB, campaignId: string, nowMs: number, leaseMs: number): { requeued: number; indeterminate: number };
export async function runCampaignOnce(deps: CampaignDeps, campaignId: string, opts?: CampaignRunOptions): Promise<CampaignRunResult>;
export function createCampaignsJob(deps: CampaignDeps): Job;   // drains every running campaign
```

`src/db/campaigns.ts` mirrors `src/db/reminders.ts` exactly:

```ts
export function createCampaign(db, input): CampaignRow;
export function insertRows(db, campaignId, rows): number;          // one transaction
export function claimNextRow(db, campaignId, owner, nowMs, leaseMs, maxAttempts): CampaignRowRow | null;
export function beginRowSubmit(db, rowId, owner, messageId, nowMs): boolean;   // journal
export function markRowSent(db, rowId, owner, { messageId, recipientId, sentAt }): boolean;
export function markRowSkipped(db, rowId, owner, reason): boolean;
export function markRowFailed(db, rowId, owner, error, { retryable: boolean }): boolean;
export function markRowIndeterminate(db, rowId, error): boolean;
export function setCampaignStatus(db, id, status, atMs, reason?): boolean;
export function campaignCounts(db, id): { pending: number; claimed: number; sent: number; skipped: number; failed: number };
export function sentInLastDay(db, accountId, nowMs): number;
```

`claimNextRow` is one conditional `UPDATE … WHERE id = (SELECT … LIMIT 1) AND status IN ('pending')
OR (status='claimed' AND lease_expires_at < :now AND submit_started_at IS NULL)` inside
`db.transaction(...).immediate()` — the same compare-and-swap Phase 3 proved on SQLite's single
writer.

**The at-most-once rule (the most important paragraph in this section).** Sending mail is
irreversible. The row's lifecycle is therefore:

```
pending ──claim──▶ claimed (submit_started_at NULL) ──beginRowSubmit──▶ claimed (submit_started_at set)
                       │                                                    │
                       ├── preflight fails ──▶ skipped                      ├── transport ok ──▶ sent
                       └── lease expires ────▶ pending (safe to retry)      ├── transport error ──▶ pending|failed
                                                                            └── process dies ────▶ failed
                                                                                 last_error = "indeterminate: …"
```

`recoverCampaign` runs at the start of every `runCampaignOnce` and at `serve` start: an expired
lease with `submit_started_at IS NULL` goes back to `pending`; an expired lease with
`submit_started_at` set becomes `failed` with `last_error = 'indeterminate: process exited after
submit began'` and is **never** retried automatically. `campaign resume --retry-indeterminate`
requeues them after printing how many and warning about possible duplicates. This is the same
at-most-once-over-at-least-once choice Phase 3 made for Gmail drafts, applied where it matters more.

**Pacing.** `nextDelayMs(ratePerMinute, jitterMs, rnd)` is pure:
`base = Math.ceil(60000 / ratePerMinute)`, `delay = max(0, base + Math.round((rnd()*2-1) * jitterMs))`.
Applied **only after a row was actually submitted** — skipped rows do not consume the rate budget
(otherwise a 500-row list that is 90 % suppressed would take hours to say so; test 271).

**Daily cap.** Before each claim, `sentInLastDay(db, accountId, now)` is compared to
`CAMPAIGN_DAILY_CAP` (default 400, well under Gmail's 500/2000). Exceeding it pauses the campaign
with `last_error='daily cap reached'` and `stopped:'daily_cap'`; a later run resumes automatically
when the trailing window drains (test 272).

**Preflight per row**, in order, each producing a distinct `skip_reason`:
`invalid_address` → `suppressed` → `opted_out` → `duplicate_in_csv` (marked at import) →
`missing_vars` → `unsafe_href`. Every skip is terminal for that row and costs no rate budget.

### 2.8 A/B subject testing

```ts
export interface Variant { key: string; template: string; weight: number }
export function assignVariant(campaignId: string, email: string, variants: Variant[]): string;
```
`h = sha256(campaignId + '\0' + email.trim().toLowerCase())`, `n = h.readUInt32BE(0)`,
`bucket = n % totalWeight`, walk the variants in declared order. Properties that matter and are
tested: deterministic (same inputs → same key, forever), independent of row order and of resume,
independent of the other rows, and within ±3 % of the requested split over 1000 synthetic addresses
(tests 253–255). The assignment is also **persisted** on `campaign_rows.variant` at import, so even
a future change to the hash cannot re-split a running campaign.

`campaign stats` reports, per variant: rows, sent, opened, clicked, replied, open rate, click rate,
plus a two-proportion `z` statistic between the two largest variants, labelled
`"indicative only — no multiple-comparison or sequential-testing correction, and N is usually far
too small"`. Reporting an unqualified "winner" would be the dishonest thing every competing tool
does; we report the number and the caveat.

### 2.9 Notifications: one digest, not N opens

- `NotifyTrigger` gains `'campaign_digest'`. `TrackingEvent` gains `campaignId: string | null`
  (populated in `record.ts` from `messages.campaign_id`; `null` everywhere else — additive).
- `decideTriggers` gains **P9**, evaluated after P0/P1 (mute and machine classifications still win)
  and before P3–P6:
  ```
  if (e.campaignId !== null) {
    if (cfg.campaignMode === 'off')      return [];
    if (cfg.campaignMode === 'digest')   return [];   // recorded, aggregated later
    /* 'per-open' */                                   // fall through to P3-P6 unchanged
  }
  ```
- `src/jobs/campaign-digest.ts` (`createCampaignDigestJob`) runs on the scheduler. For each campaign
  with `digest_next_at <= now`, it computes counts since the last window, and **only if something
  changed** enqueues one notification per configured channel with
  `dedupeKey = ${channel}:campaign_digest:${campaignId}:${windowStartMs}` — the existing
  `UNIQUE(dedupe_key)` then makes it exactly-once across restarts with no new machinery. A final
  digest is emitted when the campaign completes or is cancelled.
- Payload: `NotificationPayload` stays `version: 1` and gains an optional
  `campaign?: { id, name, windowFrom, windowTo, rows, sent, skipped, failed, opened, clicked,
  replied, openRate, clickRate, topVariant }`. For a digest, `recipient.email` is `null` and
  `recipient.id` is `''` — **a digest never names a recipient**, which is both a privacy property
  and the reason it is useful (tests 277–280).
- Channel text: `"Campaign “Q3 outreach”: 120 sent, 41 opened (34%), 9 clicked, 2 replied — last 60 min"`.

### 2.10 Privacy, retention and erasure

`campaign_rows` store `email` and `vars_json` (arbitrary CSV columns — names, companies, order
numbers). Therefore:

- `erase.ts` gains a step: for the erased address, `UPDATE campaign_rows SET email='(erased)',
  vars_json='{}', skip_reason=COALESCE(skip_reason,'erased') WHERE lower(trim(email)) = ?`. Rows are
  redacted, not deleted, so campaign counts stay truthful; the count is added to the existing
  address-free audit row (test 338).
- `campaigns.csv_path` stores the *path*, never the file contents; the file itself is never copied
  into the database. `csv_sha256` records what was imported so `campaign show` can tell you the
  source file changed.
- The retention/prune job gains campaigns: campaigns `completed`/`cancelled` longer ago than
  `RETENTION_DAYS` have their rows' `vars_json` cleared (test 339).
- A campaign row's `vars_json` never appears in a notification, an SSE frame, an audit row or a log
  line — only in the dashboard's campaign page and `campaign rows --json`, both behind auth.

### 2.11 Dashboard

Two new pages, built from the existing `html` tagged template, the existing CSP (no `unsafe-inline`),
and vendored htmx — no new assets:

- `GET /dashboard/campaigns` — list: name, status badge, account, progress bar (inline SVG via the
  existing `charts.ts` idiom), sent/total, open rate, created.
- `GET /dashboard/campaigns/:id` — header tiles (sent/opened/clicked/replied/failed/skipped), the
  per-variant table, a filtered rows table (`?status=failed`), the top-links table, and three
  CSRF-guarded buttons: Pause / Resume / Cancel.
- `GET /dashboard/fragments/campaign/:id` — the progress block, refreshed by
  `hx-trigger="every 5s"` while the campaign is running (polling, not SSE: a campaign's progress is
  not an event stream, and this keeps the CSP and the SSE budget untouched).
- `POST /dashboard/actions/campaign` — `{id, action: pause|resume|cancel, _csrf}`; goes through the
  same guard, same 303 redirect, same audit rows as the existing reclassify/mute actions.
- Nav gains **Campaigns** between Messages and Reminders.
- `GET /dashboard/campaigns/:id/rows.csv` reuses `toCsv` and the existing export cap.

---

## 3. Multi-account sending

### 3.1 Secret storage — `src/core/secretbox.ts` (new, Node crypto only)

```ts
export class SecretKeyError extends Error { readonly remedy: string }
export interface MasterKey { key: Buffer; source: 'env' | 'file'; path?: string; fingerprint: string }
export function loadMasterKey(env: NodeJS.ProcessEnv, opts?: { required?: boolean }): MasterKey | null;
export function generateMasterKey(): string;                     // 32 random bytes, base64
export function writeKeyFile(path: string, keyB64: string): void; // O_EXCL, mode 0600, fsync dir
export function seal(plaintext: string, key: Buffer, aad: string): string;
export function open(envelope: string, key: Buffer, aad: string): string;
export function secretAad(accountId: string, field: string): string;   // `op.sb.v1|${accountId}|${field}`
export function envelopeFingerprint(envelope: string): string;         // sha256(ct)[0..8], for display
```

**KDF + AEAD, chosen and justified:**

| Decision | Value | Why |
|---|---|---|
| KDF | `scrypt(masterKey, salt, 32, { N: 2**15, r: 8, p: 1, maxmem: 64 MiB })` | In Node's stdlib (`crypto.scryptSync`), memory-hard, no dependency. `N=2^15` is ~90 ms/~32 MiB on a small VPS — fine for a per-account derivation cached in-process, painful for an offline attacker. |
| AEAD | `aes-256-gcm`, 12-byte random nonce, 16-byte tag | In stdlib, hardware-accelerated, authenticated. XChaCha20 would be nicer for nonce reuse margins but is not in Node's stdlib, and a 12-byte random nonce under a per-row-salt-derived key has no practical collision risk at our volumes. |
| AAD | `op.sb.v1\|<accountId>\|<field>` | A ciphertext lifted from one account row and pasted into another fails to authenticate instead of silently decrypting. |
| Envelope | `op.sb.v1.<b64u(salt16)>.<b64u(nonce12)>.<b64u(ct‖tag)>` | Single `TEXT` column, greppable prefix, version-tagged for future rotation. |

**Key source**, in order: `OPENPOST_MASTER_KEY` (base64 or hex, ≥ 32 bytes decoded) → the file at
`OPENPOST_MASTER_KEY_FILE` → `${OPENPOST_CONFIG_DIR ?? ~/.config/openpost}/master.key`. A keyfile
whose mode has any group/other bit set is a `SecretKeyError` naming `chmod 600` (test 291) — the
same posture as ssh. `settings['master_key_fingerprint'] = sha256('op.mk.fp' ‖ key)[0..16]` is
written on first use; a mismatch on a later run is a `SecretKeyError`
("this database's secrets were encrypted with a different master key") rather than a stream of
decrypt failures (test 296).

Derived keys are cached in a `Map<saltHex, Buffer>` bounded to 32 entries for the process lifetime,
so a 500-row campaign pays the scrypt cost once, not 500 times (test 298).

**Never**: a secret in `argv` (visible in `ps`), in an audit row, in a log line, in `--json` output,
in an error message, in an SSE frame, or in the dashboard. `accounts add` reads secrets from stdin
only (`--app-password-stdin`, `--refresh-token-stdin`).

### 3.2 `accounts` columns (migration 007, §7.2)

`label`, `from_name`, `status`, `is_default`, `origin`, `self_open_strategy`, `recipient_mode`,
`config_json`, `secret_kind`, `secret_ciphertext`, `secret_scopes`, `secret_updated_at`,
`last_used_at`. `config_json` holds the non-secret transport bits (`smtpHost`, `smtpPort`,
`smtpSecure`, `smtpUser`, `gmailSmtpHost`, `gmailSmtpPort`, `imapHost`, `imapSentMailbox`,
`googleClientId`) — a JSON blob rather than fifteen more columns, because none of it is ever
queried, only read whole. `googleClientSecret` is a **secret** and lives in `secret_ciphertext`
alongside the refresh token as a JSON object when `secret_kind='gmail_oauth'`.

### 3.3 Resolution — `src/mail/accounts.ts` (new)

```ts
export interface ResolvedAccount {
  id: string; email: string; fromName: string | null;
  transport: TransportName; selfOpenStrategy: SelfOpenStrategy; recipientMode: RecipientModeOption;
  config: AccountTransportConfig;
  isEnvFallback: boolean;
  secret(): AccountSecret;              // decrypts on demand; throws SecretKeyError
}
export type AccountRef = string;        // id | label | email
export function resolveAccount(db: DB, config: AppConfig, ref?: AccountRef): ResolvedAccount;
export function listAccounts(db: DB): AccountSummary[];
export function addAccount(db: DB, config: AppConfig, input: AddAccountInput): ResolvedAccount;
export function setDefaultAccount(db: DB, ref: AccountRef): void;
export function importEnvAccount(db: DB, config: AppConfig, opts: { label?: string; makeDefault?: boolean }): ResolvedAccount;
export function rotateMasterKey(db: DB, oldKey: MasterKey, newKey: MasterKey): { reEncrypted: number };
export function resolveTransportForAccount(account: ResolvedAccount, config: AppConfig): Transport;
```

`resolveAccount` order: explicit `ref` → `accounts` row with `is_default=1` → **the env fallback**,
a synthetic `ResolvedAccount { id: <ensureAccount(FROM_EMAIL)>, isEnvFallback: true }` built from
`AppConfig` exactly as today. **A tree with zero `accounts` rows added by the CLI behaves
identically to today** — this is what makes multi-account a pure addition rather than a migration
everyone has to perform (test 293).

`resolveTransportForAccount` builds the transport from the account's own config/secret; the existing
`resolveTransport(config)` is kept and reimplemented as
`resolveTransportForAccount(envAccount(config), config)` so every current caller and test is
unaffected (test 294).

`rotateMasterKey` decrypts every secret under the old key and re-encrypts under the new one inside
**one** transaction, verifying each round-trip before commit; a single failure rolls the whole thing
back and leaves the old key valid (test 299).

### 3.4 Wiring into sends

- `openpost send` gains `--from-account <ref>`. `--from <email>` still works and now also matches an
  account by email; `--from` + `--from-account` disagreeing is a usage error (exit 2).
- `--transport` on the command line still overrides the account's transport (and still re-validates
  the self-copy rule through `shouldRunSelfCopy`).
- `campaigns.account_id` is fixed at create time: a campaign never changes identity mid-run.
- `messages.account_id` already records which account sent each message, so stats, the dashboard and
  `forget` are per-account for free.
- `accounts.last_used_at` is touched on each successful send (outside the send transaction; a
  failure to touch it never fails a send).

### 3.5 Removing an account (the dangerous one)

`messages.account_id` cascades. Therefore:

- `openpost accounts remove <ref>` **disables** by default: `status='disabled'`, secrets zeroed
  (`secret_ciphertext=NULL`), `is_default` cleared. The row and every message survive. A disabled
  account cannot be selected for a send (`ConfigError` naming `accounts enable`).
- `openpost accounts remove <ref> --purge --yes` is the only destructive path. It first prints
  `"this will delete N messages, M recipients and K events"`, requires `--yes`, writes an audit row
  with the counts (no addresses), and only then deletes (test 297).
- Removing the default account when others exist requires `--reassign <ref>` or leaves the install
  with no default (falling back to env, with a `doctor` warning).

### 3.6 Migrating the current single-account env config

`openpost accounts import-env [--label <l>] [--default]` materialises `FROM_EMAIL`, `FROM_NAME`,
`MAIL_TRANSPORT`, `SELF_OPEN_STRATEGY`, `RECIPIENT_MODE`, the SMTP settings and the on-disk Gmail
token store (`~/.config/openpost/gmail-token.json`) into an encrypted `accounts` row, then prints the
env lines that are now redundant. It does **not** edit `.env` and does **not** delete the token
store — the operator does that after verifying. Migration 007 additionally marks the oldest existing
`accounts` row `is_default=1`, `origin='legacy'`, so a pre-Phase-4 database already has a sensible
default (test 310).

### 3.7 Why accounts are CLI-only

No accounts page in the dashboard. Adding one means a web form that accepts a password or refresh
token, over a session whose threat model was written for a read-mostly UI, on a port operators do
sometimes bind off loopback. `openpost doctor` shows account health; the CLI manages them; the web
UI never sees a secret, not even to write one. Stated here so it reads as a decision, not an
omission.

---

## 4. Zero-setup onboarding, packaging, backup/restore

### 4.1 `openpost init` becomes a wizard

Same command, three modes, one code path:

```
openpost init                     # interactive when stdin is a TTY
openpost init --yes  --base-url … --from … [--transport …] [--dashboard-password …] [--no-master-key]
openpost init --print-env         # writes nothing; prints the .env it would write
```

`src/cli/wizard.ts` (new) is a thin, injectable prompt layer:

```ts
export interface PromptIo { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; isTty: boolean }
export interface WizardAnswers { dataDir: string; baseUrl: string; fromEmail: string; fromName: string | null;
  transport: TransportName; dashboardPassword: string | null; generateMasterKey: boolean; enableTunnelHint: boolean }
export async function runWizard(io: PromptIo, defaults: Partial<WizardAnswers>): Promise<WizardAnswers>;
export function renderEnvFile(answers: WizardAnswers, generated: { trackingSecret: string }): string;
```

Built on `node:readline/promises` with injected streams, so the whole wizard is driven from a test
with a scripted stdin and asserted on the produced `.env` — no TTY, no pty, no new dependency
(test 320).

Behaviour:
- Generates `TRACKING_SECRET` (36 random bytes, base64) and, unless `--no-master-key`,
  `OPENPOST_MASTER_KEY_FILE` at `~/.config/openpost/master.key` with `O_EXCL` + mode `0600`.
- Writes `.env` with `mode: 0o600`, **never overwrites** an existing `.env` without `--force`
  (with `--force` it first copies it to `.env.bak.<epoch>`), and never prints the secret to stdout
  when `--json` is set (test 317).
- Runs `migrate`, prints the schema version.
- Prints, in order: how to start (`openpost serve`), how to expose (`openpost tunnel` + the
  `TRACKING_BASE_URL` it will need), how to authorise Gmail (`openpost auth gmail`), and
  `openpost doctor --offline`.
- Idempotent: a second `init` on a configured tree reports "already initialised" and exits 0
  without touching `.env` or the keyfile (test 318).

### 4.2 `npx openpost init`

`package.json` changes: drop `"private": true`; add `"files": ["dist", "README.md", "LICENSE",
"docs/deploy.md", "packaging"]`, `"prepack": "npm run build"`, `"repository"`, `"license"`,
`"keywords"`, and keep `engines.node >= 22`. No `postinstall` script, ever — a tracker that runs
arbitrary code on install is not a tracker anyone should trust.

Honest note for the implementer: verify the npm name `openpost` is actually free before publishing;
if it is not, use a scope (`@<owner>/openpost`) and keep the `bin` name `openpost`. The docs must
show whichever is real, not an aspirational command.

### 4.3 Docker

`Dockerfile` (multi-stage, Debian both stages — better-sqlite3's prebuilt binaries are glibc, and
building it on Alpine means shipping a toolchain or a musl build; not worth it):

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --no-audit --no-fund && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production DB_PATH=/data/openpost.db OUT_DIR=/data/out \
    BIND_ADDRESS=0.0.0.0 PORT=8787 OPENPOST_CONFIG_DIR=/data/config
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN useradd -r -u 10001 -d /data openpost && mkdir -p /data && chown -R openpost /data
USER openpost
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["serve"]
```

Note `BIND_ADDRESS=0.0.0.0` inside the container: `assertSafeToBind` already requires `API_TOKEN`
for a non-loopback bind, and `assertSafeToServeDashboard` requires a dashboard secret — so the
image refuses to start insecurely, which is exactly the intended behaviour and must be documented
in `docs/deploy.md` rather than worked around.

`compose.yaml`: one service, one named volume at `/data`, `env_file: .env`, `restart: unless-stopped`,
`ports: "127.0.0.1:8787:8787"` (loopback-published by default — the tunnel is the exposure story).
`.dockerignore`: `node_modules`, `dist`, `data`, `out`, `coverage`, `.git`, `tests`, `docs/reports`.

The roadmap's "< 150 MB" is not asserted in CI; the smoke report records the measured
`docker image ls` size. `node:22-bookworm-slim` alone is ~220 MB uncompressed, so the honest claim
is "≈ 250 MB uncompressed / ≈ 90 MB compressed pull", and the roadmap line is corrected rather than
quietly missed.

### 4.4 systemd

`packaging/openpost.service` (documented, not installed by the tool):

```ini
[Unit]
Description=openpost tracking server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=openpost
Group=openpost
WorkingDirectory=/var/lib/openpost
EnvironmentFile=/etc/openpost/openpost.env
ExecStart=/usr/bin/node /opt/openpost/dist/cli/index.js serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
ReadWritePaths=/var/lib/openpost
UMask=0077
[Install]
WantedBy=multi-user.target
```

Plus `packaging/openpost.env.example` and a `packaging/README.md` with the four install commands.
`UMask=0077` matters: it keeps the SQLite file and the master keyfile private by default.

### 4.5 Migration fixtures — v1 → v7

`scripts/make-migration-fixtures.mjs` (checked in, run by hand, not by CI) builds
`tests/fixtures/db/v{1..6}.sqlite` by applying migrations `001..N` to a fresh file and inserting a
fixed, documented row set (2 accounts, 3 messages, 6 recipients, 8 open events, 3 click events,
2 notifications, 1 audit row, 1 suppression — plus, for v5+, 2 reminders, and for v6+, one
single-mode message with an aggregate recipient). The **files** are committed; the script exists so
the next phase can extend them.

`tests/integration/migrate-fixtures.test.ts` (cases 308–315) loops over every fixture: copy to a
temp file → assert `user_version === N` → `migrate()` → assert `user_version === 7` → assert every
table's row count is unchanged → assert the new columns exist with their documented defaults →
`PRAGMA integrity_check` = `ok` → `PRAGMA foreign_key_check` empty → run a representative query
(`listMessagesFiltered`, `statsReport`, `campaignCounts`) without throwing → `migrate()` a second
time and assert it is a no-op.

This is strictly stronger than the existing replay-based tests, which can only prove the migrations
are self-consistent, not that they work on a file a real user has been writing to since Phase 1.
Those tests stay.

### 4.6 `openpost backup` / `openpost restore`

`src/db/backup.ts` (new):

```ts
export interface BackupManifest {
  version: 1; createdAt: number; openpostVersion: string; schemaVersion: number;
  sourcePath: string; fileName: string; bytes: number; sha256: string; gzip: boolean;
  rowCounts: Record<string, number>;
  trackingSecretFingerprint: string | null; masterKeyFingerprint: string | null;
}
export async function backupDatabase(db: DB, opts: { outDir: string; tag?: string; gzip?: boolean; clock?: () => number }): Promise<{ path: string; manifestPath: string; manifest: BackupManifest }>;
export interface RestoreCheck { ok: boolean; problems: string[]; manifest: BackupManifest | null; schemaVersion: number }
export function inspectBackup(path: string): RestoreCheck;
export async function restoreDatabase(opts: { from: string; to: string; force?: boolean }): Promise<{ restored: string; schemaBefore: number; schemaAfter: number; rowCounts: Record<string, number> }>;
export function pruneBackups(dir: string, keep: number): string[];
```

- **Backup** uses better-sqlite3's `db.backup(dest)` — the SQLite **online backup API**, so a
  running `serve` process can be backed up without stopping it and without a torn WAL (copying the
  `.db` file with `cp` is the bug this exists to avoid; say so in the docs). Then: open the copy
  read-only, `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, count rows per table, sha256 the
  file, optionally gzip it with `node:zlib` (builtin), write `<name>.json` next to it.
- Output name: `openpost-<YYYYMMDD-HHMMSS>[-tag].sqlite[.gz]` in `BACKUP_DIR` (default
  `./data/backups`), mode `0600`.
- **Restore** refuses unless: the manifest sha256 matches, `integrity_check` is `ok`, the backup's
  schema ≤ `EXPECTED_SCHEMA`, and the destination is absent or empty — `--force` overrides the last
  one only, after printing what will be overwritten. On success it runs `migrate()` and prints
  before/after schema and row counts.
- The manifest records `masterKeyFingerprint`: restoring a backup on a host with a different master
  key prints a **warning** that account secrets in it will not decrypt (they are ciphertext; the
  backup alone is not enough, which is the point). `backup` prints the same reminder once.
- `BACKUP_ENABLED=true` registers a `backup` scheduler job every `BACKUP_INTERVAL_HOURS` keeping
  `BACKUP_KEEP` files.

### 4.7 Node SEA: deferred, with reasons

The roadmap's Phase 4 DoD 3 ("single binary runs on a clean container with no Node installed") is
**formally amended**, not quietly missed:

1. `better-sqlite3` is a native addon. Node's SEA embeds one JavaScript blob; `process.dlopen` still
   needs `better_sqlite3.node` on disk. The "single binary" would be a binary plus a sidecar — which
   is worse than a tarball, not better.
2. SEA requires a single pre-bundled JS file, i.e. esbuild/ncc: a bundler (explicitly excluded) and
   a new devDependency, plus rewrites of `migrationsDir()` and `loadDashboardAssets()`, both of
   which resolve paths from `import.meta.url`.
3. The actual user value — "runs on a clean machine with no Node installed" — is fully delivered by
   the Docker image in §4.3, which we ship and can verify.
4. The clean path exists and is cheap **later**: when the tree moves from `better-sqlite3` to the
   built-in `node:sqlite`, the native addon disappears and SEA becomes a genuine one-file build.
   That migration is a phase of its own (different API, different transaction helpers, different
   test surface).

Phase 4 therefore ships `docs/packaging.md` recording this analysis and the exact SEA recipe to use
once `node:sqlite` lands, and the roadmap line becomes: *"Docker image runs on a host with no Node
installed; SEA single binary deferred to Phase 5, gated on the `node:sqlite` migration."*

---

## 5. Optional local geo

### 5.1 The honesty constraint

openpost's differentiator #5 is *"honest location reporting — proxied opens are labelled
'unknown (proxied)' instead of showing Google's datacentre city"*. Geo must not erode that. So geo
is **suppressed by construction** whenever the IP is not plausibly the reader's:

```
if (privacyMode === 'strict')                          → null   (nothing, ever)
if (classification ∈ {google_proxy_prefetch, apple_mpp, self_open, bot, scanner, duplicate}) → null
if (ranges.isAppleRelay || ranges.isGoogleProxy || ranges.isDatacenter)                      → null
otherwise → lookup, capped by min(GEOIP_GRANULARITY, privacy-mode cap)
```

Privacy-mode caps: `off` → city; `balanced` → **country only** (a city is materially more
identifying than the salted IP hash we are willing to store); `strict` → nothing.

### 5.2 Module — `src/core/geo.ts` (new)

```ts
export interface GeoResult { country: string | null; region: string | null; city: string | null }
export interface GeoLookup { lookup(ip: string): GeoResult | null; readonly buildEpoch: number | null }
export const NULL_GEO: GeoResult;
export async function createMmdbLookup(path: string): Promise<GeoLookup>;    // dynamic import('mmdb-lib')
export type GeoGranularity = 'country' | 'region' | 'city';
export function effectiveGranularity(requested: GeoGranularity, privacyMode: PrivacyMode): GeoGranularity | 'none';
export function geoForEvent(args: {
  ip: string | null; classification: string; privacyMode: PrivacyMode;
  granularity: GeoGranularity; flags: { isAppleRelay: boolean; isGoogleProxy: boolean; isDatacenter: boolean };
  lookup: GeoLookup | null;
}): GeoResult;
```

- `createMmdbLookup` uses `readFileSync` + `new Reader(buffer)` from `mmdb-lib`, wrapped in
  try/catch; any failure returns `null` and is surfaced as a `doctor` warning, never an exception in
  the request path.
- The raw IP is passed to `geoForEvent` **in memory only**, inside `recordOpen`/`recordClick`,
  before hashing. Nothing changes about what is stored: `country`/`region`/`city` are existing
  columns and the IP still never lands anywhere.
- A lookup must never throw into the pixel path: `geoForEvent` catches and returns `NULL_GEO`
  (test 330). A 1 ms in-memory lookup is acceptable inside the request; a failure is not.
- `TrackingEvent.country` (already declared and always `null` today) starts being populated — the
  notification wire format needs no change, which was the point of Phase 2 declaring it.

### 5.3 Presentation

`present.ts` and the dashboard already print "unknown (proxied)" when there is no location. With geo
on, the rule becomes: a stored country renders as the place; a `NULL` country on a proxied/machine
classification renders **"unknown (proxied)"** as today; a `NULL` country on a human open with geo
enabled renders **"unknown"**. Three distinct strings, because conflating them is how every other
tracker lies (test 331).

### 5.4 Dependency

`mmdb-lib` — pure TypeScript, zero transitive runtime dependencies, reads MaxMind DB v2 —
added to **`optionalDependencies`**, loaded through dynamic `import()`, exactly like `imapflow`.
If it is absent, geo is disabled with a one-line explanation from `doctor`. This is the only new
runtime dependency in Phase 4; the second slot in the budget is deliberately left unused (the CSV
reader, the template renderer, the crypto, the backup and the gzip are all in-tree or in Node's
stdlib).

### 5.5 Licensing and data

openpost ships **no** geo data. `GEOIP_DB_PATH` points at a file the operator downloads from MaxMind
under their own account and EULA (GeoLite2 requires a free account and forbids redistribution).
`docs/deploy.md` gets a short section: how to get the file, how to refresh it, and the fact that the
tool works perfectly without it. `doctor` warns when the database is older than `GEOIP_MAX_AGE_DAYS`
(default 90) since a stale mmdb is a source of wrong answers presented confidently.

### 5.6 Testing without a network

- Every decision in `geoForEvent` is tested against an **injected fake** `GeoLookup` — no file, no
  parser, no fixture (cases 324–329, 331).
- The `mmdb-lib` reader itself is tested against `tests/fixtures/geo/GeoIP2-City-Test.mmdb`, vendored
  from `maxmind/MaxMind-DB` `test-data/` (Apache-2.0), checked in with its upstream URL and sha256
  in `tests/fixtures/geo/README.md` — the same hash-pinned-vendored-asset precedent as
  `htmx.min.js`, and asserted by `doctor` in the same way. The test is
  `it.skipIf(!existsSync(FIXTURE))` so a checkout without it still goes green (case 330).

---

## 6. In-Gmail checkmarks: deferred, with the server half shipped

### 6.1 The decision

**The packaged Chrome extension is deferred to Phase 5. Its entire server-side contract ships in
Phase 4, fully tested.** Reasons, honestly:

1. The only part that cannot be tested offline is the only hard part: Gmail's undocumented,
   obfuscated, frequently-rotated DOM. Everything else — matching, lookup, auth, CORS — is
   server-side and testable today, so shipping it now costs little and de-risks Phase 5 entirely.
2. An extension is a **second release channel**: a Chrome Web Store listing and review, a stable
   extension id (which the server's CORS allowlist must name), an update pipeline, and a Firefox
   variant that people will immediately ask for. That is disproportionate next to campaigns,
   accounts and packaging in the same pass.
3. It is a real credential surface. A content script on `mail.google.com` holding a bearer token for
   the operator's instance deserves its own design pass (token in `chrome.storage.session` not
   `local`, explicit `host_permissions`, no `<all_urls>`, isolated world, no compose interception,
   no write path at all). Bolting it on at the end of a large phase is how that goes wrong.
4. Phase 4 is already at or above Phase 3's size (116 test cases, ~30 new files) without it.

Roadmap DoD 4 is therefore amended to: *"the API an in-Gmail indicator needs is shipped, documented
and tested; the extension itself is Phase 5 and remains optional."*

### 6.2 What Phase 4 does ship

**a) Thread lookup.** `POST /api/threads/lookup` (under the existing `/api` auth hook):

```jsonc
// request  (each array ≤ 100 entries)
{ "threadIds": ["18f…"], "rfc822MessageIds": ["<x@y>"], "subjects": ["Re: Q3 numbers"] }
// response
{ "results": [ { "key": "18f…", "matchedBy": "threadId" | "rfc822MessageId" | "subject" | null,
                 "messageId": "…", "subject": "…", "sentAt": 1789…,
                 "summary": { "state": "read_confirmed", "opens": 3, "clicks": 1, "replied": true,
                              "recipients": 2, "lastOpenAt": 1789… },
                 "recipients": [ { "email": "…", "state": "opened", "openCount": 2, "clickCount": 0,
                                   "lastOpenAt": 1789…, "repliedAt": null } ] } ] }
```

`src/server/services/thread-lookup.ts` → `lookupThreads(db, query, opts)`; matching order is
`threadId` (exact, `recipients.thread_id` / `messages.thread_id`) → `rfc822MessageIds` (exact) →
`normalizeSubject` (last resort, newest message within the last `THREAD_LOOKUP_DAYS`, default 30,
and `matchedBy:'subject'` so a consumer can show it as approximate). Unmatched keys return
`matchedBy: null` — never a guess presented as a match.

**b) `src/core/subject.ts`** (new, pure): `normalizeSubject(s)` strips a leading run of
`Re:`/`RE:`/`Fwd:`/`FW:`/`Aw:`/`Rif:`/`回复：`/`转发：` prefixes, unwraps `[list]` tags, collapses
whitespace, lowercases, NFKC-normalises and truncates to 200 chars. Unit-tested against a table of
~20 real-world subject forms (cases 332–334) — this is the piece a future extension most needs to
get right and most easily gets wrong.

**c) CORS, off by default.** `API_CORS_ORIGINS` is an exact-match, comma-separated allowlist
(`chrome-extension://abcdefghijklmnop`, `https://mail.google.com`). Rules, each with a test:

- Empty (default) → **no CORS headers are emitted at all**, and `OPTIONS` is not handled.
- Set while `API_TOKEN` is unset → `ConfigError` at load, exit 2. Never expose an unauthenticated
  API cross-origin.
- `*` is rejected at load. Only exact origins.
- Response headers: `Access-Control-Allow-Origin: <the echoed, matched origin>`, `Vary: Origin`,
  `Access-Control-Allow-Methods: GET, POST, OPTIONS`,
  `Access-Control-Allow-Headers: authorization, content-type`, `Access-Control-Max-Age: 600`.
- **`Access-Control-Allow-Credentials` is never sent**, and a cross-origin request carrying an
  `Origin` header is authenticated by **bearer only** — the dashboard session cookie is explicitly
  rejected on cross-origin requests (test 337). Without this, the existing "`/api` also accepts the
  dashboard cookie" convenience would become a CSRF hole the moment CORS is enabled.

**d) `docs/extension.md`** — the Phase 5 hand-off: the full MV3 design (below), so it is a small job.

### 6.3 The minimal extension, specified for Phase 5

| Item | Decision |
|---|---|
| Files | `manifest.json`, `content.js`, `matcher.js`, `options.html`, `options.js`. Five files, no build step, no npm, no bundler — loaded unpacked during development. |
| `manifest_version` | 3. `host_permissions: ["https://mail.google.com/*"]` plus the operator's own instance origin, entered in options and added with `chrome.permissions.request` at runtime. No `<all_urls>`, no `tabs`, no `webRequest`. |
| Content script | Runs at `document_idle` on `https://mail.google.com/*`, isolated world. Reads thread rows: subject text plus `span[email]` addresses. Batches up to 100 keys, calls `POST /api/threads/lookup` with the bearer, renders one `<span class="op-tick" title="…">` per matched row. **No compose interception, no DOM writes outside its own span, no request rewriting, no MutationObserver on `document` (scoped to the thread list container, throttled to 500 ms).** |
| Auth | Instance base URL + bearer token entered on the options page, stored in `chrome.storage.session` (cleared when the browser closes) with an opt-in "remember" that uses `chrome.storage.local`. The token is never sent anywhere but the configured origin. |
| Server requirements | `API_TOKEN` set; `API_CORS_ORIGINS` containing `chrome-extension://<id>`; `/api/threads/lookup` reachable from the browser (loopback is fine — the extension runs on the same machine). |
| Test strategy (Playwright-free) | `matcher.js` is a plain ES module with **no DOM access**: it takes `{subject, addresses, rowId}[]` and the lookup response and returns `{rowId, glyph, title}[]`. It is unit-tested in vitest against fixture arrays, including the `normalizeSubject` table. The DOM extraction (`extractRows(document)`) is tested against checked-in HTML fixture strings parsed with the already-present cheerio. Nothing else is automated. |
| Manual checklist | Shipped in `docs/extension.md`: (1) load unpacked, (2) options accept URL+token and report a successful `/healthz`, (3) a tracked sent thread shows a tick within 2 s, (4) an untracked thread shows nothing, (5) a proxied-only open shows the hollow "prefetched" glyph, not the filled one, (6) revoking the token makes the ticks disappear rather than showing stale state, (7) no console errors, no CSP violations on Gmail, (8) disabling the extension leaves Gmail visually unchanged. |
| Glyphs | `○` not opened · `◐` prefetched (read **not** confirmed) · `●` opened · `◉` read confirmed · `↩` replied. The prefetched glyph is the whole point: Mailtrack shows a double tick there. |

---

## 7. Change list, migration, env, CLI, tests, smoke, acceptance

### 7.1 Per-file change list

**New files**

| Path | Contents |
|---|---|
| `src/core/csv.ts` | `parseCsv`, `normalizeHeader`, `pickEmailColumn`, `CsvError` (§2.2) |
| `src/core/template.ts` | `renderTemplate`, `collectVars`, `sanitizeHeaderValue`, `TemplateError` (§2.3) |
| `src/core/secretbox.ts` | scrypt + AES-256-GCM envelope, master-key loading/fingerprinting (§3.1) |
| `src/core/geo.ts` | `geoForEvent`, `createMmdbLookup`, `effectiveGranularity` (§5.2) |
| `src/core/subject.ts` | `normalizeSubject` (§6.2b) |
| `src/mail/send-message.ts` | `sendMessage` — the extracted send pipeline (§2.6) |
| `src/mail/accounts.ts` | `resolveAccount`, `addAccount`, `importEnvAccount`, `rotateMasterKey`, `resolveTransportForAccount` (§3.3) |
| `src/db/campaigns.ts` | campaign + row repo, claim/lease/mark functions (§2.7) |
| `src/db/campaign-stats.ts` | `campaignReport`, per-variant breakdown, `twoProportionZ` (§2.8) |
| `src/db/backup.ts` | `backupDatabase`, `inspectBackup`, `restoreDatabase`, `pruneBackups` (§4.6) |
| `src/jobs/campaigns.ts` | `runCampaignOnce`, `recoverCampaign`, `createCampaignsJob` (§2.7) |
| `src/jobs/campaign-digest.ts` | `createCampaignDigestJob` (§2.9) |
| `src/jobs/backup.ts` | `createBackupJob` (§4.6) |
| `src/cli/wizard.ts` | injectable prompt layer + `renderEnvFile` (§4.1) |
| `src/cli/commands/campaign.ts` | the whole `campaign` command group (§7.4) |
| `src/cli/commands/accounts.ts` | the whole `accounts` command group (§7.4) |
| `src/cli/commands/backup.ts` | `backup` + `restore` (§7.4) |
| `src/server/services/thread-lookup.ts` | `lookupThreads` (§6.2a) |
| `src/server/cors.ts` | allowlist parsing, preflight, cross-origin auth rule (§6.2c) |
| `src/server/views/pages/{campaigns,campaign}.ts` | the two dashboard pages (§2.11) |
| `src/db/migrations/007_phase4.sql` | §7.2 |
| `Dockerfile`, `.dockerignore`, `compose.yaml` | §4.3 |
| `packaging/openpost.service`, `packaging/openpost.env.example`, `packaging/README.md` | §4.4 |
| `scripts/make-migration-fixtures.mjs`, `scripts/campaign-crash-child.mjs` | §4.5, test 265 |
| `tests/fixtures/db/v{1..6}.sqlite`, `tests/fixtures/campaign/{rows500.csv,rows-messy.csv,body.html}` | fixtures |
| `tests/fixtures/geo/GeoIP2-City-Test.mmdb` + `README.md` | vendored, hash-recorded (§5.6) |
| `docs/campaigns.md`, `docs/accounts.md`, `docs/packaging.md`, `docs/extension.md` | operator docs |

**Modified files**

| Path | Change |
|---|---|
| `src/db/index.ts` | `EXPECTED_SCHEMA = 7` |
| `src/db/repo.ts` | `createMessage` accepts `campaignId`; account helpers widened; `listMessagesFiltered` gains a `campaignId` filter |
| `src/db/erase.ts` | redact `campaign_rows` for the erased address; count it in the audit row (§2.10) |
| `src/db/report.ts` / `src/db/stats.ts` | optional `campaignId` scope |
| `src/cli/commands/send.ts` | becomes a thin wrapper over `sendMessage`; gains `--from-account` |
| `src/cli/commands/init.ts` | wizard, `.env` writing, `--yes/--force/--print-env` (§4.1) |
| `src/cli/commands/auth.ts` | `--account <ref>` stores the token encrypted in the DB |
| `src/cli/commands/doctor.ts`, `src/core/doctor.ts` | new checks (§7.5) |
| `src/cli/program.ts` | register `campaign`, `accounts`, `backup`, `restore` |
| `src/cli/commands/serve.ts` | register the `campaigns`, `campaign-digest` and `backup` jobs |
| `src/config/env.ts` | all of §7.3; `API_CORS_ORIGINS` validation; geo validation |
| `src/core/html.ts` | `assertSafeHrefs` (§2.3) |
| `src/mail/mime.ts` | nothing (its `headers` field already exists) — but `sendMessage` now uses it |
| `src/notify/types.ts` | `NotifyTrigger` += `campaign_digest`; `TrackingEvent.campaignId`; optional `payload.campaign` |
| `src/notify/policy.ts` | rule P9 + `dedupeKey` case (§2.9) |
| `src/notify/channels/*.ts` | render the digest block |
| `src/server/services/record.ts` | populate `campaignId` and `country`/`region`/`city` (§5) |
| `src/server/app.ts` | register CORS hook + thread-lookup route + campaign dashboard routes |
| `src/server/routes/api.ts` | `POST /threads/lookup`, `GET /campaigns`, `GET /campaigns/:id`; cross-origin auth rule |
| `src/server/routes/optout.ts` | `POST /u/:token` (§2.5) |
| `src/server/routes/dashboard.ts` / `dashboard-actions.ts` / `views/layout.ts` / `views/fragments.ts` | campaign pages, fragment, actions, nav |
| `src/server/routes/stream.ts` | widen `ALL_TRIGGERS` with `campaign_digest` (the exact bug the Phase 3 smoke report found — do not repeat it) |
| `src/server/present.ts` | three-way location string (§5.3); campaign fields |
| `package.json` | `mmdb-lib` optional dep; `files`/`prepack`/publish metadata; drop `private` |
| `README.md`, `docs/deploy.md`, `docs/03_roadmap.md` | new commands, Docker/systemd, the two amended DoD lines (§4.7, §6.1) |

### 7.2 Migration `src/db/migrations/007_phase4.sql` (schema_version = 7)

```sql
-- 007_phase4.sql (schema_version = 7)
-- Campaigns, multi-account credentials at rest, and the campaign_id back-references.
-- Nothing here drops or rewrites an existing table: every statement is an ADD COLUMN, a CREATE, or
-- a bounded UPDATE, so a populated v6 database upgrades with zero row loss.

-- ---------- multi-account ------------------------------------------------
ALTER TABLE accounts ADD COLUMN label              TEXT;
ALTER TABLE accounts ADD COLUMN from_name          TEXT;
ALTER TABLE accounts ADD COLUMN status             TEXT    NOT NULL DEFAULT 'active';  -- active | disabled
ALTER TABLE accounts ADD COLUMN is_default         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN origin             TEXT    NOT NULL DEFAULT 'legacy';  -- legacy | cli | env
ALTER TABLE accounts ADD COLUMN self_open_strategy TEXT;                                -- NULL = inherit env
ALTER TABLE accounts ADD COLUMN recipient_mode     TEXT;                                -- NULL = inherit env
ALTER TABLE accounts ADD COLUMN config_json        TEXT    NOT NULL DEFAULT '{}';       -- non-secret transport bits
ALTER TABLE accounts ADD COLUMN secret_kind        TEXT;                                -- app_password | gmail_oauth
ALTER TABLE accounts ADD COLUMN secret_ciphertext  TEXT;                                -- op.sb.v1.<salt>.<nonce>.<ct||tag>
ALTER TABLE accounts ADD COLUMN secret_scopes      TEXT;
ALTER TABLE accounts ADD COLUMN secret_updated_at  INTEGER;
ALTER TABLE accounts ADD COLUMN last_used_at       INTEGER;

CREATE UNIQUE INDEX idx_accounts_label   ON accounts(label)      WHERE label IS NOT NULL;
CREATE UNIQUE INDEX idx_accounts_default ON accounts(is_default) WHERE is_default = 1;

-- The oldest existing account becomes the default, so a pre-Phase-4 install already resolves one.
UPDATE accounts SET is_default = 1
 WHERE id = (SELECT id FROM accounts ORDER BY created_at ASC, id ASC LIMIT 1);

-- ---------- campaigns ----------------------------------------------------
CREATE TABLE campaigns (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status                TEXT NOT NULL,          -- draft|running|paused|completed|cancelled|failed
  subject_template      TEXT NOT NULL,
  subject_variants_json TEXT,                   -- [{key,template,weight}, …]; NULL = single variant
  body_html_template    TEXT NOT NULL,
  body_text_template    TEXT,
  allow_raw             INTEGER NOT NULL DEFAULT 0,
  from_email            TEXT NOT NULL,
  from_name             TEXT,
  transport             TEXT NOT NULL,
  track                 INTEGER NOT NULL DEFAULT 1,
  track_clicks          INTEGER NOT NULL DEFAULT 1,
  dry_run               INTEGER NOT NULL DEFAULT 0,
  rate_per_minute       INTEGER NOT NULL,
  jitter_ms             INTEGER NOT NULL,
  daily_cap             INTEGER NOT NULL,
  email_column          TEXT NOT NULL,
  columns_json          TEXT NOT NULL,          -- header order, for preview and export
  csv_path              TEXT,
  csv_sha256            TEXT,
  total_rows            INTEGER NOT NULL DEFAULT 0,
  digest_window_minutes INTEGER NOT NULL DEFAULT 60,
  digest_next_at        INTEGER,
  digest_from           INTEGER,
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  paused_at             INTEGER,
  cancelled_at          INTEGER,
  finished_at           INTEGER,
  last_error            TEXT,
  created_by            TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX idx_campaigns_status  ON campaigns(status, created_at DESC);
CREATE INDEX idx_campaigns_account ON campaigns(account_id);
CREATE INDEX idx_campaigns_digest  ON campaigns(status, digest_next_at);

CREATE TABLE campaign_rows (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  row_index         INTEGER NOT NULL,
  email             TEXT NOT NULL,
  vars_json         TEXT NOT NULL,
  variant           TEXT NOT NULL DEFAULT 'A',
  status            TEXT NOT NULL,              -- pending|claimed|sent|skipped|failed
  attempts          INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_expires_at  INTEGER,
  claimed_at        INTEGER,
  submit_started_at INTEGER,                    -- journalled BEFORE the transport call (§2.7)
  message_id        TEXT REFERENCES messages(id)   ON DELETE SET NULL,
  recipient_id      TEXT REFERENCES recipients(id) ON DELETE SET NULL,
  skip_reason       TEXT,                       -- suppressed|opted_out|invalid_address|duplicate_in_csv|missing_vars|unsafe_href|erased
  last_error        TEXT,
  sent_at           INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE(campaign_id, row_index)
);
CREATE INDEX idx_campaign_rows_claim ON campaign_rows(campaign_id, status, row_index);
CREATE INDEX idx_campaign_rows_lease ON campaign_rows(status, lease_expires_at);
CREATE INDEX idx_campaign_rows_msg   ON campaign_rows(message_id);
-- One live row per address per campaign; skipped duplicates are kept so the operator can see them.
CREATE UNIQUE INDEX idx_campaign_rows_addr ON campaign_rows(campaign_id, email) WHERE status <> 'skipped';

-- ---------- back-references ---------------------------------------------
ALTER TABLE messages      ADD COLUMN campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX idx_messages_campaign ON messages(campaign_id, created_at DESC);
-- No FK: a notification must survive its campaign's deletion long enough to be reported on.
ALTER TABLE notifications ADD COLUMN campaign_id TEXT;
CREATE INDEX idx_notifications_campaign ON notifications(campaign_id, created_at DESC);
```

Note on `campaign_rows.message_id ON DELETE SET NULL`: `openpost forget` / `DELETE /api/messages/:id`
may null it. Resume idempotency therefore keys on **`status`**, never on `message_id IS NOT NULL`
(test 268).

### 7.3 New environment variables

| Variable | Default | Meaning |
|---|---|---|
| `CAMPAIGNS_ENABLED` | `true` | Register the `campaigns` + `campaign-digest` jobs in `serve`. |
| `CAMPAIGN_TICK_SECONDS` | `15` | Drain interval for running campaigns. |
| `CAMPAIGN_RATE_PER_MINUTE` | `20` | Default send rate; per-campaign override at create. |
| `CAMPAIGN_JITTER_MS` | `4000` | Uniform ± jitter added to the pacing delay. |
| `CAMPAIGN_LEASE_MS` | `120000` | Row claim lease; an expired pre-submit lease is requeued. |
| `CAMPAIGN_MAX_ATTEMPTS` | `3` | Claims before a row is `failed`. |
| `CAMPAIGN_DAILY_CAP` | `400` | Rolling-24 h sent-message cap **per account**; hitting it pauses the campaign. |
| `CAMPAIGN_MAX_ROWS` | `10000` | Import cap; exceeding it is a usage error naming this variable. |
| `CAMPAIGN_DIGEST_MINUTES` | `60` | Default digest window. |
| `NOTIFY_CAMPAIGN_MODE` | `digest` | `digest` \| `per-open` \| `off` (§2.9). |
| `OPENPOST_MASTER_KEY` | – | Base64/hex master key, ≥ 32 bytes decoded. Beats the keyfile. |
| `OPENPOST_MASTER_KEY_FILE` | `${OPENPOST_CONFIG_DIR}/master.key` | Keyfile path; must be mode `0600`. |
| `BACKUP_ENABLED` | `false` | Register the scheduled `backup` job. |
| `BACKUP_DIR` | `./data/backups` | Destination directory (created `0700`). |
| `BACKUP_INTERVAL_HOURS` | `24` | Scheduled backup interval. |
| `BACKUP_KEEP` | `7` | Files retained by `pruneBackups`. |
| `BACKUP_GZIP` | `true` | gzip scheduled backups (`node:zlib`). |
| `GEOIP_DB_PATH` | – | Path to a MaxMind `.mmdb`. Unset ⇒ geo off. |
| `GEOIP_GRANULARITY` | `country` | `country` \| `region` \| `city`, capped by `PRIVACY_MODE` (§5.1). |
| `GEOIP_MAX_AGE_DAYS` | `90` | `doctor` warns past this. |
| `API_CORS_ORIGINS` | – | Exact-match origin allowlist for `/api`. Requires `API_TOKEN`; `*` rejected. |
| `THREAD_LOOKUP_DAYS` | `30` | Window for subject-based thread matching. |

### 7.4 CLI additions (full spec)

```
openpost campaign create --name <n> --csv <file> (--template <file> | --html <s>)
        --subject <tpl> [--subject-b <tpl>] [--variant-split 50/50]
        [--text-template <file>] [--email-column <col>] [--delimiter , | ; | tab]
        [--from-account <ref>] [--transport <name>] [--dry-run]
        [--rate-per-minute <n>] [--jitter-ms <n>] [--daily-cap <n>]
        [--digest-minutes <n>] [--no-track-clicks] [--allow-raw] [--start] [--json]
    Validates the template against the CSV headers BEFORE inserting anything; an unknown
    variable, an unsafe href in the template, a reserved column name or a missing email
    column is exit 2 with the offending line/column named. Prints rows imported, rows
    de-duplicated, rows suppressed and the variant split.

openpost campaign preview <id> [--row <n> | --email <addr>] [--count <n>] [--out <dir>] [--json]
    Renders to <out>/<campaign>.<row>.{html,txt,eml}. No DB writes, no send, no tokens.

openpost campaign run <id> [--limit <n>] [--max-seconds <n>] [--once] [--json]
openpost campaign pause  <id> [--json]
openpost campaign resume <id> [--retry-indeterminate] [--json]
openpost campaign cancel <id> [--yes] [--json]
openpost campaign list [--status <s>] [--limit <n>] [--json]
openpost campaign show  <id> [--json]
openpost campaign stats <id> [--json]
openpost campaign rows  <id> [--status <s>] [--limit <n>] [--csv] [--json]

openpost accounts add --email <addr> [--label <l>] [--transport <name>] [--from-name <n>]
        [--self-open-strategy window|insert|imap-append] [--recipient-mode auto|per-recipient|single]
        [--smtp-host <h>] [--smtp-port <n>] [--smtp-secure] [--smtp-user <u>]
        [--app-password-stdin | --refresh-token-stdin | --no-secret] [--default] [--json]
openpost accounts list [--json]
openpost accounts show <ref> [--json]        # never prints a secret; prints kind + fingerprint + age
openpost accounts default <ref>
openpost accounts enable  <ref>
openpost accounts remove  <ref> [--purge --yes] [--reassign <ref>]
openpost accounts import-env [--label <l>] [--default] [--json]
openpost accounts init-key [--path <p>] [--force]
openpost accounts rotate-key --new-key-file <p> [--json]

openpost auth gmail [--account <ref>] [--with-smtp] [--with-compose]
    With --account, the refresh token (and client secret) are stored encrypted in that
    account row instead of the on-disk token store.

openpost backup  [--out <dir>] [--tag <t>] [--gzip] [--json]
openpost restore <file> [--to <db>] [--force] [--dry-run] [--json]
    --dry-run runs every check and prints the manifest without writing anything.

openpost init [--yes] [--force] [--print-env] [--base-url <u>] [--from <addr>]
              [--transport <name>] [--dashboard-password <p>] [--no-master-key] [--json]
```

Exit codes unchanged: `0` ok, `1` runtime error, `2` bad usage/config.

### 7.5 `openpost doctor` additions

| id | fail/warn condition |
|---|---|
| `accounts.key` | master key missing while encrypted secrets exist (**fail**); keyfile mode not `0600` (**fail**); fingerprint mismatch (**fail**); no key and no secrets (pass, "not needed yet"). |
| `accounts.default` | more than one account and none default (**warn**); the default account is `disabled` (**fail**). |
| `accounts.secret` | an account whose `secret_ciphertext` does not decrypt (**fail**, naming the label only). |
| `campaign.stuck` | rows `claimed` with an expired lease and `submit_started_at IS NULL` (**warn**, "will be requeued"). |
| `campaign.indeterminate` | rows `failed` with `indeterminate:` (**warn**, naming `resume --retry-indeterminate`). |
| `campaign.optout` | any campaign whose latest sent message lacks a `List-Unsubscribe` header (**fail**). |
| `backup.recent` | `BACKUP_ENABLED` and the newest file in `BACKUP_DIR` older than `2 × BACKUP_INTERVAL_HOURS` (**warn**). |
| `geo.db` | `GEOIP_DB_PATH` set but unreadable/unparseable (**fail**); older than `GEOIP_MAX_AGE_DAYS` (**warn**); granularity downgraded by `PRIVACY_MODE` (**pass**, with the downgrade stated). |
| `geo.fixture` | the vendored test mmdb's sha256 does not match the recorded value (**fail**) — same treatment as `htmx.min.js`. |
| `api.cors` | `API_CORS_ORIGINS` set with no `API_TOKEN` (**fail** — also a load-time `ConfigError`); a non-exact origin (**fail**). |
| `db.schema` | expects **7**. |

### 7.6 Test plan — cases 230–345

All offline: `DB_PATH=':memory:'` or a temp file, fake clock, injected `sleep`/`random`/transport/
`GeoLookup`, `app.inject()`, no network, no browser. New files:
`tests/unit/{csv,template,secretbox,accounts,campaign-plan,campaign-claim,geo,subject,backup,wizard,cors,thread-lookup}.test.ts`,
`tests/integration/{campaign-flow,campaign-crash,campaign-stats,campaign-dashboard,campaign-notify,accounts-flow,backup-restore,migrate-fixtures,init-wizard,geo-flow,api-threads}.test.ts`.

**csv.test.ts**
230. Quoted fields with embedded commas, CRLF and `""` round-trip exactly.
231. BOM is stripped; CRLF and LF files parse identically.
232. Delimiter auto-detection picks `;` and tab from the header line; `--delimiter` overrides.
233. A ragged row with extra cells is a `CsvError` naming the line; fewer cells leaves keys absent.
234. Duplicate headers after normalisation are a `CsvError`.
235. `maxRows` / `maxCellBytes` fail with the line number and do not allocate the whole file.
236. A column literally named `__proto__` lands as an own property and does not touch `Object.prototype`.
237. `pickEmailColumn` finds `Email`, `E-Mail`, `address`; ambiguity or absence is an error naming `--email-column`.
238. An empty file and a headers-only file each produce a distinct, named error.
239. The 500-row fixture parses to 500 rows with stable order.

**template.test.ts**
240. `{{name}}` is HTML-escaped in `html` mode and verbatim in `text` mode.
241. `{{{name}}}` throws without `allowRaw` and passes through with it.
242. An unknown key throws `TemplateError` naming the key — never renders empty.
243. `collectVars` returns sorted unique keys and ignores `{{` inside a comment-free literal `{`.
244. A reserved key (`email`, `unsubscribe_url`, …) declared as a CSV column is rejected at create.
245. A value containing `{{other}}` is not re-rendered (single pass).
246. An unterminated `{{` throws with a byte offset.
247. An invalid key charset throws.
248. `subject` mode never HTML-escapes (an apostrophe stays an apostrophe).
249. `sanitizeHeaderValue` strips `\r\n\0`, collapses whitespace, truncates at 900 bytes; a cell of `X\r\nBcc: e@evil` cannot produce a second header (asserted against the built MIME).
250. `assertSafeHrefs` rejects `javascript:` and `data:` hrefs from a rendered body and accepts `http/https/mailto/cid`.
251. A rendered body with a 4 KB variable stays one MIME part and does not break quoted-printable.

**campaign-plan.test.ts**
252. `campaign create` validation order: unknown var → unsafe href → reserved column → missing email column, each exit 2 with the offending name.
253. `assignVariant` is deterministic for the same `(campaignId, email)` across 1000 calls.
254. A 50/50 split over 1000 synthetic addresses lands within ±3 %; a 90/10 split likewise.
255. Variant assignment is independent of row order and of a later re-import.
256. Every created campaign has an unsubscribe plan; there is no input that disables it (asserted by exhausting the option surface).
257. `List-Unsubscribe` and `List-Unsubscribe-Post` appear on the built MIME; `{{unsubscribe_url}}` in the body suppresses the duplicate footer.
258. **Regression:** `openpost send` output (`--json`) is byte-identical before and after the `sendMessage` extraction, for a 1-To and a 2-To+1-Cc+1-Bcc send.
259. **Regression:** dry-run artefacts from `openpost send` are byte-identical before and after the extraction (excluding Message-ID and timestamps).

**campaign-claim.test.ts / campaign-flow.test.ts**
260. 500-row dry-run campaign: 500 messages, 500 distinct pixel tokens, 500 distinct opt-out tokens, zero duplicates.
261. Suppressed and opted-out addresses become `skipped` with the right `skip_reason` and are never submitted.
262. `pause` stops after the in-flight row; no further rows are claimed.
263. `resume` continues from the exact next `row_index`; no row is sent twice.
264. `cancel` is terminal: `run` afterwards returns `stopped:'not_running'` and sends nothing; already-sent rows keep their messages.
265. **Crash between rows** (`scripts/campaign-crash-child.mjs` + SIGKILL): every remaining row is `pending`, and a fresh run sends each exactly once.
266. **Crash after submit began**: exactly one row is `failed` with `last_error` starting `indeterminate:`, and a fresh run does **not** re-send it.
267. `resume --retry-indeterminate` requeues that row, prints the count and the duplicate warning.
268. Deleting a sent row's message (`DELETE /api/messages/:id`) nulls `message_id` but the row stays `sent` and is never re-sent.
269. `campaignCounts` after a full run: `pending=0, claimed=0`, and `sent+skipped+failed === total_rows`.
270. `nextDelayMs` with an injected `random` produces the exact expected delays; two concurrent runners never claim the same row (two `runCampaignOnce` calls interleaved on one DB).
271. Skipped rows consume no pacing delay (a 100-row all-suppressed campaign completes in zero injected sleeps).
272. Exceeding `CAMPAIGN_DAILY_CAP` pauses with `stopped:'daily_cap'`; a later run with the window drained resumes.
273. A transport error is retried up to `CAMPAIGN_MAX_ATTEMPTS` and then `failed`, with the error stored and no partial recipient row left behind.

**campaign-stats.test.ts / campaign-notify.test.ts**
274. `campaignReport` totals and rates match an independent SQL cross-check on a seeded campaign.
275. `assertUnsubscribePresent` fails the row (and the campaign) if a footer or header is missing — the belt-and-braces check.
276. Per-variant rates and the two-proportion `z` are computed correctly for a hand-built 2×2 table; the caveat string is present in both text and JSON output.
277. P9: a campaign open produces **zero** immediate notifications in `digest` mode, the event is still recorded, and SSE still sees it.
278. 30 opens in one window produce exactly **one** digest per channel; a second digest job pass in the same window enqueues nothing (`UNIQUE(dedupe_key)`).
279. The digest payload has `recipient.email === null` and names no address anywhere in its JSON.
280. `NOTIFY_CAMPAIGN_MODE=per-open` restores Phase 2/3 behaviour exactly; `off` emits nothing.
281. A completed campaign emits a final digest even when the window has not elapsed.

**campaign-dashboard.test.ts**
282. `/dashboard/campaigns` lists a seeded campaign with the correct progress and open rate.
283. `/dashboard/campaigns/:id` renders the per-variant table and a filtered rows table (`?status=failed`).
284. The progress fragment is valid standalone HTML and reflects a status change without a reload.
285. Pause/Resume/Cancel go through the CSRF guard; a missing token is 403 and changes nothing.
286. A campaign name of `"><script>alert(1)</script>` renders escaped on both pages and in the CSV export.
287. `rows.csv` honours the status filter, the export cap and the formula guard.

**secretbox.test.ts / accounts-flow.test.ts**
288. `seal`/`open` round-trip; a flipped byte anywhere in the envelope throws, never returns plaintext.
289. AAD binding: a ciphertext moved to another `accountId` or another field fails to authenticate.
290. Envelope format matches `^op\.sb\.v1\.` and its three segments are valid base64url of 16/12/≥17 bytes.
291. A keyfile with mode `0640` is a `SecretKeyError` naming `chmod 600`; `0600` passes.
292. `resolveAccount` order: explicit ref → default row → env fallback; a `ref` matching label, email and id all resolve.
293. With **zero** CLI-added accounts, `openpost send` behaves byte-identically to the pre-Phase-4 tree.
294. `resolveTransport(config)` (old signature) and `resolveTransportForAccount(envAccount)` produce equivalent transports for all four transport names.
295. `accounts add --app-password-stdin` stores only ciphertext: `grep -a` over the DB file (plus `-wal`/`-shm`) for the plaintext finds nothing.
296. A wrong master key yields one `SecretKeyError` naming the fingerprint mismatch — not a decrypt loop, not a stack trace.
297. `accounts remove` disables by default and leaves messages intact; `--purge --yes` prints the counts, writes an address-free audit row, then deletes.
298. Derived keys are cached: a 50-row campaign on one account performs exactly one scrypt derivation (counted through an injected KDF spy).
299. `rotate-key` re-encrypts every secret in one transaction; an induced failure on the third account rolls back and leaves the old key working.

**backup-restore.test.ts**
300. `backupDatabase` on a populated DB produces a file whose `integrity_check` is `ok` and whose row counts match the source exactly.
301. The manifest's sha256 matches the written file; a mutated byte makes `inspectBackup` fail.
302. `restoreDatabase` into an empty path round-trips every table's row count and `user_version`; events are readable afterwards.
303. Restoring over a non-empty DB without `--force` refuses and changes nothing; with `--force` it succeeds and reports before/after.
304. A backup at schema 6 restored into a Phase-4 tree is migrated to 7 by `restore` and reports both numbers.
305. A backup from a *newer* schema than `EXPECTED_SCHEMA` is refused with a named error.
306. `--gzip` round-trips; the manifest records `gzip:true` and the uncompressed sha256.
307. A backup taken while a write transaction is open (simulated with a second connection) still passes `integrity_check` — the online-backup property.

**migrate-fixtures.test.ts**
308–313. For each fixture v1…v6: `migrate()` reaches 7, every table's row count is unchanged, `foreign_key_check` is empty, `integrity_check` is `ok`, and `migrate()` again is a no-op.
314. The new columns have their documented defaults on migrated rows (`accounts.status='active'`, `origin='legacy'`, `messages.campaign_id IS NULL`).
315. `listMessagesFiltered`, `statsReport` and `campaignCounts` all run against every migrated fixture without throwing.

**init-wizard.test.ts**
316. `init --yes --base-url … --from …` on an empty temp dir writes `.env` (mode `0600`) containing a ≥ 32-char generated `TRACKING_SECRET` and creates the DB at schema 7.
317. `--json` output never contains the secret or the master key; `--print-env` writes no file.
318. A second `init` reports "already initialised", exits 0 and leaves `.env` and the keyfile byte-identical.
319. `--force` backs the old `.env` up to `.env.bak.<epoch>` before overwriting.
320. The interactive wizard, driven by a scripted readline stream, produces the same `.env` as the flag form.
321. `init` refuses to create a master keyfile that already exists (no `--force`), and creates it with `O_EXCL` + `0600`.
322. `renderEnvFile` output parses back through `loadConfig` with zero issues.
323. `packaging/openpost.service`, `Dockerfile` and `compose.yaml` exist and contain the asserted invariants (`USER openpost`, `VOLUME ["/data"]`, `NoNewPrivileges=true`, `UMask=0077`) — a cheap guard against silent deletion.

**geo.test.ts / geo-flow.test.ts**
324. `geoForEvent` returns a country for a `human` open with a fake lookup.
325. `google_proxy_prefetch`, `apple_mpp`, `self_open`, `bot`, `scanner` and `duplicate` all return `NULL_GEO` even when the lookup would answer.
326. An IP flagged `isDatacenter`/`isAppleRelay`/`isGoogleProxy` returns `NULL_GEO`.
327. `PRIVACY_MODE=strict` never calls the lookup at all (spy asserts zero calls).
328. `PRIVACY_MODE=balanced` caps at country even with `GEOIP_GRANULARITY=city`.
329. `effectiveGranularity` is total over all nine mode×granularity combinations.
330. A lookup that throws is swallowed and yields `NULL_GEO`; the pixel response is still 200 with the 43-byte GIF. (Reader test against the vendored fixture mmdb, skipped when absent.)
331. Presentation: stored country → the place; `NULL` + proxied → "unknown (proxied)"; `NULL` + human + geo enabled → "unknown". Three distinct strings.

**subject.test.ts / thread-lookup.test.ts / cors.test.ts / api-threads.test.ts**
332. `normalizeSubject` strips stacked `Re: Fwd: RE:` prefixes and `[list]` tags, NFKC-normalises and truncates.
333. `normalizeSubject` on the ~20-entry real-world table matches expectations, including CJK reply prefixes.
334. Two different subjects never normalise to the same key in the table (no accidental collisions).
335. `lookupThreads` matches by threadId, then rfc822 id, then subject, and reports `matchedBy`; an unmatched key returns `matchedBy: null` and no guess.
336. `POST /api/threads/lookup` enforces the 100-key cap per array (400 beyond it) and the `THREAD_LOOKUP_DAYS` window for subject matches.
337. CORS: unset ⇒ no CORS headers and no `OPTIONS` handler; set + `API_TOKEN` ⇒ preflight 204 with exact-origin echo and `Vary: Origin`; a non-allowlisted origin gets no headers; `Access-Control-Allow-Credentials` is never present; a cross-origin request authenticated **only** by the dashboard cookie is 401; `API_CORS_ORIGINS` without `API_TOKEN` is a load-time `ConfigError`; `*` is rejected.

**cross-cutting**
338. `openpost forget <email>` redacts matching `campaign_rows` (`email='(erased)'`, `vars_json='{}'`), keeps the counts truthful, and records the number in the existing address-free audit row.
339. The retention job clears `vars_json` on campaigns finished longer ago than `RETENTION_DAYS`.
340. No campaign variable value, account secret, master key or CSV cell appears in any `audit_log` row, log line, SSE frame or export added by Phase 4 (grep-style assertion over a full simulated run).
341. `/healthz` reports `schema: 7`; `doctor --offline` expects 7.
342. Every new `doctor` check returns `pass`/`warn` (never throws) on a fresh, credential-free install.
343. `GET /api/campaigns` and `/api/campaigns/:id` are bearer-gated, paginate, and return the same numbers as `campaign stats --json`.
344. `ALL_TRIGGERS` in `routes/stream.ts` includes `campaign_digest` (the exact class of bug the Phase 3 smoke run found).
345. `openpost --help` lists `campaign`, `accounts`, `backup`, `restore`; each subcommand's `--help` exits 0 and names its required options.

### 7.7 Manual verification — `scripts/curl-smoke-phase4.sh`

```sh
# 0. clean install, wizard, schema
rm -rf /tmp/op4 && mkdir -p /tmp/op4 && cd /tmp/op4
node "$REPO/dist/cli/index.js" init --yes --base-url http://127.0.0.1:8787 --from me@example.com
ls -l .env && stat -c '%a' .env                       # 600
node "$REPO/dist/cli/index.js" doctor --offline --json | jq '[.checks[]|select(.status=="fail")]|length'   # 0

# 1. accounts: secret never lands in the clear
node "$REPO/dist/cli/index.js" accounts init-key
printf 'hunter2-app-password' | node "$REPO/dist/cli/index.js" accounts add \
  --email me@example.com --label work --transport smtp --smtp-host smtp.example.com --app-password-stdin --default
node "$REPO/dist/cli/index.js" accounts list
grep -ac 'hunter2-app-password' data/openpost.db data/openpost.db-wal 2>/dev/null   # 0 0
sqlite3 data/openpost.db "select substr(secret_ciphertext,1,10) from accounts;"     # op.sb.v1.

# 2. a 500-row dry-run campaign
node "$REPO/dist/cli/index.js" campaign create --name smoke --csv "$REPO/tests/fixtures/campaign/rows500.csv" \
  --template "$REPO/tests/fixtures/campaign/body.html" --subject 'Hi {{name}}' --subject-b 'Quick one, {{name}}' \
  --dry-run --rate-per-minute 6000 --jitter-ms 0 --json | tee create.json
CID=$(jq -r .campaignId create.json)
node "$REPO/dist/cli/index.js" campaign preview "$CID" --row 1 --out ./preview
grep -c 'List-Unsubscribe' preview/*.eml                                           # 1 per copy
node "$REPO/dist/cli/index.js" campaign run "$CID" --json | jq '{sent,skipped,failed}'
ls out/*.eml | wc -l                                                               # 500
grep -ho 'o/[A-Za-z0-9_-]*' out/*.html | sort -u | wc -l                            # 500 distinct pixels
grep -Lc 'Unsubscribe' out/*.html | wc -l                                          # 0 without a footer

# 3. crash resume (the DoD)
node "$REPO/dist/cli/index.js" campaign create --name crash --csv rows50.csv … --json | jq -r .campaignId
node "$REPO/scripts/campaign-crash-child.mjs" "$CID2" & sleep 2; kill -9 %1
node "$REPO/dist/cli/index.js" campaign rows "$CID2" --status failed --json | jq '.rows[].lastError'
node "$REPO/dist/cli/index.js" campaign run "$CID2" --json
sqlite3 data/openpost.db "select count(*), count(distinct message_id) from campaign_rows where status='sent';"   # equal

# 4. one-click unsubscribe
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$(jq -r '.recipients[0].optOutUrl' send.json)"   # 200
sqlite3 data/openpost.db "select count(*) from suppressions;"                                       # 1

# 5. digest, not spam
for u in $(grep -ho 'http[^"]*\/o\/[^"]*' out/*.html | head -30); do curl -s -o /dev/null -A 'Mozilla/5.0 … Chrome/129' "$u"; done
node "$REPO/dist/cli/index.js" notifications list --json | jq '[.notifications[]|select(.trigger=="campaign_digest")]|length'  # 1

# 6. backup / restore
node "$REPO/dist/cli/index.js" backup --out ./backups --tag smoke --json | tee b.json
node "$REPO/dist/cli/index.js" restore "$(jq -r .path b.json)" --to ./restored.db --json | jq '{schemaBefore,schemaAfter}'
sqlite3 ./restored.db "pragma integrity_check; pragma user_version;"                                # ok | 7

# 7. docker (operator step; record the measured size)
docker build -t openpost:smoke "$REPO" && docker image ls openpost:smoke --format '{{.Size}}'
docker run --rm -d -v op4:/data -e TRACKING_SECRET=… -e API_TOKEN=… -e DASHBOARD_PASSWORD=… \
  -p 127.0.0.1:8787:8787 openpost:smoke && curl -s 127.0.0.1:8787/healthz | jq .schema             # 7
```

**Operator-only steps not runnable here** (record in `docs/reports/phase4_smoke.md`): one real
campaign of 3 rows over `gmail-smtp` with a real unsubscribe click; `openpost auth gmail --account`
with real consent; a real MaxMind mmdb in place of the fixture; `docker compose` restart persistence;
the systemd unit on a real host.

### 7.8 Acceptance criteria (Phase 4 sign-off)

1. `npm ci && npm run build && npm test` green offline with no `.env`, no credentials, no browser;
   cases 230–345 present and passing; the 336 Phase 1–3 cases and doc 07's 200–227 still pass in
   intent; `src/core/**` stays ≥ 90 % lines with the five new modules included.
2. `openpost migrate` reaches schema 7 from checked-in fixtures at 1, 2, 3, 4, 5 and 6 with zero row
   loss and no `foreign_key_check` violations; `/healthz` and `doctor` report 7.
3. Exactly one new runtime dependency (`mmdb-lib`, `optionalDependencies`, dynamically imported,
   degrading to "geo disabled"); zero new devDependencies; no bundler; the vendored geo fixture is
   hash-pinned and `doctor`-asserted.
4. A 500-row dry-run campaign sends 500 distinct-token messages, skips suppressed rows, survives a
   SIGKILL between rows with exactly-once resumption, and leaves a mid-submit kill as a single
   `indeterminate` row that is never silently re-sent.
5. No campaign message can leave the process without an unsubscribe footer and `List-Unsubscribe` +
   `List-Unsubscribe-Post`; `POST /u/:token` works and is idempotent.
6. A/B assignment is deterministic, persisted, resume-stable and reported per variant with an honest
   significance caveat.
7. Campaign notifications are digests by default: N opens ⇒ one notification per channel per window,
   naming no recipient.
8. Every account secret is at rest as `op.sb.v1.…` under scrypt + AES-256-GCM with AAD bound to
   `(accountId, field)`; secrets never appear in argv, logs, audit rows, `--json`, SSE or the web UI;
   a wrong key or a loose keyfile produces one named error and a remedy.
9. `--from-account` selects transport/identity/self-open/recipient-mode per account; an install with
   no CLI-added accounts is byte-identically the pre-Phase-4 tree; `accounts remove` cannot destroy
   message history without `--purge --yes` and a printed count.
10. `backup` → `restore` round-trips row counts, `user_version`, `integrity_check` and
    `foreign_key_check`; a tampered backup is refused; the master-key fingerprint mismatch is warned
    about, not discovered at first send.
11. `openpost init` (flags or wizard) takes an empty directory to a working, `doctor`-clean install
    with a `0600` `.env`, and is idempotent.
12. `Dockerfile`, `compose.yaml` and `packaging/openpost.service` exist, are documented, and the
    measured image size is recorded in the smoke report; the SEA deferral is written down in
    `docs/packaging.md` and the roadmap line amended.
13. Geo, when enabled, never turns a proxied open into a location; `strict` stores nothing;
    `balanced` caps at country; the three UI strings are distinct.
14. The extension's server half (`/api/threads/lookup`, `normalizeSubject`, the CORS allowlist) is
    shipped and tested; `docs/extension.md` carries the full Phase 5 design and manual checklist; the
    roadmap's DoD 4 is amended rather than silently missed.
15. `README.md`, `docs/campaigns.md`, `docs/accounts.md`, `docs/packaging.md`, `docs/deploy.md` and
    `docs/extension.md` document every new variable, command, security property and amended DoD.

---

## 8. Mailtrack parity scorecard

| Feature | Mailtrack | openpost after Phase 3 | openpost after Phase 4 |
|---|---|---|---|
| Open tracking (pixel) | yes | yes | yes |
| Per-recipient attribution on a multi-recipient message | no | yes (per-recipient mode) | yes |
| Real-time notification of a read | yes (extension + push + email) | Slack/Discord/webhook/ntfy/SSE + live dashboard | unchanged |
| Notification of a *confirmed* read | no | yes | yes |
| Gmail-proxy / Apple-MPP filtering, explicit `prefetched` state | no | yes, with rule chips | yes |
| Explainable + overridable classification | no | yes, two clicks, audited | yes |
| Click tracking, click→open back-fill | paid / no | on by default | on by default, per-campaign link stats |
| Web dashboard, live, no cloud | hosted SaaS | yes, local, no build step | **+ campaigns pages** |
| Reminders, auto-draft follow-up | paid / no | yes | yes |
| Reply detection | paid | yes | yes |
| Aggregate stats (open/click rate, best hour) | paid | yes | **+ per-campaign and per-variant** |
| **Mail merge / campaigns** | **yes (paid)** | **no** | **yes — CSV, strict templating, throttle + jitter, daily cap, pause/resume/cancel** |
| Crash-resume of a partially sent campaign | not exposed | n/a | **yes — leased rows, at-most-once, explicit `indeterminate` state** |
| **A/B subject testing** | **yes (paid)** | no | **yes — deterministic, persisted, honest significance caveat** |
| Per-campaign digest instead of per-open spam | no (per-open) | n/a | **yes — one notification per window, names no recipient** |
| One-click RFC 8058 unsubscribe on bulk mail | no | no | **yes, mandatory on every campaign message** |
| Suppression list honoured before send | partial | yes (per send) | yes (per row, with a named skip reason) |
| **Multiple sending accounts** | per-seat subscription | one, from env | **yes — `accounts` table, `--from-account`, per-account transport/identity** |
| Credentials encrypted at rest | n/a (they hold them) | token file on disk | **yes — scrypt + AES-256-GCM, AAD-bound, key from env or a 0600 keyfile** |
| Key rotation for stored credentials | no | n/a | **yes — `accounts rotate-key`, transactional** |
| One-command onboarding | install an extension | `.env` by hand | **`openpost init` wizard: secret, keyfile, DB, doctor, next steps** |
| Docker image / systemd unit | n/a | no | **yes, both, hardened** |
| Single static binary | n/a | no | **deferred, with the reason written down (§4.7)** |
| **Backup / restore you can trust** | their problem | no | **yes — SQLite online backup, manifest, sha256, integrity + FK check, refusals** |
| Upgrade safety across every past schema | n/a | replay-based tests | **yes — real fixture DBs at v1…v6, every one migrated to v7 in CI** |
| Location reporting | shows the proxy datacentre as "location" | never stored; "unknown (proxied)" | **optional local MaxMind, suppressed for every proxied/machine open, capped by privacy mode** |
| In-Gmail checkmarks next to sent mail | **yes** | no | **still no — server API + matcher shipped, extension is Phase 5** |
| Raw IP storage | yes | never | never (geo is computed in memory, the IP is still never stored) |
| Data leaves your box | yes | never | never |
| "Sent with Mailtrack" signature | free tier | never | never |
| Price / limits | per-seat, tracked-mail caps | free, self-hosted | free, self-hosted |

**Remaining Mailtrack advantages after Phase 4 → Phase 5 backlog:** (1) in-Gmail checkmarks (the
extension itself — everything it needs now exists); (2) a hosted "nothing to run" option, which we
deliberately never want; (3) mobile push without configuring ntfy; (4) a single static binary,
gated on the `node:sqlite` migration.

---

## 9. Summary of key decisions

1. **Campaigns are N single-recipient sends through the existing plan**, not a new send path — they
   inherit the header contract, per-recipient attribution, click tokens and self-copy rules of
   doc 07 for free, and the only new code is scheduling, state and rendering.
2. **The send pipeline is extracted into `sendMessage` first**, and two byte-identical regression
   tests on `openpost send` guard that refactor — it is the highest-risk change in the phase.
3. **Sending is at-most-once, never at-least-once**: a row journals `submit_started_at` before the
   transport call, and a process that dies after that point leaves an `indeterminate` row a human
   must requeue. Duplicated mail to a stranger is worse than a missing send you can see.
4. **Templating is deliberately not a language**: `{{key}}`, strict unknown-key failure, per-context
   escaping, CR/LF-stripped subjects and an href scheme allowlist — mail merge's real risks are
   header injection and XSS-by-CSV, not missing loops.
5. **Unsubscribe is structural, not optional**: no flag, env var or column can send a campaign
   message without a footer and RFC 8058 one-click headers, and the runner re-asserts before submit.
6. **One digest, never N opens**: one new policy rule and one new trigger reuse the existing queue's
   `UNIQUE(dedupe_key)`, and the digest names counts only — never a recipient.
7. **Secrets: Node stdlib only** — scrypt (N=2¹⁵) + AES-256-GCM with AAD bound to (account, field),
   key from env or a `0600` keyfile, fingerprint checked so a wrong key says so once instead of
   failing everywhere; secrets enter by stdin only and never reach argv, logs, audit or the web UI.
8. **Multi-account is additive**: zero CLI-added accounts means today's behaviour exactly, env stays
   the fallback, and `accounts remove` disables rather than cascading away every message ever sent.
9. **The single binary is deferred with reasons, not quietly missed** — better-sqlite3 is a native
   addon, SEA would need a bundler and a sidecar `.node`, and Docker already delivers the actual
   value; SEA returns when the tree can move to `node:sqlite`.
10. **The Gmail extension is deferred but de-risked**: its whole server half (thread lookup, subject
    normalisation, an exact-origin CORS allowlist that refuses to exist without a bearer) ships and
    is tested now, so Phase 5 is a small, well-specified job instead of an open-ended one.

---

## 10. Phase 4.1 amendments

An independent review (`docs/reports/phase4_review.md`) found 18 defects in this phase's
implementation; each amendment below moves the SPEC to match the safer behaviour the Phase 4.1
hardening pass implemented, where this document was silent, ambiguous, or itself wrong. One line
per amendment; see the review and the corresponding commit for the full reasoning.

1. §4.6 backup/restore: `restore` MUST remove `${to}-wal`/`${to}-shm` alongside the destination and
   MUST refuse (absent `--force`) when either exists or the destination cannot be locked EXCLUSIVE -
   restoring over a live/uncheckpointed WAL database silently discards the restored data. Docs and
   `--help` say to stop the server first; `--force` is not a substitute for that.
2. §2.5/§7.4 suppressions: every email comparison and write against `suppressions` MUST normalise
   with `lower(trim(...))` (the column is additionally `COLLATE NOCASE` as of migration 009) - a
   suppression recorded from any call site (an interactive send's opt-out, a campaign import,
   `forget`) MUST be found by every other, regardless of case or incidental whitespace.
3. §2.10 forget/erase: a `campaign_rows` erasure redacts `email` to a PER-ROW-UNIQUE sentinel
   (`'(erased):' || id`), never a fixed literal - the literal form collides with
   `idx_campaign_rows_addr`'s partial unique index the second time two non-skipped rows in one
   campaign are erased.
4. §2.5.2 unsubscribe footer: the mandatory opt-out footer applies to BOTH the html and (when
   present) the text part of a campaign message, not html alone; `assertUnsubscribePresent` asserts
   on both.
5. §2.7 daily cap: a campaign that hits `CAMPAIGN_DAILY_CAP` stays `status = 'running'` (recording a
   separate `capped_until` marker) rather than moving to `paused` - it MUST resume automatically,
   with no operator action, once the rolling 24h window has drained enough.
6. §2.7 campaign lifecycle: status changes made by name (CLI `pause`/`resume`/`cancel`, the
   dashboard's `/actions/campaign`) MUST go through one guarded state machine: `paused|draft ->
   running`, `running -> paused`, `!terminal -> cancelled`, erroring (never silently no-op-ing or
   un-cancelling a terminal campaign) otherwise.
7. §5.2 geo: `geoForEvent`/the mmdb lookup MUST actually be invoked from the pixel/click redaction
   step for every counted, non-suppressed-classification event when `GEOIP_DB_PATH` is configured -
   writing the module without wiring it in is not "geo is implemented". `doctor`'s geo check reports
   "configured but not applied" whenever the same load the server performs does not succeed, not
   merely when the file is missing.
8. §2.7/§5.2 scheduler fairness: the campaign drain job's per-tick wall-clock time MUST be bounded
   (`maxSeconds` ~= `CAMPAIGN_TICK_SECONDS`, shared across however many campaigns are running) -
   the shared scheduler runs every due job strictly sequentially, and an unbounded campaign drain
   starves every other job for the duration.
9. §2.3 campaign create: `--rate-per-minute`/`--daily-cap`/`--digest-minutes` MUST be positive
   integers (>= 1) and `--jitter-ms` a non-negative integer (>= 0, zero being a legitimate "no
   jitter"), validated at create time with a named error - matching the env-var equivalents'
   existing bounds exactly.
10. §4.6 backup: `inspectBackup`'s scratch decompression copy MUST be written to a private temp
    directory (mode 0600), never into the backup directory itself where its name could match
    `pruneBackups`' own glob.
11. §3.1 secrets at rest: `settings.master_key_fingerprint` MUST be recorded the first time a
    secret is sealed, and updated on `rotate-key` (with an `account.rotate-key` audit row) - a
    backup manifest's `masterKeyFingerprint` is otherwise permanently null.
12. §4.1 `init`: every value `renderEnvFile` writes MUST be quoted/escaped for `.env` (control
    characters, including a literal newline, are refused outright) and `--from-name` MUST be
    available as a non-interactive flag.
13. §6.2a thread lookup: the response's `recipients[]` (raw addressee email addresses) is opt-in
    (`?recipients=1`) and requires an actual bearer token even when the route's own auth would
    otherwise accept a same-origin dashboard cookie or (API_TOKEN unset) nothing at all - aggregate
    per-thread state has no such requirement.
14. §3.1 secrets at rest: the master key decoder MUST decide hex vs. base64 by strict shape (exactly
    64 hex characters, else actual base64 shape) rather than trying base64 first for every input -
    every hex digit is also valid base64. `doctor` additionally compares the configured key's
    fingerprint against the one recorded per amendment 11, failing by name on a mismatch.
15. §2.5 opt-out: `GET`/`POST /u/:token` skip the suppression/`opted_out_at` writes and the
    `optout.record` audit row entirely once a recipient is already opted out - a replayed hit (an
    RFC 8058 POST is machine-generated and trivially replayable) is a true no-op, not a fresh audit
    row every time.
16. §2.9 digest: the "just finished" query MUST NOT require `digest_from IS NOT NULL` (a campaign
    that completes before its first periodic digest tick would otherwise never be reported at all),
    and "final digest already sent" is tracked on the campaign row (`final_digest_sent_at`), not
    inferred from whether a `notifications` row happens to have survived retention.
17. §2.7 skip reasons: a `TemplateError` raised while rendering a row's body/text (as opposed to its
    subject, which is all `preflightRow` exercises) records `skip_reason = 'missing_vars'`, not
    `'unsafe_href'`.
18. Test hygiene: a test's title is a claim about what it proves - a test asserting less than its
    own title says (or exercising a materially weaker version of the scenario, such as async
    interleaving in one process standing in for two real `openpost serve` processes) is a defect in
    the test suite, fixed the same as a code defect.
