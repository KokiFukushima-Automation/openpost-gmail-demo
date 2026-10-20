import type { GmailClient } from './gmail.js';
import type { ImapLike } from './imap.js';

export interface ThreadMessageMeta {
  id: string;
  threadId: string;
  internalDate: number;
  from: string | null;
  to: string | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string | null;
  labelIds: string[];
  /** `X-Openpost-Self-Copy: 1` present - the sender's own untracked Sent copy (§4.2's reference to
   *  doc 05 §4.2's self-copy back-fill), which reply detection must always skip. */
  isSelfCopy: boolean;
  /** Phase 3.1 (H2): RFC 3834 `Auto-Submitted` - anything other than the absent header or the
   *  literal value `no` marks an automated message (vacation autoresponder, DSN, etc.). */
  autoSubmitted: string | null;
  /** Phase 3.1 (H2): the (non-standard but near-universal) `Precedence` header - `bulk`,
   *  `auto_reply`, `junk` and `list` all mark automated/mailing-list traffic. */
  precedence: string | null;
  /** Phase 3.1 (H2): either of these present at all (regardless of value) marks a vacation
   *  autoresponder - most autoresponders set one to `yes`/`1`, but some send an empty string. */
  xAutoreply: string | null;
  xAutorespond: string | null;
  /** Phase 3.1 (H2): a bounce/DSN's `Return-Path` is often `<>` or the real `mailer-daemon@...`
   *  address even when `From` was dressed up as something friendlier ("Mail Delivery Subsystem"). */
  returnPath: string | null;
}

export interface ThreadReader {
  readonly kind: 'gmail' | 'imap';
  readonly unitCost: number;
  fetchThread(ref: { threadId: string; rfc822MessageId: string; sinceMs: number }): Promise<ThreadMessageMeta[]>;
}

export interface ReplyDecision {
  isReply: boolean;
  reason: string;
  messageId?: string | undefined;
  atMs?: number | undefined;
}

/** Exported for `src/jobs/replies.ts`'s reply-attribution fix (docs/07_recipient_semantics.md §2.1
 *  pre-existing bug): matching a reply's `From` header against `recipients.email` needs the exact
 *  same "strip a display name, lower-case, trim" normalisation this module already uses for the
 *  sender-address comparison in `detectReply`. */
export function normalizeAddress(raw: string | null | undefined): string {
  if (raw == null) return '';
  const angle = /<([^>]+)>/.exec(raw);
  const addr = angle ? angle[1] : raw;
  return (addr ?? '').trim().toLowerCase();
}

/** `ignoreSenders` (REPLY_IGNORE_SENDERS, lower-cased) is an addition beyond the spec's literal
 *  signature, needed to reject an operator-configured alias (test 177) - every other field matches
 *  §4.2 exactly, and `ignoreSenders` defaults to empty so every existing call site compiles. */
export interface DetectReplyCtx {
  senderEmail: string;
  sentAt: number;
  ownProviderMsgId: string | null;
  skewMs?: number;
  ignoreSenders?: string[];
}

// Phase 3.1 (H2): non-standard but near-universal bulk/automated-traffic markers.
const BULK_PRECEDENCE = new Set(['bulk', 'auto_reply', 'junk', 'list']);

function isAutoSubmitted(v: string | null | undefined): boolean {
  // RFC 3834: absent, or the literal value "no", both mean "this is an ordinary message". Anything
  // else (auto-generated, auto-replied, ...) marks an automated one. `v == null` (loose) also
  // covers a hand-built ThreadMessageMeta (e.g. in a test's fake reader) that omits the field
  // entirely rather than setting it to `null`.
  return v != null && v.trim().toLowerCase() !== 'no';
}

function isBulkPrecedence(v: string | null | undefined): boolean {
  return v != null && BULK_PRECEDENCE.has(v.trim().toLowerCase());
}

function isMailerDaemonAddress(addr: string): boolean {
  return /^(mailer-daemon|postmaster)@/i.test(addr);
}

