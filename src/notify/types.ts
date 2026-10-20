import type { AppConfig } from '../config/env.js';
import type { RecipientCounters, RecipientState } from '../types.js';
import type { Transport } from '../mail/transport.js';
import type { DB } from '../db/index.js';

// Phase 3 (§3.6): `reply` and `reminder` widen the trigger union additively - every existing
// trigger value, its dedupe-key shape and P0-P6 stay exactly as Phase 2 shipped them.
// Phase 4 (docs/08_phase4_spec.md §2.9) adds `campaign_digest` the same way.
// Phase 5 (docs/09_phase5_spec.md §5.3) adds `daily_digest` the same way.
export type NotifyTrigger = 'first_open' | 'read_confirmed' | 'click' | 'prefetched' | 'reply' | 'reminder' | 'campaign_digest' | 'daily_digest';
// Phase 5 (§4, §5) adds `webpush` (Web Push to the operator's own devices) and `email` (email-to-
// self) - both a pure addition, same shape every other channel already has.
export type ChannelName = 'slack' | 'discord' | 'webhook' | 'ntfy' | 'webpush' | 'email';

/** The one canonical, exhaustive runtime list of `NotifyTrigger` values - a TS union has no runtime
 *  representation of its own. `src/server/routes/stream.ts`'s `ALL_TRIGGERS` (the SSE stream's
 *  "show everything regardless of NOTIFY_ON" list) imports this directly instead of hand-maintaining
 *  a parallel array, closing the exact class of bug the Phase 3 smoke run caught (a new trigger added
 *  here but never mirrored there, silently hidden from the live dashboard) - see test 413. */
export const ALL_NOTIFY_TRIGGERS: readonly NotifyTrigger[] = [
  'first_open',
  'read_confirmed',
  'click',
  'prefetched',
  'reply',
  'reminder',
  'campaign_digest',
  'daily_digest',
];

/** Published on the in-process bus after `recordOpen`/`recordClick` commits (§2.1-2.2), and (Phase
 *  3) after a detected reply or a fired reminder. Never persisted itself - the durable unit is the
 *  `notifications` queue row built from it. */
export interface TrackingEvent {
  kind: 'open' | 'click' | 'reply' | 'reminder';
  eventId: string;
  occurredAt: number;
  messageId: string;
  subject: string;
  recipientId: string;
  recipientEmail: string;
  classification: string;
  reasons: string[];
  counted: boolean;
  /** true for the synthetic "implied_by_click" open created by the back-fill (§4.3). */
  backfilled: boolean;
  prevState: RecipientState;
  newState: RecipientState;
  counters: RecipientCounters;
  uaFamily: string | null;
  deviceType: string | null;
  linkUrl: string | null;
  muted: boolean;
  /** Deviation from the spec's literal TrackingEvent shape (§2.2): NotificationPayload.message.sentAt
   *  and .event.country need a source, and the spec never threads them through any other argument
   *  to buildPayload/decideTriggers, so they travel on the event itself instead. Geo stays out of
   *  scope for Phase 2 (§0), so `country` is always null today but the field exists so the wire
   *  format is stable once Phase 3 geo lands. */
  sentAt: number | null;
  country: string | null;
  /** docs/07_recipient_semantics.md §4.5: true when this event's `recipientId` is the single-mode
   *  aggregate row - opens/clicks on it are never attributable to one address. Reply/reminder
   *  events are always per-addressee (never on the aggregate row) and leave this false. */
  isAggregate: boolean;
  /** Real addressee count for the message this event belongs to - only meaningful (and only ever
   *  read) when `isAggregate` is true, for the "recipient unknown, N on thread" wording. */
  recipientCount: number;
  /** docs/08_phase4_spec.md §2.9: the campaign this event's message belongs to, or `null` for every
   *  non-campaign send (additive - populated in record.ts from messages.campaign_id). */
  campaignId: string | null;
}

/** The wire format sent to every channel and to SSE (§2.2). */
export interface NotificationPayload {
  version: 1;
  id: string;
  trigger: NotifyTrigger;
  occurredAt: number;
  message: { id: string; subject: string | null; sentAt: number | null };
  recipient: {
    id: string;
    email: string | null;
    state: RecipientState;
    openCount: number;
    clickCount: number;
    /** docs/07_recipient_semantics.md §4.5: 'recipient' normally; 'message' when this event came
     *  from the single-mode aggregate row, in which case `email` is always null and
     *  `recipientCount` names how many real addressees were on the thread. */
    attribution: 'recipient' | 'message';
    recipientCount: number | null;
  };
  event: {
    id: string;
    kind: 'open' | 'click' | 'reply' | 'reminder';
    classification: string;
    reasons: string[];
    counted: boolean;
    uaFamily: string | null;
    deviceType: string | null;
    country: string | null;
    linkUrl: string | null;
  };
  /** docs/08_phase4_spec.md §2.9: present only for `trigger === 'campaign_digest'`. A digest never
   *  names a recipient - `recipient.email` stays null and `recipient.id` stays '' for these. */
  campaign?: {
    id: string;
    name: string;
    windowFrom: number;
    windowTo: number;
    rows: number;
    sent: number;
    skipped: number;
    failed: number;
    opened: number;
    clicked: number;
    replied: number;
    openRate: number;
    clickRate: number;
    topVariant: string | null;
  };
  /** docs/09_phase5_spec.md §5.3: present only for `trigger === 'daily_digest'`. Subjects appear in
   *  `topMessages` only when `NOTIFY_INCLUDE_SUBJECT`. */
  digest?: {
    windowFrom: number;
    windowTo: number;
    sent: number;
    opened: number;
    clicked: number;
    replied: number;
    openRate: number;
    topMessages: Array<{ id: string; subject: string | null; opens: number }>;
  };
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  error?: string;
  retryable: boolean;
  retryAfterMs?: number;
}

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    /** Phase 5 (§4.6): a Web Push body is binary (aes128gcm-encrypted) - widened additively, every
     *  existing caller still passes a `string` and still type-checks. */
    body?: string | Uint8Array;
    signal?: AbortSignal;
    /** Finding #9: every channel sends this as `'error'` - a 3xx response throws instead of being
     *  followed, so a compromised/misbehaving endpoint can't redirect delivery to an internal host
     *  the operator never configured. */
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<{
  status: number;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface NotifierDeps {
  fetch: FetchLike;
  timeoutMs: number;
  clock: () => number;
  config: AppConfig;
  /** Phase 5 (§5.2): the email-to-self channel needs a mail transport; supplied by `NotifyWorker`
   *  from an injectable factory so the notify path does not pull in nodemailer/googleapis at
   *  startup for a dashboard-only process. Absent for every other channel. */
  transport?: Transport;
  /** Phase 5 (§4.6): deviation from the spec's literal `{fetch, timeoutMs, clock, config}` (which
   *  only calls out adding `transport`) - the webpush channel's per-subscription fan-out and
   *  self-healing (disable on 404/410, mark-ok, failure counting) read/write `push_subscriptions`,
   *  and `NotifyWorker` already holds the db handle every other channel never needed. Always
   *  present when `NotifyWorker` calls `deliver`; optional here only so a hand-built `NotifierDeps`
   *  in a non-webpush test compiles without it. */
  db?: DB;
}

export interface Notifier {
  readonly name: ChannelName;
  isConfigured(config: AppConfig): boolean;
  deliver(payload: NotificationPayload, deps: NotifierDeps): Promise<DeliveryResult>;
}
