import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { audit, getMessage, setMute } from '../../db/repo.js';
import { cancelReminder, getReminder } from '../../db/reminders.js';
import { getCampaign, transitionCampaignStatus } from '../../db/campaigns.js';
import { reclassify, ReclassifyInvalidError, ReclassifyNotFoundError } from '../services/reclassify.js';
import { hashIp } from '../../core/privacy.js';
import {
  CSRF_COOKIE_NAME,
  DASHBOARD_COOKIE_PATH,
  SESSION_COOKIE_NAME,
  issueSession,
  resolveSecureCookies,
  serializeCookie,
} from '../auth/session.js';
import { render } from '../views/html.js';
import { loginPage } from '../views/pages/login.js';
import { eventItem } from '../views/fragments.js';
import { getOpenEvent, getClickEvent } from '../../db/repo.js';
import { OPEN_CLASSIFICATIONS, CLICK_CLASSIFICATIONS } from '../../types.js';
import { countActiveSubscriptions, deleteSubscriptionById, getSubscriptionByEndpoint, upsertSubscription } from '../../db/push.js';
import { isPrivateOrLoopbackHost, type AppConfig } from '../../config/env.js';
import type { ResolvedServerDeps } from '../app.js';
import { firstHeader, setDashboardHeaders, setHtmlContentType } from './dashboard.js';

interface Bucket {
  count: number;
  windowStartMs: number;
}
const loginAttempts = new Map<string, Bucket>();
const LOGIN_RATE_WINDOW_MS = 60_000;
// Phase 3.1 (L6): this map is process-lifetime and keyed by IP hash, so an operator-facing login
// endpoint hit from many distinct addresses (or over a long uptime) would otherwise grow without
// bound - sweep expired windows at most once per window instead of on every single call.
let lastSweepAtMs = 0;

/** Test-only: the rate limiter is a module-level, process-lifetime bucket (the whole point is that
 *  it survives across requests) - tests that exercise it need a way to start from empty rather than
 *  bleeding state from an earlier test that happened to hash to the same key. */
export function _resetLoginRateLimiterForTests(): void {
  loginAttempts.clear();
  lastSweepAtMs = 0;
}

function sweepExpiredLoginBuckets(nowMs: number): void {
  if (nowMs - lastSweepAtMs < LOGIN_RATE_WINDOW_MS) return;
  lastSweepAtMs = nowMs;
  for (const [key, bucket] of loginAttempts) {
    if (nowMs - bucket.windowStartMs >= LOGIN_RATE_WINDOW_MS) loginAttempts.delete(key);
  }
}

