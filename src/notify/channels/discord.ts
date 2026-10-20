import type { AppConfig } from '../../config/env.js';
import type { DeliveryResult, NotificationPayload, Notifier, NotifierDeps } from '../types.js';
import { deliverHttp, triggerLabel } from './util.js';

const COLOR_BY_TRIGGER: Record<NotificationPayload['trigger'], number> = {
  first_open: 3447003,
  read_confirmed: 5025616,
  click: 15844367,
  prefetched: 9807270,
  reply: 3066993,
  reminder: 16776960,
  campaign_digest: 10181046,
  daily_digest: 3901635,
};

export function buildDiscordBody(payload: NotificationPayload): Record<string, unknown> {
  const subject = payload.message.subject ?? '(subject hidden)';
  const email = payload.recipient.email ?? 'unknown recipient';
  const signals = [
    payload.event.reasons.length > 0 ? payload.event.reasons.join(',') : null,
    payload.event.uaFamily,
    payload.event.deviceType,
  ]
    .filter((v): v is string => v !== null)
    .join(' · ');

  return {
    username: 'openpost',
    embeds: [
      {
        title: triggerLabel(payload.trigger),
        description: `**${subject}**`,
        color: COLOR_BY_TRIGGER[payload.trigger],
        timestamp: new Date(payload.occurredAt).toISOString(),
        fields: [
          { name: 'Recipient', value: email, inline: true },
          { name: 'State', value: payload.recipient.state, inline: true },
          { name: 'Signals', value: signals.length > 0 ? signals : 'n/a', inline: false },
        ],
      },
    ],
  };
}

export const discordNotifier: Notifier = {
  name: 'discord',
  isConfigured(config: AppConfig): boolean {
    return config.discordWebhookUrl !== undefined;
  },
  async deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult> {
    const url = deps.config.discordWebhookUrl;
    if (url === undefined) {
      return { ok: false, error: 'DISCORD_WEBHOOK_URL is not set', retryable: false };
    }
    const body = JSON.stringify(buildDiscordBody(payload));
    return deliverHttp(
      deps.fetch,
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      deps.timeoutMs,
      (status) => status === 200 || status === 204,
    );
  },
};
