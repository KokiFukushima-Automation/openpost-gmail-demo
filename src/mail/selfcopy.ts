import { base64url, type GmailClient } from './gmail.js';
import type { ImapLike } from './imap.js';
import { buildMime, type BuildMimeInput } from './mime.js';

export interface SelfCopyInput {
  /** Built from the ORIGINAL html + original (non-rewritten) links - the whole point is that this
   *  copy carries no pixel and no click-tracking hrefs (§4.2). */
  untracked: { raw: Buffer; messageId: string };
  sentAt: number;
}

export interface SelfCopyResult {
  strategy: 'insert' | 'imap-append' | 'none';
  providerMessageId: string | null;
  error?: string;
}

/** Builds the untracked MIME reusing the delivered copy's Message-ID/Date/To/Subject/In-Reply-To/
 *  References, so Gmail threads the Sent copy with the recipient's replies, plus
 *  `X-Openpost-Self-Copy: 1` (present only in the sender's own mailbox - Phase 3 reply detection
 *  skips it). */
export async function buildUntrackedMime(
  args: BuildMimeInput & { rfc822MessageId: string },
): Promise<{ raw: Buffer; messageId: string }> {
  const { rfc822MessageId, headers, ...rest } = args;
  return buildMime({
    ...rest,
    messageId: rfc822MessageId,
    headers: { ...(headers ?? {}), 'X-Openpost-Self-Copy': '1' },
  });
}

/**
 * `SELF_OPEN_STRATEGY=insert` (§4.2): inserts the untracked copy into Sent via the Gmail API,
 * `internalDateSource: 'dateHeader'` keeping it in the right chronological place. An insert
 * failure never fails the send - it comes back as `{ error }` for the caller to audit as
 * `selfcopy.failed` and surface in `send --json`.
 */
export async function insertSentCopy(client: GmailClient, input: SelfCopyInput): Promise<SelfCopyResult> {
  try {
    const res = await client.users.messages.insert({
      userId: 'me',
      internalDateSource: 'dateHeader',
      requestBody: { raw: base64url(input.untracked.raw), labelIds: ['SENT'] },
    });
    return { strategy: 'insert', providerMessageId: res.data.id ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { strategy: 'insert', providerMessageId: null, error: message };
  }
}

/** `SELF_OPEN_STRATEGY=imap-append` (§4.2): the SMTP-only alternative when the Gmail API is
 *  unavailable. Same failure policy as `insertSentCopy`. */
export async function appendSentCopy(
  client: ImapLike,
  input: SelfCopyInput,
  mailbox: string,
): Promise<SelfCopyResult> {
  try {
    await client.append(mailbox, input.untracked.raw, ['\\Seen'], new Date(input.sentAt));
    return { strategy: 'imap-append', providerMessageId: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { strategy: 'imap-append', providerMessageId: null, error: message };
  }
}
