import type { DB, Stmt } from './index.js';
import { newId } from '../core/ids.js';

export type ReminderCondition = 'no_reply' | 'no_open' | 'always';
export type ReminderStatus = 'pending' | 'claimed' | 'fired' | 'skipped' | 'cancelled' | 'failed';
export type DraftStatus = 'created' | 'uncertain' | 'failed' | 'skipped';

export interface ReminderRow {
  id: string;
  message_id: string;
  recipient_id: string | null;
  condition: ReminderCondition;
  due_at: number;
  status: ReminderStatus;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  claimed_at: number | null;
  fired_at: number | null;
  cancelled_at: number | null;
  /** Phase 3.1 (L10): markSkipped/markFailed previously ignored their own `atMs` argument entirely
   *  - there was no column to put it in. */
  skipped_at: number | null;
  failed_at: number | null;
  cancel_reason: string | null;
  last_error: string | null;
  note: string | null;
  draft: number;
  draft_subject: string | null;
  draft_body_html: string | null;
  draft_attempted_at: number | null;
  draft_id: string | null;
  draft_thread_id: string | null;
  draft_status: DraftStatus | null;
  created_at: number;
  created_by: string;
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

export interface CreateReminderInput {
  messageId: string;
  recipientId: string | null;
  condition: ReminderCondition;
  dueAt: number;
  note?: string | null;
  draft?: boolean;
  draftSubject?: string | null;
  draftBodyHtml?: string | null;
  createdAt: number;
  createdBy?: string;
}

export function createReminder(db: DB, input: CreateReminderInput): ReminderRow {
  const row: ReminderRow = {
    id: newId(),
    message_id: input.messageId,
    recipient_id: input.recipientId,
    condition: input.condition,
    due_at: input.dueAt,
    status: 'pending',
    attempts: 0,
    lease_owner: null,
    lease_expires_at: null,
    claimed_at: null,
    fired_at: null,
    cancelled_at: null,
    skipped_at: null,
    failed_at: null,
    cancel_reason: null,
    last_error: null,
    note: input.note ?? null,
    draft: input.draft ? 1 : 0,
    draft_subject: input.draftSubject ?? null,
    draft_body_html: input.draftBodyHtml ?? null,
    draft_attempted_at: null,
    draft_id: null,
    draft_thread_id: null,
    draft_status: null,
    created_at: input.createdAt,
    created_by: input.createdBy ?? 'cli',
  };
  stmt(
    db,
    `INSERT INTO reminders
      (id, message_id, recipient_id, condition, due_at, status, attempts, lease_owner,
       lease_expires_at, claimed_at, fired_at, cancelled_at, skipped_at, failed_at, cancel_reason,
       last_error, note, draft, draft_subject, draft_body_html, draft_attempted_at, draft_id,
       draft_thread_id, draft_status, created_at, created_by)
     VALUES
      (@id, @message_id, @recipient_id, @condition, @due_at, @status, @attempts, @lease_owner,
       @lease_expires_at, @claimed_at, @fired_at, @cancelled_at, @skipped_at, @failed_at,
       @cancel_reason, @last_error, @note, @draft, @draft_subject, @draft_body_html,
       @draft_attempted_at, @draft_id, @draft_thread_id, @draft_status, @created_at, @created_by)`,
  ).run(row);
  return row;
}

export function getReminder(db: DB, id: string): ReminderRow | null {
  const row = stmt(db, 'SELECT * FROM reminders WHERE id = ?').get(id) as ReminderRow | undefined;
  return row ?? null;
}

export interface ListRemindersOpts {
  status?: ReminderStatus | 'all';
  messageId?: string;
  dueBefore?: number;
  limit?: number;
}

export function listReminders(db: DB, opts: ListRemindersOpts = {}): ReminderRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.status !== undefined && opts.status !== 'all') {
    clauses.push('status = @status');
    params.status = opts.status;
  }
  if (opts.messageId !== undefined) {
    clauses.push('message_id = @messageId');
    params.messageId = opts.messageId;
  }
  if (opts.dueBefore !== undefined) {
    clauses.push('due_at <= @dueBefore');
    params.dueBefore = opts.dueBefore;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return stmt(db, `SELECT * FROM reminders ${where} ORDER BY due_at ASC LIMIT @limit`).all(
    params,
  ) as ReminderRow[];
}

