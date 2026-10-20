import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import {
  getAccount,
  getClickEvent,
  getClickEventsForRecipient,
  getEventsForRecipient,
  getMessage,
  getMessageDetail,
  getOpenEvent,
  getRecipient,
  countAddressees,
  countAuditLog,
  countMessagesFiltered,
  getDashboardMessageRow,
  listAuditLog,
  listDistinctAuditActions,
  listMessagesFiltered,
  type ExportRow,
} from '../../db/repo.js';
import { listReminders } from '../../db/reminders.js';
import { statsReport } from '../../db/stats.js';
import { accuracyReport } from '../../db/report.js';
import { CLICK_CLASSIFICATIONS, OPEN_CLASSIFICATIONS } from '../../types.js';
import { authenticateDashboard, verifyCsrf, type DashboardAuth } from '../auth/session.js';
import { parseAuditFilter, parseMessageFilter, parseStatsWindow, QueryValidationError } from '../../server/query.js';
import { exportRows, toCsv, toCsvGeneric } from '../../server/export.js';
import { html, render, type SafeHtml } from '../views/html.js';
import { layout } from '../views/layout.js';
import type { NavKey } from '../views/layout.js';
import { messagesPage } from '../views/pages/messages.js';
import { messagePage, type RecipientDetailModel } from '../views/pages/message.js';
import { eventPage } from '../views/pages/event.js';
import { auditPage, type AuditRowModel } from '../views/pages/audit.js';
import { statsPage } from '../views/pages/stats.js';
import { remindersPage } from '../views/pages/reminders.js';
import { campaignsPage } from '../views/pages/campaigns.js';
import { campaignPage, campaignProgressFragment } from '../views/pages/campaign.js';
import { settingsPage } from '../views/pages/settings.js';
import { campaignCounts, getCampaign, listCampaigns, listRows, type CampaignRowStatus } from '../../db/campaigns.js';
import { campaignReport } from '../../db/campaign-stats.js';
import type { EventItemModel, MessageRowModel, RecipientRowModel } from '../views/fragments.js';
import { messageRow, recipientRow, eventItem } from '../views/fragments.js';
import { registerDashboardActions } from './dashboard-actions.js';
import { registerComposeRoutes } from './compose.js';
import type { ResolvedServerDeps } from '../app.js';

// Phase 5 (§2.6): manifest-src/worker-src are additive - both previously fell through to
// `default-src 'none'`, which blocks a manifest and a service worker outright. No
// 'unsafe-inline'/'unsafe-eval' anywhere, before or after this change.
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; " +
  "img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; " +
  "frame-ancestors 'none'; manifest-src 'self'; worker-src 'self'";

/** Security headers shared by every dashboard response (§2.3) - deliberately excludes
 *  `Content-Type`, which callers set themselves (`text/html` for pages/fragments, `text/csv`/
 *  `application/json` for exports and action responses) so this can run unconditionally in the
 *  `onRequest` hook without pre-empting a non-HTML route's own content type.
 *
 *  Phase 5 deviation (docs/09_phase5_spec.md §2.2 vs the Phase 3.1 hardening pass): `Referrer-Policy`
 *  was `no-referrer` through Phase 4. The compose page's plain `<form method="post">` (§2.2 requires
 *  a real, non-AJAX submission, not an htmx fetch()) turned out to interact with `no-referrer` in a
 *  way the CSRF check couldn't see coming: per the Fetch/HTML spec, a top-level navigation request's
 *  `Origin` header is itself governed by the referrer policy - under `no-referrer` a browser sends
 *  the literal string `Origin: null` even for a same-origin form POST, which the CSRF preHandler's
 *  same-origin check (correctly) cannot distinguish from a hostile cross-origin submission and
 *  rejected with 403 (found by the mobile Playwright suite - test 437 failed 403 on every real
 *  four-tap send). `fetch()`-based htmx POSTs (every other dashboard form) were never affected -
 *  only a genuine document-navigation form hits this. `same-origin` keeps the actual hardening
 *  property (nothing is ever sent to a third-party origin, exactly as `no-referrer` promised) while
 *  restoring the same-origin `Origin`/`Referer` headers those requests need; every dashboard page is
 *  same-origin with every other, so nothing new is disclosed. */