/**
 * Declares a reply for the *first* message satisfying every rule (§4.2) - pure, unit-tested, and
 * the rule that actually matters for DoD 4/9. Everything else (auto-replies, bounces, the
 * operator's own follow-up) is rejected with a named reason so a false negative is diagnosable.
 *
 * Phase 3.1 (H2): without the auto-reply/bounce rules below, a DSN from `mailer-daemon@` or a
 * vacation autoresponder was recorded as a real reply - `replied` is a terminal recipient state, so
 * that silently cancelled the `no_reply` reminder and fired a false "they replied!" notification.
 */
export function detectReply(messages: ThreadMessageMeta[], ctx: DetectReplyCtx): ReplyDecision {
  const skewMs = ctx.skewMs ?? 1000;
  const senderNorm = normalizeAddress(ctx.senderEmail);
  const ignoreSet = new Set((ctx.ignoreSenders ?? []).map((s) => s.toLowerCase()));
  // The most specific rejection reason seen across every candidate that was otherwise in the
  // running (i.e. passed the timing/self/label checks) - reported only if NO message ultimately
  // qualifies, so an operator can tell "genuinely no reply yet" from "got an autoresponder".
  let bestRejectionReason: string | null = null;

  const sorted = [...messages].sort((a, b) => a.internalDate - b.internalDate);
  for (const m of sorted) {
    if (!(m.internalDate > ctx.sentAt + skewMs)) {
      continue;
    }
    const fromNorm = normalizeAddress(m.from);
    if (fromNorm === senderNorm) continue;
    if (ignoreSet.has(fromNorm)) continue;
    if (m.labelIds.includes('SENT') || m.labelIds.includes('DRAFT')) continue;
    if (m.isSelfCopy) continue;
    if (ctx.ownProviderMsgId !== null && m.id === ctx.ownProviderMsgId) continue;

    if (isAutoSubmitted(m.autoSubmitted)) {
      bestRejectionReason ??= 'auto_submitted';
      continue;
    }
    if (isBulkPrecedence(m.precedence)) {
      bestRejectionReason ??= 'bulk_precedence';
      continue;
    }
    if (m.xAutoreply != null || m.xAutorespond != null) {
      bestRejectionReason ??= 'vacation_autoresponder';
      continue;
    }
    const returnPathNorm = normalizeAddress(m.returnPath);
    if (isMailerDaemonAddress(fromNorm) || (returnPathNorm !== '' && isMailerDaemonAddress(returnPathNorm))) {
      bestRejectionReason ??= 'mailer_daemon';
      continue;
    }

    return { isReply: true, reason: 'reply', messageId: m.id, atMs: m.internalDate };
  }
  return { isReply: false, reason: bestRejectionReason ?? 'no_qualifying_message' };
}

function headerValue(headers: Array<{ name?: string | null; value?: string | null }> | undefined, name: string): string | null {
  if (!headers) return null;
  const hit = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return hit?.value ?? null;
}

const METADATA_HEADERS = [
  'From',
  'To',
  'Date',
  'Message-ID',
  'In-Reply-To',
  'References',
  'X-Openpost-Self-Copy',
  // Phase 3.1 (H2): auto-reply/bounce detection.
  'Auto-Submitted',
  'Precedence',
  'X-Autoreply',
  'X-Autorespond',
  'Return-Path',
];

export function gmailThreadReader(client: GmailClient): ThreadReader {
  return {
    kind: 'gmail',
    unitCost: 10,
    async fetchThread(ref) {
      let res;
      try {
        res = await client.users.threads.get({
          userId: 'me',
          id: ref.threadId,
          format: 'metadata',
          metadataHeaders: METADATA_HEADERS,
        });
      } catch (err) {
        const status = (err as { code?: number; response?: { status?: number } }).code ??
          (err as { response?: { status?: number } }).response?.status;
        if (status === 404) return [];
        throw err;
      }
      const messages = res.data.messages ?? [];
      return messages.map((m): ThreadMessageMeta => {
        const headers = m.payload?.headers ?? undefined;
        return {
          id: m.id ?? '',
          threadId: m.threadId ?? ref.threadId,
          internalDate: m.internalDate ? Number(m.internalDate) : 0,
          from: headerValue(headers, 'From'),
          to: headerValue(headers, 'To'),
          messageIdHeader: headerValue(headers, 'Message-ID'),
          inReplyTo: headerValue(headers, 'In-Reply-To'),
          references: headerValue(headers, 'References'),
          labelIds: m.labelIds ?? [],
          isSelfCopy: headerValue(headers, 'X-Openpost-Self-Copy') === '1',
          autoSubmitted: headerValue(headers, 'Auto-Submitted'),
          precedence: headerValue(headers, 'Precedence'),
          xAutoreply: headerValue(headers, 'X-Autoreply'),
          xAutorespond: headerValue(headers, 'X-Autorespond'),
          returnPath: headerValue(headers, 'Return-Path'),
        };
      });
    },
  };
}

