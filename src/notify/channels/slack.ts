import type { AppConfig } from '../../config/env.js';
import type { DeliveryResult, NotificationPayload, Notifier, NotifierDeps } from '../types.js';
import { contextLine, deliverHttp, escapeSlackMd, summaryLine, triggerLabel } from './util.js';

export function buildSlackBody(payload: NotificationPayload): Record<string, unknown> {
  const email = escapeSlackMd(payload.recipient.email ?? 'unknown recipient');
  const subject = escapeSlackMd(payload.message.subject ?? '(subject hidden)');
  return {
    text: summaryLine(payload),
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${triggerLabel(payload.trigger)}* — \`${email}\`\n*${subject}*` },
      },
      { type: 'context', elements: [{ type: 'mrkdwn', text: contextLine(payload) }] },
    ],
  };
}

export const slackNotifier: Notifier = {
  name: 'slack',
  isConfigured(config: AppConfig): boolean {
    return config.slackWebhookUrl !== undefined;
  },
  async deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult> {
    const url = deps.config.slackWebhookUrl;
    if (url === undefined) {
      return { ok: false, error: 'SLACK_WEBHOOK_URL is not set', retryable: false };
    }
    const body = JSON.stringify(buildSlackBody(payload));
    return deliverHttp(
      deps.fetch,
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      deps.timeoutMs,
      (status) => status === 200,
    );
  },
};
