// Finding #7 (docs/reports/phase4_review.md): geoForEvent/createMmdbLookup were fully written and
// unit-tested but never called from the pixel/click path - open_events.country stayed NULL forever
// regardless of GEOIP_DB_PATH. This integration test drives a real /o and /c request through a
// server built with an injected fake GeoLookup (never a real mmdb file) and asserts the persisted
// event rows actually carry geo fields end to end.
import { afterEach, describe, expect, it } from 'vitest';
import type { GeoLookup } from '../../src/core/geo.js';
import { signToken } from '../../src/core/token.js';
import { newId } from '../../src/core/ids.js';
import {
  addClickToken,
  addLink,
  addRecipient,
  createMessage,
  ensureAccount,
  getClickEventsForRecipient,
  getEventsForRecipient,
  markMessageSent,
} from '../../src/db/repo.js';
import { setupTestServer, TEST_SECRET, type TestServer } from '../helpers/setup.js';

const SENT_AT = 1_700_000_000_000;
const GEO_IP = '203.0.113.9';
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const FAKE_LOOKUP: GeoLookup = {
  buildEpoch: 1,
  lookup: (ip: string) => (ip === GEO_IP ? { country: 'US', region: 'CA', city: 'Mountain View' } : null),
};

function seedMessage(env: TestServer) {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(env.db, {
    accountId: account.id,
    subject: 'hi',
    bodyHtml: '<p>hi</p>',
    bodyText: 'hi',
    status: 'draft',
    trackingEnabled: true,
    clickTrackingEnabled: true,
  });
  markMessageSent(env.db, message.id, { rfc822MsgId: '<a@b>', sentAt: SENT_AT });
  const rid = newId();
  const recipient = addRecipient(env.db, { messageId: message.id, email: 'alice@example.com', token: rid });
  const link = addLink(env.db, { messageId: message.id, url: 'https://example.com/x', label: null, position: 0 });
  const clickToken = addClickToken(env.db, { linkId: link.id, recipientId: recipient.id });
  return { message, recipient, rid, clickToken };
}

describe('geo wiring (finding #7)', () => {
  let env: TestServer;

  afterEach(async () => {
    await env.app.close();
    env.db.close();
  });

  it('a counted human open gets geo-tagged when a lookup is configured, capped to GEOIP_GRANULARITY', async () => {
    // privacyMode 'off' so PRIVACY_MODE's own downgrade (balanced -> country, strict -> none)
    // doesn't also apply here - this test isolates GEOIP_GRANULARITY's own cap (see the dedicated
    // PRIVACY_MODE test below for that interaction).
    env = setupTestServer({ startAt: SENT_AT + 60_000, geoLookup: FAKE_LOOKUP, configOverrides: { geoipGranularity: 'city', privacyMode: 'off' } });
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    await env.app.inject({
      method: 'GET',
      url: `/o/${token}.gif`,
      headers: { 'user-agent': CHROME_UA },
      remoteAddress: GEO_IP,
    });

    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.classification).toBe('human');
    expect(events[0]?.counted).toBe(1);
    expect(events[0]?.country).toBe('US');
    expect(events[0]?.region).toBe('CA');
    expect(events[0]?.city).toBe('Mountain View');
  });

  it('a counted click gets geo-tagged the same way', async () => {
    env = setupTestServer({ startAt: SENT_AT + 60_000, geoLookup: FAKE_LOOKUP, configOverrides: { geoipGranularity: 'city', privacyMode: 'off' } });
    const { recipient, clickToken } = seedMessage(env);
    const token = signToken('c', clickToken.id, TEST_SECRET);

    await env.app.inject({ method: 'GET', url: `/c/${token}`, headers: { 'user-agent': CHROME_UA }, remoteAddress: GEO_IP });

    const clicks = getClickEventsForRecipient(env.db, recipient.id);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.counted).toBe(1);
    expect(clicks[0]?.country).toBe('US');
    expect(clicks[0]?.city).toBe('Mountain View');
  });

  it('GEOIP_GRANULARITY=country caps region/city to null even though the lookup returned them', async () => {
    env = setupTestServer({ startAt: SENT_AT + 60_000, geoLookup: FAKE_LOOKUP, configOverrides: { geoipGranularity: 'country', privacyMode: 'off' } });
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    await env.app.inject({ method: 'GET', url: `/o/${token}.gif`, headers: { 'user-agent': CHROME_UA }, remoteAddress: GEO_IP });

    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events[0]?.country).toBe('US');
    expect(events[0]?.region).toBeNull();
    expect(events[0]?.city).toBeNull();
  });

  it('PRIVACY_MODE=strict suppresses geo entirely even with a working lookup configured', async () => {
    env = setupTestServer({
      startAt: SENT_AT + 60_000,
      geoLookup: FAKE_LOOKUP,
      configOverrides: { geoipGranularity: 'city', privacyMode: 'strict' },
    });
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    await env.app.inject({ method: 'GET', url: `/o/${token}.gif`, headers: { 'user-agent': CHROME_UA }, remoteAddress: GEO_IP });

    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events[0]?.country).toBeNull();
    expect(events[0]?.region).toBeNull();
    expect(events[0]?.city).toBeNull();
  });

  it('an uncounted (bot) open is never geo-tagged, even with a lookup configured', async () => {
    env = setupTestServer({ startAt: SENT_AT + 60_000, geoLookup: FAKE_LOOKUP, configOverrides: { geoipGranularity: 'city' } });
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    // A HEAD request is unconditionally classified 'bot' (uncounted) - see src/server/routes/pixel.ts.
    await env.app.inject({ method: 'HEAD', url: `/o/${token}.gif`, headers: { 'user-agent': CHROME_UA }, remoteAddress: GEO_IP });

    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.counted).toBe(0);
    expect(events[0]?.country).toBeNull();
  });

  it('with no geoLookup configured (the default), country/region/city stay null exactly as before this fix', async () => {
    env = setupTestServer({ startAt: SENT_AT + 60_000 });
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    await env.app.inject({ method: 'GET', url: `/o/${token}.gif`, headers: { 'user-agent': CHROME_UA }, remoteAddress: GEO_IP });

    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events[0]?.counted).toBe(1);
    expect(events[0]?.country).toBeNull();
  });
});
