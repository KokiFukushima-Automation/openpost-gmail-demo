import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import {
  audit,
  findRecipientByMessageAndEmail,
  getMessage,
  getRecipient,
  getSetting,
  listReplyCandidates,
  recomputeRecipientCounters,
  setRepliedAt,
  setSetting,
  touchReplyCheck,
} from '../db/repo.js';
import { cancelPendingForRecipient } from '../db/reminders.js';
import { detectReply, normalizeAddress, type ThreadReader } from '../mail/threads.js';
import type { EventBus } from '../notify/bus.js';
import type { TrackingEvent } from '../notify/types.js';
import type { Job } from './scheduler.js';

export interface Logger {
  error: (...args: unknown[]) => void;
}
const noopLogger: Logger = { error: () => undefined };

export interface ReplyJobDeps {
  db: DB;
  config: AppConfig;
  bus: EventBus;
  /** `null` disables the job entirely (no reader available - `REPLY_DETECTION=off`, or `auto`
   *  resolved to nothing usable). */
  reader: ThreadReader | null;
  /** Same contract as `ReminderJobDeps.notifyEnqueue` (§2.1's `onEvent` hook pattern). */
  notifyEnqueue?: (e: TrackingEvent) => boolean;
  clock?: () => number;
  rand?: () => number;
  log?: Logger;
}

export interface RunReplyPollResult {
  checked: number;
  replied: number;
  backoffActive: boolean;
  /** Phase 3.1 (H3): count of candidates whose `fetchThread` failed with something other than a
   *  rate-limit error - each is skipped (with `reply_checked_at` still advanced) rather than
   *  aborting the rest of the tick, but a persistently non-zero count is worth surfacing in the job
   *  detail so an operator notices a systemic problem (a bad thread id, a revoked token, ...). */
  errors: number;
}

const BACKOFF_SETTING_KEY = 'reply_poll_backoff_until';
const BACKOFF_MS_SETTING_KEY = 'reply_poll_backoff_ms';
const MIN_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const withMeta = err as Error & { code?: number; response?: { status?: number } };
  const status = withMeta.code ?? withMeta.response?.status;
  if (status === 429 || status === 403) {
    return /rateLimitExceeded|userRateLimitExceeded/i.test(err.message) || status === 429;
  }
  return /rateLimitExceeded|userRateLimitExceeded/i.test(err.message);
}

function readBackoffUntil(db: DB): number {
  const raw = getSetting(db, BACKOFF_SETTING_KEY);
  return raw ? Number(raw) : 0;
}

function applyBackoff(db: DB, nowMs: number, rand: () => number): void {
  const prevMs = Number(getSetting(db, BACKOFF_MS_SETTING_KEY) ?? '0');
  const nextMs = Math.min(prevMs > 0 ? prevMs * 2 : MIN_BACKOFF_MS, MAX_BACKOFF_MS);
  const jittered = Math.round(nextMs * (0.8 + 0.4 * rand()));
  setSetting(db, BACKOFF_MS_SETTING_KEY, String(nextMs));
  setSetting(db, BACKOFF_SETTING_KEY, String(nowMs + jittered));
}

function resetBackoff(db: DB): void {
  setSetting(db, BACKOFF_MS_SETTING_KEY, '0');
  setSetting(db, BACKOFF_SETTING_KEY, '0');
}

/** Phase 3.1 (L9): a Gmail message id is an opaque provider id, safe to keep in the audit log as-
 *  is. An IMAP-mode id is the reply's own RFC822 `Message-ID` header (`imapThreadReader` has no
 *  Gmail id to use instead) - that can embed a hostname, username fragment or timestamp, none of
 *  which belong in an audit trail meant to avoid leaking message content/PII. Detected by the `@`
 *  every RFC822 Message-ID contains and a Gmail id never does; hashed rather than dropped so the
 *  same reply still produces a stable, comparable value across audit rows. */
