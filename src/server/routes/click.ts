import type { FastifyInstance, FastifyReply } from 'fastify';
import { findClickTokenTarget, getRecipientWithMessage } from '../../db/repo.js';
import { classifyClick } from '../../core/classify.js';
import { verifyToken } from '../../core/token.js';
import { parseUserAgent } from '../../core/ua.js';
import { buildClassifyContext, buildOpenSignal, redactEventFields } from '../context.js';
import { recordCorrelation } from '../correlation.js';
import { auditRejection } from '../rejection-audit.js';
import { recordClick } from '../services/record.js';
import type { ResolvedServerDeps } from '../app.js';
import type { TrackingEvent } from '../../notify/types.js';

function fallback(reply: FastifyReply, trackingFallbackUrl: string | undefined): void {
  reply.header('Referrer-Policy', 'no-referrer').header('Cache-Control', 'no-store');
  if (trackingFallbackUrl) {
    reply.code(302).redirect(trackingFallbackUrl);
  } else {
    reply.code(404).send({ error: 'not_found' });
  }
}

export function registerClickRoute(
  app: FastifyInstance,
  deps: ResolvedServerDeps,
  clock: () => number,
): void {
  const { db, config, ranges, bus, notifyWorker, geoLookup } = deps;
  const secrets = { current: config.trackingSecret ?? '', previous: config.trackingSecretPrevious };

  app.route({
    method: ['GET', 'HEAD'],
    url: '/c/:token',
    handler: async (req, reply) => {
      const { token } = req.params as { token: string };
      const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

      const verify = verifyToken('c', token, secrets);
      if (!verify.ok) {
        auditRejection(db, {
          actor: 'server',
          action: 'token.reject',
          detail: { purpose: 'c', reason: verify.reason },
        });
        return fallback(reply, config.trackingFallbackUrl);
      }

      const target = findClickTokenTarget(db, verify.rid);
      if (!target) {
        auditRejection(db, {
          actor: 'server',
          action: 'token.orphan',
          detail: { purpose: 'c', rid: verify.rid },
        });
        return fallback(reply, config.trackingFallbackUrl);
      }

      try {
        const recipient = getRecipientWithMessage(db, target.recipientId);
        if (recipient) {
          const occurredAt = clock();
          const uaHeader = req.headers['user-agent'];
          const uaInfo = parseUserAgent(typeof uaHeader === 'string' ? uaHeader : null);
          const signal = buildOpenSignal(req, method, occurredAt);
          const ctx = buildClassifyContext(
            db,
            config,
            recipient.email,
            null,
            uaInfo,
            signal,
            recipient.id,
            'click',
            ranges,
          );
          const classification = classifyClick(signal, ctx);
          // finding #1: route click events through the same PRIVACY_MODE redaction as opens,
          // rather than storing raw UA/ip_hash/ip_net_hash/device_type/os unconditionally.
          // finding #7: geo (when configured) is resolved here too, gated on `counted` exactly like
          // the pixel route.
          const fields = redactEventFields(signal, ctx, config.privacyMode, {
            classification: classification.classification,
            counted: classification.counted,
            lookup: geoLookup,
            granularity: config.geoipGranularity,
          });

          const { events, notifyEnqueued } = recordClick(db, {
            recipient,
            occurredAt,
            classification,
            fields,
            linkId: target.linkId,
            linkUrl: target.url,
            config: { clickBackfillOpens: config.clickBackfillOpens },
            // finding #6: same reasoning as the pixel route - enqueue inside the event transaction.
            ...(notifyWorker ? { onEvent: (event: TrackingEvent) => notifyWorker.enqueueForEvent(event) } : {}),
          });
          // Same short-lived, in-memory-only correlation as the pixel route (finding #3), so a
          // strict-mode dedupe/fanout check on the *next* click still has something live to
          // compare against even though the persisted row's hashes are nulled.
          recordCorrelation(db, {
            kind: 'click',
            recipientId: recipient.id,
            occurredAt,
            ipNetHash: ctx.ipNetHash,
            uaFamily: ctx.uaInfo.family,
          });
          for (const event of events) {
            bus.publish(event);
          }
          if (notifyEnqueued) notifyWorker?.tickOnce().catch((err) => req.log.error({ err }, 'click: notify tick failed'));
        }
      } catch (err) {
        req.log.error({ err }, 'click: failed to record click event');
      }

      reply
        .header('Referrer-Policy', 'no-referrer')
        .header('Cache-Control', 'no-store')
        .code(302)
        .redirect(target.url);
    },
  });
}
