import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  deleteMessageCascade,
  getClickEventsForRecipient,
  getClickTokensForMessage,
  getEventsForRecipient,
  getMessageDetail,
  getRecipient,
  listMessages,
} from '../../db/repo.js';
import { accuracyReport } from '../../db/report.js';
import { statsReport } from '../../db/stats.js';
import { listReminders, type ReminderStatus } from '../../db/reminders.js';
import { presentClickEvent, presentMessageDetail, presentMessageListRow, presentOpenEvent } from '../present.js';
import { apiAuthRequired, isValidApiBearer } from '../api-auth.js';
import { authenticateDashboard } from '../auth/session.js';
import { isCrossOriginRequest } from '../cors.js';
import { lookupThreads, type ThreadLookupQuery } from '../services/thread-lookup.js';
import { isValidTimeZone, parseDuration } from '../../core/time.js';
import { parseStatsWindow } from '../query.js';
import type { ServerDeps } from '../app.js';

const MESSAGE_STATUSES = new Set(['draft', 'sent', 'dryrun', 'failed', 'abandoned']);

function parseBoundedInt(
  value: string | undefined,
  def: number,
  opts: { min: number; max: number },
): number | null {
  if (value === undefined) return def;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < opts.min || n > opts.max) return null;
  return n;
}

