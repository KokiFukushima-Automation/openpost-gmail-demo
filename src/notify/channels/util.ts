import type { AppConfig } from '../../config/env.js';
import type { DeliveryResult, FetchLike, NotificationPayload, NotifyTrigger } from '../types.js';

/** Finding #15: besides Slack's own documented `&`/`<`/`>` entity-escaping, mrkdwn's own formatting
 *  characters (`*bold*`, `_italic_`, `~strike~`, `` `code` ``) are neutralised with a backslash - an
 *  untrusted subject line containing an odd number of any of these would otherwise silently mangle
 *  every field that comes after it in the same Slack message. */
export function escapeSlackMd(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1');
}

const TRIGGER_LABEL: Record<NotifyTrigger, string> = {
  first_open: 'First open',
  read_confirmed: 'Read confirmed',
  click: 'Click',
  prefetched: 'Prefetched',
  reminder: 'Reminder',
  reply: 'Reply',
  campaign_digest: 'Campaign digest',
  daily_digest: 'Daily digest',
};

export function triggerLabel(trigger: NotifyTrigger): string {
  return TRIGGER_LABEL[trigger];
}

/** `'3d' '5h' '20m' '45s'` - the largest whole unit, for the short "after Nd" phrasing in reminder/
 *  reply summaries (§3.6). Negative or non-finite input is treated as 0. */
export function formatAgeShort(ms: number): string {
  const clamped = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const units: Array<[string, number]> = [
    ['d', 86_400_000],
    ['h', 3_600_000],
    ['m', 60_000],
    ['s', 1000],
  ];
  for (const [suffix, unitMs] of units) {
    if (clamped >= unitMs) return `${Math.floor(clamped / unitMs)}${suffix}`;
  }
  return '0s';
}

/** The one-line summary shared verbatim by Slack's `text` fallback and ntfy's plain-text body
 *  (§2.7). */
/** docs/07_recipient_semantics.md §4.5: the exact wording every surface (notifications, `show`,
 *  the dashboard) uses for a single-mode aggregate event - never presented as a reader count. */
export function messageLevelPhrase(recipientCount: number | null): string {
  return `recipient unknown, ${recipientCount ?? '?'} on thread`;
}

/** docs/08_phase4_spec.md §2.9: `"Campaign "Q3 outreach": 120 sent, 41 opened (34%), 9 clicked, 2
 *  replied - last 60 min"` - names counts only, never a recipient. */
export function campaignSummaryLine(payload: NotificationPayload): string {
  const c = payload.campaign;
  if (!c) return 'Campaign digest';
  const windowMinutes = Math.max(1, Math.round((c.windowTo - c.windowFrom) / 60_000));
  const openPct = Math.round(c.openRate * 100);
  return `Campaign "${c.name}": ${c.sent} sent, ${c.opened} opened (${openPct}%), ${c.clicked} clicked, ${c.replied} replied - last ${windowMinutes} min`;
}

/** docs/09_phase5_spec.md §5.3: "Daily digest: 12 sent, 5 opened (42%), 2 clicked, 1 replied - Sep 16"
 *  - counts only, never a recipient. */
export function dailyDigestSummaryLine(payload: NotificationPayload): string {
  const d = payload.digest;
  if (!d) return 'Daily digest';
  const openPct = Math.round(d.openRate * 100);
  const date = new Date(d.windowTo).toISOString().slice(0, 10);
  return `Daily digest: ${d.sent} sent, ${d.opened} opened (${openPct}%), ${d.clicked} clicked, ${d.replied} replied - ${date}`;
}

export function summaryLine(payload: NotificationPayload): string {
  if (payload.trigger === 'campaign_digest') return campaignSummaryLine(payload);
  if (payload.trigger === 'daily_digest') return dailyDigestSummaryLine(payload);
  const isMessageLevel = payload.recipient.attribution === 'message';
  const email = isMessageLevel ? messageLevelPhrase(payload.recipient.recipientCount) : (payload.recipient.email ?? 'unknown recipient');
  const subject = payload.message.subject ?? '(subject hidden)';
  switch (payload.trigger) {
    case 'first_open':
      return `First open: ${email} opened "${subject}"`;
    case 'read_confirmed':
      return `Read: ${email} opened "${subject}"`;
    case 'click':
      return `Click: ${email} clicked a link in "${subject}"`;
    case 'prefetched':
      return `Prefetched: ${email}'s mail client fetched "${subject}" (not yet confirmed read)`;
    case 'reminder': {
      const age =
        payload.message.sentAt !== null ? formatAgeShort(payload.occurredAt - payload.message.sentAt) : 'n/a';
      return `Reminder: no reply from ${email} to "${subject}" after ${age}`;
    }
    case 'reply':
      return `Reply: ${email} replied to "${subject}"`;
  }
}

