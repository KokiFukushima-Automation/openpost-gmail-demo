/**
 * The campaign runner (docs/08_phase4_spec.md §2.7): claim -> preflight -> render -> sendMessage ->
 * mark -> pace -> repeat. Every claim/mark call goes through `src/db/campaigns.ts`'s single
 * conditional UPDATEs, so two `runCampaignOnce` calls interleaved on one DB (two `openpost serve`
 * processes, or a manual `campaign run` racing the scheduler) never claim the same row.
 */
import { newId } from '../core/ids.js';
import { optOutUrl, signToken } from '../core/token.js';
import { renderTemplate, TemplateError } from '../core/template.js';
import { assertSafeHrefs } from '../core/html.js';
import type { Variant } from '../core/variant.js';
import type { AppConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import {
  beginRowSubmit,
  campaignCounts,
  claimNextRow,
  clearCampaignCap,
  earliestSentInLastDay,
  getCampaign,
  markRowFailed,
  markRowSent,
  markRowSkipped,
  recoverExpiredLeases,
  sentInLastDay,
  setCampaignCapped,
  setCampaignStatus,
  type CampaignRow,
  type CampaignRowRow,
} from '../db/campaigns.js';
import { getSuppressionReason } from '../db/repo.js';
import { resolveAccount, resolveTransportForAccount, touchLastUsed } from '../mail/accounts.js';
import { sendMessage } from '../mail/send-message.js';
import type { Job } from './scheduler.js';

export interface CampaignRunOptions {
  limit?: number | undefined;
  maxSeconds?: number | undefined;
  owner?: string;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  shouldStop?: () => boolean;
  clock?: () => number;
  /** Test/crash-simulation seams, mirroring `src/jobs/reminders.ts`'s `onEnqueued` precedent. Never
   *  used by real callers. */
  onRowClaimed?: (row: CampaignRowRow) => void;
  onSubmitBegan?: (row: CampaignRowRow) => void;
}

export type CampaignStopReason =
  | 'completed'
  | 'paused'
  | 'cancelled'
  | 'limit'
  | 'time'
  | 'daily_cap'
  | 'signal'
  | 'not_running';

export interface CampaignRunResult {
  campaignId: string;
  claimed: number;
  sent: number;
  skipped: number;
  failed: number;
  stopped: CampaignStopReason;
}

export interface CampaignDeps {
  db: DB;
  config: AppConfig;
}

/** `base = ceil(60000/ratePerMinute)`, `delay = max(0, base + round((rnd()*2-1)*jitterMs))`. Pure -
 *  every input (including `rnd`) is injected, so pacing is exactly reproducible in tests. */
export function nextDelayMs(ratePerMinute: number, jitterMs: number, rnd: () => number): number {
  const base = Math.ceil(60_000 / ratePerMinute);
  return Math.max(0, base + Math.round((rnd() * 2 - 1) * jitterMs));
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface PreflightResult {
  ok: boolean;
  reason?: string;
}

/** In order, each producing a distinct `skip_reason` (§2.7): invalid_address -> suppressed ->
 *  opted_out -> missing_vars -> unsafe_href. `duplicate_in_csv` is decided at import time (the
 *  UNIQUE index on `(campaign_id, email) WHERE status <> 'skipped'`), not here. */
export function preflightRow(
  db: DB,
  row: CampaignRowRow,
  campaign: CampaignRow,
): PreflightResult {
  if (!EMAIL_RE.test(row.email)) return { ok: false, reason: 'invalid_address' };
  const suppressionReason = getSuppressionReason(db, row.email);
  if (suppressionReason === 'recipient_optout') return { ok: false, reason: 'opted_out' };
  if (suppressionReason !== null) return { ok: false, reason: 'suppressed' };

  let vars: Record<string, string>;
  try {
    vars = JSON.parse(row.vars_json) as Record<string, string>;
  } catch {
    return { ok: false, reason: 'missing_vars' };
  }
  try {
    renderVars(campaign, row, vars);
  } catch (err) {
    if (err instanceof TemplateError) return { ok: false, reason: 'missing_vars' };
    throw err;
  }
  return { ok: true };
}

interface RenderedCampaignMessage {
  subject: string;
  html: string;
  text: string | undefined;
  variant: string;
}

function renderVars(campaign: CampaignRow, row: CampaignRowRow, csvVars: Record<string, string>): Record<string, string> {
  return {
    ...csvVars,
    email: row.email,
    campaign_name: campaign.name,
    sender_name: campaign.from_name ?? '',
    sender_email: campaign.from_email,
  };
}

function subjectTemplateFor(campaign: CampaignRow, variant: string): string {
  if (!campaign.subject_variants_json) return campaign.subject_template;
  const variants = JSON.parse(campaign.subject_variants_json) as Variant[];
  return variants.find((v) => v.key === variant)?.template ?? campaign.subject_template;
}

/** Renders subject + body for one row, injecting the reserved `unsubscribe_url` key so a template
 *  that places it itself suppresses the runner's own footer (§2.4/§2.5.2). */
function renderRow(
  campaign: CampaignRow,
  row: CampaignRowRow,
  trackingBaseUrl: string,
  trackingSecret: string,
): RenderedCampaignMessage & { token: string; unsubscribeUrl: string } {
  const csvVars = JSON.parse(row.vars_json) as Record<string, string>;
  const token = newId();
  const unsubscribeUrl = optOutUrl(trackingBaseUrl, signToken('u', token, trackingSecret));
  const vars = { ...renderVars(campaign, row, csvVars), unsubscribe_url: unsubscribeUrl };

  const allowRaw = campaign.allow_raw === 1;
  const subjectTemplate = subjectTemplateFor(campaign, row.variant);
  const subject = renderTemplate(subjectTemplate, vars, { mode: 'subject', allowRaw });
  const html = renderTemplate(campaign.body_html_template, vars, { mode: 'html', allowRaw });
  const text = campaign.body_text_template
    ? renderTemplate(campaign.body_text_template, vars, { mode: 'text', allowRaw })
    : undefined;
  assertSafeHrefs(html);

  return { subject, html, text, variant: row.variant, token, unsubscribeUrl };
}

/** Requeues expired leases: a thin, spec-named wrapper over `recoverExpiredLeases` (the extra
 *  `leaseMs` parameter is accepted for API-shape compatibility but unused - the lease's own
 *  `lease_expires_at` already carries that information). Runs at the start of every
 *  `runCampaignOnce` and at `serve` start. */
export function recoverCampaign(db: DB, campaignId: string, nowMs: number, _leaseMs: number): { requeued: number; indeterminate: number } {
  return recoverExpiredLeases(db, campaignId, nowMs);
}

export async function runCampaignOnce(deps: CampaignDeps, campaignId: string, opts: CampaignRunOptions = {}): Promise<CampaignRunResult> {
  const { db, config } = deps;
  const clock = opts.clock ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const random = opts.random ?? Math.random;
  const owner = opts.owner ?? `campaign-runner-${process.pid}-${newId().slice(0, 6)}`;
  const startMs = clock();
  const leaseMs = 120_000;
  const maxAttempts = 3;

  const result: CampaignRunResult = { campaignId, claimed: 0, sent: 0, skipped: 0, failed: 0, stopped: 'completed' };

  let campaign = getCampaign(db, campaignId);
  if (!campaign) {
    result.stopped = 'not_running';
    return result;
  }
  // A `run` call may auto-start a fresh `draft` campaign, but must NEVER silently resume a
  // `paused` one - only the explicit `campaign resume` CLI command (or the digest/dashboard action
  // behind it) flips paused -> running. `run` on anything else terminal is a no-op.
  if (campaign.status === 'paused' || campaign.status === 'cancelled' || campaign.status === 'completed' || campaign.status === 'failed') {
    result.stopped = 'not_running';
    return result;
  }
  if (campaign.status === 'draft') {
    setCampaignStatus(db, campaignId, 'running', clock());
  }

  recoverCampaign(db, campaignId, clock(), leaseMs);

  for (;;) {
    if (opts.shouldStop?.()) {
      result.stopped = 'signal';
      break;
    }
    if (opts.maxSeconds !== undefined && clock() - startMs >= opts.maxSeconds * 1000) {
      result.stopped = 'time';
      break;
    }
    if (opts.limit !== undefined && result.claimed >= opts.limit) {
      result.stopped = 'limit';
      break;
    }

    campaign = getCampaign(db, campaignId);
    if (!campaign) {
      result.stopped = 'not_running';
      break;
    }
    if (campaign.status === 'paused') {
      result.stopped = 'paused';
      break;
    }
    if (campaign.status === 'cancelled') {
      result.stopped = 'cancelled';
      break;
    }

    const sentToday = sentInLastDay(db, campaign.account_id, clock());
    if (sentToday >= campaign.daily_cap) {
      // Finding #5: stays 'running' (never 'paused') specifically so createCampaignsJob's own
      // `WHERE status = 'running'` keeps re-checking this campaign every tick - the cap drains on
      // its own once enough of the rolling 24h window has aged out, with no operator action needed.
      const earliest = earliestSentInLastDay(db, campaign.account_id, clock());
      const cappedUntil = earliest !== null ? earliest + 24 * 60 * 60 * 1000 : null;
      setCampaignCapped(db, campaignId, cappedUntil, clock());
      result.stopped = 'daily_cap';
      break;
    }
    if (campaign.capped_until !== null) {
      // The window has drained enough to send again - clear the marker so the campaign no longer
      // reads as capped between now and the next time (if ever) it hits the cap again.
      clearCampaignCap(db, campaignId);
    }

    const row = claimNextRow(db, campaignId, owner, clock(), leaseMs, maxAttempts);
    if (!row) {
      const counts = campaignCounts(db, campaignId);
      if (counts.pending === 0 && counts.claimed === 0) {
        setCampaignStatus(db, campaignId, 'completed', clock());
        result.stopped = 'completed';
      } else {
        // Nothing claimable right now (every remaining row's lease is still held elsewhere) - not
        // an error, just nothing more this call can do.
        result.stopped = 'completed';
      }
      break;
    }
    result.claimed += 1;
    opts.onRowClaimed?.(row);

    const preflight = preflightRow(db, row, campaign);
    if (!preflight.ok) {
      markRowSkipped(db, row.id, owner, preflight.reason as string);
      result.skipped += 1;
      // §2.7: a skip costs no pacing delay - do not sleep, loop immediately.
      continue;
    }

    let rendered: ReturnType<typeof renderRow>;
    try {
      rendered = renderRow(campaign, row, config.trackingBaseUrl, config.trackingSecret as string);
    } catch (err) {
      // Finding #17: every throw here was recorded as skip_reason='unsafe_href', even a
      // TemplateError from a row whose vars fail to render at this point - preflightRow only ever
      // renders the SUBJECT via renderVars, so a row can pass preflight (subject-only) and still
      // fail here (body/text templates, which preflight never exercises). Branch on the actual
      // error type so the skip reason names what really happened.
      markRowSkipped(db, row.id, owner, err instanceof TemplateError ? 'missing_vars' : 'unsafe_href');
      result.skipped += 1;
      continue;
    }

    beginRowSubmit(db, row.id, owner, clock());
    opts.onSubmitBegan?.(row);

    const account = resolveAccount(db, config, campaign.account_id);
    // A campaign created with --dry-run is dryrun forever, regardless of what its account's own
    // stored transport is - the account's real transport must never be silently substituted in.
    const transport =
      campaign.dry_run === 1 && account.transport !== 'dryrun'
        ? resolveTransportForAccount({ ...account, transport: 'dryrun' }, config)
        : resolveTransportForAccount(account, config);

    const outcome = await sendMessage(
      { db, config, transport, clock },
      {
        account,
        addresses: [{ email: row.email, kind: 'to' }],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        track: campaign.track === 1,
        trackClicks: campaign.track_clicks === 1,
        optOutFooter: true,
        listUnsubscribe: true,
        campaignId,
        token: rendered.token,
      },
    );

    if (outcome.status === 'failed') {
      markRowFailed(db, row.id, owner, outcome.error ?? 'send failed', { retryable: true, maxAttempts });
      result.failed += 1;
    } else {
      markRowSent(db, row.id, owner, { messageId: outcome.messageId, recipientId: outcome.recipientId, sentAt: clock() });
      result.sent += 1;
      touchLastUsed(db, account.id === 'env' ? campaign.account_id : account.id, clock());
    }

    // §2.7: pacing is applied only after an actual submit attempt, never after a skip.
    const delay = nextDelayMs(campaign.rate_per_minute, campaign.jitter_ms, random);
    if (delay > 0) await sleep(delay);
  }

  return result;
}

/** Registered on the scheduler (`openpost serve`): drains every `running` campaign a little on each
 *  tick, so a long campaign makes progress without a dedicated foreground process.
 *
 *  Finding #8 (docs/reports/phase4_review.md): this used to call `runCampaignOnce(..., {limit: 50})`
 *  per running campaign with NO `maxSeconds`, and campaign pacing (`await sleep(delay)`) runs
 *  *inside* that call - `src/jobs/scheduler.ts` runs every due job strictly sequentially and awaits
 *  the whole tick before starting the next one, so at the default `CAMPAIGN_RATE_PER_MINUTE=20`
 *  (3s/row) a single tick could block for minutes, during which reminders, reply polling, prune, the
 *  ranges reload and the backup job simply never ran. `maxSeconds` now bounds the WHOLE job's
 *  wall-clock time (shared across however many campaigns are running, decremented as each one is
 *  drained) to roughly one `CAMPAIGN_TICK_SECONDS`-sized slice - other jobs never wait longer than
 *  about one extra tick for a slow/many-campaign backlog to get out of the way. */
export function createCampaignsJob(deps: CampaignDeps, opts: { intervalMs?: number; perTickLimit?: number; maxSeconds?: number } = {}): Job {
  const intervalMs = opts.intervalMs ?? 15_000;
  const maxSecondsTotal = opts.maxSeconds ?? Math.max(1, Math.floor(intervalMs / 1000));
  return {
    name: 'campaigns',
    intervalMs,
    async run(): Promise<{ detail?: unknown }> {
      const startMs = Date.now();
      const running = deps.db.prepare(`SELECT id FROM campaigns WHERE status = 'running'`).all() as Array<{ id: string }>;
      const results: CampaignRunResult[] = [];
      for (const row of running) {
        const remainingSeconds = maxSecondsTotal - (Date.now() - startMs) / 1000;
        if (remainingSeconds <= 0) break; // out of budget for this tick - the rest wait for the next one
        results.push(await runCampaignOnce(deps, row.id, { limit: opts.perTickLimit ?? 50, maxSeconds: remainingSeconds }));
      }
      return { detail: { drained: results.length, runningTotal: running.length } };
    },
  };
}