export function setDashboardHeaders(reply: FastifyReply): void {
  reply
    .header('Content-Security-Policy', CSP)
    .header('Referrer-Policy', 'same-origin')
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Frame-Options', 'DENY')
    .header('Cache-Control', 'no-store')
    .header('Cross-Origin-Opener-Policy', 'same-origin')
    .header('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), interest-cohort=()');
}

export function setHtmlContentType(reply: FastifyReply): void {
  reply.header('Content-Type', 'text/html; charset=utf-8');
}

declare module 'fastify' {
  interface FastifyRequest {
    dashboardAuth: DashboardAuth | undefined;
  }
}

export function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function renderPage(
  reply: FastifyReply,
  config: AppConfig,
  opts: { title: string; active: NavKey | null; body: SafeHtml; csrf: string; flash?: { kind: 'info' | 'error'; text: string } | null; page?: 'compose' },
): void {
  setHtmlContentType(reply);
  const html_ = layout({
    title: opts.title,
    active: opts.active,
    body: opts.body,
    csrf: opts.csrf,
    live: config.dashboardLive,
    flash: opts.flash ?? null,
    pwaEnabled: config.pwaEnabled,
    composeEnabled: config.composeEnabled,
    page: opts.page,
  });
  reply.send(render(html_));
}

function notFoundPage(reply: FastifyReply, config: AppConfig, csrf: string, what: string): void {
  reply.code(404);
  renderPage(reply, config, { title: 'Not found', active: null, csrf, body: html`<h1>Not found</h1><p>${what} was not found.</p>` });
}

// Phase 3.1 (L1): `flash`/`flashKind` used to render whatever text a query string carried, verbatim
// (escaped, so never an XSS vector, but still a content-spoofing surface - a crafted link could put
// arbitrary "system" text in front of an already-authenticated dashboard user). Every flash message
// is now a fixed, enum-keyed string the server itself owns; an unrecognised or missing key renders
// nothing.
export const FLASH_MESSAGES: Record<string, { kind: 'info' | 'error'; text: string }> = {
  muted: { kind: 'info', text: 'Notifications muted for this message.' },
  unmuted: { kind: 'info', text: 'Notifications unmuted for this message.' },
  reminder_cancelled: { kind: 'info', text: 'Reminder cancelled.' },
  // Phase 5 (§2.3, §4.5)
  sent: { kind: 'info', text: 'Message sent.' },
  sent_partial: { kind: 'error', text: 'Message sent, but one or more recipients failed - see the per-recipient status below.' },
  push_enabled: { kind: 'info', text: 'Push notifications enabled on this device.' },
  push_disabled: { kind: 'info', text: 'Push notifications disabled on this device.' },
  compose_discarded: { kind: 'info', text: 'Draft discarded.' },
};

function flashFromQuery(query: Record<string, string | undefined>): { kind: 'info' | 'error'; text: string } | null {
  if (!query.flash) return null;
  return FLASH_MESSAGES[query.flash] ?? null;
}

function csrfTokenFromReq(req: FastifyRequest, config: AppConfig): string {
  const auth = req.dashboardAuth;
  if (auth?.ok && auth.via === 'session' && auth.sid) {
    return csrfTokenForSid(config, auth.sid);
  }
  return '';
}

// Re-exported here to avoid a second import line at every call site above.
import { csrfTokenFor as csrfTokenForSid } from '../auth/session.js';

function buildOpenEventModel(e: ReturnType<typeof getOpenEvent>, csrf: string, nowMs: number): EventItemModel {
  if (!e) throw new Error('unreachable');
  return {
    kind: 'open',
    id: e.id,
    occurredAt: e.occurred_at,
    classification: e.classification,
    confidence: e.confidence,
    counted: e.counted === 1,
    reasons: e.reason ? e.reason.split(',') : [],
    uaFamily: e.ua_family,
    deviceType: e.device_type,
    linkUrl: null,
    overridden: e.overridden_at !== null,
    originalClassification: e.original_classification,
    validClassifications: [...OPEN_CLASSIFICATIONS],
    csrf,
    nowMs,
  };
}