export function contextLine(payload: NotificationPayload): string {
  if (payload.trigger === 'campaign_digest') {
    const c = payload.campaign;
    return c?.topVariant ? `top variant ${c.topVariant}` : 'digest window closed';
  }
  if (payload.trigger === 'daily_digest') {
    const d = payload.digest;
    if (!d || d.topMessages.length === 0) return 'no top messages';
    const top = d.topMessages[0] as { id: string; subject: string | null; opens: number };
    return `top message: ${top.subject ?? '(subject hidden)'} (${top.opens} opens)`;
  }
  if (payload.trigger === 'reminder') {
    const condition = payload.event.reasons[1] ?? 'unknown';
    const age =
      payload.message.sentAt !== null ? formatAgeShort(payload.occurredAt - payload.message.sentAt) : 'n/a';
    const draftReason = payload.event.reasons.find((r) => r.startsWith('draft:'));
    const draftStatus = draftReason ? draftReason.slice('draft:'.length) : 'none';
    return `condition ${condition} · age ${age} · draft ${draftStatus}`;
  }
  if (payload.trigger === 'reply') {
    const delay =
      payload.message.sentAt !== null ? formatAgeShort(payload.occurredAt - payload.message.sentAt) : 'n/a';
    return `replied ${delay} after sending`;
  }
  const ua = payload.event.uaFamily ?? 'unknown';
  const device = payload.event.deviceType ?? 'unknown';
  const date = new Date(payload.occurredAt).toISOString().replace('T', ' ').slice(0, 16);
  const clickWord = payload.recipient.clickCount === 1 ? 'click' : 'clicks';
  const rules = payload.event.reasons.length > 0 ? payload.event.reasons.join(',') : 'n/a';
  return (
    `opened ${payload.recipient.openCount}×, ${payload.recipient.clickCount} ${clickWord} · ` +
    `${ua} / ${device} · ${date} UTC · rules ${rules}`
  );
}

/**
 * Finding #9: a Slack/Discord/ntfy webhook URL carries its own secret token in its path (there is
 * no separate credential to redact it *to* - the URL itself is the bearer credential), and
 * WEBHOOK_URL can point anywhere an operator likes. A delivery failure's error text (a thrown
 * `fetch` error, or an HTTP error body a misbehaving endpoint echoes back) can end up containing the
 * URL verbatim; that text is persisted to `notifications.last_error` and printed by
 * `notifications list`, so every configured channel URL/token is scrubbed out of it before it is
 * ever stored.
 */
// Phase 5 (§4.6); broadened in finding #9 (phase5.1): a push subscription endpoint is
// bearer-equivalent (anyone holding it can send a notification to that device) and is never
// persisted to `push_subscriptions.last_error`/`notifications.last_error` in the clear. The
// original pattern only matched `/fcm/send`, `/wp/` and `/push/` paths - it missed Mozilla
// autopush (`…/wpush/v2/<token>`) and Apple (`https://web.push.apple.com/<token>`) entirely, so
// this is now a generic backstop matching ANY `https://` URL rather than any particular push
// service's path shape; there is no single "the push URL" the way there is for the other channels
// (one row per subscribed device), and a delivery error string never legitimately needs to name a
// URL for any other reason. This is a backstop only - the primary guard for the webpush channel's
// own errors is the per-call exact-match in `redactPushEndpoint` below, applied before the error is
// ever recorded.
const PUSH_ENDPOINT_RE = /https:\/\/[^\s"']+/gi;

export function redactSecretUrls(message: string, config: AppConfig): string {
  const secrets = [config.slackWebhookUrl, config.discordWebhookUrl, config.webhookUrl, config.ntfyToken].filter(
    (s): s is string => s !== undefined && s.length > 0,
  );
  let redacted = message;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join('[redacted]');
  }
  redacted = redacted.replace(PUSH_ENDPOINT_RE, '[redacted-push-endpoint]');
  return redacted;
}

/** Phase 5 (§4.6), corrected in finding #9 (phase5.1): scrubs a webpush delivery error before it is
 *  ever persisted. First splits on the EXACT subscription endpoint (unlike the other channels,
 *  there is no single fixed configured URL to match against - one row per device - so the caller
 *  always has the specific endpoint in hand and passes it here); then, as a backstop, treats ANY
 *  remaining `https://` URL fragment as endpoint-shaped and redacts it too, since a webpush error
 *  string never legitimately needs to name a URL for any other reason (a network error's message
 *  can otherwise echo a mangled, re-encoded, or partial form of the endpoint that the exact split
 *  alone would miss). */
export function redactPushEndpoint(message: string, endpoint: string): string {
  const exact = message.split(endpoint).join('[redacted-push-endpoint]');
  return exact.replace(/https:\/\/[^\s"']+/gi, '[redacted-push-endpoint]');
}

export function retryAfterMsFromHeader(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/** Shared HTTP delivery classification for all four channels: network/abort errors and 5xx/408/429
 *  are retryable, every other 4xx is not (§2.7). */
export async function deliverHttp(
  fetchImpl: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
  isSuccess: (status: number) => boolean,
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Finding #9: never follow a redirect - a channel endpoint that 3xx's is either misconfigured
    // or, worse, has been made to point delivery somewhere the operator never configured.
    const res = await fetchImpl(url, { ...init, signal: controller.signal, redirect: 'error' });
    if (isSuccess(res.status)) {
      return { ok: true, status: res.status, retryable: false };
    }
    const retryAfterMs = res.status === 429 ? retryAfterMsFromHeader(res.headers.get('retry-after')) : undefined;
    const retryable = res.status >= 500 || res.status === 408 || res.status === 429;
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      // ignore - body isn't required for classification
    }
    const result: DeliveryResult = {
      ok: false,
      status: res.status,
      error: `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`,
      retryable,
    };
    if (retryAfterMs !== undefined) result.retryAfterMs = retryAfterMs;
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}
