import type { AppConfig } from '../../config/env.js';
import { buildMime } from '../../mail/mime.js';
import type { Transport } from '../../mail/transport.js';
import { resolveTransport } from '../../mail/transport.js';
import type { DeliveryResult, NotificationPayload, Notifier, NotifierDeps } from '../types.js';
import { contextLine, summaryLine, triggerLabel } from './util.js';

/** docs/09_phase5_spec.md §5.2: `NotifyWorker` supplies this from an injectable factory (tests
 *  inject a fake transport directly) so the notify path does not pull nodemailer/googleapis at
 *  startup for a dashboard-only process - the dynamic import happens here, not at module load. */
export async function defaultEmailTransportFactory(config: AppConfig): Promise<Transport> {
  return resolveTransport(config);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Zero-config channel (§5.1): every openpost install already has a working mail transport, so an
 * email to yourself needs no keys. `deliver()` never goes through `runSend`/`sendMessage` - it calls
 * `buildMime` directly, so there is structurally no pixel, no click rewriting, and no `messages` row
 * for a notification email (test 408).
 */
export const emailNotifier: Notifier = {
  name: 'email',
  isConfigured(): boolean {
    // Always "configured": NOTIFY_EMAIL_TO defaults to FROM_EMAIL, and the missing-both case is a
    // non-retryable delivery failure (naming the remedy) rather than a silently skipped channel -
    // that failure is what makes a misconfiguration visible in `notifications list`.
    return true;
  },
  async deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult> {
    const { config } = deps;
    const to = config.notifyEmailTo ?? config.fromEmail;
    if (!to) {
      return { ok: false, retryable: false, error: 'NOTIFY_EMAIL_TO (or FROM_EMAIL) must be set for the email notification channel' };
    }
    const from = config.notifyEmailFrom ?? config.fromEmail ?? to;

    // §5.2 loop safety: never email a notification about a message TO the very address the
    // notification would be about, if that address is also the configured notification recipient's.
    if (payload.recipient.email && payload.recipient.email.toLowerCase() === to.toLowerCase()) {
      return { ok: false, retryable: false, error: 'refusing to notify: NOTIFY_EMAIL_TO matches the recipient this notification is about' };
    }

    const subjectLine = `[openpost] ${summaryLine(payload)}`.slice(0, 200);
    // Finding #13 (phase5.1): mirror the webpush channel's isDigest branch (`buildPushPayload` in
    // notify/channels/webpush.ts) - a digest names counts, never a single message, so it must link
    // to the message list, not to `/dashboard/messages/` with an empty id (`daily-digest.ts` sets
    // `message.id = ''`).
    const isDigest = payload.trigger === 'campaign_digest' || payload.trigger === 'daily_digest';
    const messageUrl = `${config.trackingBaseUrl}${isDigest ? '/dashboard/messages' : `/dashboard/messages/${payload.message.id}`}`;
    const bodyHtml = `<html><body>
<p><strong>${escapeHtml(triggerLabel(payload.trigger))}</strong></p>
<p>${escapeHtml(summaryLine(payload))}</p>
<p>${escapeHtml(contextLine(payload))}</p>
<p><a href="${escapeHtml(messageUrl)}">${escapeHtml(messageUrl)}</a></p>
</body></html>`;
    const bodyText = `${triggerLabel(payload.trigger)}\n\n${summaryLine(payload)}\n${contextLine(payload)}\n\n${messageUrl}\n`;

    try {
      const mime = await buildMime({
        from: { email: from },
        to: [{ email: to }],
        subject: subjectLine,
        html: bodyHtml,
        text: bodyText,
        headers: {
          'Auto-Submitted': 'auto-generated',
          'X-Openpost-Notification': '1',
          Precedence: 'bulk',
        },
      });
      const transport = deps.transport ?? (await defaultEmailTransportFactory(config));
      await transport.send(mime, { to: [to], subject: subjectLine, html: bodyHtml });
      return { ok: true, retryable: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, retryable: true, error: message };
    }
  },
};