function buildClickEventModel(e: ReturnType<typeof getClickEvent>, linkUrl: string | null, csrf: string, nowMs: number): EventItemModel {
  if (!e) throw new Error('unreachable');
  return {
    kind: 'click',
    id: e.id,
    occurredAt: e.occurred_at,
    classification: e.classification,
    confidence: e.confidence,
    counted: e.counted === 1,
    reasons: e.reason ? e.reason.split(',') : [],
    uaFamily: e.ua_family,
    deviceType: e.device_type,
    linkUrl,
    overridden: e.overridden_at !== null,
    originalClassification: e.original_classification,
    validClassifications: [...CLICK_CLASSIFICATIONS],
    csrf,
    nowMs,
  };
}

export function registerDashboardRoutes(app: FastifyInstance, deps: ResolvedServerDeps): void {
  const { db, config } = deps;

  app.register(
    async (instance) => {
      instance.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(body as string)));
        } catch (err) {
          done(err as Error, undefined);
        }
      });

      instance.decorateRequest('dashboardAuth', undefined);

      instance.addHook('onRequest', async (req, reply) => {
        setDashboardHeaders(reply);
        const isLoginRoute = req.url.split('?')[0] === '/dashboard/login';
        if (isLoginRoute) return;

        const auth = authenticateDashboard(config, { headers: req.headers as Record<string, string | string[] | undefined> }, Date.now());
        req.dashboardAuth = auth;
        if (auth.ok) return;

        const wantsHtml = req.method === 'GET';
        if (wantsHtml && config.dashboardPassword !== undefined) {
          const next = encodeURIComponent(req.url);
          reply.code(302).header('Location', `/dashboard/login?next=${next}`).send();
          return;
        }
        reply.code(401).header('Content-Type', 'text/plain; charset=utf-8').send(
          'unauthorized - set DASHBOARD_PASSWORD (for a browser session) or API_TOKEN (for a bearer client)',
        );
      });

      instance.addHook('preHandler', async (req, reply) => {
        if (req.method !== 'POST') return;
        if (req.url.split('?')[0] === '/dashboard/login') return;
        const auth = req.dashboardAuth;
        if (!auth?.ok) return; // already rejected in onRequest
        // A bearer client presents its own `Authorization` header explicitly on every request -
        // there is no ambient browser credential for a hostile origin to piggyback on, so CSRF
        // never applies to `via: 'bearer'`.
        if (auth.via === 'bearer') return;
        // Phase 3.1 (M1): the zero-config "open" (loopback, no secret) mode has no session cookie
        // and therefore no unguessable `_csrf` token to compare either - but the request still
        // rides on an ambient credential in the sense that ANY request reaching this process at all
        // is implicitly trusted, so a same-origin/no-Referer check still belongs here: it is the
        // only thing standing between "loopback dev with no password" and a hostile page's
        // cross-origin form POST (verified: cross-origin POST to /dashboard/actions/mute in open
        // mode used to succeed). Only the token comparison below is skipped for `via: 'open'`.

        const origin = firstHeader(req.headers['origin']);
        if (origin !== undefined) {
          let sameOrigin = false;
          try {
            const originHost = new URL(origin).host;
            const selfHost = firstHeader(req.headers['host']);
            sameOrigin = originHost === selfHost;
          } catch {
            sameOrigin = false;
          }
          if (!sameOrigin) {
            reply.code(403).send({ error: 'csrf' });
            return;
          }
        } else {
          const referer = firstHeader(req.headers['referer']);
          if (referer !== undefined) {
            try {
              const refHost = new URL(referer).host;
              const selfHost = firstHeader(req.headers['host']);
              if (refHost !== selfHost) {
                reply.code(403).send({ error: 'csrf' });
                return;
              }
            } catch {
              reply.code(403).send({ error: 'csrf' });
              return;
            }
          }
        }

        // `via: 'open'` has no session id and no `_csrf` token to check - the same-origin check
        // above is its only defence, by design (M1).
        if (auth.via === 'open') return;

        const sid = auth.sid;
        const body = req.body as Record<string, string> | undefined;
        const headerToken = firstHeader(req.headers['x-openpost-csrf']);
        const submitted = body?._csrf ?? headerToken;
        if (!sid || !verifyCsrf(config, sid, submitted)) {
          reply.code(403).send({ error: 'csrf' });
        }
      });

      // --- pages ---------------------------------------------------------------------------

      instance.get('/', async (req, reply) => {
        const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
        reply.code(302).header('Location', `/dashboard/messages${qs}`).send();
      });

      instance.get('/messages', async (req, reply) => {
        const query = req.query as Record<string, string | undefined>;
        let parsed;
        try {
          parsed = parseMessageFilter(query, { nowMs: Date.now(), defaultLimit: config.dashboardPageSize });
        } catch (err) {
          if (err instanceof QueryValidationError) {
            reply.code(400);
            return renderPage(reply, config, { title: 'Messages', active: 'messages', csrf: csrfTokenFromReq(req, config), body: html`<h1>Messages</h1><p class="flash flash-error">${err.message}</p>` });
          }
          throw err;
        }
        const nowMs = Date.now();
        const total = countMessagesFiltered(db, parsed.filter);
        const rows = listMessagesFiltered(db, parsed.filter, parsed);
        const model: MessageRowModel[] = rows.map((r) => ({
          id: r.message.id,
          sentAt: r.message.sent_at,
          subject: r.message.subject,
          toEmails: r.toEmails,
          worstState: r.worstState,
          countedOpens: r.aggregate.countedOpens,
          totalOpens: r.aggregate.countedOpens + r.aggregate.machineOpens,
          machineOpens: r.aggregate.machineOpens,
          clicks: r.aggregate.clicks,
          repliedCount: r.repliedCount,
          recipientCount: r.recipientCount,
          pendingReminder: r.pendingReminder,
          nowMs,
          status: r.message.status,
        }));
        renderPage(reply, config, {
          title: 'Messages',
          active: 'messages',
          csrf: csrfTokenFromReq(req, config),
          flash: flashFromQuery(query),
          body: messagesPage({ rows: model, total, filter: parsed.filter, limit: parsed.limit, offset: parsed.offset, sort: parsed.sort, nowMs }),
        });
      });

      instance.get('/messages/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const detail = getMessageDetail(db, id);
        if (!detail) return notFoundPage(reply, config, csrfTokenFromReq(req, config), 'Message');
        const csrf = csrfTokenFromReq(req, config);
        const nowMs = Date.now();

        const recipients: RecipientDetailModel[] = detail.recipients.map((r) => {
          const opens = getEventsForRecipient(db, r.id);
          const clicks = getClickEventsForRecipient(db, r.id);
          const linksById = new Map(detail.links.map((l) => [l.id, l.url]));
          const timeline: EventItemModel[] = [
            ...opens.map((o) => buildOpenEventModel(o, csrf, nowMs)),
            ...clicks.map((c) => buildClickEventModel(c, linksById.get(c.link_id) ?? null, csrf, nowMs)),
          ].sort((a, b) => a.occurredAt - b.occurredAt);
          const reminders = listReminders(db, { messageId: id }).filter((rem) => rem.recipient_id === r.id);
          const isSingle = detail.message.recipient_mode === 'single';
          const row: RecipientRowModel = {
            id: r.id,
            messageId: id,
            email: r.email,
            kind: r.kind,
            state: r.state,
            openCount: r.open_count,
            machineOpenCount: r.machine_open_count,
            clickCount: r.click_count,
            repliedAt: r.replied_at,
            pendingReminder: reminders.some((rm) => rm.status === 'pending' || rm.status === 'claimed'),
            nowMs,
            isAggregate: r.is_aggregate === 1,
            isSingleMode: isSingle,
            recipientCount: r.is_aggregate === 1 ? countAddressees(db, id) : undefined,
          };
          return {
            row,
            sentAt: r.sent_at,
            timeToOpenMs: r.first_open_at !== null && r.sent_at !== null && r.first_open_at >= r.sent_at ? r.first_open_at - r.sent_at : null,
            threadId: r.thread_id,
            rfc822MsgId: r.rfc822_msg_id,
            timeline,
            replyAt: r.replied_at,
            replyMsgId: r.reply_msg_id,
            reminders: reminders.map((rm) => ({ id: rm.id, condition: rm.condition, dueAt: rm.due_at, status: rm.status })),
          };
        });

        renderPage(reply, config, {
          title: detail.message.subject,
          active: 'messages',
          csrf,
          body: messagePage({
            id: detail.message.id,
            subject: detail.message.subject,
            status: detail.message.status,
            sentAt: detail.message.sent_at,
            createdAt: detail.message.created_at,
            transport: (getAccount(db, detail.message.account_id)?.transport) ?? 'unknown',
            selfCopyStrategy: detail.message.self_copy_strategy,
            muted: detail.message.notify_muted === 1,
            trackingEnabled: detail.message.tracking_enabled === 1,
            clickTrackingEnabled: detail.message.click_tracking_enabled === 1,
            recipients,
            csrf,
            nowMs,
            recipientMode: detail.message.recipient_mode,
          }),
        });
      });

      instance.get('/events/:kind/:id', async (req, reply) => {
        const { kind, id } = req.params as { kind: string; id: string };
        if (kind !== 'open' && kind !== 'click') return notFoundPage(reply, config, csrfTokenFromReq(req, config), 'Event');
        const csrf = csrfTokenFromReq(req, config);
        const nowMs = Date.now();

        let eventModel: EventItemModel;
        let recipientId: string;
        let classification: string;
        let signalRow: { ip_hash: string | null; ip_net_hash: string | null; ua: string | null; os: string | null; country: string | null; region: string | null; city: string | null };
        if (kind === 'open') {
          const eventRow = getOpenEvent(db, id);
          if (!eventRow) return notFoundPage(reply, config, csrf, 'Event');
          recipientId = eventRow.recipient_id;
          classification = eventRow.classification;
          signalRow = eventRow;
          eventModel = buildOpenEventModel(eventRow, csrf, nowMs);
        } else {
          const eventRow = getClickEvent(db, id);
          if (!eventRow) return notFoundPage(reply, config, csrf, 'Event');
          recipientId = eventRow.recipient_id;
          classification = eventRow.classification;
          signalRow = eventRow;
          const linkUrl = getMessageDetail(db, getRecipient(db, eventRow.recipient_id)?.message_id ?? '')?.links.find((l) => l.id === eventRow.link_id)?.url ?? null;
          eventModel = buildClickEventModel(eventRow, linkUrl, csrf, nowMs);
        }
        const recipient = getRecipient(db, recipientId);
        if (!recipient) return notFoundPage(reply, config, csrf, 'Event');
        const message = getMessage(db, recipient.message_id);

        const proxied = ['google_proxy_prefetch', 'apple_mpp'].includes(classification);
        renderPage(reply, config, {
          title: `Event ${kind}`,
          active: 'messages',
          csrf,
          body: eventPage({
            event: eventModel,
            messageId: recipient.message_id,
            messageSubject: message?.subject ?? '(deleted)',
            recipientId: recipient.id,
            recipientEmail: recipient.email,
            signals: {
              ipHashPrefix: signalRow.ip_hash ? signalRow.ip_hash.slice(0, 8) : null,
              ipNetHashPrefix: signalRow.ip_net_hash ? signalRow.ip_net_hash.slice(0, 8) : null,
              ua: signalRow.ua,
              os: signalRow.os,
              country: signalRow.country,
              region: signalRow.region,
              city: signalRow.city,
              proxied,
            },
            csrf,
          }),
        });
      });

      instance.get('/audit', async (req, reply) => {
        const query = req.query as Record<string, string | undefined>;
        let parsed;
        try {
          parsed = parseAuditFilter(query, { nowMs: Date.now(), defaultLimit: 50 });
        } catch (err) {
          if (err instanceof QueryValidationError) {
            reply.code(400);
            return renderPage(reply, config, { title: 'Audit', active: 'audit', csrf: csrfTokenFromReq(req, config), body: html`<h1>Audit log</h1><p class="flash flash-error">${err.message}</p>` });
          }
          throw err;
        }
        const total = countAuditLog(db, parsed.filter);
        const rows = listAuditLog(db, parsed.filter, parsed);
        const modelRows: AuditRowModel[] = rows.map((r) => {
          let detail: unknown = null;
          try {
            detail = r.detail_json ? JSON.parse(r.detail_json) : null;
          } catch {
            detail = r.detail_json;
          }
          let reclassifyDiff: { before: string; after: string } | null = null;
          if (r.action === 'reclassify.override' && detail && typeof detail === 'object') {
            const d = detail as { before?: { classification?: string }; after?: { classification?: string } };
            if (d.before?.classification && d.after?.classification) {
              reclassifyDiff = { before: d.before.classification, after: d.after.classification };
            }
          }
          return { id: r.id, at: r.at, actor: r.actor, action: r.action, subjectType: r.subject_type, subjectId: r.subject_id, detail, reclassifyDiff };
        });
        renderPage(reply, config, {
          title: 'Audit log',
          active: 'audit',
          csrf: csrfTokenFromReq(req, config),
          body: auditPage({ rows: modelRows, total, filter: parsed.filter, limit: parsed.limit, offset: parsed.offset, distinctActions: listDistinctAuditActions(db) }),
        });
      });

      instance.get('/stats', async (req, reply) => {
        const query = req.query as Record<string, string | undefined>;
        let window;
        try {
          window = parseStatsWindow(query, {
            nowMs: Date.now(),
            defaultWindowDays: config.statsDefaultWindowDays,
            maxWindowDays: config.statsMaxWindowDays,
          });
        } catch (err) {
          if (err instanceof QueryValidationError) {
            reply.code(400);
            return renderPage(reply, config, { title: 'Stats', active: 'stats', csrf: csrfTokenFromReq(req, config), body: html`<h1>Stats</h1><p class="flash flash-error">${err.message}</p>` });
          }
          throw err;
        }
        const stats = statsReport(db, { sinceMs: window.sinceMs, untilMs: window.untilMs, timeZone: config.reportTimezone });
        const accuracy = accuracyReport(db, window.sinceMs);
        renderPage(reply, config, { title: 'Stats', active: 'stats', csrf: csrfTokenFromReq(req, config), body: statsPage({ stats, accuracy }) });
      });

      instance.get('/reminders', async (req, reply) => {
        const rows = listReminders(db, { status: 'all', limit: 500 });
        const withNames = rows.map((r) => ({
          ...r,
          messageSubject: getMessage(db, r.message_id)?.subject ?? '(deleted)',
          recipientEmail: r.recipient_id ? (getRecipient(db, r.recipient_id)?.email ?? null) : null,
        }));
        renderPage(reply, config, {
          title: 'Reminders',
          active: 'reminders',
          csrf: csrfTokenFromReq(req, config),
          flash: flashFromQuery(req.query as Record<string, string | undefined>),
          body: remindersPage({ rows: withNames, csrf: csrfTokenFromReq(req, config), nowMs: Date.now() }),
        });
      });

      instance.get('/campaigns', async (req, reply) => {
        const rows = listCampaigns(db, { status: 'all', limit: 200 });
        const withCounts = rows.map((row) => {
          const counts = campaignCounts(db, row.id);
          const report = campaignReport(db, row.id);
          return { row, sent: counts.sent, opened: report.opened, skipped: counts.skipped, failed: counts.failed, pending: counts.pending, claimed: counts.claimed };
        });
        renderPage(reply, config, {
          title: 'Campaigns',
          active: 'campaigns',
          csrf: csrfTokenFromReq(req, config),
          flash: flashFromQuery(req.query as Record<string, string | undefined>),
          body: campaignsPage({ campaigns: withCounts, nowMs: Date.now() }),
        });
      });

      instance.get('/campaigns/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const query = req.query as { status?: string };
        const campaign = getCampaign(db, id);
        if (!campaign) {
          return notFoundPage(reply, config, csrfTokenFromReq(req, config), 'Campaign');
        }
        const statusFilter = (query.status ?? 'all') as CampaignRowStatus | 'all';
        const rows = listRows(db, id, { status: statusFilter, limit: 500 });
        const report = campaignReport(db, id);
        renderPage(reply, config, {
          title: campaign.name,
          active: 'campaigns',
          csrf: csrfTokenFromReq(req, config),
          body: campaignPage({ campaign, report, rows, rowsStatusFilter: statusFilter, csrf: csrfTokenFromReq(req, config), nowMs: Date.now() }),
        });
      });

      instance.get('/campaigns/:id/rows.csv', async (req, reply) => {
        const { id } = req.params as { id: string };
        const query = req.query as { status?: string };
        const campaign = getCampaign(db, id);
        if (!campaign) {
          reply.code(404);
          return 'not found';
        }
        const statusFilter = (query.status ?? 'all') as CampaignRowStatus | 'all';
        const rows = listRows(db, id, { status: statusFilter, limit: config.dashboardMaxExportRows });
        setDashboardHeaders(reply);
        reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="${campaign.id}-rows.csv"`);
        return toCsvGeneric(
          rows.map((r) => ({ row_index: r.row_index, email: r.email, variant: r.variant, status: r.status, skip_reason: r.skip_reason ?? '', last_error: r.last_error ?? '' })),
          ['row_index', 'email', 'variant', 'status', 'skip_reason', 'last_error'],
        );
      });

      instance.get('/settings', async (req, reply) => {
        const { listAllSubscriptions } = await import('../../db/push.js');
        const auth = req.dashboardAuth;
        renderPage(reply, config, {
          title: 'Settings',
          active: 'settings',
          csrf: csrfTokenFromReq(req, config),
          flash: flashFromQuery(req.query as Record<string, string | undefined>),
          body: settingsPage({
            csrf: csrfTokenFromReq(req, config),
            pwaEnabled: config.pwaEnabled,
            webpushConfigured: config.vapidPublicKey !== undefined && config.vapidPrivateKey !== undefined,
            vapidPublicKey: config.vapidPublicKey ?? null,
            subscriptions: listAllSubscriptions(db),
            nowMs: Date.now(),
            sessionVia: auth?.ok ? auth.via : null,
            dashboardSessionHours: config.dashboardSessionHours,
          }),
        });
      });

      // --- fragments (live-replacement targets) ---------------------------------------------

      instance.get('/fragments/campaign/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const campaign = getCampaign(db, id);
        if (!campaign) {
          reply.code(404);
          return '';
        }
        const report = campaignReport(db, id);
        setDashboardHeaders(reply);
        setHtmlContentType(reply);
        return render(campaignProgressFragment({ campaign, report }));
      });

      instance.get('/fragments/recipient/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const r = getRecipient(db, id);
        if (!r) {
          reply.code(404);
          return '';
        }
        const reminders = listReminders(db, { messageId: r.message_id }).filter((rem) => rem.recipient_id === r.id);
        const parentMessage = getMessage(db, r.message_id);
        const isSingle = parentMessage?.recipient_mode === 'single';
        setDashboardHeaders(reply);
        setHtmlContentType(reply);
        return render(
          recipientRow({
            id: r.id,
            messageId: r.message_id,
            email: r.email,
            kind: r.kind,
            state: r.state,
            openCount: r.open_count,
            machineOpenCount: r.machine_open_count,
            clickCount: r.click_count,
            repliedAt: r.replied_at,
            pendingReminder: reminders.some((rm) => rm.status === 'pending' || rm.status === 'claimed'),
            nowMs: Date.now(),
            isAggregate: r.is_aggregate === 1,
            isSingleMode: isSingle,
            recipientCount: r.is_aggregate === 1 ? countAddressees(db, r.message_id) : undefined,
          }),
        );
      });

      instance.get('/fragments/message-row/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const target = getDashboardMessageRow(db, id);
        if (!target) {
          reply.code(404);
          return '';
        }
        setDashboardHeaders(reply);
        setHtmlContentType(reply);
        const nowMs = Date.now();
        return render(
          messageRow({
            id: target.message.id,
            sentAt: target.message.sent_at,
            subject: target.message.subject,
            toEmails: target.toEmails,
            worstState: target.worstState,
            countedOpens: target.aggregate.countedOpens,
            totalOpens: target.aggregate.countedOpens + target.aggregate.machineOpens,
            machineOpens: target.aggregate.machineOpens,
            clicks: target.aggregate.clicks,
            repliedCount: target.repliedCount,
            recipientCount: target.recipientCount,
            pendingReminder: target.pendingReminder,
            nowMs,
            status: target.message.status,
          }),
        );
      });

      instance.get('/fragments/event/:kind/:id', async (req, reply) => {
        const { kind, id } = req.params as { kind: string; id: string };
        if (kind !== 'open' && kind !== 'click') {
          reply.code(404);
          return '';
        }
        const csrf = csrfTokenFromReq(req, config);
        const eventRow = kind === 'open' ? getOpenEvent(db, id) : getClickEvent(db, id);
        if (!eventRow) {
          reply.code(404);
          return '';
        }
        setDashboardHeaders(reply);
        setHtmlContentType(reply);
        const model = kind === 'open' ? buildOpenEventModel(eventRow as ReturnType<typeof getOpenEvent>, csrf, Date.now()) : buildClickEventModel(eventRow as ReturnType<typeof getClickEvent>, null, csrf, Date.now());
        return render(eventItem(model));
      });

      // --- export --------------------------------------------------------------------------

      instance.get('/export.csv', async (req, reply) => {
        const query = req.query as Record<string, string | undefined>;
        let parsed;
        try {
          parsed = parseMessageFilter(query, { nowMs: Date.now(), defaultLimit: config.dashboardPageSize });
        } catch (err) {
          if (err instanceof QueryValidationError) {
            reply.code(400);
            return { error: err.message };
          }
          throw err;
        }
        const { rows, overLimit } = exportRows(db, parsed.filter, config.dashboardMaxExportRows);
        if (overLimit) {
          reply.code(413);
          return { error: 'too_many_rows', variable: 'DASHBOARD_MAX_EXPORT_ROWS' };
        }
        const csv = toCsv(rows);
        const dateStr = new Date().toISOString().slice(0, 10);
        reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="openpost-export-${dateStr}.csv"`)
          .header('Cache-Control', 'no-store');
        return csv;
      });

      instance.get('/export.json', async (req, reply) => {
        const query = req.query as Record<string, string | undefined>;
        let parsed;
        try {
          parsed = parseMessageFilter(query, { nowMs: Date.now(), defaultLimit: config.dashboardPageSize });
        } catch (err) {
          if (err instanceof QueryValidationError) {
            reply.code(400);
            return { error: err.message };
          }
          throw err;
        }
        const { rows, overLimit } = exportRows(db, parsed.filter, config.dashboardMaxExportRows);
        if (overLimit) {
          reply.code(413);
          return { error: 'too_many_rows', variable: 'DASHBOARD_MAX_EXPORT_ROWS' };
        }
        reply.header('Cache-Control', 'no-store');
        return { generatedAt: Date.now(), filter: parsed.filter, count: rows.length, rows };
      });

      registerComposeRoutes(instance, deps, { csrfTokenFromReq });
      registerDashboardActions(instance, deps, { csrfTokenFromReq });
    },
    { prefix: '/dashboard' },
  );
}

export type { ExportRow };
