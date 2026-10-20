# Campaigns (CSV mail merge)

A campaign is **N single-recipient sends**, not one multi-recipient send: every row goes through
the exact per-recipient send path `openpost send --to one@example.com` already uses, so per-recipient
attribution, the header contract, click tokens and self-copy rules are inherited unchanged. A
campaign can never enter single/aggregate mode.

## CSV format

- RFC 4180: quoted fields, embedded delimiters/CRLF/`""`, CRLF or LF line endings, a leading BOM
  stripped.
- The delimiter (`,`, `;`, or tab) is auto-detected from the header line, or forced with
  `--delimiter`.
- The email column is auto-detected (`email`, `e-mail`, `address`, case-insensitively) or named
  with `--email-column`.
- A CSV column may not be named `email`, `campaign_name`, `sender_name`, `sender_email` or
  `unsubscribe_url` - those are reserved template keys injected by the runner.
- Duplicate addresses (after trimming/lowercasing) are imported once; the rest are marked
  `skipped`/`duplicate_in_csv` so you can see them, not silently dropped.
- Limits: `CAMPAIGN_MAX_ROWS` (default 10 000) rows, 8 KiB per cell.

## Templates

`{{key}}` and `{{{key}}}` only - no conditionals, loops, filters or partials. `{{key}}` is
HTML-escaped in the body, inserted verbatim (then header-sanitised) in the subject. `{{{key}}}`
(raw, unescaped HTML) requires `--allow-raw` at create time and is otherwise a hard error - never a
silent fallback. An unknown key, an unterminated `{{`, or an invalid key charset (`[A-Za-z0-9_][A-Za-z0-9_.-]*`)
is rejected at `campaign create`, before anything is imported: unknown var → unsafe href → reserved
column → missing email column, in that order, each naming the offending value.

A rendered body's `href`/`src` attributes must be `http:`, `https:`, `mailto:` or `cid:` - a
`javascript:`/`data:` URL smuggled in via a CSV cell fails that one row (`skip_reason=unsafe_href`),
not the whole campaign.

## Unsubscribe is mandatory

There is no flag, environment variable or CLI option that sends a campaign message without:

1. An unsubscribe footer (or, if the template placed `{{unsubscribe_url}}` itself, no second
   footer is appended).
2. `List-Unsubscribe: <https://.../u/TOKEN>, <mailto:FROM_EMAIL?subject=unsubscribe>` and
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (RFC 8058).

`POST /u/:token` is the one-click endpoint a mail client's own "Unsubscribe" button calls: same
verification/suppression as the existing `GET`, idempotent, no CSRF applicable (it's an
unauthenticated, token-bearing URL like the pixel/click endpoints).

## A/B subject testing

```bash
openpost campaign create ... --subject 'Hi {{name}}' --subject-b 'Quick one, {{name}}' --variant-split 50/50
```

Assignment is `sha256(campaignId + '\0' + email)`-bucketed: deterministic forever for the same
`(campaignId, email)` pair, independent of row order or a later re-import, and persisted on
`campaign_rows.variant` at import time so even a future change to the hashing algorithm can't
re-split a running campaign. `campaign stats` reports per-variant open/click rates plus a
two-proportion z-statistic between the two largest variants, always labelled "indicative only - no
multiple-comparison or sequential-testing correction, and N is usually far too small." Reporting an
unqualified "winner" is the dishonest thing every competing tool does; openpost reports the number
and the caveat.

## Throttling, daily cap, and crash-resume

`--rate-per-minute` (default `CAMPAIGN_RATE_PER_MINUTE`) plus `--jitter-ms` pace sends; a skipped
row (suppressed, opted out, invalid address, missing template vars, unsafe href) costs no pacing
delay. `CAMPAIGN_DAILY_CAP` (default 400, well under Gmail's own limits) is a rolling 24h cap **per
account** - exceeding it pauses the campaign, and a later run resumes automatically once the window
drains.

Sending is **at-most-once**, never at-least-once: each row journals `submit_started_at` *before*
the transport call. A process that dies before that point leaves the row `pending` - safe to retry.
A process that dies *after* that point leaves the row `failed` with `last_error` starting
`indeterminate:` - this is never retried automatically, because a duplicate send to a stranger is
worse than a visible gap. Requeue it deliberately, after checking, with:

```bash
openpost campaign resume <id> --retry-indeterminate
```

## CLI reference

```
openpost campaign create --name <n> --csv <file> (--template <file> | --html <s>)
        --subject <tpl> [--subject-b <tpl>] [--variant-split 50/50]
        [--text-template <file>] [--email-column <col>] [--delimiter , | ; | tab]
        [--from-account <ref>] [--transport <name>] [--dry-run]
        [--rate-per-minute <n>] [--jitter-ms <n>] [--daily-cap <n>]
        [--digest-minutes <n>] [--no-track-clicks] [--allow-raw] [--start] [--json]
openpost campaign preview <id> [--row <n>] [--out <dir>] [--json]
openpost campaign run <id> [--limit <n>] [--max-seconds <n>] [--once] [--json]
openpost campaign pause  <id> [--json]
openpost campaign resume <id> [--retry-indeterminate] [--json]
openpost campaign cancel <id> [--yes] [--json]
openpost campaign list [--status <s>] [--limit <n>] [--json]
openpost campaign show  <id> [--json]
openpost campaign stats <id> [--json]
openpost campaign rows  <id> [--status <s>] [--limit <n>] [--csv] [--json]
```

`campaign run` auto-starts a fresh `draft` campaign but never silently resumes a `paused` one -
only `campaign resume` does that, so a paused campaign stays paused until you deliberately restart
it (including via the scheduler's own `campaigns` job in `openpost serve`).

## Digest notifications

By default (`NOTIFY_CAMPAIGN_MODE=digest`), opens/clicks/replies during a campaign are aggregated
into **one** notification per channel per digest window (`--digest-minutes`, default 60) - never
one per open. The digest names counts only ("120 sent, 41 opened (34%), 9 clicked, 2 replied - last
60 min"), never a recipient. Set `NOTIFY_CAMPAIGN_MODE=per-open` to get the pre-Phase-4 one-per-open
behaviour back, or `off` to silence campaign notifications entirely (the events are still recorded
and still visible on the dashboard's live feed either way).

## Privacy and erasure

`campaign_rows` store the CSV's own cell values (`vars_json`), which can include names, companies,
order numbers. `openpost forget <email>` redacts (never merely deletes) matching rows -
`email='(erased)'`, `vars_json='{}'` - so campaign counts stay truthful after an address is
forgotten. The retention job clears `vars_json` for campaigns finished longer ago than
`RETENTION_DAYS`. A campaign row's `vars_json` never appears in a notification, an SSE frame, an
audit row, or a log line - only in the dashboard's campaign page and `campaign rows --json`, both
behind the same auth as everything else.
