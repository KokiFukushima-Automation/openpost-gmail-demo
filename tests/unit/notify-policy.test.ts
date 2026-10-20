import { describe, expect, it } from 'vitest';
import { dedupeKey, decideTriggers } from '../../src/notify/policy.js';
import type { NotifyPolicyConfig } from '../../src/notify/policy.js';
import type { TrackingEvent } from '../../src/notify/types.js';

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

const FULL_CFG: NotifyPolicyConfig = { on: ['first_open', 'read_confirmed', 'click', 'prefetched'], channels: ['slack'] };
const DEFAULT_CFG: NotifyPolicyConfig = { on: ['first_open', 'read_confirmed', 'click'], channels: ['slack'] };

describe('decideTriggers', () => {
  it('60. first counted open -> [first_open]; counters openCount===1', () => {
    const e = baseEvent({ counted: true, counters: { openCount: 1, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1, lastOpenAt: 1 } });
    expect(decideTriggers(e, DEFAULT_CFG)).toEqual(['first_open']);
  });

  it('61. second counted open with no state change -> []', () => {
    const e = baseEvent({
      counted: true,
      prevState: 'opened',
      newState: 'opened',
      counters: { openCount: 2, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1, lastOpenAt: 2 },
    });
    expect(decideTriggers(e, DEFAULT_CFG)).toEqual([]);
  });

  it('62. transition opened -> read_confirmed -> [read_confirmed]', () => {
    const e = baseEvent({
      counted: true,
      prevState: 'opened',
      newState: 'read_confirmed',
      counters: { openCount: 2, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1, lastOpenAt: 70_000 },
    });
    expect(decideTriggers(e, DEFAULT_CFG)).toEqual(['read_confirmed']);
  });

  it('63. counted click -> [click], even with a state flip into read_confirmed (P6 supersedes P5, finding #2)', () => {
    const clickOnly = baseEvent({
      kind: 'click',
      counted: true,
      prevState: 'opened',
      newState: 'opened',
      counters: { openCount: 1, machineOpenCount: 0, clickCount: 1, firstOpenAt: 1, lastOpenAt: 1 },
    });
    expect(decideTriggers(clickOnly, DEFAULT_CFG)).toEqual(['click']);

    const clickAndConfirm = baseEvent({
      kind: 'click',
      counted: true,
      prevState: 'opened',
      newState: 'read_confirmed',
      counters: { openCount: 1, machineOpenCount: 0, clickCount: 1, firstOpenAt: 1, lastOpenAt: 1 },
    });
    expect(decideTriggers(clickAndConfirm, DEFAULT_CFG)).toEqual(['click']);

    // An *open* event's own P5 is unaffected - only a click event's P5 is superseded.
    const openConfirm = baseEvent({
      kind: 'open',
      counted: true,
      prevState: 'opened',
      newState: 'read_confirmed',
      counters: { openCount: 2, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1, lastOpenAt: 70_000 },
    });
    expect(decideTriggers(openConfirm, DEFAULT_CFG)).toEqual(['read_confirmed']);
  });

  it('64. a back-filled open yields [] (P2); the click that caused it produces exactly one trigger', () => {
    const backfilled = baseEvent({
      kind: 'open',
      backfilled: true,
      counted: true,
      prevState: 'not_opened',
      newState: 'read_confirmed',
      counters: { openCount: 1, machineOpenCount: 0, clickCount: 1, firstOpenAt: 1, lastOpenAt: 1 },
    });
    expect(decideTriggers(backfilled, DEFAULT_CFG)).toEqual([]);

    // Finding #2: this same back-filling click must notify exactly once (DoD 8), not once as
    // `read_confirmed` and again as `click`.
    const click = baseEvent({
      kind: 'click',
      backfilled: false,
      counted: true,
      prevState: 'not_opened',
      newState: 'read_confirmed',
      counters: { openCount: 1, machineOpenCount: 0, clickCount: 1, firstOpenAt: 1, lastOpenAt: 1 },
    });
    expect(decideTriggers(click, DEFAULT_CFG)).toHaveLength(1);
    expect(decideTriggers(click, DEFAULT_CFG)).toEqual(['click']);
  });

  it('65. apple_mpp only -> []; with prefetched listed and a not_opened->prefetched transition -> [prefetched]', () => {
    const e = baseEvent({
      classification: 'apple_mpp',
      counted: false,
      prevState: 'not_opened',
      newState: 'prefetched',
      counters: { openCount: 0, machineOpenCount: 1, clickCount: 0, firstOpenAt: null, lastOpenAt: null },
    });
    expect(decideTriggers(e, DEFAULT_CFG)).toEqual([]);
    expect(decideTriggers(e, FULL_CFG)).toEqual(['prefetched']);
  });

  it('66. opt_out, dnt, self_open, duplicate, bot -> [] in every configuration', () => {
    for (const classification of ['opt_out', 'dnt', 'self_open', 'duplicate', 'bot']) {
      const e = baseEvent({ classification, counted: false });
      expect(decideTriggers(e, FULL_CFG), classification).toEqual([]);
    }
  });

  it('67. message.notify_muted or recipient.notify_muted -> [] (represented by muted: true)', () => {
    const e = baseEvent({ muted: true });
    expect(decideTriggers(e, FULL_CFG)).toEqual([]);
  });

  it('68. dedupeKey is stable per (trigger, recipient), differs per channel and per click event', () => {
    const e = baseEvent();
    expect(dedupeKey('first_open', e, 'slack')).toBe(dedupeKey('first_open', e, 'slack'));
    expect(dedupeKey('first_open', e, 'slack')).not.toBe(dedupeKey('first_open', e, 'discord'));
    const clickA = baseEvent({ kind: 'click', eventId: 'clickA' });
    const clickB = baseEvent({ kind: 'click', eventId: 'clickB' });
    expect(dedupeKey('click', clickA, 'slack')).not.toBe(dedupeKey('click', clickB, 'slack'));
  });
});
