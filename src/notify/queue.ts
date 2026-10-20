import type { DB, Stmt } from '../db/index.js';
import { newId } from '../core/ids.js';
import type { ChannelName, NotificationPayload, NotifyTrigger } from './types.js';

export interface NotificationRow {
  id: string;
  trigger: NotifyTrigger;
  channel: ChannelName;
  message_id: string | null;
  recipient_id: string | null;
  event_type: 'open' | 'click' | 'reply' | 'reminder' | 'campaign_digest' | 'daily_digest';
  event_id: string | null;
  dedupe_key: string;
  payload_json: string;
  status: 'pending' | 'sending' | 'sent' | 'failed';
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  sent_at: number | null;
  /** Set when a row is claimed (status flips to 'sending'), cleared on markSent/markRetry/
   *  markFailed. Phase 2.1 (finding #6): lets `notifications list`/doctor tell an in-flight
   *  delivery apart from an abandoned lease left by a worker that crashed mid-delivery. */
  claimed_at: number | null;
}

const stmtCache = new WeakMap<DB, Map<string, Stmt>>();
function stmt(db: DB, sql: string): Stmt {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

export interface EnqueueInput {
  trigger: NotifyTrigger;
  channel: ChannelName;
  payload: NotificationPayload;
  /** `null` for a campaign digest (§2.9) - it aggregates across many messages, not one. */
  messageId: string | null;
  recipientId: string | null;
  eventType: 'open' | 'click' | 'reply' | 'reminder' | 'campaign_digest' | 'daily_digest';
  eventId: string;
  dedupeKey: string;
  atMs: number;
  campaignId?: string | null;
}

/** Inserts a pending notification row. Returns `null` (rather than throwing) when `dedupeKey`
 *  already exists - `INSERT OR IGNORE` against the `UNIQUE(dedupe_key)` index makes this atomic and
 *  race-safe (§2.5).
 *
 *  Finding #5: the row's primary key is `input.payload.id`, not a freshly minted id - the wire
 *  payload's own `id` field (and therefore `X-Openpost-Delivery` on the webhook channel) must
 *  always name the same notification the queue itself tracks, never a second, throwaway id that
 *  happens to have been generated alongside it. */
export function enqueue(db: DB, input: EnqueueInput): string | null {
  const id = input.payload.id;
  const result = stmt(
    db,
    `INSERT OR IGNORE INTO notifications
      (id, trigger, channel, message_id, recipient_id, event_type, event_id, dedupe_key,
       payload_json, status, attempts, next_attempt_at, last_error, created_at, sent_at, claimed_at,
       campaign_id)
     VALUES
      (@id, @trigger, @channel, @message_id, @recipient_id, @event_type, @event_id, @dedupe_key,
       @payload_json, 'pending', 0, @next_attempt_at, NULL, @created_at, NULL, NULL,
       @campaign_id)`,
  ).run({
    id,
    trigger: input.trigger,
    channel: input.channel,
    message_id: input.messageId,
    recipient_id: input.recipientId,
    event_type: input.eventType,
    event_id: input.eventId,
    dedupe_key: input.dedupeKey,
    payload_json: JSON.stringify(input.payload),
    next_attempt_at: input.atMs,
    created_at: input.atMs,
    campaign_id: input.campaignId ?? null,
  });
  return result.changes > 0 ? id : null;
}

// A claimed row's next_attempt_at is provisionally pushed forward by this lease so a second,
// concurrent worker tick can never claim the same row while the first is still delivering it - the
// real backoff (on failure) or a terminal status (on success/failure) supersedes this immediately
// afterwards via markSent/markRetry/markFailed.
const CLAIM_LEASE_MS = 60_000;

/** Claims up to `limit` due rows (either freshly `pending`, or a `sending` row whose lease has
 *  expired - Phase 2.1, finding #6), ordered by `next_attempt_at`, bumping `attempts` and marking
 *  the row `sending` with a fresh lease so two workers can never double-send the same row (§2.5). */
export function claimDue(db: DB, nowMs: number, limit: number): NotificationRow[] {
  return db.transaction(() => {
    const rows = stmt(
      db,
      `SELECT * FROM notifications WHERE status IN ('pending', 'sending') AND next_attempt_at <= ?
         ORDER BY next_attempt_at ASC LIMIT ?`,
    ).all(nowMs, limit) as NotificationRow[];
    for (const row of rows) {
      stmt(
        db,
        `UPDATE notifications SET status = 'sending', attempts = attempts + 1,
           next_attempt_at = @leaseUntil, claimed_at = @claimedAt WHERE id = @id`,
      ).run({ id: row.id, leaseUntil: nowMs + CLAIM_LEASE_MS, claimedAt: nowMs });
      row.attempts += 1;
      row.status = 'sending';
      row.claimed_at = nowMs;
    }
    return rows;
  })();
}

export function markSent(db: DB, id: string, atMs: number): void {
  stmt(
    db,
    `UPDATE notifications SET status = 'sent', sent_at = @atMs, claimed_at = NULL WHERE id = @id`,
  ).run({
    id,
    atMs,
  });
}

/** Moves a claimed row back to `pending` for its next scheduled attempt (§2.5). */
export function markRetry(db: DB, id: string, error: string, nextAttemptAt: number): void {
  stmt(
    db,
    `UPDATE notifications SET status = 'pending', last_error = @error,
       next_attempt_at = @nextAttemptAt, claimed_at = NULL WHERE id = @id`,
  ).run({ id, error, nextAttemptAt });
}

export function markFailed(db: DB, id: string, error: string, atMs: number): void {
  const row = stmt(db, 'SELECT * FROM notifications WHERE id = ?').get(id) as
    | NotificationRow
    | undefined;
  db.transaction(() => {
    stmt(
      db,
      `UPDATE notifications SET status = 'failed', last_error = @error, claimed_at = NULL WHERE id = @id`,
    ).run({
      id,
      error,
    });
    if (row) {
      stmt(
        db,
        `INSERT INTO notification_dead_letters
          (id, notification_id, recipient_id, channel, trigger, payload_json, attempts, last_error, failed_at)
         VALUES (@id, @notificationId, @recipientId, @channel, @trigger, @payloadJson, @attempts, @lastError, @failedAt)`,
      ).run({
        id: newId(),
        notificationId: row.id,
        recipientId: row.recipient_id,
        channel: row.channel,
        trigger: row.trigger,
        payloadJson: row.payload_json,
        attempts: row.attempts,
        lastError: error,
        failedAt: atMs,
      });
    }
  })();
}

export interface ListNotificationsOpts {
  status?: 'pending' | 'sending' | 'sent' | 'failed';
  limit?: number;
  since?: number;
}

export function listNotifications(db: DB, opts: ListNotificationsOpts = {}): NotificationRow[] {
  const limit = opts.limit ?? 50;
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit };
  if (opts.status !== undefined) {
    clauses.push('status = @status');
    params.status = opts.status;
  }
  if (opts.since !== undefined) {
    clauses.push('created_at >= @since');
    params.since = opts.since;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return stmt(
    db,
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT @limit`,
  ).all(params) as NotificationRow[];
}

/** Moves a `failed` row back to `pending` for immediate re-delivery on the next tick. Returns false
 *  when the id does not exist or is not currently `failed`. */
export function requeue(db: DB, id: string, atMs: number): boolean {
  const result = stmt(
    db,
    `UPDATE notifications SET status = 'pending', last_error = NULL, next_attempt_at = @atMs
       WHERE id = @id AND status = 'failed'`,
  ).run({ id, atMs });
  return result.changes > 0;
}

export function getNotification(db: DB, id: string): NotificationRow | null {
  const row = stmt(db, 'SELECT * FROM notifications WHERE id = ?').get(id) as
    | NotificationRow
    | undefined;
  return row ?? null;
}

export function listFailedIds(db: DB): string[] {
  const rows = stmt(db, `SELECT id FROM notifications WHERE status = 'failed'`).all() as Array<{
    id: string;
  }>;
  return rows.map((r) => r.id);
}

/**
 * Deletes `sent` rows older than `sentOlderThanMs` and dead letters older than
 * `deadLettersOlderThanMs` (§5.2/`notifications purge`).
 *
 * Finding #13 (documented, not fixed by a schema change): a deleted `sent` row also frees its
 * `dedupe_key` - `enqueue`'s `UNIQUE(dedupe_key)` no longer has anything to collide with, so if the
 * *same* (trigger, recipient, channel) - or (channel, click event id) for a click - somehow produced
 * another `TrackingEvent` after the purge (a bug elsewhere, a restored/replayed backup, a manually
 * re-inserted event row), a second, real delivery for something already notified once becomes
 * possible again. In normal operation this never happens: the recipient/message rows a purged
 * notification pointed at have long since been superseded by higher-numbered counters that no
 * longer produce that same historical trigger. Retaining a tombstone row (rather than deleting)
 * would close this gap entirely but was judged unnecessary complexity for Phase 2.1 given how
 * degenerate the trigger condition is; operators relying on strict single-delivery guarantees over
 * long retention windows should set `RETENTION_DAYS`/purge cadence generously rather than
 * aggressively.
 */
export function purgeNotifications(
  db: DB,
  opts: { sentOlderThanMs: number; deadLettersOlderThanMs: number },
): { sent: number; deadLetters: number } {
  const sent = (
    stmt(db, `SELECT COUNT(*) AS n FROM notifications WHERE status = 'sent' AND sent_at < ?`).get(
      opts.sentOlderThanMs,
    ) as { n: number }
  ).n;
  const deadLetters = (
    stmt(db, `SELECT COUNT(*) AS n FROM notification_dead_letters WHERE failed_at < ?`).get(
      opts.deadLettersOlderThanMs,
    ) as { n: number }
  ).n;
  db.transaction(() => {
    stmt(db, `DELETE FROM notifications WHERE status = 'sent' AND sent_at < ?`).run(
      opts.sentOlderThanMs,
    );
    stmt(db, `DELETE FROM notification_dead_letters WHERE failed_at < ?`).run(
      opts.deadLettersOlderThanMs,
    );
  })();
  return { sent, deadLetters };
}

/** `base * 2^(attempt-1)`, capped at 300s, multiplied by a `(0.8 + 0.4*rand())` jitter factor
 *  (§2.5). `attempt` is 1-based (the first retry after the initial send is `attempt=1`). */
export function backoffMs(attempt: number, baseMs: number, rand: () => number): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(raw, 300_000);
  const jitter = 0.8 + 0.4 * rand();
  return Math.round(capped * jitter);
}
