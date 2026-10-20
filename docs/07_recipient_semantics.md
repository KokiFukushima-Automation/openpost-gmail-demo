# 07 — Recipient semantics (To / CC / BCC)

Status: implemented (`006_recipient_semantics.sql`, `EXPECTED_SCHEMA` 6). Landed across
`src/mail/recipients.ts` (new), `src/cli/commands/send.ts`, `src/mail/mime.ts`,
`src/mail/transport.ts`, `src/mail/{dryrun,smtp,gmail,gmail-smtp}.ts` (`gmail-smtp` new),
`src/db/{repo,stats,report,erase,reminders}.ts`, `src/jobs/{replies,reminders}.ts`, presenters,
notify, doctor and the CLI. See `docs/reports/recipient_semantics_smoke.md` for the offline
verification run and `tests/unit/recipients.test.ts` / `tests/unit/recipient-transports.test.ts` /
`tests/integration/{reply-attribution,recipient-semantics}.test.ts` for test cases 200-227.
The migration below is the number after Phase 3's 005 (`006`, `EXPECTED_SCHEMA` 5 → 6).

---

## 1. The defect

`send.ts` builds one MIME per recipient with `to: [{ email }]` and nothing else.

Consequences, in order of severity:

1. **CC semantics are destroyed.** A CC'd recipient receives a message whose `To:` is *themselves*
   and which carries no `Cc:` at all. They cannot tell they were CC'd, cannot see who else got it,
   and Reply-All reaches only the sender.
