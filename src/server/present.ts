import type { AppConfig } from '../config/env.js';
import type { RecipientState } from '../types.js';
import { clickUrl, newCacheBuster, optOutUrl, pixelUrl, signToken } from '../core/token.js';
import type {
  ClickEventRow,
  ClickTokenWithLink,
  MessageDetail,
  MessageListRow,
  OpenEventRow,
  RecipientRow,
} from '../db/repo.js';

export interface PresentedLink {
  linkId: string;
  url: string;
  label: string | null;
  clickUrl: string | null;
}

export interface PresentedRecipient {
  id: string;
  email: string;
  name: string | null;
  kind: string;
  openCount: number;
  machineOpenCount: number;
  firstOpenAt: number | null;
  lastOpenAt: number | null;
  clickCount: number;
  firstClickAt: number | null;
  optedOutAt: number | null;
  state: RecipientState;
  /** Phase 3 (§4.4/§7.1). */
  repliedAt: number | null;
  threadId: string | null;
  /** `firstOpenAt - sent_at`, or `null` when either is missing or the open precedes the send
   *  (clock skew - never negative-bucketed, §5). */
  timeToOpenMs: number | null;
  /** null unless tokens were explicitly requested (finding #2) - a signed pixel/opt-out/click
   *  token lets its holder forge an open or suppress a recipient, so it is not handed out by
   *  default just for listing/inspecting messages. */
  pixelUrl: string | null;
  optOutUrl: string | null;
  links: PresentedLink[];
  /** docs/07_recipient_semantics.md §4.5: true for the single-mode aggregate row - every presenter
   *  (`show`, dashboard, export) must render this as a distinct "message-level tracking" line,
   *  never as if `email` were a real address. */
  isAggregate: boolean;
}

export interface PresentOptions {
  /** Include signed pixel/opt-out/click token URLs. Defaults to true for CLI callers (which read
   *  the local DB directly, under the operator's own control); the `/api` route explicitly passes
   *  `false` unless the caller asked for tokens (finding #2). */
  includeTokens?: boolean;
}

function presentRecipient(
  config: AppConfig,
  r: RecipientRow,
  linksForRecipient: ClickTokenWithLink[],
  opts: PresentOptions,
): PresentedRecipient {
  const includeTokens = opts.includeTokens ?? true;
  const secret = config.trackingSecret ?? '';
  // finding #16: reuse the cache-buster generated (and persisted) at send time instead of minting
  // a fresh one on every read, so the reported pixel URL is stable. Rows created before this field
  // existed fall back to a freshly generated one.
  const cacheBuster = r.cache_buster ?? newCacheBuster();

  return {
    id: r.id,
    email: r.email,
    name: r.name,
    kind: r.kind,
    openCount: r.open_count,
    machineOpenCount: r.machine_open_count,
    firstOpenAt: r.first_open_at,
    lastOpenAt: r.last_open_at,
    clickCount: r.click_count,
    firstClickAt: r.first_click_at,
    optedOutAt: r.opted_out_at,
    // Phase 2 (§7.1): `recipients.state` is materialised and kept in sync by `recomputeRecipientCounters`
    // on every write path (record/reclassify/forget), so it is read directly rather than re-derived
    // from the raw counters here (which would disagree with a manual override's recomputed state).
    state: r.state,
    repliedAt: r.replied_at,
    threadId: r.thread_id,
    timeToOpenMs:
      r.first_open_at !== null && r.sent_at !== null && r.first_open_at >= r.sent_at
        ? r.first_open_at - r.sent_at
        : null,
    pixelUrl: includeTokens
      ? pixelUrl(config.trackingBaseUrl, signToken('o', r.token, secret), cacheBuster)
      : null,
    optOutUrl: includeTokens ? optOutUrl(config.trackingBaseUrl, signToken('u', r.token, secret)) : null,
    links: linksForRecipient.map((l) => ({
      linkId: l.link_id,
      url: l.url,
      label: l.label,
      clickUrl: includeTokens ? clickUrl(config.trackingBaseUrl, signToken('c', l.id, secret)) : null,
    })),
    isAggregate: r.is_aggregate === 1,
  };
}

