import { describe, expect, it } from 'vitest';
import { dedupeKey, decideTriggers } from '../../src/notify/policy.js';
import type { NotifyPolicyConfig } from '../../src/notify/policy.js';
import { buildPayload } from '../../src/notify/payload.js';
import type { NotificationPayload, TrackingEvent } from '../../src/notify/types.js';
import { makeConfig } from '../helpers/setup.js';

function baseEvent(overrides: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    kind: 'open',
    eventId: 'evt1',
    occurredAt: 1000,
    messageId: 'msg1',
    subject: 'hello',
    recipientId: 'rcpt1',
    recipientEmail: 'alice@example.com',
    classification: 'human',
    reasons: ['R9'],
    counted: true,
    backfilled: false,
    prevState: 'not_opened',
    newState: 'opened',
    counters: { openCount: 1, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1000, lastOpenAt: 1000 },
    uaFamily: 'Chrome',
    deviceType: 'desktop',
    linkUrl: null,
    muted: false,
    sentAt: 0,
    country: null,
    ...overrides,
  };
}

const FULL_CFG: NotifyPolicyConfig = { on: ['first_open', 'read_confirmed', 'click', 'prefetched', 'reply', 'reminder'], channels: ['slack'] };

describe('Phase 3 notify widening', () => {
  it('187. decideTriggers for a reminder returns [reminder] even when muted, and [] when reminder is absent from NOTIFY_ON', () => {
    const e = baseEvent({ kind: 'reminder', classification: 'reminder', reasons: ['reminder', 'no_reply'], counted: false, muted: true, prevState: 'not_opened', newState: 'not_opened' });
    expect(decideTriggers(e, FULL_CFG)).toEqual(['reminder']);
    const withoutReminder: NotifyPolicyConfig = { on: ['first_open'], channels: ['slack'] };
    expect(decideTriggers(e, withoutReminder)).toEqual([]);
  });

  it('188. decideTriggers for a reply returns [reply]; [] when muted; a subsequent counted open does not double-fire read_confirmed', () => {
    const reply = baseEvent({ kind: 'reply', classification: 'reply', reasons: ['reply'], counted: false, prevState: 'read_confirmed', newState: 'replied' });
    expect(decideTriggers(reply, FULL_CFG)).toEqual(['reply']);
    expect(decideTriggers({ ...reply, muted: true }, FULL_CFG)).toEqual([]);

    // A later counted open on an already-replied recipient: prevState/newState both "progressed"
    // (replied is in PROGRESSED_STATES), so P5 must not re-fire.
    const laterOpen = baseEvent({ kind: 'open', counted: true, prevState: 'replied', newState: 'replied', counters: { openCount: 2, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1, lastOpenAt: 2 } });
    expect(decideTriggers(laterOpen, FULL_CFG)).toEqual([]);
  });

  it('dedupeKey: reminder keys by the reminder id (eventId), reply keys by recipientId', () => {
    const reminderEvent = baseEvent({ kind: 'reminder', eventId: 'reminder-id-1' });
    expect(dedupeKey('reminder', reminderEvent, 'slack')).toBe('slack:reminder:reminder-id-1');
    const replyEvent = baseEvent({ kind: 'reply', recipientId: 'rcpt-9' });
    expect(dedupeKey('reply', replyEvent, 'discord')).toBe('discord:reply:rcpt-9');
  });

  it('189. buildPayload for both new triggers honours NOTIFY_REDACT_EMAIL/NOTIFY_INCLUDE_SUBJECT, and the payload parses as a valid NotificationPayload', () => {
    const config = makeConfig({ notifyRedactEmail: true, notifyIncludeSubject: false });
    const reminderEvent = baseEvent({ kind: 'reminder', classification: 'reminder', reasons: ['reminder', 'no_reply'] });
    const payload = buildPayload(reminderEvent, 'reminder', 'notif-1', config);
    expect(payload.recipient.email).toBe('a***@example.com');
    expect(payload.message.subject).toBeNull();
    expect(payload.trigger).toBe('reminder');
    expect(payload.event.kind).toBe('reminder');

    // Round-trips through JSON exactly like the SSE stream does.
    const roundTripped = JSON.parse(JSON.stringify(payload)) as NotificationPayload;
    expect(roundTripped.version).toBe(1);
    expect(roundTripped.event.kind).toBe('reminder');

    const replyEvent = baseEvent({ kind: 'reply', classification: 'reply', reasons: ['reply'] });
    const replyPayload = buildPayload(replyEvent, 'reply', 'notif-2', config);
    expect(replyPayload.event.kind).toBe('reply');
  });
});
