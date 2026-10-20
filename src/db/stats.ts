import type { DB } from './index.js';
import { median } from './report.js';
import { hourInZone, dayKeyInZone } from '../core/time.js';

export interface StatsBucket {
  key: string;
  label: string;
  fromMs: number;
  toMs: number | null;
  count: number;
}

export interface StatsReport {
  since: number;
  until: number;
  timeZone: string;
  generatedAt: number;
  totals: {
    messages: number;
    recipients: number;
    opened: number;
    clicked: number;
    replied: number;
    prefetchedOnly: number;
    notOpened: number;
    optedOut: number;
  };
  rates: {
    openRate: number;
    clickRate: number;
    clickToOpenRate: number;
    replyRate: number;
    prefetchSuppressionRate: number;
  };
  timeToOpen: { buckets: StatsBucket[]; medianMs: number | null; p90Ms: number | null; sampleSize: number };
  bestHour: { timeZone: string; hours: Array<{ hour: number; count: number }>; peakHour: number | null };
  byDay: Array<{ day: string; sent: number; opened: number; clicked: number; replied: number }>;
  topMessages: Array<{ id: string; subject: string; recipients: number; openRate: number; clickRate: number; replyRate: number }>;
}

const TIME_TO_OPEN_BUCKETS: Array<{ key: string; label: string; maxMs: number | null }> = [
  { key: 'lt_1m', label: '< 1 min', maxMs: 60_000 },
  { key: 'm1_5', label: '1-5 min', maxMs: 300_000 },
  { key: 'm5_30', label: '5-30 min', maxMs: 1_800_000 },
  { key: 'm30_2h', label: '30 min - 2 h', maxMs: 7_200_000 },
  { key: 'h2_6', label: '2-6 h', maxMs: 21_600_000 },
  { key: 'h6_24', label: '6-24 h', maxMs: 86_400_000 },
  { key: 'd1_3', label: '1-3 d', maxMs: 259_200_000 },
  { key: 'gt_3d', label: '> 3 d', maxMs: null },
];

function bucketFor(ms: number): string {
  for (const b of TIME_TO_OPEN_BUCKETS) {
    if (b.maxMs === null || ms < b.maxMs) return b.key;
  }
  return 'gt_3d';
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? round4(numerator / denominator) : 0;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(0, idx)] as number;
}

interface BaseRow {
  id: string;
  message_id: string;
  state: string;
  open_count: number;
  machine_open_count: number;
  click_count: number;
  replied_at: number | null;
  first_open_at: number | null;
  opted_out_at: number | null;
  eff_sent_at: number;
}

// docs/07_recipient_semantics.md §4.4: count the TRACKED unit - the aggregate row in single mode
// (the only row with real event counts), every addressee row otherwise - so a 3-recipient
// single-mode message contributes exactly one unit, not four. Shared verbatim across every query
// below so the denominator can never drift between them.
const WINDOW_PREDICATE = `
  m.status IN ('sent','dryrun')
  AND r.is_aggregate = (CASE WHEN m.recipient_mode = 'single' THEN 1 ELSE 0 END)
  AND COALESCE(r.sent_at, m.sent_at, m.created_at) BETWEEN @since AND @until
`;

interface TotalsRow {
  recipients: number;
  messages: number;
  opened: number;
  clicked: number;
  replied: number;
  prefetchedOnly: number;
  notOpened: number;
  optedOut: number;
}

/**
 * Pure aggregate stats over a `DB` (Phase 3 §5). The denominator throughout is *recipients of
 * sent/dryrun messages whose effective send time falls in the window* - never "events" - so rates
 * cannot exceed 1 and an unsent draft never dilutes them.
 *
 * Phase 3.1 (M6): the simple totals/rates and the per-message leaderboard are now SQL aggregates
 * (`COUNT`/`SUM(CASE ...)`/`GROUP BY`) rather than materialising every matching recipient row and
 * summing in JS - `base` below still exists, but only for the two computations that genuinely need
 * one JS pass per row (the time-to-open histogram's bucketing and the per-day rollup, both driven
 * by `Intl`-based time-zone arithmetic SQLite cannot do). Callers are expected to pass an already-
 * bounded `[sinceMs, untilMs]` (`server/query.ts`'s `parseStatsWindow`) rather than an all-time
 * window, so `base` itself stays bounded too.
 */
