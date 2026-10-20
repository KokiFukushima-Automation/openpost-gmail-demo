import { describe, expect, it } from 'vitest';
import { decideTriggers } from '../../src/notify/policy.js';
import type { NotifyPolicyConfig, TrackingEvent } from '../../src/notify/types.js';

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
    isAggregate: false,
    recipientCount: 0,
    campaignId: null,
    ...overrides,
  };
}

const CFG: NotifyPolicyConfig = { on: ['first_open', 'read_confirmed', 'click'], channels: ['slack'] };

describe('decideTriggers - P9 campaign mode', () => {
  it('277. a campaign open in digest mode (default) produces zero immediate triggers', () => {
    const e = baseEvent({ campaignId: 'camp1' });
    expect(decideTriggers(e, CFG)).toEqual([]);
    expect(decideTriggers(e, { ...CFG, campaignMode: 'digest' })).toEqual([]);
  });

  it('280. NOTIFY_CAMPAIGN_MODE=per-open restores Phase 2/3 behaviour exactly; off emits nothing', () => {
    const e = baseEvent({ campaignId: 'camp1', counters: { openCount: 1, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1000, lastOpenAt: 1000 } });
    expect(decideTriggers(e, { ...CFG, campaignMode: 'per-open' })).toEqual(['first_open']);
    expect(decideTriggers(e, { ...CFG, campaignMode: 'off' })).toEqual([]);
  });

  it('a non-campaign event (campaignId null/undefined) is completely unaffected by campaignMode', () => {
    const e = baseEvent();
    expect(decideTriggers(e, { ...CFG, campaignMode: 'digest' })).toEqual(['first_open']);
    // Legacy caller shape: no campaignId property at all.
    const legacy = { ...e } as Partial<TrackingEvent>;
    delete (legacy as { campaignId?: string | null }).campaignId;
    expect(decideTriggers(legacy as TrackingEvent, { ...CFG, campaignMode: 'digest' })).toEqual(['first_open']);
  });

  it('mute (P0) still wins over a campaign event regardless of campaignMode', () => {
    const e = baseEvent({ campaignId: 'camp1', muted: true });
    expect(decideTriggers(e, { ...CFG, campaignMode: 'per-open' })).toEqual([]);
  });
});