export interface PresentedMessageDetail {
  id: string;
  subject: string;
  status: string;
  sentAt: number | null;
  createdAt: number;
  trackingEnabled: boolean;
  clickTrackingEnabled: boolean;
  error: string | null;
  recipients: PresentedRecipient[];
  /** docs/07_recipient_semantics.md §4.1: 'per-recipient' | 'single'. */
  recipientMode: string;
}

export function presentMessageDetail(
  config: AppConfig,
  detail: MessageDetail,
  clickTokens: ClickTokenWithLink[],
  opts: PresentOptions = {},
): PresentedMessageDetail {
  const byRecipient = new Map<string, ClickTokenWithLink[]>();
  for (const ct of clickTokens) {
    const list = byRecipient.get(ct.recipient_id) ?? [];
    list.push(ct);
    byRecipient.set(ct.recipient_id, list);
  }
  return {
    id: detail.message.id,
    subject: detail.message.subject,
    status: detail.message.status,
    sentAt: detail.message.sent_at,
    createdAt: detail.message.created_at,
    trackingEnabled: detail.message.tracking_enabled === 1,
    clickTrackingEnabled: detail.message.click_tracking_enabled === 1,
    error: detail.message.error,
    recipients: detail.recipients.map((r) =>
      presentRecipient(config, r, byRecipient.get(r.id) ?? [], opts),
    ),
    recipientMode: detail.message.recipient_mode,
  };
}

export interface PresentedMessageListRow {
  id: string;
  subject: string;
  status: string;
  sentAt: number | null;
  to: string[];
  opens: { counted: number; total: number };
  clicks: number;
}

export function presentMessageListRow(row: MessageListRow): PresentedMessageListRow {
  return {
    id: row.message.id,
    subject: row.message.subject,
    status: row.message.status,
    sentAt: row.message.sent_at,
    to: row.toEmails,
    opens: {
      counted: row.aggregate.countedOpens,
      total: row.aggregate.countedOpens + row.aggregate.machineOpens,
    },
    clicks: row.aggregate.clicks,
  };
}

export interface PresentedEvent {
  id: string;
  occurredAt: number;
  classification: string;
  confidence: number;
  counted: boolean;
  reasons: string[];
  uaFamily: string | null;
  deviceType: string | null;
  country: string | null;
  /** Phase 2 (§4.4): set once a manual reclassification has touched this event. */
  overridden: boolean;
  originalClassification: string | null;
  /** Phase 3 (§6.1): the raw timestamp behind `overridden`, for the dashboard's event detail page. */
  overriddenAt: number | null;
}

export function presentOpenEvent(e: OpenEventRow): PresentedEvent {
  return {
    id: e.id,
    occurredAt: e.occurred_at,
    classification: e.classification,
    confidence: e.confidence,
    counted: e.counted === 1,
    reasons: e.reason ? e.reason.split(',') : [],
    uaFamily: e.ua_family,
    deviceType: e.device_type,
    country: e.country,
    overridden: e.overridden_at !== null,
    originalClassification: e.original_classification,
    overriddenAt: e.overridden_at,
  };
}

export function presentClickEvent(e: ClickEventRow): PresentedEvent {
  return {
    id: e.id,
    occurredAt: e.occurred_at,
    classification: e.classification,
    confidence: e.confidence,
    counted: e.counted === 1,
    reasons: e.reason ? e.reason.split(',') : [],
    uaFamily: e.ua_family,
    deviceType: e.device_type,
    country: e.country,
    overridden: e.overridden_at !== null,
    originalClassification: e.original_classification,
    overriddenAt: e.overridden_at,
  };
}
