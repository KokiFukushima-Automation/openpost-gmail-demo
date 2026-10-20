import type { AppConfig } from '../config/env.js';
import type { NotifyTrigger, NotificationPayload, TrackingEvent } from './types.js';

/** `a***@example.com`-style redaction: keeps the first local-part character and the whole domain,
 *  masks the rest of the local part. Anything that isn't a plausible `local@domain` shape is masked
 *  wholesale as `***`. */
export function redactEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return `${local[0]}***@${domain}`;
}

/**
 * Builds the wire-format payload for one (event, trigger) pair. Redaction happens once, here, so no
 * individual channel can leak what `NOTIFY_REDACT_EMAIL`/`NOTIFY_INCLUDE_SUBJECT` hide from the
 * others (§2.2).
 */
export function buildPayload(
  e: TrackingEvent,
  trigger: NotifyTrigger,
  notificationId: string,
  config: AppConfig,
): NotificationPayload {
  // docs/07_recipient_semantics.md §4.5: a single-mode aggregate-row event is never attributable to
  // one address - `email` is always null here, redaction or not, and `recipientCount` carries the
  // "N on thread" figure instead.
  const email = e.isAggregate ? null : config.notifyRedactEmail ? redactEmail(e.recipientEmail) : e.recipientEmail;
  const subject = config.notifyIncludeSubject ? e.subject : null;

  return {
    version: 1,
    id: notificationId,
    trigger,
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
