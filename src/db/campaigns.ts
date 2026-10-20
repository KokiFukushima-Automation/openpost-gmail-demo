import type { DB, Stmt } from './index.js';
import { newId } from '../core/ids.js';

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
export type CampaignRowStatus = 'pending' | 'claimed' | 'sent' | 'skipped' | 'failed';

export interface CampaignRow {
  id: string;
  name: string;
  account_id: string;
  status: CampaignStatus;
  subject_template: string;
  subject_variants_json: string | null;
  body_html_template: string;
  body_text_template: string | null;
  allow_raw: number;
  from_email: string;
  from_name: string | null;
  transport: string;
  track: number;
  track_clicks: number;
  dry_run: number;
  rate_per_minute: number;
  jitter_ms: number;
  daily_cap: number;
  email_column: string;
  columns_json: string;
  csv_path: string | null;
  csv_sha256: string | null;
  total_rows: number;
  digest_window_minutes: number;
  digest_next_at: number | null;
  digest_from: number | null;
  /** Finding #5: set (while `status` stays 'running') when the rolling-24h daily cap is reached -
   *  the timestamp the cap is expected to drain by, so the dashboard/CLI can show it and
   *  `createCampaignsJob` (which only ever selects `status = 'running'`) keeps re-checking the
   *  campaign every tick instead of it being stranded `paused` forever. `null` when not capped. */
  capped_until: number | null;
  created_at: number;
  started_at: number | null;
  paused_at: number | null;
  cancelled_at: number | null;
  finished_at: number | null;
  last_error: string | null;
  created_by: string;
}