2. **BCC and CC are indistinguishable to the receiver** — both arrive as a lone `To: me`.
3. **Thread context is lost for everyone.** Nobody on a 4-way mail can see the other three.
4. **Gmail API fan-out hazard.** `users.messages.send` derives delivery *entirely* from the
   `To`/`Cc`/`Bcc` headers of the submitted `raw`. The naive fix ("put the full header lists on every
   copy") would deliver N copies to each of N recipients — N² messages.
5. **Latent: the SMTP envelope is empty today.** `SmtpTransport.send` calls
   `sendMail({ raw: mime.raw })` with no `envelope`. A `MailComposer` built from `raw` produces
   `getEnvelope() === { from: false, to: [] }`, so a real SMTP send has no `RCPT TO`.
6. **Latent: nodemailer will emit a `Bcc:` header.** `buildMime` uses `streamTransport`, which forces
   `keepBcc = true`. Passing `bcc:` into `buildMime` for delivered copies would print the blind list in
   every copy. Only the self-copy (`buildUntrackedMime`) may ever receive a `bcc` argument.

---

## 2. The recipient-visible header contract (HC)

| # | Rule |
|---|---|
| HC-1 | `From`, `Subject`, `Date`, `Reply-To`, `To`, `Cc`, `References` are **byte-identical** across all copies of one `openpost send`. |
| HC-2 | `To:` lists exactly the `--to` addresses in order. `Cc:` lists exactly the `--cc` addresses in order, omitted when empty. |
| HC-3 | **No delivered copy ever carries a `Bcc:` header**, on any transport, in either mode — with the single documented exception in §3.2 (Gmail-API single mode, where Gmail itself strips it). |
| HC-4 | Per-copy divergence is limited to: pixel URL, rewritten click URLs, opt-out URL, and `Message-ID`. |
| HC-5 | `Date` is computed **once per send** and passed explicitly to `buildMime`. |
| HC-6 | Reply-All from any recipient reaches `From ∪ To ∪ Cc` — the same set for everyone. A BCC recipient's Reply-All exposes them to that set; standard mail behaviour, documented in `--help`. |

### 2.1 Message-ID: distinct per copy, plus a shared `References` root

**Each copy gets its own `Message-ID`; every copy carries the same synthetic thread root in `References`:**

```
Message-ID: <auto-per-copy@fromdomain>
References: <op.{messages.id}@{fromdomain}>
```

Reasons: per-recipient reply detection keys on `recipients.rfc822_msg_id`; Gmail collapses messages
sharing a `Message-ID` within one mailbox, so a shared ID would make the untracked Sent copy collide
with the tracked copy whenever the sender CCs themselves, silently defeating `SELF_OPEN_STRATEGY=insert`;
and the Sent copy's `Message-ID` becomes the synthetic root, present in every delivered copy's
`References`, so Gmail joins the Sent copy to every recipient's reply chain.

Cost: strict clients thread on `References` chains; the shared root gives a common ancestor. Best-effort;
`RECIPIENT_MODE=single` is the escape hatch for perfect cross-recipient threading.

Pre-existing bug to fix in the same change: reply detection credits the recipient whose Message-ID is in
the reply's chain, so Bob replying to Alice's reply credits Alice. Fix in `src/jobs/replies.ts`: match the
reply's `From` against `recipients.email` for the same `message_id` first; fall back to the MID-chain
candidate only when `From` matches no addressee. Test 214.

---

## 3. Per-transport decision table

`E` = SMTP envelope. `H` = the `To`/`Cc`/`Bcc` headers inside the MIME.

| | dryrun | smtp | gmail (API) | **gmail-smtp** (new) |
|---|---|---|---|---|
| Delivery derived from | nothing | `E` | `H` — no envelope field | `E` |
| Envelope override | n/a | yes | **no** | yes |
| Copies per send (per-recipient) | N | N | N (unsafe) | N |
| `To`/`Cc` headers on each copy | full | full | only in single mode | full |
| `Bcc` header | never | never | **present** in single mode (Gmail strips it) | never |
| `RCPT TO` per copy | recorded as `X-Openpost-Envelope-To` in the `.eml` | exactly one | n/a | exactly one |
| Writes its own Sent copy | no | no | **yes, tracked** | no |
| `SELF_OPEN_STRATEGY=insert`/`imap-append` usable | yes (rendered to `.sent.eml`) | yes | no | **yes** |
| Default mode (`RECIPIENT_MODE=auto`) | per-recipient | per-recipient | single | per-recipient |
| Auth | none | password | OAuth `gmail.send` | OAuth **`https://mail.google.com/`** + XOAUTH2 |

### 3.1 SMTP path (reference implementation)

```ts
const mime = await buildMime({
  from, to: headerTo, cc: headerCc,        // full lists, HC-2 — NEVER bcc
  subject, html: c.html, text, date: sendDate,
  references: [threadRootMid],
});
await transport.send(mime, { ...meta, envelopeTo: [c.address], recipientKind: c.kind });
```

`SmtpTransport.send` passes `envelope: { from: meta.envelopeFrom, to: meta.envelopeTo }` (exactly one
address). Bcc recipients are delivered purely by `RCPT TO`.

**Sent copy:** exactly one untracked message carrying `To` + `Cc` **and** `Bcc`, `Message-ID` = the
synthetic root, `Date` = `sendDate`, `X-Openpost-Self-Copy: 1`, via the existing insert / imap-append.
`env.ts` validation widens: `SELF_OPEN_STRATEGY=insert requires MAIL_TRANSPORT=smtp or gmail-smtp`.

### 3.2 Gmail API path

- (a) status quo: per-recipient copies with only that recipient in headers — breaks CC. Reject.
- (b) one message, all recipients in headers, message-level tracking — this is `single` mode.
- (c) per-recipient copies with full headers and constrained delivery — **impossible over the Gmail
  API** (`users.messages.send` accepts only `{ raw, threadId }`; no envelope). State plainly.

(c) **is** achievable via **SMTP submission to `smtp.gmail.com` with OAuth2 XOAUTH2**, offered as
`MAIL_TRANSPORT=gmail-smtp`: port 465 (default) or 587 STARTTLS; `auth: { type: 'OAuth2', user: FROM_EMAIL, ... }`;
scope **`https://mail.google.com/`** (`gmail.send` is not accepted by Gmail's SMTP front end; this is a
restricted scope, a non-issue for a self-hosted operator-owned Cloud project in Testing mode). Reuses
`src/mail/oauth.ts` with a new `GMAIL_SCOPE_FULL` requested behind `openpost auth gmail --with-smtp`.
Bonus: `smtp.gmail.com` writes no Sent copy, so `SELF_OPEN_STRATEGY=insert` becomes available.

### 3.3 Default and override

```
RECIPIENT_MODE = auto | per-recipient | single          # default: auto
openpost send … --recipient-mode <auto|per-recipient|single>
```

`resolveRecipientMode(mode, transportName, recipientCount)` (pure):

| input | transport | result |
|---|---|---|
| any | `recipientCount === 1` | `per-recipient` (no aggregate row; nothing changes for single-To sends) |
| `auto` | dryrun / smtp / gmail-smtp | `per-recipient` |
| `auto` | gmail | `single`, with a printed explanation |
| `per-recipient` | gmail | **hard error** naming both remedies (`--transport gmail-smtp`, `--recipient-mode single`) |
| `single` | any | `single` |

Never silently downgrade; never silently fan out.

### 3.4 Extra rules for `single` mode

- **Suppression is all-or-nothing.** If any addressee is suppressed/opted out, the whole message is sent
  untracked and `send` reports why.
- Click tokens bind `(link_id, aggregate_recipient_id)`.
- Gmail's image proxy caches per URL, so a second Gmail reader usually produces no fetch. The UI must
  never present a single-mode open count as a reader count.

---

## 4. Database representation

### 4.1 Migration `006_recipient_semantics.sql` (schema 5 → 6)

```sql
ALTER TABLE messages   ADD COLUMN recipient_mode TEXT NOT NULL DEFAULT 'per-recipient';
ALTER TABLE recipients ADD COLUMN is_aggregate   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipients ADD COLUMN envelope_to    TEXT;   -- the RCPT TO actually used; NULL in single mode
CREATE INDEX idx_recipients_aggregate ON recipients(message_id, is_aggregate);
-- No back-fill: every pre-006 message was one-copy-per-recipient. For pre-006 rows messages.rfc822_msg_id
-- keeps the old "first recipient's Message-ID" meaning; from 006 on it is the thread root.
```

`is_aggregate` rather than a new `kind` value so every existing query and display stays correct.

### 4.2 Row layout per mode

**per-recipient:** one row per address, `kind ∈ {to,cc,bcc}`, `is_aggregate = 0`, own token, own
cache_buster, own provider ids, plus `envelope_to`.

**single:** one row per address (`is_aggregate = 0`, `envelope_to = NULL`, token generated but never
embedded) **plus** exactly one aggregate row: `is_aggregate = 1`, `email = '(all recipients)'`,
`name = '<n> recipients'`, its own token + cache_buster (the pixel that goes in the body), and the
provider ids of the one submitted message. Presenters branch on `is_aggregate` before printing `email`.

### 4.3 `messages.rfc822_msg_id` and friends

| column | per-recipient | single |
|---|---|---|
| `messages.rfc822_msg_id` | the synthetic thread root (also Sent copy's Message-ID) | the one submitted copy's Message-ID |
| `messages.provider_msg_id`, `thread_id` | `NULL` when N > 1; unchanged when N = 1 | the one real value |
| `recipients.rfc822_msg_id` | that copy's own | the single copy's, on all rows incl. aggregate |
| `recipients.provider_msg_id` / `thread_id` | per copy | same single value on all rows |

`markMessageSent` must accept nulls.

### 4.4 Queries that must learn about `is_aggregate`

| Site | Change |
|---|---|
| `listReplyCandidates` | `AND r.is_aggregate = 0` |
| stats / report queries | count the tracked unit: `AND r.is_aggregate = (CASE WHEN m.recipient_mode = 'single' THEN 1 ELSE 0 END)` |
| `erase.ts` | also delete the aggregate row (and its events) of every message that had the erased address; count in the same audit row |
| export / present / show / dashboard message page | render aggregate rows as a distinct line, never as an address |
| reminders | may not target an aggregate row; in single mode `no_open` degrades to message level and says so |

### 4.5 What surfaces say in `single` mode

- `openpost show`: `mode: single`, addressee rows with `state: —` and `tracking: message-level`, one
  aggregate row `(message-level) — opened (recipient unknown, 3 on thread)`.
- Dashboard: banner explaining message-level tracking; the open timeline hangs off the aggregate row.
- Notifications: `payload.recipient.attribution: 'recipient' | 'message'`; when `'message'`,
  `email: null`, `recipientCount: N`; channel text `"Opened — recipient unknown, N on thread"`.
- `send --json` gains `recipientMode` and per-result `attribution`.

---

## 5. BCC specifics

1. A BCC copy's `To`/`Cc` are identical to everyone else's.
2. No BCC address appears in any delivered copy, including other BCC recipients' copies; enforced by
   `assertNoBccHeader` on dryrun/smtp/gmail-smtp.
3. Exception: Gmail-API single mode must place `Bcc:` in the submitted raw and relies on Gmail stripping
   it. Documented; `--transport gmail-smtp` removes the delegation.
4. The DB keeps `kind = 'bcc'`; the dashboard shows BCC recipients to the sender unredacted.
5. Tokens are opaque and signed; a BCC recipient's URLs reference no other recipient.

---

## 6. Implementation

### 6.1 New module `src/mail/recipients.ts` (pure)

```ts
export type RecipientMode = 'per-recipient' | 'single';
export type RecipientModeOption = RecipientMode | 'auto';
export interface AddressInput { email: string; kind: 'to' | 'cc' | 'bcc' }
export interface CopyPlan {
  address?: string; kind?: 'to' | 'cc' | 'bcc';
  envelopeTo: string[];        // one address in per-recipient mode, all in single mode
  headerTo: MimeAddress[]; headerCc: MimeAddress[];
  headerBcc: MimeAddress[];    // ALWAYS empty except gmail-API single mode
  isAggregate: boolean;
}
export interface SendPlan {
  mode: RecipientMode; threadRootMessageId: string; date: Date; copies: CopyPlan[];
  sentCopy: { headerTo: MimeAddress[]; headerCc: MimeAddress[]; headerBcc: MimeAddress[] };
}
export function resolveRecipientMode(requested: RecipientModeOption, transport: TransportName, recipientCount: number): RecipientMode;
export function buildSendPlan(args: { addresses: AddressInput[]; mode: RecipientMode; transport: TransportName; messageId: string; fromEmail: string; now: number }): SendPlan;
export function threadRootMessageId(messageId: string, fromEmail: string): string;
```

### 6.2 Signature changes

- `types.ts`: `TransportName` gains `'gmail-smtp'`; re-export `RecipientMode`.
- `mime.ts`: doc comment on `bcc`; `+ assertNoBccHeader(raw: Buffer)` scanning the header block for `^bcc:`.
- `transport.ts`: `TransportSendMeta` gains `envelopeFrom`, `envelopeTo`, `recipientMode`, `recipientKind?`, `isAggregate?`; `resolveTransport` gains `'gmail-smtp'` (nodemailer OAuth2 auth).
- `smtp.ts`: pass `envelope`; call `assertNoBccHeader`.
- `gmail.ts`: refuse a per-recipient copy whose headers name more addresses than `envelopeTo` (defence in depth).
- `send.ts`: `--recipient-mode`; resolve → `buildSendPlan` → messages row with `recipient_mode` → recipient rows (aggregate only in single mode) → loop over `plan.copies`; single-mode all-or-nothing suppression before generating tokens; `markMessageSent` gets `plan.threadRootMessageId`; `runSelfCopy` gets `plan.sentCopy` + root + date + `references`; `shouldRunSelfCopy` excludes dryrun (dryrun renders `.sent.eml` instead).
- `env.ts`: `RECIPIENT_MODE` (default `auto`); `SELF_OPEN_STRATEGY=insert` accepts smtp or gmail-smtp; `gmail-smtp` requires FROM_EMAIL + client id/secret; `per-recipient` + `gmail` is a config-time error.

### 6.3 Env vars and CLI

| Variable | Default | Meaning |
|---|---|---|
| `RECIPIENT_MODE` | `auto` | `auto` \| `per-recipient` \| `single` |
| `GMAIL_SMTP_HOST` | `smtp.gmail.com` | only for `gmail-smtp` |
| `GMAIL_SMTP_PORT` | `465` | `587` selects STARTTLS |

```
openpost send … --recipient-mode <auto|per-recipient|single>
openpost send … --transport gmail-smtp
openpost auth gmail --with-smtp        # additionally requests https://mail.google.com/
openpost doctor                        # + gmail-smtp scope present, recipient mode resolves to …
```

### 6.4 Dry-run verification

`DryRunTransport` prepends, to the written bytes only, `X-Openpost-Envelope-To`, `X-Openpost-Recipient-Kind`,
`X-Openpost-Recipient-Mode`, and writes the Sent copy as `${messageId}.sent.eml` when
`SELF_OPEN_STRATEGY !== 'window'`.

```sh
openpost send --dry-run --out /tmp/op --to a@example.com --to b@example.com --cc c@example.com --bcc d@example.com \
  --subject "recipient semantics" --html '<p>hi <a href="https://example.com">x</a></p>'
ls /tmp/op/*.eml                                                     # 4 delivered + 1 sent
for f in /tmp/op/*.*.eml; do sed -n '1,/^$/p' "$f" | grep -iE '^(to|cc|subject|date):'; echo --; done   # identical
! grep -il '^bcc:' /tmp/op/*.*.eml                                   # no Bcc in delivered copies
grep -h '^X-Openpost-Envelope-To:' /tmp/op/*.*.eml | sort            # a, b, c, d — one each
grep -h '^Message-ID:' /tmp/op/*.*.eml | sort -u | wc -l             # 4
grep -h '^References:' /tmp/op/*.*.eml | sort -u | wc -l             # 1
sed -n '1,/^$/p' /tmp/op/*.sent.eml | grep -iE '^(to|cc|bcc|message-id|x-openpost-self-copy):'
! grep -q '/o/' /tmp/op/*.sent.eml && grep -q 'https://example.com' /tmp/op/*.sent.eml
openpost send --dry-run --out /tmp/op2 --recipient-mode single …     # 1 delivered + 1 sent, exactly one pixel, no Bcc header
```

### 6.5 Test cases 200–227

Header contract: 200 buildSendPlan 2To+1Cc+1Bcc → 4 copies, deep-equal headerTo/headerCc, empty headerBcc;
201 each envelopeTo has one element, union == inputs; 202 identical To/Cc/Subject/Date header lines
(byte comparison minus Message-ID); 203 no Bcc in delivered copies, assertNoBccHeader throws on a fixture;
204 unique Message-ID per copy, shared References root == Sent copy's Message-ID; 205 empty --cc → no Cc
header; 206 display names round-trip identically.
Mode resolution: 207 auto/smtp/3 → per-recipient, auto/gmail/3 → single, auto/any/1 → per-recipient;
208 per-recipient/gmail throws naming both remedies; 209 explicit single never downgraded;
210 loadConfig rejects RECIPIENT_MODE=per-recipient + MAIL_TRANSPORT=gmail.
Transports: 211 SmtpTransport passes a one-address envelope (regression for §1.5); 212 GmailTransport
refuses a fan-out copy with no network call; 213 gmail-smtp builds an XOAUTH2 transporter without importing
googleapis; missing full scope → GmailAuthError naming `auth gmail --with-smtp`.
Reply attribution: 214 reply From B with In-Reply-To A's MID marks B; 215 listReplyCandidates never returns
aggregate rows; 216 two independent replies → two correct rows.
Single mode: 217 one delivered .eml, one pixel, full To/Cc, no Bcc; 218 1 aggregate + N addressee rows,
pixel token belongs to aggregate, addressee tokens in no artefact; 219 pixel hit lands on aggregate,
show --json reports attribution 'message' + recipientCount; 220 any suppressed addressee → untracked copy
with reason; 221 notification payload email null / attribution 'message' / text "recipient unknown, N on thread".
Persistence: 222 migrate v5 → 6, old rows read as per-recipient / is_aggregate 0; 223 per-recipient N>1
stores root in messages.rfc822_msg_id and NULL provider/thread ids, per-copy ids on recipients;
224 single stores same ids on all rows; 225 stats count a 3-recipient single message as one unit;
226 forget deletes addressee row + aggregate row + events, one address-free audit row.
Integration: 227 the full §6.4 dry-run scenario asserted programmatically.

### 6.6 Acceptance criteria

1. A `--to a --to b --cc c --bcc d` send produces header-identical copies (except Message-ID and tracking
   URLs); no delivered copy carries `Bcc:`; Reply-All from any of the four reaches the same set.
2. `MAIL_TRANSPORT=gmail` with N > 1 never submits more than one message and never silently fans out;
   asking for per-recipient there fails loudly with both remedies.
3. `MAIL_TRANSPORT=gmail-smtp` delivers per-recipient copies with correct CC semantics and lets
   `SELF_OPEN_STRATEGY=insert` run, producing exactly one untracked Sent copy.
4. Exactly one Sent copy per send, untracked, with To + Cc + Bcc, threaded via the shared References root.
5. `show`, the dashboard and every notification channel say "recipient unknown, N on thread" in single mode.
6. Tests 200–227 pass; earlier tests stay green in intent; `migrate` reaches schema 6 from any of 1–5.
7. Everything is verifiable offline via §6.4.

---

## 7. Versus Mailtrack

Mailtrack mutates the one message the Gmail web client sends, injecting a single pixel: perfect To/CC/BCC
semantics and threading, and **no per-recipient attribution** on a multi-recipient message.

| Feature | Mailtrack | openpost after this change |
|---|---|---|
| CC/BCC semantics preserved | yes (structural) | yes (header contract, enforced by `assertNoBccHeader` + tests 200–206) |
| Per-recipient attribution on a multi-recipient message | **no** | **yes** in per-recipient mode (SMTP / Gmail-SMTP) |
| Cost of that attribution | n/a | N copies; best-effort cross-recipient threading; impossible over the Gmail REST API |
| Honest fallback | n/a | `single` mode — Mailtrack behaviour, and the UI says "recipient unknown, N on thread" |

The current code is *below* the Mailtrack baseline (it breaks CC); parity on semantics is the floor.

---

## 8. Summary of key decisions

1. Header contract HC-1…HC-6; never a `Bcc:` on a delivered copy.
2. Distinct `Message-ID` per copy plus a shared synthetic `References` root that is also the Sent copy's
   `Message-ID` and `messages.rfc822_msg_id`.
3. Delivery constrained by the SMTP envelope, made explicit in `SmtpTransport` (fixes the empty-envelope bug).
4. The Gmail REST API has no envelope override; the path to per-recipient CC-correct sends is
   `MAIL_TRANSPORT=gmail-smtp` (XOAUTH2, scope `https://mail.google.com/`).
5. `RECIPIENT_MODE=auto` → per-recipient everywhere except the Gmail API (single); impossible
   combinations fail loudly.
6. Migration 006: `messages.recipient_mode`, `recipients.is_aggregate`, `recipients.envelope_to`.
7. Single mode: all-or-nothing suppression; every surface says "recipient unknown, N on thread".
