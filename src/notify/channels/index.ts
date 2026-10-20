import type { AppConfig } from '../../config/env.js';
import type { ChannelName, Notifier } from '../types.js';
import { discordNotifier } from './discord.js';
import { ntfyNotifier } from './ntfy.js';
import { slackNotifier } from './slack.js';
import { webhookNotifier } from './webhook.js';
import { webpushNotifier } from './webpush.js';
import { emailNotifier } from './email.js';

export { slackNotifier } from './slack.js';
export { discordNotifier } from './discord.js';
export { webhookNotifier, computeWebhookSignature } from './webhook.js';
export { ntfyNotifier } from './ntfy.js';
export { webpushNotifier, buildPushPayload } from './webpush.js';
export { emailNotifier, defaultEmailTransportFactory } from './email.js';
export { redactSecretUrls, redactPushEndpoint } from './util.js';

const ALL: Notifier[] = [slackNotifier, discordNotifier, webhookNotifier, ntfyNotifier, webpushNotifier, emailNotifier];

/** Builds the map of notifiers this config actually has enabled (listed in `NOTIFY_CHANNELS`). */
export function buildNotifiers(config: AppConfig): Map<ChannelName, Notifier> {
  const map = new Map<ChannelName, Notifier>();
  for (const notifier of ALL) {
    if (config.notifyChannels.includes(notifier.name)) {
      map.set(notifier.name, notifier);
    }
  }
  return map;
}
