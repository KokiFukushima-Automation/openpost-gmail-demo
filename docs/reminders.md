# Reminders and reply detection (Phase 3)

## Reminders

```bash
openpost remind <messageId> [--recipient <id|email>] --if no-reply|no-open|always \
    (--in <3d|4h|90m|45s> | --at <ISO-8601>) \
    [--draft] [--draft-subject <text>] [--draft-body-file <path> | --draft-body <html>] \
    [--note <text>] [--json]

openpost reminders list   [--status pending|claimed|fired|skipped|cancelled|failed|all]
                          [--message <id>] [--due-before <iso|dur>] [--limit <n>] [--json]
openpost reminders cancel (<id> | --message <id> | --all-pending) [--json]
openpost reminders run    [--now <iso>] [--limit <n>] [--json]     # one firing pass - cron/tests
```

`--in`/`--at` are mutually exclusive and mandatory; both are rejected beyond
`REMINDER_MAX_HORIZON_DAYS` (default 365). Without `--recipient`, one reminder is created per
recipient of the message.

### Conditions

- **`no_reply`** (default) - skipped once `recipients.replied_at` is set.
- **`no_open`** - skipped once the recipient has a counted open.
- **`always`** - never skipped; fires on schedule regardless of engagement.

A skipped reminder writes `reminder.skip` to the audit log and enqueues no notification.

### Crash-safe, fires exactly once

Firing is a claim/lease protocol against `reminders.status`:

1. `selectDue` finds rows that are `pending` and due, or `claimed` with an expired lease.
2. `claim` is a **single conditional `UPDATE`** run under `BEGIN IMMEDIATE` - SQLite's one-writer
   model makes this a real compare-and-swap. Only the process whose `UPDATE` actually changed a row
   owns it; everyone else gets nothing back.
3. The owner evaluates the condition, optionally writes a Gmail draft, enqueues the notification,
   and marks the row `fired` - in that order, so a crash between "notification enqueued" and "row
   marked fired" is recoverable: a fresh pass re-claims the (still `claimed`, lease-expired) row,
   but the notification queue's `UNIQUE(dedupe_key)` (`${channel}:reminder:${reminderId}`) makes a
   second enqueue attempt a silent no-op. The delivered notification is still exactly one, even
   though the audit log may show two `reminder.fire` attempts in that crash window - documented,
   append-only, and by design.
4. `REMINDER_LEASE_MS` (default 2 min) bounds how long a crashed process's claim blocks a retry;
   `REMINDER_MAX_ATTEMPTS` (default 3) bounds how many times a reminder is retried before it is
   swept to `failed`.

This is proven with a real test, not a simulation: `tests/integration/reminders-flow.test.ts`'s
crash-safety case spawns `scripts/reminder-crash-child.mjs` as a genuine child process, which
`SIGKILL`s itself the instant it claims a reminder, then asserts a fresh firing pass still produces
exactly one `fired` row and exactly one notification.

### `--draft`: a threaded Gmail follow-up, never sent

Requires a Gmail refresh token with the `gmail.compose` scope
(`openpost auth gmail --with-compose`); without one, the reminder is still created and its
notification will still fire - only the draft is skipped (`draft_status='skipped'`), with a warning
printed at creation time.

The draft is built once, at fire time, from `In-Reply-To`/`References` set to the recipient's own
`rfc822_msg_id` (never the sender's self-copy) and `X-Openpost-Reminder: <reminderId>`, then created
via:

```ts
gmail.users.drafts.create({ userId: 'me', requestBody: { message: { threadId, raw } } });
```

**`users.drafts.send` is never called anywhere in this codebase** (`grep -rn "drafts\.send(" src/`
finds nothing - enforced by a test). The attempt is journalled (`draft_attempted_at`) *before* the
API call, so a crash between the call and recording its result is recovered by *searching* for the
draft by its `X-Openpost-Reminder` header instead of blindly creating a second one.

### Notifications

Firing a reminder publishes a `reminder` `TrackingEvent` on the same bus the pixel/click routes
use, so it rides the existing SSE stream and notify-worker queue unchanged. A reminder notifies
**even on a muted message** - `--mute` silences tracking noise, not an alarm you explicitly
scheduled - while a *reply* notification still respects mute. Dedupe key:
`${channel}:reminder:${reminderId}`.

## Reply detection

Polls each recipient's own thread for a message from someone other than the sender, and:

1. Sets `recipients.replied_at`/`reply_msg_id` and flips `state` to the first-class `replied` value
   (which wins over every other signal - a later open or manual override can never silently erase a
   detected reply).
2. Cancels any pending (or claimed-with-expired-lease) `no_reply` reminder for that recipient
   (`no_open`/`always` reminders are untouched - they aren't about replies).
3. Writes one `reply.detected` audit row containing **no address, no snippet, no body** - reply
   detection uses `format=metadata` throughout, which cannot return message content even if asked.
4. Publishes a `reply` `TrackingEvent` (SSE + notify, dedupe key `${channel}:reply:${recipientId}`).

### The reply rule (`detectReply`)

The first message in the thread satisfying **every** rule counts as the reply:

- `internalDate` is after `sent_at` (a small clock-skew allowance, default 1s);
- its `From` address, normalised, is not the sender's own address and not in `REPLY_IGNORE_SENDERS`;
- it is not labelled `SENT` or `DRAFT`;
- it does not carry `X-Openpost-Self-Copy: 1` (the sender's own untracked Sent-copy back-fill from
  `SELF_OPEN_STRATEGY=insert`);
- its id is not the recipient's own `provider_msg_id`.

Everything else - auto-replies, bounces, your own follow-up - is rejected with a named reason.

### Reader, schedule and quota

`REPLY_DETECTION` (default `auto`) resolves to `gmail` when a refresh token with `gmail.readonly`
is available, else `imap` when `IMAP_USER`/`IMAP_PASS` are set, else `off`. The Gmail reader calls
`users.threads.get(..., format: 'metadata')` (10 quota units); the IMAP reader (`imapflow`, already
an optional dependency) searches `IMAP_ALL_MAIL_MAILBOX` for a message whose `In-Reply-To` or
`References` names the recipient's `rfc822_msg_id`.

Poll interval tiers by age since send (floor `REPLY_POLL_SECONDS`, default 5 min):

| Age | Poll every |
|---|---|
| < 2 h | `REPLY_POLL_SECONDS` |
| 2 h - 24 h | 15 min |
| 1 - 3 d | 1 h |
| 3 - 14 d (`REPLY_WATCH_DAYS`) | 6 h |
| > `REPLY_WATCH_DAYS` | never again |

A per-tick quota budget (`REPLY_QUOTA_UNITS_PER_MIN`, default 300 ⇒ ≤30 Gmail thread reads/min)
stops the tick early once exhausted; a `429`/rate-limit error sets a doubling backoff (1 → 2 → 4 →
... → 60 min, jittered) that a clean tick resets.

Every test injects a fake `ThreadReader` - no test ever constructs a real Gmail or IMAP client.

## New environment variables

See `.env.example` for the full, commented list (`DASHBOARD_*`, `REMINDER*`, `REPLY_*`,
`REPORT_TIMEZONE`, `IMAP_ALL_MAIL_MAILBOX`).