function auditSafeMessageId(id: string | null): string | null {
  if (id === null || !id.includes('@')) return id;
  return `sha256:${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

/** One reply-poll tick (§4.1): honours the tiered candidate selection, a per-tick quota budget
 *  (`REPLY_QUOTA_UNITS_PER_MIN`, spent against `reader.unitCost`), and a doubling backoff on a
 *  provider rate-limit error. Never throws for a single candidate's transient failure; a rate-limit
 *  error stops the rest of the tick (the tiered gap means the next tick tries again). */
export async function runReplyPollOnce(deps: ReplyJobDeps, nowMs: number): Promise<RunReplyPollResult> {
  const result: RunReplyPollResult = { checked: 0, replied: 0, backoffActive: false, errors: 0 };
  if (!deps.reader) return result;

  const backoffUntil = readBackoffUntil(deps.db);
  if (nowMs < backoffUntil) {
    result.backoffActive = true;
    return result;
  }

  const rand = deps.rand ?? Math.random;
  const candidates = listReplyCandidates(deps.db, {
    nowMs,
    watchDays: deps.config.replyWatchDays,
    pollSeconds: deps.config.replyPollSeconds,
    batch: deps.config.replyPollBatch,
    mode: deps.reader.kind,
  });

  // Phase 3.1 (L11): REPLY_QUOTA_UNITS_PER_MIN is a rate, but this loop spends a fixed budget once
  // per tick, and the tick length is REPLY_POLL_SECONDS (createReplyPollJob), not a hardcoded
  // minute - scale the per-tick allowance to the actual tick length so the configured name still
  // approximates the real rate. This is still a fixed allowance per tick, not a token bucket that
  // carries an unused surplus (or a burst deficit) across ticks - REPLY_POLL_BATCH is the other
  // half of the real cap on how much work one tick can ever do.
  let budget = deps.config.replyQuotaUnitsPerMin * (deps.config.replyPollSeconds / 60);
  let hadCleanFetch = false;

  for (const candidate of candidates) {
    if (budget < deps.reader.unitCost) break;
    budget -= deps.reader.unitCost;

    try {
      const messages = await deps.reader.fetchThread({
        threadId: candidate.thread_id ?? '',
        rfc822MessageId: candidate.rfc822_msg_id ?? '',
        sinceMs: candidate.sent_at,
      });
      result.checked += 1;
      hadCleanFetch = true;

      const decision = detectReply(messages, {
        senderEmail: candidate.sender_email,
        sentAt: candidate.sent_at,
        ownProviderMsgId: candidate.provider_msg_id,
        ignoreSenders: deps.config.replyIgnoreSenders,
      });

      if (decision.isReply) {
        const atMs = decision.atMs ?? nowMs;

        // docs/07_recipient_semantics.md §2.1: pre-existing bug fix. `candidate` is whichever
        // recipient's Message-ID/thread happened to be in this poll batch - on a multi-recipient
        // thread, crediting it unconditionally means "Bob replies to Alice's reply" gets recorded
        // as Alice having replied. Match the reply's own `From` against this message's addressees
        // first; only fall back to `candidate` when From matches no addressee (e.g. a reply sent
        // from an alias the recipient list never named).
        const replyMessage = messages.find((m) => m.id === decision.messageId);
        const replyFromNorm = replyMessage ? normalizeAddress(replyMessage.from) : '';
        const matchedByFrom =
          replyFromNorm !== '' ? findRecipientByMessageAndEmail(deps.db, candidate.message_id, replyFromNorm) : null;
        const creditRecipientId = matchedByFrom?.id ?? candidate.id;

        const before = getRecipient(deps.db, creditRecipientId);
        const changed = setRepliedAt(deps.db, creditRecipientId, { atMs, replyMsgId: decision.messageId ?? null });
        if (changed) {
          recomputeRecipientCounters(deps.db, creditRecipientId);
          const remindersCancelled = cancelPendingForRecipient(deps.db, creditRecipientId, nowMs, 'replied', [
            'no_reply',
          ]);
          audit(deps.db, {
            actor: 'server',
            action: 'reply.detected',
            subjectType: 'recipient',
            subjectId: creditRecipientId,
            detail: {
              messageId: auditSafeMessageId(decision.messageId ?? null),
              delayMs: atMs - candidate.sent_at,
              remindersCancelled,
              reason: decision.reason,
              ...(matchedByFrom && matchedByFrom.id !== candidate.id ? { attributedByFrom: true } : {}),
            },
          });
          const recipient = getRecipient(deps.db, creditRecipientId);
          const message = getMessage(deps.db, candidate.message_id);
          if (recipient && message) {
            const event: TrackingEvent = {
              kind: 'reply',
              eventId: `reply:${creditRecipientId}`,
              occurredAt: atMs,
              messageId: message.id,
              subject: message.subject,
              recipientId: recipient.id,
              recipientEmail: recipient.email,
              classification: 'reply',
              reasons: ['reply'],
              counted: false,
              backfilled: false,
              prevState: before?.state ?? recipient.state,
              newState: recipient.state,
              counters: {
                openCount: recipient.open_count,
                machineOpenCount: recipient.machine_open_count,
                clickCount: recipient.click_count,
                firstOpenAt: recipient.first_open_at,
                lastOpenAt: recipient.last_open_at,
              },
              uaFamily: null,
              deviceType: null,
              linkUrl: null,
              muted: message.notify_muted === 1 || recipient.notify_muted === 1,
              sentAt: recipient.sent_at,
              country: null,
              isAggregate: false,
              recipientCount: 0,
              campaignId: message.campaign_id,
            };
            deps.notifyEnqueue?.(event);
            deps.bus.publish(event);
          }
          result.replied += 1;
        }
      } else {
        touchReplyCheck(deps.db, candidate.id, nowMs);
      }
    } catch (err) {
      if (isRateLimitError(err)) {
        applyBackoff(deps.db, nowMs, rand);
        audit(deps.db, { actor: 'server', action: 'reply.backoff', detail: { candidateId: candidate.id } });
        result.backoffActive = true;
        return result;
      }
      // Phase 3.1 (H3): a single candidate's non-rate-limit failure (a bad thread id, a transient
      // network error, ...) used to `throw` here, aborting the whole tick and never advancing this
      // candidate's `reply_checked_at` - `listReplyCandidates`'s tiering means the SAME candidate is
      // re-selected first next tick, wedging the poll on it permanently and starving every other
      // recipient. Log it, advance the checkpoint anyway, and move on to the next candidate.
      (deps.log ?? noopLogger).error(err, `replies: fetchThread failed for recipient ${candidate.id}`);
      touchReplyCheck(deps.db, candidate.id, nowMs);
      result.errors += 1;
    }
  }

  if (hadCleanFetch) resetBackoff(deps.db);
  return result;
}

export function createReplyPollJob(deps: ReplyJobDeps): Job {
  const clock = deps.clock ?? (() => Date.now());
  return {
    name: 'reply-poll',
    // Phase 3.1 (L11): this was hardcoded to 60s regardless of REPLY_POLL_SECONDS (default 300s) -
    // the job ran 5x more often than configured, at 1/5th the intended budget scaling below.
    intervalMs: deps.config.replyPollSeconds * 1000,
    async run(nowMs: number) {
      const result = await runReplyPollOnce({ ...deps, clock }, nowMs ?? clock());
      return { detail: result };
    },
  };
}
