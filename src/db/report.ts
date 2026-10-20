import type { DB } from './index.js';
import type { RecipientState } from '../types.js';

export interface AccuracyReport {
  since: number;
  generatedAt: number;
  messages: { total: number; sent: number; dryrun: number; failed: number };
  recipients: { total: number; byState: Record<RecipientState, number> };
  opens: { total: number; counted: number; machine: number; byClassification: Record<string, number> };
  clicks: { total: number; counted: number; byClassification: Record<string, number> };
  rules: Record<string, number>;
  derived: {
    countedOpenRate: number;
    prefetchSuppressionRate: number;
    backfilledOpens: number;
    overrides: number;
    medianTimeToOpenMs: number | null;
  };
  notifications: { sent: number; pending: number; failed: number; deadLettered: number };
}

const STATES: RecipientState[] = ['not_opened', 'prefetched', 'opened', 'read_confirmed', 'replied'];

/** Exported so `src/db/stats.ts` (Phase 3 §5) reuses the same median implementation rather than a
 *  second copy. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  }
  return sorted[mid] as number;
}

function tally(reasons: Array<string | null>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of reasons) {
    if (!reason) continue;
    for (const token of reason.split(',')) {
      const trimmed = token.trim();
      if (trimmed.length === 0) continue;
      counts[trimmed] = (counts[trimmed] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Builds the numbers behind `openpost accuracy` (§4.5). `rules` is built by splitting every
 * `reason` on `,` and counting each token, so an event with `reason: 'R4,apple_ip'` increments
 * both `R4` and `apple_ip`.
 */
export function accuracyReport(db: DB, sinceMs: number): AccuracyReport {
  const generatedAt = Date.now();

  const messageRows = db
    .prepare('SELECT status, COUNT(*) AS n FROM messages WHERE created_at >= ? GROUP BY status')
    .all(sinceMs) as Array<{ status: string; n: number }>;
  const messages = { total: 0, sent: 0, dryrun: 0, failed: 0 };
  for (const row of messageRows) {
    messages.total += row.n;
    if (row.status === 'sent') messages.sent = row.n;
    else if (row.status === 'dryrun') messages.dryrun = row.n;
    else if (row.status === 'failed') messages.failed = row.n;
  }

  const recipientRows = db
    .prepare(
      `SELECT r.state AS state, COUNT(*) AS n FROM recipients r
         JOIN messages m ON m.id = r.message_id
        WHERE m.created_at >= ?
          -- docs/07_recipient_semantics.md §4.4: count the tracked unit, same rule as stats.ts.
          AND r.is_aggregate = (CASE WHEN m.recipient_mode = 'single' THEN 1 ELSE 0 END)
        GROUP BY r.state`,
    )
    .all(sinceMs) as Array<{ state: RecipientState; n: number }>;
  const byState: Record<RecipientState, number> = {
    not_opened: 0,
    prefetched: 0,
    opened: 0,
    read_confirmed: 0,
    replied: 0,
  };
  let recipientsTotal = 0;
  for (const row of recipientRows) {
    if (STATES.includes(row.state)) byState[row.state] = row.n;
    recipientsTotal += row.n;
  }

  const openRows = db
    .prepare(
      'SELECT classification, counted, reason FROM open_events WHERE occurred_at >= ?',
    )
    .all(sinceMs) as Array<{ classification: string; counted: number; reason: string | null }>;
  const opens = { total: openRows.length, counted: 0, machine: 0, byClassification: {} as Record<string, number> };
  for (const row of openRows) {
    if (row.counted === 1) opens.counted += 1;
    else opens.machine += 1;
    opens.byClassification[row.classification] = (opens.byClassification[row.classification] ?? 0) + 1;
  }

  const clickRows = db
    .prepare('SELECT classification, counted, reason FROM click_events WHERE occurred_at >= ?')
    .all(sinceMs) as Array<{ classification: string; counted: number; reason: string | null }>;
  const clicks = { total: clickRows.length, counted: 0, byClassification: {} as Record<string, number> };
  for (const row of clickRows) {
    if (row.counted === 1) clicks.counted += 1;
    clicks.byClassification[row.classification] = (clicks.byClassification[row.classification] ?? 0) + 1;
  }

  const rules = tally([...openRows.map((r) => r.reason), ...clickRows.map((r) => r.reason)]);

  const backfilledOpens = openRows.filter((r) => r.reason?.includes('implied_by_click')).length;
  const overrides = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reclassify.override' AND at >= ?`)
      .get(sinceMs) as { n: number }
  ).n;

  const timeToOpenRows = db
    .prepare(
      `SELECT (first_open_at - sent_at) AS ms FROM recipients
        WHERE sent_at IS NOT NULL AND first_open_at IS NOT NULL AND sent_at >= ?`,
    )
    .all(sinceMs) as Array<{ ms: number }>;
  const medianTimeToOpenMs = median(timeToOpenRows.map((r) => r.ms));

  const denomForCountedRate = recipientsTotal > 0 ? recipientsTotal : 1;
  const countedOpenRate = recipientsTotal > 0 ? opens.counted / denomForCountedRate : 0;
  const totalOpenAttempts = opens.counted + opens.machine;
  const prefetchSuppressionRate = totalOpenAttempts > 0 ? opens.machine / totalOpenAttempts : 0;

  const notifRows = db
    .prepare('SELECT status, COUNT(*) AS n FROM notifications WHERE created_at >= ? GROUP BY status')
    .all(sinceMs) as Array<{ status: string; n: number }>;
  const notifications = { sent: 0, pending: 0, failed: 0, deadLettered: 0 };
  for (const row of notifRows) {
    if (row.status === 'sent') notifications.sent = row.n;
    else if (row.status === 'pending') notifications.pending = row.n;
    else if (row.status === 'failed') notifications.failed = row.n;
  }
  notifications.deadLettered = (
    db.prepare('SELECT COUNT(*) AS n FROM notification_dead_letters WHERE failed_at >= ?').get(sinceMs) as {
      n: number;
    }
  ).n;

  return {
    since: sinceMs,
    generatedAt,
    messages,
    recipients: { total: recipientsTotal, byState },
    opens,
    clicks,
    rules,
    derived: { countedOpenRate, prefetchSuppressionRate, backfilledOpens, overrides, medianTimeToOpenMs },
    notifications,
  };
}
