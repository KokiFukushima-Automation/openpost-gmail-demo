import type { AppConfig } from '../../config/env.js';
import { audit } from '../../db/repo.js';
import { disableSubscription, listActiveSubscriptions, markSubscriptionOk, recordSubscriptionFailure } from '../../db/push.js';
import { encryptPush, MAX_PUSH_PLAINTEXT, vapidAuthorization } from '../../core/webpush.js';
import type { DeliveryResult, NotificationPayload, Notifier, NotifierDeps } from '../types.js';
import { redactPushEndpoint, retryAfterMsFromHeader, summaryLine, triggerLabel } from './util.js';

export interface PushPayloadJson {
  v: 1;
  title: string;
  body: string;
  url: string;
  tag: string;
  ts: number;
}

/** §4.6: `url` is always a `/dashboard/`-prefixed PATH, never an absolute URL - the service worker
 *  re-validates it before navigating, which closes the open-redirect hole an absolute URL would
 *  open. `tag` coalesces repeated activity on one message into one notification instead of
 *  stacking. `body` inherits every existing redaction knob via `summaryLine` verbatim. */
export function buildPushPayload(payload: NotificationPayload, _config: AppConfig): PushPayloadJson {
  const title = triggerLabel(payload.trigger);
  const body = summaryLine(payload).slice(0, 240);
  const isDigest = payload.trigger === 'campaign_digest' || payload.trigger === 'daily_digest';
  const url = isDigest ? '/dashboard/messages' : `/dashboard/messages/${payload.message.id}`;
  const tag = isDigest ? payload.trigger : payload.message.id;
  return { v: 1, title, body, url, tag, ts: payload.occurredAt };
}

function safeAudit(db: NotifierDeps['db'], action: string, detail: Record<string, unknown>): void {
  if (!db) return;
  try {
    audit(db, { actor: 'server', action, subjectType: 'push_subscription', subjectId: (detail.subscriptionId as string) ?? null, detail });
  } catch {
    // best-effort only - never let an audit failure affect delivery accounting.
  }
}

export const webpushNotifier: Notifier = {
  name: 'webpush',
  isConfigured(config: AppConfig): boolean {
    return config.vapidPublicKey !== undefined && config.vapidPrivateKey !== undefined;
  },
  async deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult> {
    const { config, db } = deps;
    if (config.vapidPublicKey === undefined || config.vapidPrivateKey === undefined) {
      return { ok: false, retryable: false, error: 'VAPID keys are not configured' };
    }
    if (!db) {
      return { ok: false, retryable: false, error: 'webpush channel requires a database handle' };
    }

    const subs = listActiveSubscriptions(db);
    // DoD 5.4/§4.6 result-folding table: zero active subscriptions is a no-op that must not
    // dead-letter the row or fill the audit log.
    if (subs.length === 0) {
      return { ok: true, retryable: false };
    }

    const json = buildPushPayload(payload, config);
    const plaintext = Buffer.from(JSON.stringify(json), 'utf8');
    if (plaintext.length > MAX_PUSH_PLAINTEXT) {
      return { ok: false, retryable: false, error: 'push payload exceeds the aes128gcm single-record size limit' };
    }

    const nowSec = Math.floor(deps.clock() / 1000);
    const urgency = payload.trigger === 'read_confirmed' || payload.trigger === 'reply' ? 'high' : config.pushUrgency;

    let successCount = 0;
    let disabledCount = 0;
    let failCount = 0;
    let firstFailDesc: string | null = null;
    let anyRetryable = false;
    let smallestRetryAfterMs: number | undefined;

    for (const sub of subs) {
      // Finding #5 (phase5.1): every other channel goes through `deliverHttp` (channels/util.ts),
      // which wires an AbortController to `deps.timeoutMs` - this channel called `deps.fetch`
      // directly with no `signal` at all, so one hung/tarpitting endpoint stalled the whole tick
      // (sequentially, for every remaining subscription behind it).
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
      try {
        const body = encryptPush({ plaintext, sub: { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth } });
        const authorization = vapidAuthorization({
          endpoint: sub.endpoint,
          subject: config.vapidSubject,
          keys: { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey },
          nowSec,
          ttlSec: 12 * 3600,
        });
        const res = await deps.fetch(sub.endpoint, {
          method: 'POST',
          headers: {
            TTL: String(config.pushTtlSeconds),
            'Content-Encoding': 'aes128gcm',
            'Content-Type': 'application/octet-stream',
            Urgency: urgency,
            Authorization: authorization,
          },
          body,
          redirect: 'error',
          signal: controller.signal,
        });

        if (res.status >= 200 && res.status < 300) {
          markSubscriptionOk(db, sub.id, deps.clock());
          successCount += 1;
          continue;
        }
        if (res.status === 404 || res.status === 410) {
          disableSubscription(db, sub.id, res.status === 404 ? 'gone_404' : 'gone_410', deps.clock());
          safeAudit(db, 'push.gone', { subscriptionId: sub.id, status: res.status });
          disabledCount += 1;
          continue;
        }

        failCount += 1;
        firstFailDesc ??= `HTTP ${res.status}`;
        if (res.status === 413) {
          recordSubscriptionFailure(db, sub.id, 'HTTP 413: payload too large', deps.clock(), config.pushMaxFailures);
          safeAudit(db, 'push.too_large', { subscriptionId: sub.id });
        } else if (res.status === 429) {
          anyRetryable = true;
          const ra = retryAfterMsFromHeader(res.headers.get('retry-after'));
          const capped = ra !== undefined ? Math.min(ra, 3_600_000) : undefined;
          if (capped !== undefined) smallestRetryAfterMs = smallestRetryAfterMs === undefined ? capped : Math.min(smallestRetryAfterMs, capped);
          recordSubscriptionFailure(db, sub.id, 'HTTP 429: rate limited', deps.clock(), config.pushMaxFailures);
        } else if (res.status >= 500) {
          anyRetryable = true;
          recordSubscriptionFailure(db, sub.id, `HTTP ${res.status}`, deps.clock(), config.pushMaxFailures);
        } else {
          recordSubscriptionFailure(db, sub.id, `HTTP ${res.status}`, deps.clock(), config.pushMaxFailures);
        }
      } catch (err) {
        failCount += 1;
        anyRetryable = true;
        const message = err instanceof Error ? err.message : String(err);
        const redacted = redactPushEndpoint(message, sub.endpoint);
        firstFailDesc ??= redacted;
        recordSubscriptionFailure(db, sub.id, redacted, deps.clock(), config.pushMaxFailures);
      } finally {
        clearTimeout(timer);
      }
    }

    const total = subs.length;
    // Row result: ok if >=1 success, OR every subscription was disabled this attempt (a dead device
    // is not a delivery failure), OR (already handled above) zero active subscriptions.
    if (successCount > 0 || disabledCount === total) {
      return { ok: true, retryable: false };
    }

    // Endpoint URLs are never persisted (they are bearer-equivalent) - `firstFailDesc` is always a
    // status/message string, never the endpoint itself (test greps `notifications.last_error` for
    // any endpoint substring and asserts zero hits).
    const result: DeliveryResult = {
      ok: false,
      retryable: anyRetryable,
      error: `${failCount} of ${total} endpoints failed: ${firstFailDesc ?? 'unknown error'}`,
    };
    if (smallestRetryAfterMs !== undefined) result.retryAfterMs = smallestRetryAfterMs;
    return result;
  },
};