function checkLoginRate(key: string, limitPerMin: number, nowMs: number): boolean {
  sweepExpiredLoginBuckets(nowMs);
  const bucket = loginAttempts.get(key);
  if (!bucket || nowMs - bucket.windowStartMs >= LOGIN_RATE_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, windowStartMs: nowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limitPerMin;
}

function isSafeNextPath(next: unknown): string {
  if (typeof next === 'string' && next.startsWith('/dashboard') && !next.startsWith('//')) return next;
  return '/dashboard';
}

/** Phase 3.1 (L3): resolves an untrusted `Referer` header to a same-origin path, or `null` when it
 *  is absent, unparsable, or names a different host - never redirect to an attacker-controlled
 *  external URL just because it showed up in a request header. */
function safeSameOriginPath(referer: string | undefined, selfHost: string | undefined): string | null {
  if (referer === undefined || selfHost === undefined) return null;
  try {
    const url = new URL(referer);
    if (url.host !== selfHost) return null;
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

/** Phase 3.1 (L4): an operator-facing free-text field with no server-side bound - a very large
 *  `note` (the finding used 20 000 characters) is stored and rendered on every reminder/audit view
 *  indefinitely. Mirrors the note the CLI's own `--note` accepts (docs/06_phase3_spec.md §3.1). */
const MAX_NOTE_LENGTH = 500;

function boundedNote(note: string): string {
  return note.length > MAX_NOTE_LENGTH ? note.slice(0, MAX_NOTE_LENGTH) : note;
}

/** Hash-then-compare (same trick as `src/server/api-auth.ts`): both operands are normalised to a
 *  fixed 32-byte digest before the constant-time comparison, so there is no length-mismatch branch
 *  to time either. */
function timingSafePasswordEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Finding #4 (phase5.1): a Web Push subscription endpoint is the one attacker-influenced URL the
 * server is ever asked to POST to - every OTHER operator-configured notify URL (Slack/Discord/
 * webhook/ntfy) already goes through `isPrivateOrLoopbackHost`/`NOTIFY_ALLOW_PRIVATE_URLS`
 * (`src/config/env.ts`); this one had no such check at all. Exported (moved out of the route
 * closure) so it is unit-testable without spinning up a server (finding #10).
 */
export function isValidPushEndpoint(endpoint: string, config: Pick<AppConfig, 'notifyAllowPrivateUrls'>): boolean {
  if (endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return config.notifyAllowPrivateUrls || !isPrivateOrLoopbackHost(url.hostname);
  }
  // Loopback exception (§4.5) so tests and local fakes work without a real secure context - kept
  // ONLY under the same explicit escape hatch every other notify URL uses, so the test-fake path
  // stays explicit rather than a silent, permanent carve-out for plain http.
  if (url.protocol === 'http:' && config.notifyAllowPrivateUrls) {
    // `URL#hostname` keeps the brackets around an IPv6 literal (`[::1]`, never bare `::1`).
    return url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost';
  }
  return false;
}

/** Finding #8 (phase5.1): `label`/`uaFamily`/`deviceType` are operator-device metadata from an
 *  untrusted request body - bound and type-checked before they ever reach `upsertSubscription`
 *  (a non-string previously reached better-sqlite3 raw and either bound oddly or threw a 500). */
function boundedDeviceField(v: unknown, max = 200): string | null {
  return typeof v === 'string' ? v.slice(0, max) : null;
}

export interface DashboardActionsHelpers {
  csrfTokenFromReq: (req: FastifyRequest, config: ResolvedServerDeps['config']) => string;
}

export function registerDashboardActions(
  instance: FastifyInstance,
  deps: ResolvedServerDeps,
  helpers: DashboardActionsHelpers,
): void {
  const { db, config } = deps;

  instance.get('/login', async (req, reply) => {
    if (config.dashboardPassword === undefined) {
      reply.code(404);
      setDashboardHeaders(reply);
      setHtmlContentType(reply);
      return render(loginPage({ next: '/dashboard', error: 'password login is not configured', csrf: null }));
    }
    const query = req.query as { next?: string; error?: string };
    setDashboardHeaders(reply);
    setHtmlContentType(reply);
    return render(
      loginPage({
        next: isSafeNextPath(query.next),
        error: query.error === '1' ? 'incorrect password' : null,
        csrf: null,
      }),
    );
  });

  instance.post('/login', async (req, reply) => {
    const body = req.body as { password?: string; next?: string } | undefined;
    const next = isSafeNextPath(body?.next);
    setDashboardHeaders(reply);

    if (config.dashboardPassword === undefined) {
      reply.code(404);
      setHtmlContentType(reply);
      return render(loginPage({ next, error: 'password login is not configured', csrf: null }));
    }

    const ipHash = hashIp(req.clientIp, config.ipSalt, Date.now()) ?? 'unknown';
    if (!checkLoginRate(ipHash, config.dashboardLoginRatePerMin, Date.now())) {
      reply.code(429);
      return { error: 'rate_limited' };
    }

    const password = body?.password ?? '';
    const correct = timingSafePasswordEqual(password, config.dashboardPassword);

    // Finding-style delay: a flat 250ms on failure, so a brute-forcer gains nothing from timing.
    if (!correct) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      audit(db, { actor: 'operator', action: 'dashboard.login.failed', subjectType: 'ip_hash', subjectId: ipHash });
      reply.code(302).header('Location', `/dashboard/login?next=${encodeURIComponent(next)}&error=1`).send();
      return;
    }

    const session = issueSession(config, Date.now());
    audit(db, { actor: 'operator', action: 'dashboard.login', subjectType: 'ip_hash', subjectId: ipHash });
    reply.header('Set-Cookie', [session.cookie, session.csrfCookie]);
    reply.code(302).header('Location', next).send();
  });

  instance.post('/logout', async (req, reply) => {
    const secure = resolveSecureCookies(config);
    reply.header('Set-Cookie', [
      serializeCookie(SESSION_COOKIE_NAME, '', { maxAgeSec: 0, secure, httpOnly: true, sameSite: 'Strict', path: DASHBOARD_COOKIE_PATH }),
      serializeCookie(CSRF_COOKIE_NAME, '', { maxAgeSec: 0, secure, httpOnly: false, sameSite: 'Strict', path: DASHBOARD_COOKIE_PATH }),
    ]);
    reply.code(302).header('Location', '/dashboard/login').send();
  });

  instance.post('/actions/reclassify', async (req, reply) => {
    const body = req.body as { kind?: string; eventId?: string; classification?: string; counted?: string; note?: string } | undefined;
    const kind = body?.kind === 'click' ? 'click' : 'open';
    const eventId = body?.eventId ?? '';
    const classification = body?.classification ?? '';
    const validSet = kind === 'open' ? OPEN_CLASSIFICATIONS : CLICK_CLASSIFICATIONS;
    if (!eventId || !validSet.includes(classification as never)) {
      reply.code(400);
      return { error: 'invalid_request' };
    }
    try {
      reclassify(db, {
        kind,
        eventId,
        classification,
        actor: 'dashboard',
        atMs: Date.now(),
        ...(body?.note ? { note: boundedNote(body.note) } : {}),
        ...(body?.counted !== undefined ? { counted: body.counted === 'true' || body.counted === '1' } : {}),
      });
    } catch (err) {
      if (err instanceof ReclassifyInvalidError) {
        reply.code(400);
        return { error: err.message };
      }
      if (err instanceof ReclassifyNotFoundError) {
        reply.code(404);
        return { error: err.message };
      }
      throw err;
    }

    const isHx = req.headers['hx-request'] === 'true';
    if (isHx) {
      const csrf = helpers.csrfTokenFromReq(req, config);
      const eventRow = kind === 'open' ? getOpenEvent(db, eventId) : getClickEvent(db, eventId);
      setDashboardHeaders(reply);
      setHtmlContentType(reply);
      if (!eventRow) {
        reply.code(404);
        return '';
      }
      const model = {
        kind,
        id: eventRow.id,
        occurredAt: eventRow.occurred_at,
        classification: eventRow.classification,
        confidence: eventRow.confidence,
        counted: eventRow.counted === 1,
        reasons: eventRow.reason ? eventRow.reason.split(',') : [],
        uaFamily: eventRow.ua_family,
        deviceType: eventRow.device_type,
        linkUrl: null,
        overridden: eventRow.overridden_at !== null,
        originalClassification: eventRow.original_classification,
        validClassifications: [...validSet],
        csrf,
        nowMs: Date.now(),
      } as const;
      return render(eventItem(model));
    }

    // Phase 3.1 (L3): an unvalidated `Referer` is an open-redirect surface (it is a request header,
    // spoofable by anything the browser follows a link from) - only ever redirect back to it when
    // it actually names this dashboard, and otherwise fall back to the messages list.
    const referer = req.headers['referer'];
    const refererPath = safeSameOriginPath(typeof referer === 'string' ? referer : undefined, firstHeader(req.headers['host']));
    reply.code(303).header('Location', refererPath ?? '/dashboard/messages').send();
    return;
  });

  instance.post('/actions/mute', async (req, reply) => {
    const body = req.body as { messageId?: string; recipientId?: string; muted?: string } | undefined;
    const messageId = body?.messageId ?? '';
    const message = getMessage(db, messageId);
    if (!message) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const muted = body?.muted === '1' || body?.muted === 'true';
    setMute(db, { messageId, recipientId: body?.recipientId ?? null, muted });
    audit(db, { actor: 'dashboard', action: muted ? 'mute.on' : 'mute.off', subjectType: 'message', subjectId: messageId });
    reply.code(303).header('Location', `/dashboard/messages/${messageId}`).send();
  });

  instance.post('/actions/reminder-cancel', async (req, reply) => {
    const body = req.body as { id?: string } | undefined;
    const id = body?.id ?? '';
    const existing = getReminder(db, id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const changed = cancelReminder(db, id, Date.now(), 'manual');
    if (changed) {
      audit(db, { actor: 'dashboard', action: 'reminder.cancel', subjectType: 'reminder', subjectId: id });
    }
    reply.code(303).header('Location', changed ? '/dashboard/reminders?flash=reminder_cancelled' : '/dashboard/reminders').send();
  });

  instance.post('/actions/campaign', async (req, reply) => {
    const body = req.body as { id?: string; action?: string } | undefined;
    const id = body?.id ?? '';
    const campaign = getCampaign(db, id);
    if (!campaign) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const action = body?.action;
    const nextStatus = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : action === 'cancel' ? 'cancelled' : null;
    if (nextStatus === null) {
      reply.code(400);
      return { error: 'invalid_action' };
    }
    // Finding #6: the dashboard action route mapped straight to setCampaignStatus with no guard on
    // the campaign's CURRENT status - the pause/resume/cancel buttons are hidden client-side for a
    // campaign in the wrong state, but the POST endpoint itself enforced nothing, so a replayed or
    // hand-crafted request could still un-cancel a terminal campaign.
    const result = transitionCampaignStatus(db, id, nextStatus, Date.now(), `dashboard: ${action}`);
    if (!result.ok) {
      reply.code(409);
      return { error: 'invalid_transition', currentStatus: campaign.status };
    }
    audit(db, { actor: 'dashboard', action: `campaign.${action}`, subjectType: 'campaign', subjectId: id });
    reply.code(303).header('Location', `/dashboard/campaigns/${id}`).send();
  });

  // --- Phase 5 (§4.5): Web Push subscription lifecycle -------------------------------------

  interface PushSubscribeBody {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    oldEndpoint?: string;
    label?: string;
    uaFamily?: string;
    deviceType?: string;
  }

  function decodeLen(v: string | undefined): number | null {
    if (v === undefined) return null;
    try {
      return Buffer.from(v, 'base64url').length;
    } catch {
      return null;
    }
  }

  instance.post('/actions/push-subscribe', async (req, reply) => {
    const body = req.body as PushSubscribeBody | undefined;
    const endpoint = body?.endpoint ?? '';
    const p256dh = body?.keys?.p256dh ?? '';
    const auth = body?.keys?.auth ?? '';

    if (!isValidPushEndpoint(endpoint, config)) {
      reply.code(400);
      return { error: 'invalid_endpoint' };
    }
    const p256dhLen = decodeLen(p256dh);
    if (p256dhLen !== 65) {
      reply.code(400);
      return { error: 'invalid_p256dh' };
    }
    const rawP256dh = Buffer.from(p256dh, 'base64url');
    if (rawP256dh[0] !== 0x04) {
      reply.code(400);
      return { error: 'invalid_p256dh' };
    }
    const authLen = decodeLen(auth);
    if (authLen !== 16) {
      reply.code(400);
      return { error: 'invalid_auth' };
    }

    // Finding #2 (phase5.1): `oldEndpoint` is a replacement ONLY when it actually resolves to an
    // existing row - previously ANY request that merely mentioned the field (including `""`, which
    // resolves to no row) skipped the PUSH_MAX_SUBSCRIPTIONS check entirely (50 POSTs, cap of 1, 50
    // active rows). A subscription that already has a row for THIS endpoint is a plain re-confirm,
    // not a net-new device either, and must not count against the cap.
    const oldEndpoint = typeof body?.oldEndpoint === 'string' ? body.oldEndpoint : undefined;
    const oldRow = oldEndpoint ? getSubscriptionByEndpoint(db, oldEndpoint) : null;
    const isReplacement = oldRow !== null && oldRow.endpoint !== endpoint;
    const alreadyRegistered = getSubscriptionByEndpoint(db, endpoint) !== null;

    if (isReplacement) {
      db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(oldRow!.id);
    }

    // Re-check the cap AFTER the delete above, so a genuine replacement (net row count unchanged)
    // never falsely trips it.
    if (!alreadyRegistered && countActiveSubscriptions(db) >= config.pushMaxSubscriptions) {
      reply.code(409);
      return { error: 'too_many_subscriptions', limit: config.pushMaxSubscriptions };
    }

    const row = upsertSubscription(db, {
      endpoint,
      p256dh,
      auth,
      label: boundedDeviceField(body?.label),
      uaFamily: boundedDeviceField(body?.uaFamily),
      deviceType: boundedDeviceField(body?.deviceType),
      createdAt: Date.now(),
    });
    audit(db, { actor: 'dashboard', action: 'push.subscribe', subjectType: 'push_subscription', subjectId: row.id });
    return { ok: true, id: row.id };
  });

  instance.post('/actions/push-unsubscribe', async (req) => {
    const body = req.body as { id?: string } | undefined;
    const id = body?.id ?? '';
    const deleted = deleteSubscriptionById(db, id);
    if (deleted) {
      audit(db, { actor: 'dashboard', action: 'push.unsubscribe', subjectType: 'push_subscription', subjectId: id });
    }
    return { ok: deleted };
  });
}
