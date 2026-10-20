# Notifications: payload schema and webhook signature verification

openpost's generic `webhook` channel (`WEBHOOK_URL` / `WEBHOOK_SECRET`) POSTs a JSON
[`NotificationPayload`](../src/notify/types.ts) with these headers:

```
Content-Type: application/json
User-Agent: openpost/<version>
X-Openpost-Event: <trigger>                 # first_open | read_confirmed | click | prefetched
X-Openpost-Delivery: <notification id>
X-Openpost-Timestamp: <unix seconds>
X-Openpost-Signature: sha256=<hex>          # HMAC-SHA256(WEBHOOK_SECRET, `${timestamp}.${rawBody}`)
```

`rawBody` is the exact bytes sent in the request body - do not re-serialise the parsed JSON before
verifying, since re-serialisation is not guaranteed to reproduce byte-identical output. Receivers
**must**:

1. compare the signature with a timing-safe comparison (never `===` on the hex strings), and
2. reject a timestamp older than 5 minutes (or more than 5 minutes in the future), to bound replay.

## Example payload

```json
{
  "version": 1,
  "id": "01hz...",
  "trigger": "read_confirmed",
  "occurredAt": 1789459200000,
  "message": { "id": "01hz...", "subject": "hello", "sentAt": 1789459100000 },
  "recipient": { "id": "01hz...", "email": "alice@example.com", "state": "read_confirmed", "openCount": 2, "clickCount": 1 },
  "event": { "id": "01hz...", "kind": "open", "classification": "human", "reasons": ["R9"], "counted": true, "uaFamily": "Chrome", "deviceType": "desktop", "country": null, "linkUrl": null }
}
```

## Node.js verifier

```js
const crypto = require('node:crypto');

function verifySignature({ secret, headers, rawBody, nowSeconds = Math.floor(Date.now() / 1000), maxSkewSeconds = 300 }) {
  const signatureHeader = headers['x-openpost-signature'] || '';
  const timestampHeader = headers['x-openpost-timestamp'] || '';
  const match = /^sha256=([0-9a-f]{64})$/.exec(signatureHeader);
  if (!match) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(nowSeconds - timestamp) > maxSkewSeconds) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const given = Buffer.from(match[1], 'hex');
  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(given, expected);
}

module.exports = { verifySignature };
```

## Python verifier (byte-compatible)

```python
import hashlib
import hmac
import re
import time


def verify_signature(secret: str, headers: dict, raw_body: bytes, now_seconds: int | None = None, max_skew_seconds: int = 300) -> bool:
    now_seconds = now_seconds if now_seconds is not None else int(time.time())
    signature_header = headers.get("x-openpost-signature", "")
    timestamp_header = headers.get("x-openpost-timestamp", "")

    match = re.fullmatch(r"sha256=([0-9a-f]{64})", signature_header)
    if not match:
        return False
    try:
        timestamp = int(timestamp_header)
    except ValueError:
        return False
    if abs(now_seconds - timestamp) > max_skew_seconds:
        return False

    message = f"{timestamp}.".encode() + raw_body
    expected = hmac.new(secret.encode(), message, hashlib.sha256).digest()
    given = bytes.fromhex(match.group(1))
    return hmac.compare_digest(given, expected)
```

Both verifiers compute the same HMAC over `${timestamp}.${rawBody}` (note: `rawBody` is the raw
request body bytes, concatenated *after* the literal `.` following the timestamp digits - not
JSON-re-encoded) and reject a timestamp more than 5 minutes away from "now". `tests/unit/notify-
channels.test.ts` (case 71b) evaluates the Node snippet above verbatim against a real webhook
delivery built by `src/notify/channels/webhook.ts`, so this document can never silently drift from
the implementation.

## Phase 5: `webpush` and `email`

Two more channel values for `NOTIFY_CHANNELS`, both zero-config relative to `webhook`/`slack`/
`discord`/`ntfy` (see docs/mobile.md for the full setup):

- **`webpush`**: delivers to every registered device (`/dashboard/settings`) as an
  [RFC 8291](https://www.rfc-editor.org/rfc/rfc8291)-encrypted, [RFC
  8292](https://www.rfc-editor.org/rfc/rfc8292)-authorized POST straight to the browser's push
  service - no third party ever sees the plaintext. The wire body a device receives, once decrypted,
  is `{ v: 1, title, body, url, tag, ts }` where `url` is always a `/dashboard/`-relative **path**
  (never an absolute URL - the service worker re-validates it before navigating) and `body` is the
  same `summaryLine()` text every other channel's plain-text form already uses, so
  `NOTIFY_REDACT_EMAIL`/`NOTIFY_INCLUDE_SUBJECT` apply identically. Implemented from scratch on
  `node:crypto` (`src/core/webpush.ts`) - no push-notification dependency of any kind.
- **`email`**: sends a plain email to `NOTIFY_EMAIL_TO` (default `FROM_EMAIL`) through the
  already-configured `MAIL_TRANSPORT`, carrying `Auto-Submitted: auto-generated`,
  `X-Openpost-Notification: 1` and `Precedence: bulk`. It is built directly with `buildMime` - never
  through the tracked-send pipeline - so a notification email can never itself become a tracked
  message (no pixel, no click rewriting, no `messages` row). Recommended `NOTIFY_ON=read_confirmed,reply`
  so it stays useful rather than becoming one email per prefetch.

## Phase 5: `daily_digest`

`DIGEST_DAILY_AT=HH:MM` (local time, `DIGEST_TIMEZONE`) enqueues one summary notification per
configured channel, once per calendar day, built from the same counts `openpost stats` reports -
sent/opened/clicked/replied and up to five top messages by open count (subjects only when
`NOTIFY_INCLUDE_SUBJECT`). It is deliberately not gated by `NOTIFY_ON` (there is no per-event
trigger to filter): every configured channel gets exactly one digest per day, deduplicated the same
way every other trigger is - via the notification queue's `UNIQUE(dedupe_key)` - so a restart or a
clock jump can never double-send it.
