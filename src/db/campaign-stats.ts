import type { DB } from './index.js';
import { twoProportionZ, type TwoProportionZResult } from '../core/variant.js';

export interface VariantStats {
  variant: string;
  rows: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  openRate: number;
  clickRate: number;
}

export interface CampaignReport {
  campaignId: string;
  rows: number;
  pending: number;
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  opened: number;
  clicked: number;
  replied: number;
  openRate: number;
  clickRate: number;
  variants: VariantStats[];
  significance: TwoProportionZResult | null;
}

interface VariantRow {
  variant: string;
  rows: number;
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
}

/** Aggregates entirely in SQL (no per-row JS loop over every recipient) - the same discipline
 *  stats.ts already follows (docs/reports/phase3_review.md: no unbounded aggregation in JS). */
export function campaignReport(db: DB, campaignId: string): CampaignReport {
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS rows,
         SUM(CASE WHEN cr.status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN cr.status = 'claimed' THEN 1 ELSE 0 END) AS claimed,
         SUM(CASE WHEN cr.status = 'sent' THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN cr.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN cr.status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM campaign_rows cr WHERE cr.campaign_id = @campaignId`,
    )
    .get({ campaignId }) as {
    rows: number;
    pending: number;
    claimed: number;
    sent: number;
    skipped: number;
    failed: number;
  };

  const engagement = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN r.open_count > 0 THEN 1 ELSE 0 END), 0) AS opened,
         COALESCE(SUM(CASE WHEN r.click_count > 0 THEN 1 ELSE 0 END), 0) AS clicked,
         COALESCE(SUM(CASE WHEN r.replied_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS replied
       FROM campaign_rows cr JOIN recipients r ON r.id = cr.recipient_id
      WHERE cr.campaign_id = @campaignId AND cr.status = 'sent'`,
    )
    .get({ campaignId }) as { opened: number; clicked: number; replied: number };

  const variantRows = db
    .prepare(
      `SELECT
         cr.variant AS variant,
         COUNT(*) AS rows,
         SUM(CASE WHEN cr.status = 'sent' THEN 1 ELSE 0 END) AS sent,
         COALESCE(SUM(CASE WHEN cr.status = 'sent' AND r.open_count > 0 THEN 1 ELSE 0 END), 0) AS opened,
         COALESCE(SUM(CASE WHEN cr.status = 'sent' AND r.click_count > 0 THEN 1 ELSE 0 END), 0) AS clicked,
         COALESCE(SUM(CASE WHEN cr.status = 'sent' AND r.replied_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS replied
       FROM campaign_rows cr LEFT JOIN recipients r ON r.id = cr.recipient_id
      WHERE cr.campaign_id = @campaignId
      GROUP BY cr.variant
      ORDER BY cr.variant ASC`,
    )
    .all({ campaignId }) as VariantRow[];

  const variants: VariantStats[] = variantRows.map((v) => ({
    variant: v.variant,
    rows: v.rows,
    sent: v.sent,
    opened: v.opened,
    clicked: v.clicked,
    replied: v.replied,
    openRate: v.sent > 0 ? v.opened / v.sent : 0,
    clickRate: v.sent > 0 ? v.clicked / v.sent : 0,
  }));

  const significance =
    variants.length >= 2
      ? twoProportionZ(variants.map((v) => ({ key: v.variant, n: v.sent, successes: v.opened })))
      : null;

  return {
    campaignId,
    rows: totals.rows,
    pending: totals.pending,
    claimed: totals.claimed,
    sent: totals.sent,
    skipped: totals.skipped,
    failed: totals.failed,
    opened: engagement.opened,
    clicked: engagement.clicked,
    replied: engagement.replied,
    openRate: totals.sent > 0 ? engagement.opened / totals.sent : 0,
    clickRate: totals.sent > 0 ? engagement.clicked / totals.sent : 0,
    variants,
    significance,
  };
}

export interface CampaignWindowCounts {
  rows: number;
  sent: number;
  skipped: number;
  failed: number;
  opened: number;
  clicked: number;
  replied: number;
}

/** Counts for one digest window `[fromMs, toMs)`, all in SQL (docs/08_phase4_spec.md §2.9). `rows`/
 *  `sent`/`skipped`/`failed` are windowed by `campaign_rows.created_at`/`sent_at`; `opened`/
 *  `clicked`/`replied` are windowed by the underlying event/recipient timestamps, joined through
 *  `campaign_rows.recipient_id`. */
export function campaignWindowCounts(db: DB, campaignId: string, fromMs: number, toMs: number): CampaignWindowCounts {
  const rows = db
    .prepare(
      `SELECT
         SUM(CASE WHEN sent_at IS NOT NULL AND sent_at >= @from AND sent_at < @to THEN 1 ELSE 0 END) AS sent,
         SUM(CASE WHEN status = 'skipped' AND created_at >= @from AND created_at < @to THEN 1 ELSE 0 END) AS skipped,
         SUM(CASE WHEN status = 'failed' AND created_at >= @from AND created_at < @to THEN 1 ELSE 0 END) AS failed
       FROM campaign_rows WHERE campaign_id = @campaignId`,
    )
    .get({ campaignId, from: fromMs, to: toMs }) as { sent: number; skipped: number; failed: number };

  const opened = db
    .prepare(
      `SELECT COUNT(DISTINCT cr.id) AS n
         FROM campaign_rows cr
         JOIN open_events oe ON oe.recipient_id = cr.recipient_id
        WHERE cr.campaign_id = @campaignId AND oe.occurred_at >= @from AND oe.occurred_at < @to AND oe.counted = 1`,
    )
    .get({ campaignId, from: fromMs, to: toMs }) as { n: number };

  const clicked = db
    .prepare(
      `SELECT COUNT(DISTINCT cr.id) AS n
         FROM campaign_rows cr
         JOIN click_events ce ON ce.recipient_id = cr.recipient_id
        WHERE cr.campaign_id = @campaignId AND ce.occurred_at >= @from AND ce.occurred_at < @to AND ce.counted = 1`,
    )
    .get({ campaignId, from: fromMs, to: toMs }) as { n: number };

  const replied = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM campaign_rows cr
         JOIN recipients r ON r.id = cr.recipient_id
        WHERE cr.campaign_id = @campaignId AND r.replied_at IS NOT NULL AND r.replied_at >= @from AND r.replied_at < @to`,
    )
    .get({ campaignId, from: fromMs, to: toMs }) as { n: number };

  return {
    rows: (rows.sent ?? 0) + (rows.skipped ?? 0) + (rows.failed ?? 0),
    sent: rows.sent ?? 0,
    skipped: rows.skipped ?? 0,
    failed: rows.failed ?? 0,
    opened: opened.n,
    clicked: clicked.n,
    replied: replied.n,
  };
}
