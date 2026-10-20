import type { FastifyInstance } from 'fastify';
import { audit, findRecipientByToken } from '../../db/repo.js';
import { verifyToken } from '../../core/token.js';
import { parseUserAgent } from '../../core/ua.js';
import { TRANSPARENT_GIF } from '../assets.js';
import { buildClassifyContext, buildOpenSignal, classifyAndRedact } from '../context.js';
import { recordCorrelation } from '../correlation.js';
import { auditRejection } from '../rejection-audit.js';
import { recordOpen } from '../services/record.js';
import type { ResolvedServerDeps } from '../app.js';
import type { TrackingEvent } from '../../notify/types.js';

export function registerPixelRoute(
  app: FastifyInstance,
  deps: ResolvedServerDeps,
  clock: () => number,
): void {
  const { db, config, ranges, bus, notifyWorker, geoLookup } = deps;
  const secrets = { current: config.trackingSecret ?? '', previous: config.trackingSecretPrevious };

  app.route({
    method: ['GET', 'HEAD'],
    url: '/o/:token',
    handler: async (req, reply) => {
      const params = req.params as { token: string };
      const token = params.token.replace(/\.gif$/i, '');
      const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

      reply
        .header('Content-Type', 'image/gif')
        .header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0, private')
        .header('Pragma', 'no-cache')
        .header('Expires', '0')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Referrer-Policy', 'no-referrer')
        .code(200);

      // Respond first, record second (doc 02 §1.3) - true for both GET and HEAD. HEAD gets an
      // empty body, but (Phase 1.1 amendment, finding #17) still flows through classification: R6
      // already classifies method==='HEAD' as `bot`, and recording it (uncounted) keeps HEAD
      // scanner probes visible in the same audit trail as every other bot signal, instead of a
      // silent, untraceable early return.
      if (method === 'HEAD') {
        reply.header('Content-Length', String(TRANSPARENT_GIF.length));
        await reply.send();
      } else {
        await reply.send(TRANSPARENT_GIF);
      }

      try {
        const verify = verifyToken('o', token, secrets);
        if (!verify.ok) {
          auditRejection(db, {
            actor: 'server',
            action: 'token.reject',
            detail: { purpose: 'o', reason: verify.reason },
          });
          return;
        }

        const recipient = findRecipientByToken(db, verify.rid);
        if (!recipient) {
          auditRejection(db, {
            actor: 'server',
            action: 'token.orphan',
            detail: { purpose: 'o', rid: verify.rid },
          });
          return;
        }

        // finding #4: a message sent with --no-track must never produce an open_events row, even
        // if its (unembedded, but still validly signed) token is somehow probed directly.
        if (!recipient.trackingEnabled) {
          auditRejection(db, {
            actor: 'server',
            action: 'token.disabled',
            subjectType: 'recipient',
            subjectId: recipient.id,
          });
          return;
        }

        const occurredAt = clock();
        const uaHeader = req.headers['user-agent'];
        const uaInfo = parseUserAgent(typeof uaHeader === 'string' ? uaHeader : null);
        const signal = buildOpenSignal(req, method, occurredAt);
        const ctx = buildClassifyContext(
          db,
          config,
          recipient.email,
          recipient.sentAt,
          uaInfo,
          signal,
          recipient.id,
          'open',
          ranges,
        );
        const { classification: classified, fields } = classifyAndRedact(signal, ctx, config.privacyMode, {
          lookup: geoLookup,
          granularity: config.geoipGranularity,
        });
        // Gmail loads the pixel while composing. Until a send is linked, it cannot be a
        // confirmed recipient open; retain the signal without incrementing human opens.
        const classification = recipient.sentAt === null
          ? { classification: 'self_open' as const, counted: false, confidence: 1, reasons: ['unsent_or_unlinked'] }
          : classified;

        try {
          const { events, notifyEnqueued } = recordOpen(db, {
            recipient,
            occurredAt,
            classification,
            fields,
            // finding #6: enqueue inside the same transaction that records the event, instead of
            // only afterwards via bus.publish (below), which can only ever run once that
            // transaction has already committed.
            ...(notifyWorker ? { onEvent: (event: TrackingEvent) => notifyWorker.enqueueForEvent(event) } : {}),
          });
          // Strict mode's persisted row has its identifying fields nulled; keep the live
          // (already-hashed) values around in memory just long enough for R7/R8 to work on the
          // next hit (finding #3). Recorded after a successful insert so a failed write never
          // pollutes correlation with an event that isn't actually reflected in the DB.
          recordCorrelation(db, {
            kind: 'open',
            recipientId: recipient.id,
            occurredAt,
            ipNetHash: ctx.ipNetHash,
            uaFamily: ctx.uaInfo.family,
          });
          for (const event of events) {
            bus.publish(event);
          }
          if (notifyEnqueued) notifyWorker?.tickOnce().catch((err) => req.log.error({ err }, 'pixel: notify tick failed'));
        } catch (err) {
          // finding #12: a failed insert must not vanish silently - it goes to audit_log (never to
          // the response, which has already been sent) so the operator can see it happened at all.
          const message = err instanceof Error ? err.message : String(err);
          try {
            audit(db, {
              actor: 'server',
              action: 'open.record.failed',
              subjectType: 'recipient',
              subjectId: recipient.id,
              detail: { error: message },
            });
          } catch {
            // The DB write itself is failing; there is nothing further we can do here.
          }
          throw err;
        }
      } catch (err) {
        req.log.error({ err }, 'pixel: failed to record open event');
      }
    },
  });
}
