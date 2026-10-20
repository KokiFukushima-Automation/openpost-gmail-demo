import type { DB } from './index.js';
import { newId } from '../core/ids.js';

/** docs/09_phase5_spec.md §4.3: rows describing the OPERATOR's own devices, never a recipient -
 *  `openpost forget` deliberately never touches this table (test asserts that). */
export interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string | null;
  ua_family: string | null;
  device_type: string | null;
  created_at: number;
  last_ok_at: number | null;
  last_error: string | null;
  failure_count: number;
  disabled_at: number | null;
  disabled_reason: string | null;
}

export type PushDisabledReason = 'gone_404' | 'gone_410' | 'manual' | 'expired';

export interface UpsertSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  label?: string | null;
  uaFamily?: string | null;
  deviceType?: string | null;
  createdAt: number;
}

/** Keyed on `endpoint` - re-subscribing the same device never duplicates and always clears
 *  `disabled_at`/`failure_count` (§4.3). */
export function upsertSubscription(db: DB, input: UpsertSubscriptionInput): PushSubscriptionRow {
  const id = newId();
  db.prepare(
    `INSERT INTO push_subscriptions
      (id, endpoint, p256dh, auth, label, ua_family, device_type, created_at, last_ok_at, last_error,
       failure_count, disabled_at, disabled_reason)
     VALUES (@id, @endpoint, @p256dh, @auth, @label, @ua_family, @device_type, @created_at, NULL, NULL, 0, NULL, NULL)
     ON CONFLICT(endpoint) DO UPDATE SET
       p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label,
       ua_family = excluded.ua_family, device_type = excluded.device_type,
       failure_count = 0, disabled_at = NULL, disabled_reason = NULL, last_error = NULL`,
  ).run({
    id,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    label: input.label ?? null,
    ua_family: input.uaFamily ?? null,
    device_type: input.deviceType ?? null,
    created_at: input.createdAt,
  });
  return getSubscriptionByEndpoint(db, input.endpoint) as PushSubscriptionRow;
}

export function getSubscriptionByEndpoint(db: DB, endpoint: string): PushSubscriptionRow | null {
  const row = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
    | PushSubscriptionRow
    | undefined;
  return row ?? null;
}

export function getSubscription(db: DB, id: string): PushSubscriptionRow | null {
  const row = db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as PushSubscriptionRow | undefined;
  return row ?? null;
}

export function listActiveSubscriptions(db: DB): PushSubscriptionRow[] {
  return db.prepare('SELECT * FROM push_subscriptions WHERE disabled_at IS NULL ORDER BY created_at ASC').all() as PushSubscriptionRow[];
}

export function listAllSubscriptions(db: DB): PushSubscriptionRow[] {
  return db.prepare('SELECT * FROM push_subscriptions ORDER BY created_at ASC').all() as PushSubscriptionRow[];
}

export function countActiveSubscriptions(db: DB): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NULL').get() as { n: number };
  return row.n;
}

export function markSubscriptionOk(db: DB, id: string, atMs: number): void {
  db.prepare('UPDATE push_subscriptions SET last_ok_at = @atMs, failure_count = 0, last_error = NULL WHERE id = @id').run({
    id,
    atMs,
  });
}

export function recordSubscriptionFailure(db: DB, id: string, error: string, atMs: number, maxFailures: number): void {
  const row = getSubscription(db, id);
  if (!row) return;
  const failureCount = row.failure_count + 1;
  if (failureCount >= maxFailures) {
    db.prepare(
      `UPDATE push_subscriptions SET failure_count = @fc, last_error = @error, disabled_at = @atMs, disabled_reason = 'expired' WHERE id = @id`,
    ).run({ id, fc: failureCount, error, atMs });
    return;
  }
  db.prepare('UPDATE push_subscriptions SET failure_count = @fc, last_error = @error WHERE id = @id').run({
    id,
    fc: failureCount,
    error,
  });
}

export function disableSubscription(db: DB, id: string, reason: PushDisabledReason, atMs: number): void {
  db.prepare('UPDATE push_subscriptions SET disabled_at = @atMs, disabled_reason = @reason WHERE id = @id').run({
    id,
    atMs,
    reason,
  });
}

export function deleteSubscription(db: DB, endpoint: string): boolean {
  const result = db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  return result.changes > 0;
}

export function deleteSubscriptionById(db: DB, id: string): boolean {
  const result = db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(id);
  return result.changes > 0;
}

/** `pushsubscriptionchange` (§2.5 step 5): the SW re-subscribes with the same `applicationServerKey`
 *  and asks us to swap rather than duplicate. */
export function swapSubscription(db: DB, oldEndpoint: string, next: UpsertSubscriptionInput): PushSubscriptionRow {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = @old AND endpoint <> @next').run({
    old: oldEndpoint,
    next: next.endpoint,
  });
  return upsertSubscription(db, next);
}

/** `openpost prune`: delete subscriptions disabled longer than `retentionDays`. */
export function pruneDisabledSubscriptions(db: DB, olderThanMs: number): number {
  const result = db.prepare('DELETE FROM push_subscriptions WHERE disabled_at IS NOT NULL AND disabled_at < ?').run(olderThanMs);
  return result.changes;
}
