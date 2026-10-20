import type { AppConfig } from '../../config/env.js';
import type { DB } from '../../db/index.js';
import { withTx } from '../../db/index.js';
import {
  audit,
  countAddressees,
  insertClickEvent,
  insertOpenEvent,
  recomputeRecipientCounters,
  type RecipientRow,
} from '../../db/repo.js';
import type { TrackingEvent } from '../../notify/types.js';
import type { ClickClassification, OpenClassification, RecipientState } from '../../types.js';

type RedactedFields = {
  ip_hash?: string | null;
  ip_net_hash?: string | null;
  ua?: string | null;
  ua_family?: string | null;
  device_type?: string | null;
  os?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
};

export interface RecordOpenInput {
  recipient: RecipientRow & { messageSubject: string; messageNotifyMuted: boolean; messageCampaignId?: string | null };
  occurredAt: number;
  classification: OpenClassification;
  fields: RedactedFields;
  /** Phase 2.1 (finding #6): invoked synchronously, once per `TrackingEvent`, from *inside* this
   *  function's transaction - before it commits. Callers use this to enqueue notifications in the
   *  same atomic write as the event row itself, rather than only after the fact via the event bus
   *  (which can never run before the transaction that made the event true has already committed).
   *  Returning `true` from any call marks the result `notifyEnqueued: true`. */
  onEvent?: (event: TrackingEvent) => boolean | void;
}

export interface RecordOpenResult {
  eventId: string;
  events: TrackingEvent[];
  notifyEnqueued: boolean;
}

function toTrackingEvent(args: {
  kind: 'open' | 'click';
  eventId: string;
  occurredAt: number;
  recipient: RecipientRow & { messageSubject: string; messageNotifyMuted: boolean; messageCampaignId?: string | null };
  classification: string;
  reasons: string[];
  counted: boolean;
  backfilled: boolean;
  prevState: RecipientState;
  counters: ReturnType<typeof recomputeRecipientCounters>;
  fields: RedactedFields;
  linkUrl: string | null;
  isAggregate: boolean;
  recipientCount: number;
}): TrackingEvent {
  const { recipient, counters } = args;
  return {
    kind: args.kind,
    eventId: args.eventId,
    occurredAt: args.occurredAt,
    messageId: recipient.message_id,
    subject: recipient.messageSubject,
    recipientId: recipient.id,
    recipientEmail: recipient.email,
    classification: args.classification,
    reasons: args.reasons,
    counted: args.counted,
    backfilled: args.backfilled,
    prevState: args.prevState,
    newState: counters.state,
    counters: {
      openCount: counters.openCount,
      machineOpenCount: counters.machineOpenCount,
      clickCount: counters.clickCount,
      firstOpenAt: counters.firstOpenAt,
      lastOpenAt: counters.lastOpenAt,
    },
    uaFamily: args.fields.ua_family ?? null,
    deviceType: args.fields.device_type ?? null,
    linkUrl: args.linkUrl,
    muted: recipient.notify_muted === 1 || recipient.messageNotifyMuted,
    sentAt: recipient.sent_at,
    country: args.fields.country ?? null,
    isAggregate: args.isAggregate,
    recipientCount: args.recipientCount,
    campaignId: recipient.messageCampaignId ?? null,
  };
}

/** `recordOpen`: classify -> redact (already done by the caller) -> insert -> recompute counters
 *  and `recipients.state` -> build the `TrackingEvent` the route publishes to the bus, all inside
 *  one transaction (§2.1). */
export function recordOpen(db: DB, input: RecordOpenInput): RecordOpenResult {
  const { recipient, occurredAt, classification, fields } = input;
  return withTx(db, () => {
    const prevState = recipient.state;
    let notifyEnqueued = false;
    // docs/07_recipient_semantics.md §4.5: only ever true for the single-mode aggregate row - a
    // plain recipient row is never `is_aggregate`, so this stays a cheap constant `false` for every
    // pre-006 or per-recipient-mode send.
    const isAggregate = recipient.is_aggregate === 1;
    const recipientCount = isAggregate ? countAddressees(db, recipient.message_id) : 0;
    const eventId = insertOpenEvent(db, {
      recipientId: recipient.id,
      occurredAt,
      classification: classification.classification,
      confidence: classification.confidence,
      counted: classification.counted,
      reason: classification.reasons.join(','),
      ipHash: fields.ip_hash ?? null,
      ipNetHash: fields.ip_net_hash ?? null,
      ua: fields.ua ?? null,
      uaFamily: fields.ua_family ?? null,
      deviceType: fields.device_type ?? null,
      os: fields.os ?? null,
      country: fields.country ?? null,
      region: fields.region ?? null,
      city: fields.city ?? null,
    });
    const counters = recomputeRecipientCounters(db, recipient.id);
    audit(db, {
      actor: 'server',
      action: 'open.record',
      subjectType: 'recipient',
      subjectId: recipient.id,
      detail: { eventId, classification: classification.classification, reasons: classification.reasons },
    });
    const event = toTrackingEvent({
      kind: 'open',
      eventId,
      occurredAt,
      recipient,
      classification: classification.classification,
      reasons: classification.reasons,
      counted: classification.counted,
      backfilled: false,
      prevState,
      counters,
      fields,
      linkUrl: null,
      isAggregate,
      recipientCount,
    });
    if (input.onEvent && input.onEvent(event)) notifyEnqueued = true;
    return { eventId, events: [event], notifyEnqueued };
  });
}

