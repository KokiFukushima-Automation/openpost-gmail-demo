/**
 * Server half of the future in-Gmail extension (docs/08_phase4_spec.md §6.2a): matches Gmail thread
 * rows to openpost messages by threadId, then rfc822 Message-ID, then (last resort, and marked as
 * such) normalized subject within a recent window. Unmatched keys are reported with `matchedBy:
 * null` - never a guess presented as a match.
 */
import type { DB } from '../../db/index.js';
import { normalizeSubject } from '../../core/subject.js';

export const THREAD_LOOKUP_MAX_KEYS = 100;

export interface ThreadLookupQuery {
  threadIds?: string[];
  rfc822MessageIds?: string[];
  subjects?: string[];
}

export interface ThreadLookupRecipientSummary {
  email: string;
  state: string;
  openCount: number;
  clickCount: number;
  lastOpenAt: number | null;
  repliedAt: number | null;
}

export interface ThreadLookupResultItem {
  key: string;
  matchedBy: 'threadId' | 'rfc822MessageId' | 'subject' | null;
  messageId?: string;
  subject?: string;
  sentAt?: number | null;
  summary?:
    | {
        state: string;
        opens: number;
        clicks: number;
        replied: boolean;
        recipients: number;
        lastOpenAt: number | null;
      }
    | undefined;
  recipients?: ThreadLookupRecipientSummary[];
}

interface MessageRow {
  id: string;
  subject: string;
  sent_at: number | null;
  thread_id: string | null;
  rfc822_msg_id: string | null;
  recipient_mode: string;
}

function summarize(db: DB, message: MessageRow): { summary: ThreadLookupResultItem['summary']; recipients: ThreadLookupRecipientSummary[] } {
  const recipientRows = db
    .prepare(
      `SELECT email, state, open_count, click_count, last_open_at, replied_at, is_aggregate FROM recipients
        WHERE message_id = ?`,
    )
    .all(message.id) as Array<{ email: string; state: string; open_count: number; click_count: number; last_open_at: number | null; replied_at: number | null; is_aggregate: number }>;

  const addressees = recipientRows.filter((r) => r.is_aggregate === 0);
  const tracked = message.recipient_mode === 'single' ? recipientRows.filter((r) => r.is_aggregate === 1) : addressees;
  const recipients: ThreadLookupRecipientSummary[] = addressees.map((r) => ({
    email: r.email,
    state: r.state,
    openCount: r.open_count,
    clickCount: r.click_count,
    lastOpenAt: r.last_open_at,
    repliedAt: r.replied_at,
  }));

  const opens = tracked.reduce((sum, r) => sum + r.open_count, 0);
  const clicks = tracked.reduce((sum, r) => sum + r.click_count, 0);
  const replied = recipients.some((r) => r.repliedAt !== null);
  const lastOpenAt = tracked.reduce<number | null>((max, r) => (r.last_open_at !== null && (max === null || r.last_open_at > max) ? r.last_open_at : max), null);
  const overallState = replied ? 'replied' : tracked.some((r) => r.state === 'read_confirmed') ? 'read_confirmed' : opens > 0 ? 'opened' : tracked.some((r) => r.state === 'prefetched') ? 'prefetched' : 'not_opened';

  return {
    summary: { state: overallState, opens, clicks, replied, recipients: recipients.length, lastOpenAt },
    recipients,
  };
}

export interface LookupThreadsOptions {
  /** THREAD_LOOKUP_DAYS - the window subject-based matching is allowed to look back. */
  windowDays: number;
  nowMs?: number;
  /** Finding #13 (docs/reports/phase4_review.md): `recipients[]` (every matched thread's addressee
   *  email address) used to be returned unconditionally, including for matches made by the
   *  last-resort normalised-subject guess - a bearer holder (or a compromised allow-listed
   *  extension origin) could dump address lists by guessing subjects. Aggregate `summary` is always
   *  returned; the raw per-recipient array only when this is explicitly set (and, at the route
   *  level, only over a real bearer token - see src/server/routes/api.ts). */
  includeRecipients?: boolean;
}

export function lookupThreads(db: DB, query: ThreadLookupQuery, opts: LookupThreadsOptions): { results: ThreadLookupResultItem[] } {
  const nowMs = opts.nowMs ?? Date.now();
  const windowStart = nowMs - opts.windowDays * 24 * 60 * 60 * 1000;

  const results: ThreadLookupResultItem[] = [];
  const seen = new Set<string>();

  const push = (key: string, matchedBy: ThreadLookupResultItem['matchedBy'], message: MessageRow | null): void => {
    if (seen.has(key)) return;
    seen.add(key);
    if (!message) {
      results.push({ key, matchedBy: null });
      return;
    }
    const { summary, recipients } = summarize(db, message);
    results.push({
      key,
      matchedBy,
      messageId: message.id,
      subject: message.subject,
      sentAt: message.sent_at,
      summary,
      ...(opts.includeRecipients ? { recipients } : {}),
    });
  };

  for (const threadId of (query.threadIds ?? []).slice(0, THREAD_LOOKUP_MAX_KEYS)) {
    const row = db.prepare(`SELECT m.* FROM messages m WHERE m.tracking_enabled = 1 AND m.status = 'sent'
      AND (m.thread_id = ? OR EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.thread_id = ?))
      ORDER BY m.created_at DESC LIMIT 1`).get(threadId, threadId) as MessageRow | undefined;
    push(threadId, row ? 'threadId' : null, row ?? null);
  }

  for (const rfc822 of (query.rfc822MessageIds ?? []).slice(0, THREAD_LOOKUP_MAX_KEYS)) {
    if (seen.has(rfc822)) continue;
    const row = db.prepare(`SELECT * FROM messages WHERE rfc822_msg_id = ? ORDER BY created_at DESC LIMIT 1`).get(rfc822) as MessageRow | undefined;
    push(rfc822, row ? 'rfc822MessageId' : null, row ?? null);
  }

  const subjectKeys = (query.subjects ?? []).slice(0, THREAD_LOOKUP_MAX_KEYS).filter((s) => !seen.has(s));
  if (subjectKeys.length > 0) {
    // Finding #13: hoisted out of the loop - this used to re-run (and re-normalize up to 500 rows
    // of) the SAME query for every one of up to 100 subject keys (50k row scans + normalizeSubject
    // calls worst case). Run once, normalize each candidate's subject once, then look each key up
    // in that single pre-normalized list.
    const candidates = db
      .prepare(`SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at DESC LIMIT 500`)
      .all(windowStart) as MessageRow[];
    const normalizedCandidates = candidates.map((c) => ({ normalized: normalizeSubject(c.subject), row: c }));
    for (const subject of subjectKeys) {
      const normalized = normalizeSubject(subject);
      const match = normalizedCandidates.find((c) => c.normalized === normalized);
      push(subject, match ? 'subject' : null, match?.row ?? null);
    }
  }

  return { results };
}
