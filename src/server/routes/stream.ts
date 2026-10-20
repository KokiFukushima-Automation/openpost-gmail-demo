import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../config/env.js';
import { decideTriggers } from '../../notify/policy.js';
import { buildPayload, redactEmail } from '../../notify/payload.js';
import { ALL_NOTIFY_TRIGGERS, type NotificationPayload, type NotifyTrigger, type TrackingEvent } from '../../notify/types.js';
import { newId } from '../../core/ids.js';
import { isValidApiBearer } from '../api-auth.js';
import { authenticateDashboard } from '../auth/session.js';
import type { ResolvedServerDeps } from '../app.js';

// Phase 3 (§3.6): widened additively so a reply/reminder TrackingEvent also gets a real `trigger`
// on the SSE frame instead of falling through to the "produces no trigger" branch below.
// Phase 4 (docs/08_phase4_spec.md §2.9, test 344) / Phase 5 (§5.3, test 413): imports the one
// canonical runtime list directly (`notify/types.ts`'s `ALL_NOTIFY_TRIGGERS`) instead of
// hand-maintaining a parallel array - the exact class of bug the Phase 3 smoke run found when a new
// trigger value was added but this array wasn't, silently hiding it from the live dashboard.
const ALL_TRIGGERS: NotifyTrigger[] = [...ALL_NOTIFY_TRIGGERS];

/** SSE is unfiltered by policy (the dashboard wants everything, including machine
 *  classifications), but still speaks the `NotificationPayload` wire shape: `trigger` is the first
 *  trigger the event *would* have produced (ignoring `NOTIFY_ON`/muting), or `''` when it produces
 *  none at all (§2.8). Phase 4 (test 277): `campaignMode: 'per-open'` so a campaign event still
 *  shows up live on the dashboard even when `NOTIFY_CAMPAIGN_MODE=digest` suppresses the per-open
 *  Slack/Discord/webhook/ntfy notification for it - "the event is still recorded, SSE still sees
 *  it" is a property of the *stream*, not of the notification queue. */
function buildStreamPayload(e: TrackingEvent, config: AppConfig): NotificationPayload | (Omit<NotificationPayload, 'trigger'> & { trigger: '' }) {
  const triggers = decideTriggers(e, { on: ALL_TRIGGERS, channels: [], campaignMode: 'per-open' });
  const first = triggers[0];
  if (first !== undefined) {
    return buildPayload(e, first, newId(), config);
  }
  const email = e.isAggregate ? null : config.notifyRedactEmail ? redactEmail(e.recipientEmail) : e.recipientEmail;
  const subject = config.notifyIncludeSubject ? e.subject : null;
  return {
    version: 1,
    id: newId(),
    trigger: '',
    occurredAt: e.occurredAt,
    message: { id: e.messageId, subject, sentAt: e.sentAt },
    recipient: {
      id: e.recipientId,
      email,
      state: e.newState,
      openCount: e.counters.openCount,
      clickCount: e.counters.clickCount,
      attribution: e.isAggregate ? 'message' : 'recipient',
      recipientCount: e.isAggregate ? e.recipientCount : null,
    },
    event: {
      id: e.eventId,
      kind: e.kind,
      classification: e.classification,
      reasons: e.reasons,
      counted: e.counted,
      uaFamily: e.uaFamily,
      deviceType: e.deviceType,
      country: e.country,
      linkUrl: e.linkUrl,
    },
  };
}

/**
 * `GET /api/events/stream` and `GET /dashboard/events/stream` (§2.8) - the SAME handler mounted
 * under both prefixes, sharing one `activeClients` counter.
 *
 * Phase 3.1 (H1): the dashboard's session cookie is issued with `Path=/dashboard` (`auth/
 * session.ts`), so a browser never actually attaches it to a request for `/api/events/stream` in
 * any real deployment - only a bearer client (or a test that sets the `Cookie` header by hand) can
 * reach that path with a session credential. A non-loopback deployment forces `API_TOKEN`, so a
 * dashboard user with only `DASHBOARD_PASSWORD` configured could open the page but never see a
 * single live update, and the dashboard's own `EventSource` in `assets/app.js` would 401 forever.
 * Rather than widen the cookie to `Path=/` (which would also require adding CSRF/Origin checks to
 * every state-changing `/api` route, since a session cookie would then ride along with it), the
 * stream is additionally served at `/dashboard/events/stream`, a path the existing `Path=/dashboard`
 * cookie already covers - `assets/app.js` points there. `/api/events/stream` is kept, unchanged, for
 * bearer-only API clients.
 */
export function registerStreamRoute(app: FastifyInstance, deps: ResolvedServerDeps, opts: { mountDashboard: boolean } = { mountDashboard: true }): void {
  const { config, bus } = deps;
  let activeClients = 0;

  function register(prefix: string): void {
    app.register(
      async (instance) => {
        instance.addHook('onRequest', async (req, reply) => {
          // Phase 3 (§2.6): a browser `EventSource` cannot send an `Authorization` header, so the
          // dashboard's own session cookie is accepted here too - `SameSite=Strict` on that cookie
          // still prevents a cross-site page from opening the stream with the ambient credential,
          // and test 88's original behaviour (bearer required, no cookie present -> 401) is
          // preserved unchanged for a request that carries neither.
          if (
            !isValidApiBearer(config, req.headers['authorization']) &&
            authenticateDashboard(config, { headers: req.headers as Record<string, string | string[] | undefined>, ip: req.clientIp }, Date.now()).ok !== true
          ) {
            reply.code(401).send({ error: 'unauthorized' });
          }
        });

        instance.get('/events/stream', async (req, reply) => {
          if (activeClients >= config.sseMaxClients) {
            reply.code(503).send({ error: 'too_many_clients' });
            return;
          }
          activeClients += 1;

          reply.hijack();
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          reply.raw.write('retry: 3000\n\n');

          const writeEvent = (e: TrackingEvent): void => {
            const payload = buildStreamPayload(e, config);
            reply.raw.write(`id: ${e.eventId}\nevent: tracking\ndata: ${JSON.stringify(payload)}\n\n`);
          };

          const query = req.query as { since?: string };
          if (query.since !== undefined && /^\d+$/.test(query.since)) {
            const since = Number(query.since);
            for (const e of bus.recent()) {
              if (e.occurredAt > since) writeEvent(e);
            }
          }

          const unsubscribe = bus.subscribe(writeEvent);
          const heartbeat = setInterval(() => {
            reply.raw.write(': ping\n\n');
          }, config.sseHeartbeatSeconds * 1000);
          heartbeat.unref();

          req.raw.on('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
            activeClients -= 1;
          });
        });
      },
      { prefix },
    );
  }

  register('/api');
  if (opts.mountDashboard) register('/dashboard');
}