export interface RecordClickInput {
  recipient: RecipientRow & { messageSubject: string; messageNotifyMuted: boolean; messageCampaignId?: string | null };
  occurredAt: number;
  classification: ClickClassification;
  fields: RedactedFields;
  linkId: string;
  linkUrl: string;
  config: Pick<AppConfig, 'clickBackfillOpens'>;
  /** See `RecordOpenInput.onEvent` (finding #6) - called once per `TrackingEvent` produced (the
   *  back-filled open, if any, then the click itself), inside this function's transaction. */
  onEvent?: (event: TrackingEvent) => boolean | void;
}

export interface RecordClickResult {
  eventId: string;
  backfilledOpenId: string | null;
  events: TrackingEvent[];
  notifyEnqueued: boolean;
}

/** `recordClick`: as `recordOpen`, plus the click->open back-fill (§4.3, DoD 8): a *counted* click
 *  from a recipient with zero counted opens implies a human read the message even though the pixel
 *  never fired (image blocking). The synthetic open is inserted first, in the same transaction, so
 *  `recomputeRecipientCounters` reflects both events together before either `TrackingEvent` is
 *  built - the click's own `newState` already accounts for the back-fill. */
export function recordClick(db: DB, input: RecordClickInput): RecordClickResult {
  const { recipient, occurredAt, classification, fields, linkId, linkUrl } = input;
  return withTx(db, () => {
    const prevState = recipient.state;
    const isAggregate = recipient.is_aggregate === 1;
    const recipientCount = isAggregate ? countAddressees(db, recipient.message_id) : 0;
    const eventId = insertClickEvent(db, {
      linkId,
      recipientId: recipient.id,
      occurredAt,
      classification: classification.classification,
      confidence: classification.confidence,
      counted: classification.counted,
      reason: classification.reasons.join(','),
      ipHash: fields.ip_hash ?? null,
      ipNetHash: fields.ip_net_hash ?? null,
      ua: fields.ua ?? null,
      uaFamily: fields.ua_family ?? null,
      deviceType: fields.device_type ?? null,
      os: fields.os ?? null,
      country: fields.country ?? null,
      region: fields.region ?? null,
      city: fields.city ?? null,
    });

    let backfilledOpenId: string | null = null;
    // Idempotence: the guard is open_count === 0 (the *pre-click* count), so a second counted
    // click for the same recipient never back-fills a second implied open.
    if (input.config.clickBackfillOpens && classification.counted && recipient.open_count === 0) {
      backfilledOpenId = insertOpenEvent(db, {
        recipientId: recipient.id,
        occurredAt,
        classification: 'human',
        confidence: 0.8,
        counted: true,
        reason: 'R10,implied_by_click',
        ipHash: fields.ip_hash ?? null,
        ipNetHash: fields.ip_net_hash ?? null,
        ua: fields.ua ?? null,
        uaFamily: fields.ua_family ?? null,
        deviceType: fields.device_type ?? null,
        os: fields.os ?? null,
        country: fields.country ?? null,
        region: fields.region ?? null,
        city: fields.city ?? null,
      });
    }

    const counters = recomputeRecipientCounters(db, recipient.id);
    audit(db, {
      actor: 'server',
      action: 'click.record',
      subjectType: 'recipient',
      subjectId: recipient.id,
      detail: { eventId, classification: classification.classification, backfilledOpenId },
    });

    const events: TrackingEvent[] = [];
    if (backfilledOpenId !== null) {
      events.push(
        toTrackingEvent({
          kind: 'open',
          eventId: backfilledOpenId,
          occurredAt,
          recipient,
          classification: 'human',
          reasons: ['R10', 'implied_by_click'],
          counted: true,
          backfilled: true,
          prevState,
          counters,
          fields,
          linkUrl: null,
          isAggregate,
          recipientCount,
        }),
      );
    }
    events.push(
      toTrackingEvent({
        kind: 'click',
        eventId,
        occurredAt,
        recipient,
        classification: classification.classification,
        reasons: classification.reasons,
        counted: classification.counted,
        backfilled: false,
        prevState,
        counters,
        fields,
        linkUrl,
        isAggregate,
        recipientCount,
      }),
    );

    let notifyEnqueued = false;
    if (input.onEvent) {
      for (const event of events) {
        if (input.onEvent(event)) notifyEnqueued = true;
      }
    }

    return { eventId, backfilledOpenId, events, notifyEnqueued };
  });
}
