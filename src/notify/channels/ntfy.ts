import type { AppConfig } from '../../config/env.js';
import type { DeliveryResult, NotificationPayload, Notifier, NotifierDeps } from '../types.js';
import { deliverHttp, summaryLine, triggerLabel } from './util.js';

export const ntfyNotifier: Notifier = {
  name: 'ntfy',
  isConfigured(config: AppConfig): boolean {
    return config.ntfyTopic !== undefined;
  },
  async deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult> {
    const { ntfyUrl, ntfyTopic, ntfyToken, ntfyPriority } = deps.config;
    if (ntfyTopic === undefined) {
      return { ok: false, error: 'NTFY_TOPIC is not set', retryable: false };
    }
    const url = `${ntfyUrl}/${ntfyTopic}`;
    const headers: Record<string, string> = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: triggerLabel(payload.trigger),
      Priority: ntfyPriority,
      Tags: 'envelope',
    };
    if (ntfyToken !== undefined) {
      headers.Authorization = `Bearer ${ntfyToken}`;
    }
    return deliverHttp(
      deps.fetch,
      url,
      { method: 'POST', headers, body: summaryLine(payload) },
      deps.timeoutMs,
      (status) => status === 200,
    );
  },
};