export type { ImapFetchMessage as ImapMessageEnvelope } from './imap.js';

function parseImapHeaders(raw: Buffer | string | undefined): Record<string, string> {
  const text = raw === undefined ? '' : raw.toString();
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!(name in out)) out[name] = value;
  }
  return out;
}

const IMAP_HEADER_FIELDS = [
  'message-id',
  'in-reply-to',
  'references',
  'x-openpost-self-copy',
  'from',
  // Phase 3.1 (H2): auto-reply/bounce detection, same as the Gmail path.
  'auto-submitted',
  'precedence',
  'x-autoreply',
  'x-autorespond',
  'return-path',
];

/** `SELF_OPEN_STRATEGY`-independent SMTP-mode alternative (§4.2): searches `IMAP_ALL_MAIL_MAILBOX`
 *  for a message whose `In-Reply-To` or `References` names the recipient's own `rfc822_msg_id`.
 *  `unitCost` is 1 (no Gmail quota) - the same token bucket still paces it to avoid hammering the
 *  mailbox.
 *
 *  Phase 3.1 (L9): `detectReply`'s "SENT/DRAFT label" rule and "id equals ownProviderMsgId" rule
 *  are both effectively inert for this reader - `labelIds` is always `[]` here (IMAP has no Gmail-
 *  style labels), and `id` is the RFC822 `Message-ID` (or a bare UID), never comparable to a Gmail
 *  provider message id. The operative defences against crediting the sender's own copy in IMAP mode
 *  are the `From`-address match and the `X-Openpost-Self-Copy` header (both still fully live), plus
 *  - as of H2 - the auto-reply/bounce rules below, which apply identically to both readers. */
export function imapThreadReader(client: ImapLike, mailbox: string): ThreadReader {
  return {
    kind: 'imap',
    unitCost: 1,
    async fetchThread(ref) {
      await client.mailboxOpen(mailbox);
      const uids = await client.search({
        or: [{ header: { 'in-reply-to': ref.rfc822MessageId } }, { header: { references: ref.rfc822MessageId } }],
        since: new Date(ref.sinceMs),
      });
      if (uids.length === 0) return [];
      const results: ThreadMessageMeta[] = [];
      for await (const msg of client.fetch(uids, {
        envelope: true,
        headers: IMAP_HEADER_FIELDS,
      })) {
        const headers = parseImapHeaders(msg.headers);
        const envelopeDate = msg.envelope?.date;
        const internalDate =
          envelopeDate !== undefined && envelopeDate !== null
            ? new Date(envelopeDate).getTime()
            : (msg.internalDate?.getTime() ?? 0);
        const from =
          headers.from ??
          (msg.envelope?.from?.[0]?.address ? (msg.envelope.from[0].address as string) : null);
        results.push({
          id: headers['message-id'] ?? String(msg.uid),
          threadId: ref.threadId,
          internalDate,
          from: from ?? null,
          to: null,
          messageIdHeader: headers['message-id'] ?? null,
          inReplyTo: headers['in-reply-to'] ?? null,
          references: headers['references'] ?? null,
          labelIds: [],
          isSelfCopy: headers['x-openpost-self-copy'] === '1',
          autoSubmitted: headers['auto-submitted'] ?? null,
          precedence: headers['precedence'] ?? null,
          xAutoreply: headers['x-autoreply'] ?? null,
          xAutorespond: headers['x-autorespond'] ?? null,
          returnPath: headers['return-path'] ?? null,
        });
      }
      return results;
    },
  };
}