export function registerApiRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { db, config } = deps;
  // finding #2: authentication must key on whether an API_TOKEN is configured at all, not on
  // BIND_ADDRESS - a loopback bind reached through an SSH tunnel or reverse proxy is still
  // reachable by anyone who can reach that tunnel/proxy. Shared with routes/stream.ts and
  // routes/reclassify.ts (§7.2) so every /api-prefixed route enforces the identical rule.
  const requireAuth = apiAuthRequired(config);

  app.register(
    async (instance) => {
      instance.addHook('onRequest', async (req, reply) => {
        if (!requireAuth) return;
        if (isValidApiBearer(config, req.headers['authorization'])) return;
        // docs/08_phase4_spec.md §6.2c (test 337): once CORS is enabled at all, a cross-origin
        // request (one carrying an `Origin` header) is authenticated by bearer ONLY - the dashboard
        // session cookie fallback below is a same-origin convenience that would otherwise become a
        // CSRF hole the moment `/api` is reachable cross-origin.
        if (config.apiCorsOrigins.length > 0 && isCrossOriginRequest(req)) {
          reply.code(401).send({ error: 'unauthorized' });
          return;
        }
        // Phase 3 (§2.4): the dashboard session cookie is accepted here too, so a dashboard page
        // that fetches `/api/*` client-side (none do today, but `/api/stats` and `/api/events/
        // stream` are meant to be reachable by the same session that renders the dashboard).
        if (authenticateDashboard(config, { headers: req.headers as Record<string, string | string[] | undefined> }, Date.now()).ok !== true) {
          reply.code(401).send({ error: 'unauthorized' });
        }
      });

      // docs/09_phase5_spec.md §6.4: /api/addon/* are 404 unless ADDON_ENABLED=true (test 415) and
      // 401 without a bearer when it is enabled (test 416, enforced by the hook above).
      instance.addHook('onRequest', async (req, reply) => {
        if (req.url.split('?')[0]?.startsWith('/api/addon/') && !config.addonEnabled) {
          reply.code(404).send({ error: 'not_found' });
        }
      });

      instance.get('/messages', async (req, reply) => {
        const query = req.query as { limit?: string; offset?: string; status?: string; tokens?: string };

        const limit = parseBoundedInt(query.limit, 20, { min: 1, max: 200 });
        if (limit === null) {
          reply.code(400);
          return { error: 'invalid_limit' };
        }
        const offset = parseBoundedInt(query.offset, 0, { min: 0, max: 1_000_000 });
        if (offset === null) {
          reply.code(400);
          return { error: 'invalid_offset' };
        }
        if (query.status !== undefined && !MESSAGE_STATUSES.has(query.status)) {
          reply.code(400);
          return { error: 'invalid_status' };
        }

        const listOpts: { limit?: number; offset?: number; status?: string } = { limit, offset };
        if (query.status !== undefined) listOpts.status = query.status;
        const rows = listMessages(db, listOpts);
        return { messages: rows.map(presentMessageListRow) };
      });

      instance.get('/messages/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const query = req.query as { tokens?: string };
        const detail = getMessageDetail(db, id);
        if (!detail) {
          reply.code(404);
          return { error: 'not_found' };
        }
        const clickTokens = getClickTokensForMessage(db, id);
        // finding #2: signed open/opt-out/click tokens let their bearer forge opens or suppress a
        // recipient, so they are omitted unless explicitly requested with `?tokens=1` - which,
        // when this instance requires a bearer at all, only an already-authenticated caller can do.
        const includeTokens = query.tokens === '1' || query.tokens === 'true';
        return presentMessageDetail(config, detail, clickTokens, { includeTokens });
      });

      // Phase 2 (§7.2): per-recipient event timeline, previously only available via `openpost show
      // --events`.
      instance.get('/recipients/:id/events', async (req, reply) => {
        const { id } = req.params as { id: string };
        const recipient = getRecipient(db, id);
        if (!recipient) {
          reply.code(404);
          return { error: 'not_found' };
        }
        return {
          recipientId: recipient.id,
          opens: getEventsForRecipient(db, id).map(presentOpenEvent),
          clicks: getClickEventsForRecipient(db, id).map(presentClickEvent),
        };
      });

      // Phase 2 (§7.2): the same numbers `openpost accuracy` prints. Phase 3 (§5) widens this into
      // a superset that also carries the new `stats` key (open/click rate, time-to-open buckets,
      // best-hour histogram) - every field this endpoint returned before Phase 3 is unchanged.
      instance.get('/stats', async (req, reply) => {
        const query = req.query as { since?: string; until?: string; tz?: string; view?: string };
        const nowMs = Date.now();
        const parseWhenMs = (v: string | undefined, fallback: number): number | null => {
          if (v === undefined) return fallback;
          if (/^\d+$/.test(v)) return Number(v);
          const dur = parseDuration(v);
          return dur !== null ? nowMs - dur : null;
        };
        // `accuracy` (Phase 2, unrelated to M6) keeps its historical all-time default - this
        // endpoint's own `sinceMs`/`untilMs`.
        const sinceMs = parseWhenMs(query.since, 0);
        const untilMs = parseWhenMs(query.until, nowMs);
        if (sinceMs === null || untilMs === null) {
          reply.code(400);
          return { error: 'invalid_since_or_until' };
        }
        const tz = query.tz ?? config.reportTimezone;
        if (!isValidTimeZone(tz)) {
          reply.code(400);
          return { error: 'invalid_tz' };
        }
        const view = query.view ?? 'all';
        if (!['all', 'accuracy', 'stats'].includes(view)) {
          reply.code(400);
          return { error: 'invalid_view' };
        }

        const accuracy = view !== 'stats' ? accuracyReport(db, sinceMs) : null;
        let stats = null;
        if (view !== 'accuracy') {
          // Phase 3.1 (M6): `stats` gets its OWN bounded window - an explicit `since`/`until` is
          // still honoured, but an omitted `since` defaults to the last STATS_DEFAULT_WINDOW_DAYS
          // (never all-time), and the span is capped at STATS_MAX_WINDOW_DAYS regardless, so this
          // endpoint can never be made to aggregate an unbounded number of recipient rows.
          let statsWindow;
          try {
            statsWindow = parseStatsWindow(query, {
              nowMs,
              defaultWindowDays: config.statsDefaultWindowDays,
              maxWindowDays: config.statsMaxWindowDays,
            });
          } catch {
            reply.code(400);
            return { error: 'invalid_since_or_until' };
          }
          stats = statsReport(db, { sinceMs: statsWindow.sinceMs, untilMs: statsWindow.untilMs, timeZone: tz });
        }

        if (view === 'accuracy') return accuracy;
        if (view === 'stats') return { stats };
        return { ...accuracy, stats };
      });

      // Phase 3 (§3): reminders visible over the API for external tooling.
      const RESULT_STATUSES: Array<ReminderStatus | 'all'> = ['pending', 'claimed', 'fired', 'skipped', 'cancelled', 'failed', 'all'];
      instance.get('/reminders', async (req, reply) => {
        const query = req.query as { status?: string; message?: string; limit?: string };
        const listOpts: Parameters<typeof listReminders>[1] = {};
        if (query.status !== undefined) {
          if (!RESULT_STATUSES.includes(query.status as ReminderStatus | 'all')) {
            reply.code(400);
            return { error: 'invalid_status' };
          }
          listOpts.status = query.status as ReminderStatus | 'all';
        }
        if (query.message !== undefined) listOpts.messageId = query.message;
        if (query.limit !== undefined) {
          const n = Number(query.limit);
          if (!Number.isInteger(n) || n < 1 || n > 1000) {
            reply.code(400);
            return { error: 'invalid_limit' };
          }
          listOpts.limit = n;
        }
        return { reminders: listReminders(db, listOpts) };
      });

      // Phase 3 (§7.2): the per-recipient view the dashboard renders, for external tooling.
      instance.get('/recipients/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const recipient = getRecipient(db, id);
        if (!recipient) {
          reply.code(404);
          return { error: 'not_found' };
        }
        return {
          id: recipient.id,
          messageId: recipient.message_id,
          email: recipient.email,
          state: recipient.state,
          openCount: recipient.open_count,
          machineOpenCount: recipient.machine_open_count,
          clickCount: recipient.click_count,
          repliedAt: recipient.replied_at,
          threadId: recipient.thread_id,
          reminders: listReminders(db, { messageId: recipient.message_id }).filter((r) => r.recipient_id === id),
        };
      });

      // Phase 2 (§7.2): erase a single message (its recipients/links cascade); distinct from
      // `openpost forget`, which erases every message for a given recipient address.
      instance.delete('/messages/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const detail = getMessageDetail(db, id);
        if (!detail) {
          reply.code(404);
          return { error: 'not_found' };
        }
        deleteMessageCascade(db, id);
        reply.code(204);
        return null;
      });

      // docs/08_phase4_spec.md §6.2a: the in-Gmail extension's server half. Each array is capped at
      // 100 entries (test 336); beyond that is a 400, not a silent truncation.
      instance.post('/threads/lookup', async (req, reply) => {
        const body = req.body as ThreadLookupQuery | null;
        if (body === null || typeof body !== 'object') {
          reply.code(400);
          return { error: 'invalid_body' };
        }
        for (const key of ['threadIds', 'rfc822MessageIds', 'subjects'] as const) {
          const arr = body[key];
          if (arr !== undefined && (!Array.isArray(arr) || arr.length > 100 || arr.some((v) => typeof v !== 'string'))) {
            reply.code(400);
            return { error: `invalid_${key}` };
          }
        }
        // Finding #13: recipients[] (raw addressee emails, including matches made by guessing a
        // normalised subject) is opt-in via ?recipients=1, and even then only over a REAL bearer
        // token - never the same-origin dashboard-cookie fallback this route's own onRequest hook
        // otherwise accepts, and never just because API_TOKEN happens to be unset (unlike the rest
        // of /api, which is then unauthenticated by existing, documented design).
        const includeRecipients = (req.query as { recipients?: string } | undefined)?.recipients === '1';
        if (includeRecipients && !(config.apiToken !== undefined && isValidApiBearer(config, req.headers['authorization']))) {
          reply.code(403);
          return { error: 'recipients_requires_bearer_token' };
        }
        const result = lookupThreads(db, body, { windowDays: config.threadLookupDays, includeRecipients });
        return result;
      });

      // Phase 4 (§2.11's dashboard pages, exposed here too for external tooling - test 343).
      instance.get('/campaigns', async (req, reply) => {
        const query = req.query as { status?: string; limit?: string };
        const limit = parseBoundedInt(query.limit, 50, { min: 1, max: 500 });
        if (limit === null) {
          reply.code(400);
          return { error: 'invalid_limit' };
        }
        const { listCampaigns } = await import('../../db/campaigns.js');
        const rows = listCampaigns(db, { status: (query.status as never) ?? 'all', limit });
        return { campaigns: rows };
      });

      instance.get('/campaigns/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const { getCampaign } = await import('../../db/campaigns.js');
        const { campaignReport } = await import('../../db/campaign-stats.js');
        const campaign = getCampaign(db, id);
        if (!campaign) {
          reply.code(404);
          return { error: 'not_found' };
        }
        return { campaign, report: campaignReport(db, id) };
      });

      // docs/09_phase5_spec.md §6.4-§6.5: the Gmail add-on's server half - gated by the two
      // onRequest hooks above (ADDON_ENABLED, then the bearer).
      const addonRateBuckets = new Map<string, { count: number; windowStartMs: number }>();
      function checkAddonRate(key: string, limitPerHour: number, nowMs: number): boolean {
        const bucket = addonRateBuckets.get(key);
        if (!bucket || nowMs - bucket.windowStartMs >= 3_600_000) {
          addonRateBuckets.set(key, { count: 1, windowStartMs: nowMs });
          return true;
        }
        bucket.count += 1;
        return bucket.count <= limitPerHour;
      }

      instance.post('/addon/track', async (req, reply) => {
        const authHeader = req.headers['authorization'];
        const bearerKey = (Array.isArray(authHeader) ? authHeader[0] : authHeader) ?? 'anon';
        const rateKey = createHash('sha256').update(bearerKey).digest('hex').slice(0, 16);
        if (!checkAddonRate(rateKey, config.addonRatePerHour, Date.now())) {
          reply.code(429);
          return { error: 'rate_limited' };
        }
        const { addonTrack, AddonError } = await import('../services/addon.js');
        try {
          const body = (req.body as Record<string, unknown>) ?? {};
          const result = addonTrack(db, config, {
            subject: typeof body.subject === 'string' ? body.subject : undefined,
            to: Array.isArray(body.to) ? (body.to as string[]) : undefined,
            cc: Array.isArray(body.cc) ? (body.cc as string[]) : undefined,
            bcc: Array.isArray(body.bcc) ? (body.bcc as string[]) : undefined,
            draftId: typeof body.draftId === 'string' ? body.draftId : undefined,
          });
          return result;
        } catch (err) {
          if (err instanceof AddonError) {
            reply.code(err.statusCode);
            return { error: err.message };
          }
          throw err;
        }
      });

      instance.post('/addon/link', async (req, reply) => {
        const { addonLink, AddonError } = await import('../services/addon.js');
        try {
          const body = (req.body as Record<string, unknown>) ?? {};
          const result = addonLink(db, config, {
            token: typeof body.token === 'string' ? body.token : undefined,
            gmailMessageId: typeof body.gmailMessageId === 'string' ? body.gmailMessageId : undefined,
            threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
            rfc822MessageId: typeof body.rfc822MessageId === 'string' ? body.rfc822MessageId : undefined,
            sentAt: typeof body.sentAt === 'number' ? body.sentAt : undefined,
          });
          return result;
        } catch (err) {
          if (err instanceof AddonError) {
            reply.code(err.statusCode);
            return { error: err.message };
          }
          throw err;
        }
      });

      instance.get('/addon/config', async () => {
        return {
          version: 1,
          trackingBaseUrl: config.trackingBaseUrl,
          linkPollMinutes: 5,
          pixelTemplate: '<img src="{{pixelUrl}}" width="1" height="1" alt="" style="display:none">',
        };
      });
    },
    { prefix: '/api' },
  );
}
