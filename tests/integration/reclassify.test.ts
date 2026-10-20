import { beforeEach, describe, expect, it } from 'vitest';
import { setupTestServer, type TestServer } from '../helpers/setup.js';
import {
  addClickToken,
  addLink,
  addRecipient,
  createMessage,
  ensureAccount,
  getClickEventsForRecipient,
  getEventsForRecipient,
  getOpenEvent,
  getRecipient,
} from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { signToken } from '../../src/core/token.js';

const SENT_AT = 1_700_000_000_000;
const BOT_UA = 'curl/8.5.0';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function setup(env: TestServer) {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(env.db, {
    accountId: account.id,
    subject: 'hello',
    bodyHtml: '<p><a href="https://example.com/x">link</a></p>',
    bodyText: 'hi',
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: true,
  });
  env.db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(SENT_AT, message.id);
  const recipient = addRecipient(env.db, { messageId: message.id, email: 'alice@example.com', token: newId() });
  const link = addLink(env.db, { messageId: message.id, url: 'https://example.com/x', label: 'link', position: 0 });
  const clickToken = addClickToken(env.db, { linkId: link.id, recipientId: recipient.id });
  return { message, recipient, link, clickToken };
}

describe('reclassify', () => {
  let env: TestServer;

  beforeEach(() => {
    env = setupTestServer({
      startAt: SENT_AT + 60_000,
      configOverrides: { notifyChannels: ['webhook'], webhookUrl: 'https://hook.test/x', webhookSecret: 'shh-secret' },
    });
  });

  it('94. POST /api/events/open/:id/reclassify bot->human recomputes counters, changes state, one audit row, zero notifications', async () => {
    const { recipient } = setup(env);
    const secret = env.config.trackingSecret as string;
    await env.app.inject({ method: 'GET', url: `/o/${signToken('o', recipient.token, secret)}.gif`, headers: { 'user-agent': BOT_UA } });
    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.classification).toBe('bot');

    const publishedEvents: unknown[] = [];
    env.bus.subscribe((e) => publishedEvents.push(e));

    const res = await env.app.inject({
      method: 'POST',
      url: `/api/events/open/${events[0]?.id}/reclassify`,
      payload: { classification: 'human', note: 'confirmed by reply', actor: 'me' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.before.classification).toBe('bot');
    expect(body.after.classification).toBe('human');
    expect(body.recipient.state).not.toBe('not_opened');

    const updated = getRecipient(env.db, recipient.id);
    expect(updated?.open_count).toBe(1);
    expect(updated?.state).toBe('opened');

    const auditCount = env.db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'reclassify.override'`).get() as {
      n: number;
    };
    expect(auditCount.n).toBe(1);
    expect(publishedEvents).toHaveLength(0);
  });

  it('95. click human->scanner removes the orphaned implied open and decrements click_count', async () => {
    const { recipient, clickToken } = setup(env);
    const secret = env.config.trackingSecret as string;
    await env.app.inject({ method: 'GET', url: `/c/${signToken('c', clickToken.id, secret)}`, headers: { 'user-agent': CHROME_UA } });

    let updated = getRecipient(env.db, recipient.id);
    expect(updated?.click_count).toBe(1);
    expect(updated?.open_count).toBe(1); // back-filled

    const clickEventRow = env.db.prepare('SELECT id FROM click_events WHERE recipient_id = ?').get(recipient.id) as { id: string };

    const res = await env.app.inject({
      method: 'POST',
      url: `/api/events/click/${clickEventRow.id}/reclassify`,
      payload: { classification: 'scanner', actor: 'me' },
    });
    expect(res.statusCode).toBe(200);

    updated = getRecipient(env.db, recipient.id);
    expect(updated?.click_count).toBe(0);
    expect(updated?.open_count).toBe(0);
    const remainingOpens = getEventsForRecipient(env.db, recipient.id);
    expect(remainingOpens).toHaveLength(0);
  });

  it('finding #8: demoting one of two counted clicks keeps the implied open (another counted click still justifies it) and state stays read_confirmed', async () => {
    const { message, recipient, link } = setup(env);
    const secret = env.config.trackingSecret as string;
    // A second link/click token, so this recipient can rack up a *second* counted click without a
    // second implied open (clickBackfillOpens only fires while open_count === 0).
    const link2 = addLink(env.db, { messageId: message.id, url: 'https://example.com/y', label: 'link2', position: 1 });
    const clickToken1 = addClickToken(env.db, { linkId: link.id, recipientId: recipient.id });
    const clickToken2 = addClickToken(env.db, { linkId: link2.id, recipientId: recipient.id });

    await env.app.inject({ method: 'GET', url: `/c/${signToken('c', clickToken1.id, secret)}`, headers: { 'user-agent': CHROME_UA } });
    env.clock.now += 40_000; // past DEDUPE_SECONDS (30s default) so the second click isn't R8-deduped
    await env.app.inject({ method: 'GET', url: `/c/${signToken('c', clickToken2.id, secret)}`, headers: { 'user-agent': CHROME_UA } });

    let updated = getRecipient(env.db, recipient.id);
    expect(updated?.click_count).toBe(2);
    expect(updated?.open_count).toBe(1); // exactly one implied open, from the first click only
    const opensBefore = getEventsForRecipient(env.db, recipient.id);
    expect(opensBefore).toHaveLength(1);

    // Demote the FIRST click (the one that actually caused the back-fill) away from human.
    const clicks = getClickEventsForRecipient(env.db, recipient.id).sort((a, b) => a.occurred_at - b.occurred_at);
    const firstClickId = clicks[0]?.id as string;
    const res = await env.app.inject({
      method: 'POST',
      url: `/api/events/click/${firstClickId}/reclassify`,
      payload: { classification: 'scanner', actor: 'me' },
    });
    expect(res.statusCode).toBe(200);

    // The second click is still counted, so the implied open must survive - and the recipient must
    // not fall back to anything less than read_confirmed.
    const opensAfter = getEventsForRecipient(env.db, recipient.id);
    expect(opensAfter).toHaveLength(1);
    updated = getRecipient(env.db, recipient.id);
    expect(updated?.click_count).toBe(1);
    expect(updated?.state).toBe('read_confirmed');
  });

  it('96. unknown id -> 404; an out-of-enum classification -> 400; a second override keeps the first original_classification', async () => {
    const { recipient } = setup(env);
    const secret = env.config.trackingSecret as string;
    await env.app.inject({ method: 'GET', url: `/o/${signToken('o', recipient.token, secret)}.gif`, headers: { 'user-agent': BOT_UA } });
    const events = getEventsForRecipient(env.db, recipient.id);
    const eventId = events[0]?.id as string;

    const notFound = await env.app.inject({
      method: 'POST',
      url: `/api/events/open/does-not-exist/reclassify`,
      payload: { classification: 'human' },
    });
    expect(notFound.statusCode).toBe(404);

    const badEnum = await env.app.inject({
      method: 'POST',
      url: `/api/events/open/${eventId}/reclassify`,
      payload: { classification: 'not_a_real_classification' },
    });
    expect(badEnum.statusCode).toBe(400);

    await env.app.inject({
      method: 'POST',
      url: `/api/events/open/${eventId}/reclassify`,
      payload: { classification: 'human' },
    });
    await env.app.inject({
      method: 'POST',
      url: `/api/events/open/${eventId}/reclassify`,
      payload: { classification: 'bot', counted: false },
    });
    const finalEvent = getOpenEvent(env.db, eventId);
    expect(finalEvent?.original_classification).toBe('bot');
  });

  it('finding #12: body.counted must be a real boolean, and unknown top-level fields are rejected', async () => {
    const { recipient } = setup(env);
    const secret = env.config.trackingSecret as string;
    await env.app.inject({ method: 'GET', url: `/o/${signToken('o', recipient.token, secret)}.gif`, headers: { 'user-agent': BOT_UA } });
    const events = getEventsForRecipient(env.db, recipient.id);
    const eventId = events[0]?.id as string;

    // The exact footgun this finding names: a JSON string "false" is truthy in JS.
    const stringCounted = await env.app.inject({
      method: 'POST',
      url: `/api/events/open/${eventId}/reclassify`,
      payload: { classification: 'human', counted: 'false' },
    });
    expect(stringCounted.statusCode).toBe(400);

    const unknownField = await env.app.inject({
      method: 'POST',
      url: `/api/events/open/${eventId}/reclassify`,
      payload: { classification: 'human', counter: false },
    });
    expect(unknownField.statusCode).toBe(400);

    // A real boolean still works, and is honoured exactly (counted:false on a human override).
    const ok = await env.app.inject({
      method: 'POST',
      url: `/api/events/open/${eventId}/reclassify`,
      payload: { classification: 'human', counted: false },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().after.counted).toBe(false);
  });

  it('97. openpost reclassify --json prints {before, after, recipient}', async () => {
    const { recipient } = setup(env);
    const secret = env.config.trackingSecret as string;
    await env.app.inject({ method: 'GET', url: `/o/${signToken('o', recipient.token, secret)}.gif`, headers: { 'user-agent': BOT_UA } });
    const events = getEventsForRecipient(env.db, recipient.id);
    const eventId = events[0]?.id as string;

    const { reclassify } = await import('../../src/server/services/reclassify.js');
    const result = reclassify(env.db, { kind: 'open', eventId, classification: 'human', actor: 'cli', atMs: Date.now() });
    expect(result).toHaveProperty('before');
    expect(result).toHaveProperty('after');
    expect(result).toHaveProperty('recipient');
  });
});
