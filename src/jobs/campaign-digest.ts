/**
 * One digest per campaign per window, never N per-open notifications (docs/08_phase4_spec.md §2.9).
 * Reuses the existing notification queue's `UNIQUE(dedupe_key)` unchanged - the only new machinery
 * is computing the window's counts and building the payload.
 */
import { newId } from '../core/ids.js';
import { audit } from '../db/repo.js';
import { campaignWindowCounts } from '../db/campaign-stats.js';
import type { AppConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import { enqueue } from '../notify/queue.js';
import type { NotificationPayload } from '../notify/types.js';
import type { Job } from './scheduler.js';

interface DueCampaign {
  id: string;
  name: string;
  status: string;
  digest_from: number | null;
  digest_next_at: number | null;
  digest_window_minutes: number;
  started_at: number | null;
  created_at: number;
}

function buildDigestPayload(campaign: DueCampaign, windowFrom: number, windowTo: number, counts: ReturnType<typeof campaignWindowCounts>): NotificationPayload {
  const openRate = counts.sent > 0 ? counts.opened / counts.sent : 0;
  const clickRate = counts.sent > 0 ? counts.clicked / counts.sent : 0;
  return {
    version: 1,
    id: newId(),
    trigger: 'campaign_digest',
    occurredAt: windowTo,
    message: { id: campaign.id, subject: campaign.name, sentAt: null },
    recipient: { id: '', email: null, state: 'not_opened', openCount: 0, clickCount: 0, attribution: 'message', recipientCount: null },
    event: { id: campaign.id, kind: 'open', classification: 'campaign_digest', reasons: [], counted: false, uaFamily: null, deviceType: null, country: null, linkUrl: null },
    campaign: {
      id: campaign.id,
      name: campaign.name,
      windowFrom,
      windowTo,
      rows: counts.rows,
      sent: counts.sent,
      skipped: counts.skipped,
      failed: counts.failed,
      opened: counts.opened,
      clicked: counts.clicked,
      replied: counts.replied,
      openRate,
      clickRate,
      topVariant: null,
    },
  };
}

function windowHadActivity(counts: ReturnType<typeof campaignWindowCounts>): boolean {
  return counts.sent > 0 || counts.opened > 0 || counts.clicked > 0 || counts.replied > 0 || counts.skipped > 0 || counts.failed > 0;
}

export interface CampaignDigestDeps {
  db: DB;
  config: AppConfig;
  clock?: () => number;
}

/** Runs one digest pass: for every campaign whose `digest_next_at` is due (or unset - the first
 *  window), computes counts since `digest_from`, and - only if something changed - enqueues one
 *  notification per configured channel. A campaign that just finished (`completed`/`cancelled`)
 *  gets a final digest immediately, even if its window has not elapsed. */
export async function runCampaignDigestOnce(deps: CampaignDigestDeps, nowMs?: number): Promise<{ digestsSent: number }> {
  const { db, config } = deps;
  const clock = deps.clock ?? (() => Date.now());
  const now = nowMs ?? clock();

  const due = db
    .prepare(
      `SELECT id, name, status, digest_from, digest_next_at, digest_window_minutes, started_at, created_at
         FROM campaigns
        WHERE status IN ('running','paused')
          AND (digest_next_at IS NULL OR digest_next_at <= @now)`,
    )
    .all({ now }) as DueCampaign[];

  // A campaign that just finished and never got a final digest for its tail window. Finding #16:
  // no longer requires digest_from IS NOT NULL (a campaign that finished before its first periodic
  // digest ever ran had no digest_from set, so it was never reported at all) - `final_digest_sent_at`
  // alone (a durable marker on the campaign row, unaffected by notifications retention) decides
  // whether this campaign still needs one.
  const justFinished = db
    .prepare(
      `SELECT id, name, status, digest_from, digest_next_at, digest_window_minutes, started_at, created_at
         FROM campaigns
        WHERE status IN ('completed','cancelled') AND final_digest_sent_at IS NULL
          AND finished_at IS NOT NULL`,
    )
    .all() as DueCampaign[];

  let digestsSent = 0;
  for (const campaign of [...due, ...justFinished]) {
    // Finding #16: falls back to started_at/created_at rather than epoch 0 when this is the
    // campaign's first-ever digest (periodic or final) - a sensible window even for a campaign that
    // never lived long enough to see a periodic tick.
    const windowFrom = campaign.digest_from ?? campaign.started_at ?? campaign.created_at;
    const windowTo = now;
    const counts = campaignWindowCounts(db, campaign.id, windowFrom, windowTo);
    const isFinal = campaign.status === 'completed' || campaign.status === 'cancelled';

    if (windowHadActivity(counts) || isFinal) {
      let anyEnqueued = false;
      for (const channel of config.notifyChannels) {
        const payload = buildDigestPayload(campaign, windowFrom, windowTo, counts);
        const dedupeKey = isFinal
          ? `final:${channel}:campaign_digest:${campaign.id}`
          : `${channel}:campaign_digest:${campaign.id}:${windowFrom}`;
        const id = enqueue(db, {
          trigger: 'campaign_digest',
          channel,
          payload,
          messageId: null,
          recipientId: null,
          eventType: 'campaign_digest',
          eventId: campaign.id,
          dedupeKey,
          atMs: now,
          campaignId: campaign.id,
        });
        if (id !== null) {
          anyEnqueued = true;
          audit(db, { actor: 'server', action: 'notify.enqueue', subjectType: 'campaign', subjectId: campaign.id, detail: { channel, trigger: 'campaign_digest', dedupeKey } });
        }
      }
      if (anyEnqueued) digestsSent += 1;
    }

    if (isFinal) {
      // Finding #16: persisted on the campaign row itself - independent of whether the
      // notifications this pass enqueued (or any earlier final digest's) survive retention.
      db.prepare('UPDATE campaigns SET final_digest_sent_at = @now WHERE id = @id').run({ id: campaign.id, now });
    } else {
      db.prepare('UPDATE campaigns SET digest_from = @now, digest_next_at = @next WHERE id = @id').run({
        id: campaign.id,
        now,
        next: now + campaign.digest_window_minutes * 60_000,
      });
    }
  }

  return { digestsSent };
}

export function createCampaignDigestJob(deps: CampaignDigestDeps, intervalMs = 60_000): Job {
  return {
    name: 'campaign-digest',
    intervalMs,
    async run(nowMs: number): Promise<{ detail?: unknown }> {
      const result = await runCampaignDigestOnce(deps, nowMs);
      return { detail: result };
    },
  };
}