export function statsReport(db: DB, opts: { sinceMs: number; untilMs: number; timeZone: string }): StatsReport {
  const generatedAt = Date.now();
  const { sinceMs, untilMs, timeZone } = opts;
  const windowParams = { since: sinceMs, until: untilMs };

  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) AS recipients,
              COUNT(DISTINCT r.message_id) AS messages,
              COALESCE(SUM(CASE WHEN r.open_count > 0 THEN 1 ELSE 0 END), 0) AS opened,
              COALESCE(SUM(CASE WHEN r.click_count > 0 THEN 1 ELSE 0 END), 0) AS clicked,
              COALESCE(SUM(CASE WHEN r.replied_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS replied,
              COALESCE(SUM(CASE WHEN r.open_count = 0 AND r.machine_open_count > 0 THEN 1 ELSE 0 END), 0) AS prefetchedOnly,
              COALESCE(SUM(CASE WHEN r.open_count = 0 AND r.machine_open_count = 0 THEN 1 ELSE 0 END), 0) AS notOpened,
              COALESCE(SUM(CASE WHEN r.opted_out_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS optedOut
         FROM recipients r JOIN messages m ON m.id = r.message_id
        WHERE ${WINDOW_PREDICATE}`,
    )
    .get(windowParams) as TotalsRow;

  const recipients = totalsRow.recipients;
  const opened = totalsRow.opened;
  const clicked = totalsRow.clicked;
  const replied = totalsRow.replied;
  const prefetchedOnly = totalsRow.prefetchedOnly;
  const notOpened = totalsRow.notOpened;
  const optedOut = totalsRow.optedOut;
  // Phase 3.1 amendment (docs/06_phase3_spec.md, see "Phase 3.1 amendments"): an opted-out
  // recipient can never register a counted open/click again (the pixel/click route always records
  // `opt_out`, uncounted) regardless of whether they otherwise would have - counting them in the
  // RATE denominator silently deflates open/click/reply rates by however many people opted out,
  // which has nothing to do with how engaging the message actually was. `totals.recipients` still
  // reports the full window count (context), but rates use only the recipients who could still be
  // tracked.
  const trackedRecipients = recipients - optedOut;

  const base = db
    .prepare(
      `SELECT r.id AS id, r.message_id AS message_id, r.state AS state, r.open_count AS open_count,
              r.machine_open_count AS machine_open_count, r.click_count AS click_count,
              r.replied_at AS replied_at, r.first_open_at AS first_open_at, r.opted_out_at AS opted_out_at,
              COALESCE(r.sent_at, m.sent_at, m.created_at) AS eff_sent_at
         FROM recipients r JOIN messages m ON m.id = r.message_id
        WHERE ${WINDOW_PREDICATE}`,
    )
    .all(windowParams) as BaseRow[];

  const rates = {
    openRate: rate(opened, trackedRecipients),
    clickRate: rate(clicked, trackedRecipients),
    clickToOpenRate: rate(clicked, opened),
    replyRate: rate(replied, trackedRecipients),
    prefetchSuppressionRate: rate(prefetchedOnly, opened + prefetchedOnly),
  };

  // Time-to-open buckets: first *counted* open only, excluding clock-skew negatives (a
  // first_open_at earlier than the effective send time never happens honestly and must not land in
  // a negative bucket).
  const deltas = base
    .filter((r) => r.first_open_at !== null && (r.first_open_at as number) >= r.eff_sent_at)
    .map((r) => (r.first_open_at as number) - r.eff_sent_at);
  const bucketCounts = new Map<string, number>(TIME_TO_OPEN_BUCKETS.map((b) => [b.key, 0]));
  for (const d of deltas) {
    bucketCounts.set(bucketFor(d), (bucketCounts.get(bucketFor(d)) ?? 0) + 1);
  }
  const sortedDeltas = [...deltas].sort((a, b) => a - b);
  const timeToOpen = {
    buckets: TIME_TO_OPEN_BUCKETS.map((b) => ({
      key: b.key,
      label: b.label,
      fromMs: TIME_TO_OPEN_BUCKETS[TIME_TO_OPEN_BUCKETS.indexOf(b) - 1]?.maxMs ?? 0,
      toMs: b.maxMs,
      count: bucketCounts.get(b.key) ?? 0,
    })),
    medianMs: median(sortedDeltas),
    p90Ms: percentile(sortedDeltas, 0.9),
    sampleSize: sortedDeltas.length,
  };

  // Best-hour histogram: over *counted open events*, bucketed by Intl in JS (SQLite has no
  // timezone database, and `localtime` would silently use the server's own TZ and get DST wrong).
  const openEventTimes = db
    .prepare(
      `SELECT oe.occurred_at AS occurred_at FROM open_events oe
         JOIN recipients r ON r.id = oe.recipient_id
        WHERE oe.counted = 1 AND oe.occurred_at BETWEEN @since AND @until`,
    )
    .all({ since: sinceMs, until: untilMs }) as Array<{ occurred_at: number }>;
  const hourCounts = new Array<number>(24).fill(0);
  for (const row of openEventTimes) {
    const h = hourInZone(row.occurred_at, timeZone);
    hourCounts[h] = (hourCounts[h] ?? 0) + 1;
  }
  let peakHour: number | null = null;
  let peakCount = 0;
  for (let h = 0; h < 24; h++) {
    const c = hourCounts[h] as number;
    if (c > peakCount) {
      peakCount = c;
      peakHour = h;
    }
  }
  const bestHour = {
    timeZone,
    hours: hourCounts.map((count, hour) => ({ hour, count })),
    peakHour: peakCount > 0 ? peakHour : null,
  };

  // byDay: sent/opened/clicked/replied per calendar day in `timeZone`.
  const byDayMap = new Map<string, { sent: number; opened: number; clicked: number; replied: number }>();
  for (const r of base) {
    const day = dayKeyInZone(r.eff_sent_at, timeZone);
    const entry = byDayMap.get(day) ?? { sent: 0, opened: 0, clicked: 0, replied: 0 };
    entry.sent += 1;
    if (r.open_count > 0) entry.opened += 1;
    if (r.click_count > 0) entry.clicked += 1;
    if (r.replied_at !== null) entry.replied += 1;
    byDayMap.set(day, entry);
  }
  const byDay = [...byDayMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([day, v]) => ({ day, ...v }));

  // topMessages: every distinct message in the window, ranked by recipient count desc - a single
  // GROUP BY rather than a JS Map plus a separate subjects lookup (M6).
  interface PerMessageRow {
    id: string;
    subject: string;
    recipients: number;
    opened: number;
    clicked: number;
    replied: number;
    optedOut: number;
  }
  const perMessageRows = db
    .prepare(
      `SELECT r.message_id AS id, m.subject AS subject,
              COUNT(*) AS recipients,
              SUM(CASE WHEN r.open_count > 0 THEN 1 ELSE 0 END) AS opened,
              SUM(CASE WHEN r.click_count > 0 THEN 1 ELSE 0 END) AS clicked,
              SUM(CASE WHEN r.replied_at IS NOT NULL THEN 1 ELSE 0 END) AS replied,
              SUM(CASE WHEN r.opted_out_at IS NOT NULL THEN 1 ELSE 0 END) AS optedOut
         FROM recipients r JOIN messages m ON m.id = r.message_id
        WHERE ${WINDOW_PREDICATE}
        GROUP BY r.message_id, m.subject
        ORDER BY recipients DESC
        LIMIT 20`,
    )
    .all(windowParams) as PerMessageRow[];
  const topMessages = perMessageRows.map((v) => {
    const tracked = v.recipients - v.optedOut;
    return {
      id: v.id,
      subject: v.subject,
      recipients: v.recipients,
      openRate: rate(v.opened, tracked),
      clickRate: rate(v.clicked, tracked),
      replyRate: rate(v.replied, tracked),
    };
  });

  return {
    since: sinceMs,
    until: untilMs,
    timeZone,
    generatedAt,
    totals: { messages: totalsRow.messages, recipients, opened, clicked, replied, prefetchedOnly, notOpened, optedOut },
    rates,
    timeToOpen,
    bestHour,
    byDay,
    topMessages,
  };
}
