import { base64url, type GmailClient } from './gmail.js';
import { buildMime, type MimeAddress } from './mime.js';

/**
 * `findDraftByHeader`'s result (Phase 3.1, M3): distinguishes "searched everything reachable and
 * there is definitely no such draft" (`not_found` - safe to create a fresh one) from "gave up
 * before seeing every draft" (`uncertain` - the crash-recovery caller must NOT create a second
 * draft on a false negative; `processDraft` already treats `uncertain` as the terminal outcome for
 * this reminder rather than falling through to a fresh creation attempt).
 */
export type FindDraftResult = { status: 'found'; draftId: string } | { status: 'not_found' } | { status: 'uncertain' };

export interface DraftClient {
  createDraft(input: { raw: Buffer; threadId: string }): Promise<{
    draftId: string;
    messageId: string | null;
    threadId: string | null;
  }>;
  findDraftByHeader(threadId: string, headerName: string, headerValue: string): Promise<FindDraftResult>;
}

// Phase 3.1 (M3): bounds how many drafts a single search ever scans (10 pages of 50 = 500) - an
// account with more drafts than that in flight stops the search rather than looping forever or
// burning unbounded quota; `uncertain` is the correct (safe) outcome for the caller in that case,
// never `not_found`.
const DRAFT_SEARCH_PAGE_SIZE = 50;
const DRAFT_SEARCH_MAX_PAGES = 10;

/** Wraps a real `GmailClient` as a `DraftClient` (§3.5). `users.drafts.send` is never called
 *  anywhere in this module or the rest of the codebase - a reminder draft is created and left for
 *  the operator to review and send themselves. */
export function gmailDraftClient(client: GmailClient): DraftClient {
  return {
    async createDraft(input) {
      const res = await client.users.drafts.create({
        userId: 'me',
        requestBody: { message: { threadId: input.threadId, raw: base64url(input.raw) } },
      });
      return {
        draftId: res.data.id ?? '',
        messageId: res.data.message?.id ?? null,
        threadId: res.data.message?.threadId ?? null,
      };
    },
    async findDraftByHeader(threadId, headerName, headerValue) {
      let pageToken: string | undefined;
      for (let page = 0; page < DRAFT_SEARCH_MAX_PAGES; page++) {
        let list;
        try {
          list = await client.users.drafts.list({
            userId: 'me',
            q: `in:draft`,
            maxResults: DRAFT_SEARCH_PAGE_SIZE,
            ...(pageToken ? { pageToken } : {}),
          });
        } catch {
          // A failed list call mid-search means the earlier pages (if any) are not the whole
          // picture either - never conclude "not found" from a partial, failed search.
          return { status: 'uncertain' };
        }
        const drafts = list.data.drafts ?? [];
        for (const d of drafts) {
          if (!d.id) continue;
          try {
            // `drafts.get` (unlike `messages.get`/`threads.get`) has no `metadataHeaders` filter -
            // `format: 'metadata'` alone still avoids fetching the full MIME body.
            const full = await client.users.drafts.get({ userId: 'me', id: d.id, format: 'metadata' });
            if (full.data.message?.threadId !== threadId) continue;
            const headers = full.data.message?.payload?.headers ?? [];
            const hit = headers.some(
              (h: { name?: string | null; value?: string | null }) =>
                h.name?.toLowerCase() === headerName.toLowerCase() && h.value === headerValue,
            );
            if (hit) return { status: 'found', draftId: d.id };
          } catch {
            // A single unreadable draft must not abort the search for the others.
          }
        }
        pageToken = list.data.nextPageToken ?? undefined;
        if (!pageToken) return { status: 'not_found' };
      }
      // Exhausted the page bound with a `nextPageToken` still outstanding - there are more drafts
      // this search never looked at, so the honest answer is "don't know", not "not found".
      return { status: 'uncertain' };
    },
  };
}

export interface ReminderDraftInput {
  from: MimeAddress;
  to: MimeAddress[];
  originalSubject: string;
  subject?: string | undefined;
  html: string;
  text?: string | undefined;
  threadId: string;
  rfc822MessageId: string;
  reminderId: string;
}

const DEFAULT_DRAFT_TEXT = 'Just following up on my message below - did this reach you?';
const DEFAULT_DRAFT_HTML = `<p>${DEFAULT_DRAFT_TEXT}</p><blockquote></blockquote>`;

function replySubject(original: string, override: string | undefined): string {
  if (override !== undefined) return override;
  return /^re:/i.test(original.trim()) ? original : `Re: ${original}`;
}

/** Builds the reminder-follow-up MIME (§3.5): `In-Reply-To`/`References` point at the recipient's
 *  own `rfc822_msg_id` (never the sender's self-copy), and `X-Openpost-Reminder` marks the message
 *  so a crash-recovery search (`findDraftByHeader`) can find it again without blindly recreating a
 *  second draft. */
export async function buildReminderDraftMime(input: ReminderDraftInput): ReturnType<typeof buildMime> {
  return buildMime({
    from: input.from,
    to: input.to,
    subject: replySubject(input.originalSubject, input.subject),
    html: input.html || DEFAULT_DRAFT_HTML,
    text: input.text ?? DEFAULT_DRAFT_TEXT,
    inReplyTo: input.rfc822MessageId,
    references: [input.rfc822MessageId],
    headers: { 'X-Openpost-Reminder': input.reminderId },
  });
}

export async function createReminderDraft(
  client: DraftClient,
  input: ReminderDraftInput,
): Promise<{ draftId: string; threadId: string | null }> {
  const mime = await buildReminderDraftMime(input);
  const result = await client.createDraft({ raw: mime.raw, threadId: input.threadId });
  return { draftId: result.draftId, threadId: result.threadId };
}