export interface CampaignRowRow {
  id: string;
  campaign_id: string;
  row_index: number;
  email: string;
  vars_json: string;
  variant: string;
  status: CampaignRowStatus;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: number | null;
  claimed_at: number | null;
  submit_started_at: number | null;
  message_id: string | null;
  recipient_id: string | null;
  skip_reason: string | null;
  last_error: string | null;
  sent_at: number | null;
  created_at: number;
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

export interface CreateCampaignInput {
  name: string;
  accountId: string;
  subjectTemplate: string;
  subjectVariantsJson?: string | null;
  bodyHtmlTemplate: string;
  bodyTextTemplate?: string | null;
  allowRaw?: boolean;
  fromEmail: string;
  fromName?: string | null;
  transport: string;
  track?: boolean;
  trackClicks?: boolean;
  dryRun?: boolean;
  ratePerMinute: number;
  jitterMs: number;
  dailyCap: number;
  emailColumn: string;
  columnsJson: string;
  csvPath?: string | null;
  csvSha256?: string | null;
  digestWindowMinutes?: number;
  createdAt: number;
  createdBy?: string;
}

export function createCampaign(db: DB, input: CreateCampaignInput): CampaignRow {
  const row: CampaignRow = {
    id: newId(),
    name: input.name,
    account_id: input.accountId,
    status: 'draft',
    subject_template: input.subjectTemplate,
    subject_variants_json: input.subjectVariantsJson ?? null,
    body_html_template: input.bodyHtmlTemplate,
    body_text_template: input.bodyTextTemplate ?? null,
    allow_raw: input.allowRaw ? 1 : 0,
    from_email: input.fromEmail,
    from_name: input.fromName ?? null,
    transport: input.transport,
    track: input.track === false ? 0 : 1,
    track_clicks: input.trackClicks === false ? 0 : 1,
    dry_run: input.dryRun ? 1 : 0,
    rate_per_minute: input.ratePerMinute,
    jitter_ms: input.jitterMs,
    daily_cap: input.dailyCap,
    email_column: input.emailColumn,
    columns_json: input.columnsJson,
    csv_path: input.csvPath ?? null,
    csv_sha256: input.csvSha256 ?? null,
    total_rows: 0,
    digest_window_minutes: input.digestWindowMinutes ?? 60,
    digest_next_at: null,
    digest_from: null,
    capped_until: null,
    created_at: input.createdAt,
    started_at: null,
    paused_at: null,
    cancelled_at: null,
    finished_at: null,
    last_error: null,
    created_by: input.createdBy ?? 'cli',
  };
  stmt(
    db,
    `INSERT INTO campaigns
      (id, name, account_id, status, subject_template, subject_variants_json, body_html_template,
       body_text_template, allow_raw, from_email, from_name, transport, track, track_clicks,
       dry_run, rate_per_minute, jitter_ms, daily_cap, email_column, columns_json, csv_path,
       csv_sha256, total_rows, digest_window_minutes, digest_next_at, digest_from, created_at,
       started_at, paused_at, cancelled_at, finished_at, last_error, created_by)
     VALUES
      (@id, @name, @account_id, @status, @subject_template, @subject_variants_json, @body_html_template,
       @body_text_template, @allow_raw, @from_email, @from_name, @transport, @track, @track_clicks,
       @dry_run, @rate_per_minute, @jitter_ms, @daily_cap, @email_column, @columns_json, @csv_path,
       @csv_sha256, @total_rows, @digest_window_minutes, @digest_next_at, @digest_from, @created_at,
       @started_at, @paused_at, @cancelled_at, @finished_at, @last_error, @created_by)`,
  ).run(row);
  return row;
}

export function getCampaign(db: DB, id: string): CampaignRow | null {
  const row = stmt(db, 'SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
  return row ?? null;
}

export interface ListCampaignsOpts {
  status?: CampaignStatus | 'all';
  limit?: number;
}

export function listCampaigns(db: DB, opts: ListCampaignsOpts = {}): CampaignRow[] {
  const clauses: string[] = [];
  const params: Record<string, unknown> = { limit: opts.limit ?? 200 };
  if (opts.status !== undefined && opts.status !== 'all') {
    clauses.push('status = @status');
    params.status = opts.status;
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  return stmt(db, `SELECT * FROM campaigns ${where} ORDER BY created_at DESC LIMIT @limit`).all(params) as CampaignRow[];
}

export interface InsertRowInput {
  rowIndex: number;
  email: string;
  varsJson: string;
  variant: string;
  status: CampaignRowStatus;
  skipReason?: string | null | undefined;
}

/** Inserts every row for a campaign in one transaction and updates `total_rows`. */
export function insertRows(db: DB, campaignId: string, rows: InsertRowInput[], nowMs: number): number {
  const insert = stmt(
    db,
    `INSERT INTO campaign_rows
      (id, campaign_id, row_index, email, vars_json, variant, status, attempts, lease_owner,
       lease_expires_at, claimed_at, submit_started_at, message_id, recipient_id, skip_reason,
       last_error, sent_at, created_at)
     VALUES
      (@id, @campaign_id, @row_index, @email, @vars_json, @variant, @status, 0, NULL,
       NULL, NULL, NULL, NULL, NULL, @skip_reason,
       NULL, NULL, @created_at)`,
  );
  const tx = db.transaction((items: InsertRowInput[]): number => {
    for (const item of items) {
      insert.run({
        id: newId(),
        campaign_id: campaignId,
        row_index: item.rowIndex,
        email: item.email,
        vars_json: item.varsJson,
        variant: item.variant,
        status: item.status,
        skip_reason: item.skipReason ?? null,
        created_at: nowMs,
      });
    }
    stmt(db, 'UPDATE campaigns SET total_rows = total_rows + @n WHERE id = @id').run({
      n: items.length,
      id: campaignId,
    });
    return items.length;
  });
  return tx(rows);
}

export function listRows(
  db: DB,
  campaignId: string,
  opts: { status?: CampaignRowStatus | 'all'; limit?: number } = {},
): CampaignRowRow[] {
  const clauses = ['campaign_id = @campaignId'];
  const params: Record<string, unknown> = { campaignId, limit: opts.limit ?? 1000 };
  if (opts.status !== undefined && opts.status !== 'all') {
    clauses.push('status = @status');
    params.status = opts.status;
  }
  return stmt(
    db,
    `SELECT * FROM campaign_rows WHERE ${clauses.join(' AND ')} ORDER BY row_index ASC LIMIT @limit`,
  ).all(params) as CampaignRowRow[];
}

export function getRow(db: DB, id: string): CampaignRowRow | null {
  const row = stmt(db, 'SELECT * FROM campaign_rows WHERE id = ?').get(id) as CampaignRowRow | undefined;
  return row ?? null;
}

/** Single conditional UPDATE under `BEGIN IMMEDIATE` - a compare-and-swap identical in shape to
 *  `src/db/reminders.ts`'s `claim`. A row is claimable when `pending`, or `claimed` with an
 *  expired lease and `submit_started_at IS NULL` (a lease that expired AFTER submit began is
 *  never silently reclaimed - that is `recoverCampaign`'s job, and it marks the row `failed`
 *  instead). */
export function claimNextRow(
  db: DB,
  campaignId: string,
  owner: string,
  nowMs: number,
  leaseMs: number,
  maxAttempts: number,
): CampaignRowRow | null {
  const tx = db.transaction((): CampaignRowRow | null => {
    const candidate = stmt(
      db,
      `SELECT id FROM campaign_rows
        WHERE campaign_id = @campaignId
          AND (status = 'pending'
               OR (status = 'claimed' AND lease_expires_at <= @now AND submit_started_at IS NULL AND attempts < @maxAttempts))
        ORDER BY row_index ASC LIMIT 1`,
    ).get({ campaignId, now: nowMs, maxAttempts }) as { id: string } | undefined;
    if (!candidate) return null;
    const result = stmt(
      db,
      `UPDATE campaign_rows
          SET status = 'claimed', lease_owner = @owner, lease_expires_at = @leaseUntil,
              claimed_at = @now, attempts = attempts + 1
        WHERE id = @id
          AND (status = 'pending'
               OR (status = 'claimed' AND lease_expires_at <= @now AND submit_started_at IS NULL))`,
    ).run({ id: candidate.id, owner, now: nowMs, leaseUntil: nowMs + leaseMs });
    if (result.changes !== 1) return null;
    return getRow(db, candidate.id);
  });
  return tx.immediate();
}

/** Journals `submit_started_at` BEFORE the transport call - the at-most-once discipline: a process
 *  that dies after this point leaves the row `claimed` with `submit_started_at` set, which
 *  `recoverCampaign` turns into `failed`/`indeterminate:` rather than silently re-sending. */
export function beginRowSubmit(db: DB, rowId: string, owner: string, nowMs: number): boolean {
  const result = stmt(
    db,
    `UPDATE campaign_rows SET submit_started_at = @now
       WHERE id = @id AND lease_owner = @owner AND status = 'claimed' AND submit_started_at IS NULL`,
  ).run({ id: rowId, owner, now: nowMs });
  return result.changes > 0;
}

export function markRowSent(
  db: DB,
  rowId: string,
  owner: string,
  input: { messageId: string; recipientId: string; sentAt: number },
): boolean {
  const result = stmt(
    db,
    `UPDATE campaign_rows SET status = 'sent', message_id = @messageId, recipient_id = @recipientId,
        sent_at = @sentAt, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = @id AND lease_owner = @owner AND status = 'claimed'`,
  ).run({ id: rowId, owner, messageId: input.messageId, recipientId: input.recipientId, sentAt: input.sentAt });
  return result.changes > 0;
}

/** Skip is terminal and journalled before submit began - never consumes an attempt against
 *  `CAMPAIGN_MAX_ATTEMPTS` retry logic, since nothing was ever sent. */
export function markRowSkipped(db: DB, rowId: string, owner: string, reason: string): boolean {
  const result = stmt(
    db,
    `UPDATE campaign_rows SET status = 'skipped', skip_reason = @reason, lease_owner = NULL, lease_expires_at = NULL
       WHERE id = @id AND lease_owner = @owner AND status = 'claimed'`,
  ).run({ id: rowId, owner, reason });
  return result.changes > 0;
}

/** A CAUGHT transport error - the process is still alive and knows the call did not (or must be
 *  treated as if it did not) reach a state worth retrying blindly, unlike an actual crash (which
 *  `recoverExpiredLeases`/`markRowIndeterminate` handle separately). Safe to requeue as `pending`
 *  up to `maxAttempts` (clearing `submit_started_at` so the retry's own `beginRowSubmit` can
 *  journal again), else terminal `failed`. */
export function markRowFailed(
  db: DB,
  rowId: string,
  owner: string,
  error: string,
  opts: { retryable: boolean; maxAttempts: number },
): boolean {
  const row = getRow(db, rowId);
  if (!row) return false;
  const nextStatus = opts.retryable && row.attempts < opts.maxAttempts ? 'pending' : 'failed';
  const result = stmt(
    db,
    `UPDATE campaign_rows SET status = @nextStatus, last_error = @error, lease_owner = NULL,
        lease_expires_at = NULL, submit_started_at = NULL
       WHERE id = @id AND lease_owner = @owner AND status = 'claimed'`,
  ).run({ id: rowId, owner, error, nextStatus });
  return result.changes > 0;
}

/** Terminal, never retried automatically - a process died strictly after `submit_started_at` was
 *  journalled, so the transport call MAY have succeeded. Not owner-gated: `recoverCampaign` calls
 *  this for a row whose owner is long gone. */
export function markRowIndeterminate(db: DB, rowId: string): boolean {
  const result = stmt(
    db,
    `UPDATE campaign_rows SET status = 'failed',
        last_error = 'indeterminate: process exited after submit began', lease_owner = NULL, lease_expires_at = NULL
       WHERE id = @id AND status = 'claimed' AND submit_started_at IS NOT NULL`,
  ).run({ id: rowId });
  return result.changes > 0;
}

/** `campaign resume --retry-indeterminate`: requeue every `failed` row whose `last_error` starts
 *  `indeterminate:` back to `pending`, resetting `attempts` so it gets the full retry budget. */
export function requeueIndeterminate(db: DB, campaignId: string): number {
  const result = stmt(
    db,
    `UPDATE campaign_rows SET status = 'pending', attempts = 0, last_error = NULL
       WHERE campaign_id = @campaignId AND status = 'failed' AND last_error LIKE 'indeterminate:%'`,
  ).run({ campaignId });
  return result.changes;
}

export function countIndeterminate(db: DB, campaignId: string): number {
  const row = stmt(
    db,
    `SELECT COUNT(*) AS n FROM campaign_rows WHERE campaign_id = @campaignId AND status = 'failed' AND last_error LIKE 'indeterminate:%'`,
  ).get({ campaignId }) as { n: number };
  return row.n;
}

/** Requeues expired leases: pre-submit -> back to `pending`; post-submit -> terminal
 *  `indeterminate` failure. Runs at the start of every `runCampaignOnce` and at `serve` start. */
export function recoverExpiredLeases(db: DB, campaignId: string, nowMs: number): { requeued: number; indeterminate: number } {
  const tx = db.transaction((): { requeued: number; indeterminate: number } => {
    const requeue = stmt(
      db,
      `UPDATE campaign_rows SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL, claimed_at = NULL
         WHERE campaign_id = @campaignId AND status = 'claimed' AND lease_expires_at <= @now AND submit_started_at IS NULL`,
    ).run({ campaignId, now: nowMs });

    const stuck = stmt(
      db,
      `SELECT id FROM campaign_rows WHERE campaign_id = @campaignId AND status = 'claimed'
          AND lease_expires_at <= @now AND submit_started_at IS NOT NULL`,
    ).all({ campaignId, now: nowMs }) as Array<{ id: string }>;
    let indeterminate = 0;
    for (const row of stuck) {
      if (markRowIndeterminate(db, row.id)) indeterminate += 1;
    }
    return { requeued: requeue.changes, indeterminate };
  });
  return tx.immediate();
}

/** Finding #6: `campaign resume`/`campaign cancel` (CLI) and the dashboard's own action route
 *  called `setCampaignStatus` unconditionally, with no check on the campaign's CURRENT status - a
 *  cancelled (terminal) campaign could be "resumed" straight back to running, and `resume` on an
 *  unknown campaign id silently printed "resumed" (the boolean `setCampaignStatus` returns was
 *  ignored). This is the one gate every caller that changes a campaign's status by name (rather than
 *  the runner's own internal draft->running auto-start, which already checks) should go through. */
export type CampaignTransitionTarget = 'running' | 'paused' | 'cancelled';

export type CampaignTransitionResult =
  | { ok: true }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'invalid_transition'; from: CampaignStatus };

const ALLOWED_TRANSITIONS: Record<CampaignTransitionTarget, CampaignStatus[]> = {
  // §2.7/finding #6: a paused campaign resumes; a still-draft one (never actually started) may also
  // be started directly via `resume` - draft->running is otherwise only reachable through `run`.
  running: ['paused', 'draft'],
  paused: ['running'],
  // Cancel is terminal, but reachable from anything that isn't ALREADY terminal.
  cancelled: ['draft', 'running', 'paused'],
};

export function transitionCampaignStatus(
  db: DB,
  id: string,
  to: CampaignTransitionTarget,
  atMs: number,
  reason?: string | null,
): CampaignTransitionResult {
  const current = getCampaign(db, id);
  if (!current) return { ok: false, error: 'not_found' };
  if (!ALLOWED_TRANSITIONS[to].includes(current.status)) {
    return { ok: false, error: 'invalid_transition', from: current.status };
  }
  setCampaignStatus(db, id, to, atMs, reason ?? null);
  return { ok: true };
}

export function setCampaignStatus(db: DB, id: string, status: CampaignStatus, atMs: number, reason?: string | null): boolean {
  const timestampCol =
    status === 'running'
      ? 'started_at'
      : status === 'paused'
        ? 'paused_at'
        : status === 'cancelled'
          ? 'cancelled_at'
          : status === 'completed' || status === 'failed'
            ? 'finished_at'
            : null;
  const setClause = timestampCol ? `, ${timestampCol} = @atMs` : '';
  const result = stmt(
    db,
    // capped_until is only meaningful while status = 'running' (finding #5); clear it on any other
    // transition (pause/cancel/complete/fail) so a stale value never lingers on a non-running row.
    `UPDATE campaigns SET status = @status, last_error = @reason,
        capped_until = CASE WHEN @status = 'running' THEN capped_until ELSE NULL END${setClause}
      WHERE id = @id`,
  ).run({ id, status, reason: reason ?? null, atMs });
  return result.changes > 0;
}

export function campaignCounts(
  db: DB,
  id: string,
): { pending: number; claimed: number; sent: number; skipped: number; failed: number } {
  const rows = stmt(db, 'SELECT status, COUNT(*) AS n FROM campaign_rows WHERE campaign_id = ? GROUP BY status').all(id) as Array<{
    status: CampaignRowStatus;
    n: number;
  }>;
  const counts = { pending: 0, claimed: 0, sent: 0, skipped: 0, failed: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

/** Rolling-24h sent-message count for one account, used against `CAMPAIGN_DAILY_CAP`. */
export function sentInLastDay(db: DB, accountId: string, nowMs: number): number {
  const row = stmt(
    db,
    `SELECT COUNT(*) AS n FROM campaign_rows cr
       JOIN campaigns c ON c.id = cr.campaign_id
      WHERE c.account_id = @accountId AND cr.status = 'sent' AND cr.sent_at >= @since`,
  ).get({ accountId, since: nowMs - 24 * 60 * 60 * 1000 }) as { n: number };
  return row.n;
}

/** Finding #5: the earliest `sent_at` currently inside the rolling 24h window - once it ages out,
 *  `sentInLastDay` necessarily drops (that send no longer counts), so `earliestSentAt + 24h` is the
 *  soonest a capped campaign's count can possibly fall back under `daily_cap`. `null` when nothing
 *  has been sent in the window at all (should not happen right after hitting a cap, but a caller
 *  should not assume it can't). */
export function earliestSentInLastDay(db: DB, accountId: string, nowMs: number): number | null {
  const row = stmt(
    db,
    `SELECT MIN(cr.sent_at) AS earliest FROM campaign_rows cr
       JOIN campaigns c ON c.id = cr.campaign_id
      WHERE c.account_id = @accountId AND cr.status = 'sent' AND cr.sent_at >= @since`,
  ).get({ accountId, since: nowMs - 24 * 60 * 60 * 1000 }) as { earliest: number | null };
  return row.earliest;
}

/** Finding #5: records that a campaign has hit `CAMPAIGN_DAILY_CAP` WITHOUT changing `status` away
 *  from 'running' - `createCampaignsJob` only ever drains `status = 'running'` campaigns, so setting
 *  status to 'paused' here (as before this fix) stranded a capped campaign forever; an operator had
 *  to run `campaign resume` by hand even though the spec says the cap should drain on its own.
 *  `cappedUntil` is purely informational (dashboard/CLI display) - the actual gate every tick
 *  re-evaluates is `sentInLastDay(...) >= daily_cap` in `runCampaignOnce` itself. */
export function setCampaignCapped(db: DB, id: string, cappedUntil: number | null, atMs: number): void {
  stmt(
    db,
    `UPDATE campaigns SET capped_until = @cappedUntil, last_error = @reason WHERE id = @id AND status = 'running'`,
  ).run({ id, cappedUntil, reason: cappedUntil !== null ? `daily cap reached; expected to drain by ${new Date(cappedUntil).toISOString()}` : `daily cap reached at ${new Date(atMs).toISOString()}` });
}

/** Clears a previously-set `capped_until` once the rolling window has drained enough that the next
 *  claim can proceed - a no-op if the campaign was never capped. */
export function clearCampaignCap(db: DB, id: string): void {
  stmt(db, `UPDATE campaigns SET capped_until = NULL WHERE id = @id AND capped_until IS NOT NULL`).run({ id });
}

/** docs/08_phase4_spec.md §2.10: redacts every campaign_rows entry for an erased address rather
 *  than deleting it, so campaign counts stay truthful. Returns the number of rows touched.
 *
 *  Finding #3 (docs/reports/phase4_review.md): redacting to the fixed literal '(erased)' collided
 *  with idx_campaign_rows_addr's UNIQUE(campaign_id, email) WHERE status <> 'skipped' the second
 *  time two non-skipped rows in the same campaign were erased, aborting the whole `forget`
 *  transaction with a UNIQUE constraint violation. Each row is redacted to its own
 *  '(erased):<row id>' sentinel instead - unique by construction (campaign_rows.id is a primary
 *  key), so no two redacted rows can ever collide regardless of how many share a campaign. */
export function redactCampaignRowsForAddress(db: DB, normalizedEmail: string): number {
  const result = stmt(
    db,
    `UPDATE campaign_rows SET email = '(erased):' || id, vars_json = '{}', skip_reason = COALESCE(skip_reason, 'erased')
       WHERE lower(trim(email)) = @email AND email NOT LIKE '(erased):%'`,
  ).run({ email: normalizedEmail });
  return result.changes;
}

/** Retention: clears `vars_json` (PII) for campaigns finished long enough ago; row counts and
 *  statuses are untouched. */
export function clearVarsForOldCampaigns(db: DB, olderThanMs: number): number {
  const campaignIds = stmt(
    db,
    `SELECT id FROM campaigns WHERE status IN ('completed','cancelled') AND finished_at IS NOT NULL AND finished_at < @cutoff`,
  ).all({ cutoff: olderThanMs }) as Array<{ id: string }>;
  if (campaignIds.length === 0) return 0;
  let total = 0;
  const clear = stmt(db, `UPDATE campaign_rows SET vars_json = '{}' WHERE campaign_id = @id AND vars_json != '{}'`);
  for (const c of campaignIds) {
    total += clear.run({ id: c.id }).changes;
  }
  return total;
}