/** Cancels a single reminder if it is still in a non-terminal state. Returns whether it changed. */
export function cancelReminder(db: DB, id: string, atMs: number, reason: string): boolean {
  const result = stmt(
    db,
    `UPDATE reminders SET status = 'cancelled', cancelled_at = @atMs, cancel_reason = @reason
       WHERE id = @id AND status IN ('pending','claimed')`,
  ).run({ id, atMs, reason });
  return result.changes > 0;
}

export function cancelAllPending(db: DB, atMs: number, reason: string): number {
  const result = stmt(
    db,
    `UPDATE reminders SET status = 'cancelled', cancelled_at = @atMs, cancel_reason = @reason
       WHERE status = 'pending'`,
  ).run({ atMs, reason });
  return result.changes;
}

export function cancelPendingForMessage(db: DB, messageId: string, atMs: number, reason: string): number {
  const result = stmt(
    db,
    `UPDATE reminders SET status = 'cancelled', cancelled_at = @atMs, cancel_reason = @reason
       WHERE message_id = @messageId AND status = 'pending'`,
  ).run({ messageId, atMs, reason });
  return result.changes;
}

/** Cancels every pending (or claimed-with-expired-lease) reminder of the given `conditions` for one
 *  recipient - used by reply detection (§4.3) to cancel `no_reply` reminders without touching
 *  `no_open`/`always`.
 *
 *  Phase 3.1 (M8): the `claimed` branch used to match ANY claimed row regardless of its lease -
 *  including one another process currently owns and is actively mid-fire on (lease not yet
 *  expired). Cancelling out from under a live claim raced `processClaimed`'s own `notifyEnqueue`-
 *  then-`markFired` sequence: the notification had already been enqueued by the time this ran, so
 *  the reminder ended up `cancelled` in the database while still having notified. Only a claimed
 *  row whose lease has actually expired (i.e. `selectDue`/`claim` would treat it as up for grabs
 *  again anyway) is fair game here. */
export function cancelPendingForRecipient(
  db: DB,
  recipientId: string,
  atMs: number,
  reason: string,
  conditions: ReminderCondition[],
): number {
  if (conditions.length === 0) return 0;
  const placeholders = conditions.map((_, i) => `@c${i}`).join(',');
  const params: Record<string, unknown> = { recipientId, atMs, reason };
  conditions.forEach((c, i) => {
    params[`c${i}`] = c;
  });
  const result = stmt(
    db,
    `UPDATE reminders SET status = 'cancelled', cancelled_at = @atMs, cancel_reason = @reason
       WHERE recipient_id = @recipientId
         AND condition IN (${placeholders})
         AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= @atMs))`,
  ).run(params);
  return result.changes;
}

/** §3.3: due when `pending`, or `claimed` with an expired lease. */
export function selectDue(db: DB, nowMs: number, limit: number): ReminderRow[] {
  return stmt(
    db,
    `SELECT * FROM reminders
      WHERE due_at <= @now
        AND (status = 'pending' OR (status = 'claimed' AND lease_expires_at <= @now))
      ORDER BY due_at ASC LIMIT @limit`,
  ).all({ now: nowMs, limit }) as ReminderRow[];
}

/** Single conditional UPDATE under `BEGIN IMMEDIATE` - a real compare-and-swap on SQLite's one
 *  writer (§3.3). `result.changes === 1` means this call owns the reminder; the caller re-reads the
 *  row. Returns `null` when someone else owns it, it is terminal, or it is out of attempts. */
