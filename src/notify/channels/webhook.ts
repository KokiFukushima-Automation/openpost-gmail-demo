import { createHmac } from 'node:crypto';
import type { AppConfig } from '../../config/env.js';
import { VERSION } from '../../version.js';
import type { DeliveryResult, NotificationPayload, Notifier, NotifierDeps } from '../types.js';
import { deliverHttp } from './util.js';

/** `HMAC-SHA256(secret, "${timestampSeconds}.${rawBody}")`, hex-encoded (§2.7). Exported so
 *  `docs/notifications.md`'s verifier samples and the tests can compute the same value. */
export function computeWebhookSignature(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
}

export const webhookNotifier: Notifier = {
  name: 'webhook',
  isConfigured(config: AppConfig): boolean {
    return config.webhookUrl !== undefined && config.webhookSecret !== undefined;
  },
  async deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult> {
    const { webhookUrl, webhookSecret } = deps.config;
    if (webhookUrl === undefined || webhookSecret === undefined) {
      return { ok: false, error: 'WEBHOOK_URL/WEBHOOK_SECRET are not set', retryable: false };
    }
    const rawBody = JSON.stringify(payload);
    const timestampSeconds = Math.floor(deps.clock() / 1000);
    const signature = computeWebhookSignature(webhookSecret, timestampSeconds, rawBody);
    return deliverHttp(
      deps.fetch,
      webhookUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `openpost/${VERSION}`,
          'X-Openpost-Event': payload.trigger,
          'X-Openpost-Delivery': payload.id,
          'X-Openpost-Timestamp': String(timestampSeconds),
          'X-Openpost-Signature': `sha256=${signature}`,
        },
        body: rawBody,
      },
      deps.timeoutMs,
      (status) => status >= 200 && status < 300,
    );
  },
};