export function claim(
  db: DB,
  id: string,
  owner: string,
  nowMs: number,
  opts: { leaseMs: number; maxAttempts: number },
): ReminderRow | null {
  // A single conditional UPDATE under `BEGIN IMMEDIATE` (better-sqlite3's `.immediate()` variant of
  // `db.transaction()`) is a real compare-and-swap on SQLite's one writer: the `WHERE` clause
  // re-checks everything `selectDue` assumed, so the check and the mutation cannot be separated by
  // another process racing the same row (§3.3).
  const tx = db.transaction((): ReminderRow | null => {
    const result = stmt(
      db,
      `UPDATE reminders
          SET status = 'claimed', lease_owner = @owner, lease_expires_at = @leaseUntil,
              claimed_at = @now, attempts = attempts + 1
        WHERE id = @id
          AND due_at <= @now
          AND (status = 'pending'
               OR (status = 'claimed' AND lease_expires_at <= @now AND attempts < @maxAttempts))`,
    ).run({ id, owner, now: nowMs, leaseUntil: nowMs + opts.leaseMs, maxAttempts: opts.maxAttempts });
    if (result.changes !== 1) return null;
    return getReminder(db, id);
  });
  return tx.immediate();
}

/** Sweeps `claimed` rows whose lease has expired and are already out of attempts to `failed` -
 *  otherwise such a row would sit forever, neither firing nor visibly failed (§3.3). */
export function sweepExhaustedLeases(db: DB, nowMs: number, maxAttempts: number): number {
  const result = stmt(
    db,
    // L10: this used to leave lease_owner/lease_expires_at set on the now-`failed` row - every
    // other terminal-state writer (markFired/markSkipped/markFailed) clears them; a stale non-null
    // lease on a row that will never be claimed again is misleading in the dashboard/CLI listing.
    `UPDATE reminders SET status = 'failed', failed_at = @now, last_error = @error,
        lease_owner = NULL, lease_expires_at = NULL
       WHERE status = 'claimed' AND lease_expires_at <= @now AND attempts >= @maxAttempts`,
  ).run({ now: nowMs, maxAttempts, error: `lease expired after ${maxAttempts} attempts` });
  return result.changes;
}

/** Only succeeds for the reminder's *current* `lease_owner` - a stale owner's write (e.g. a
 *  process whose lease already expired and was re-claimed by someone else) is a safe no-op. */
export function markFired(db: DB, id: string, owner: string, atMs: number): boolean {
  const result = stmt(
    db,
    `UPDATE reminders SET status = 'fired', fired_at = @atMs, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = @id AND lease_owner = @owner AND status = 'claimed'`,
  ).run({ id, owner, atMs });
  return result.changes > 0;
}

export function markSkipped(db: DB, id: string, owner: string, atMs: number, reason: string): boolean {
  const result = stmt(
    db,
    `UPDATE reminders SET status = 'skipped', skipped_at = @atMs, cancel_reason = @reason, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = @id AND lease_owner = @owner AND status = 'claimed'`,
  ).run({ id, owner, atMs, reason });
  return result.changes > 0;
}

export function markFailed(db: DB, id: string, owner: string, atMs: number, error: string): boolean {
  const result = stmt(
    db,
    `UPDATE reminders SET status = 'failed', failed_at = @atMs, last_error = @error, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = @id AND lease_owner = @owner AND status = 'claimed'`,
  ).run({ id, owner, atMs, error });
  return result.changes > 0;
}

/** `message_deleted` cancellation - the message/recipient vanished under a still-pending reminder
 *  (§3.4 step 1). Not owner-gated: this can run even before the row was ever claimed. */
export function cancelForMissingTarget(db: DB, id: string, atMs: number): void {
  stmt(
    db,
    `UPDATE reminders SET status = 'cancelled', cancelled_at = @atMs, cancel_reason = 'message_deleted'
       WHERE id = @id`,
  ).run({ id, atMs });
}

/** Written in its own committed transaction, *before* the Gmail draft-create call - the at-most-
 *  once discipline §3.5 depends on (a crash between this and `recordDraft` is recoverable by
 *  searching for the draft rather than blindly re-creating it). */
export function noteDraftAttempt(db: DB, id: string, atMs: number): void {
  stmt(db, `UPDATE reminders SET draft_attempted_at = @atMs WHERE id = @id`).run({ id, atMs });
}

export function recordDraft(
  db: DB,
  id: string,
  d: { draftId: string | null; threadId: string | null; status: DraftStatus },
): void {
  stmt(
    db,
    `UPDATE reminders SET draft_id = @draftId, draft_thread_id = @threadId, draft_status = @status WHERE id = @id`,
  ).run({ id, draftId: d.draftId, threadId: d.threadId, status: d.status });
}
