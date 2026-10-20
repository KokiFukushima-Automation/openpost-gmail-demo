import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signToken } from '../../src/core/token.js';
import { newId } from '../../src/core/ids.js';
import {
  addRecipient,
  countAuditByAction,
  createMessage,
  ensureAccount,
  getEventsForRecipient,
  getRecipient,
  markMessageSent,
} from '../../src/db/repo.js';
import { setupTestServer, TEST_SECRET } from '../helpers/setup.js';
import type { TestServer } from '../helpers/setup.js';

const SENT_AT = 1_700_000_000_000;

function seedMessage(env: TestServer) {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(env.db, {
    accountId: account.id,
    subject: 'hi',
    bodyHtml: '<p>hi</p>',
    bodyText: 'hi',
    status: 'draft',
    trackingEnabled: true,
    clickTrackingEnabled: false,
  });
  markMessageSent(env.db, message.id, { rfc822MsgId: '<a@b>', sentAt: SENT_AT });
  const rid = newId();
  const recipient = addRecipient(env.db, {
    messageId: message.id,
    email: 'alice@example.com',
    token: rid,
  });
  return { message, recipient, rid };
}

describe('pixel flow', () => {
  let env: TestServer;

  beforeEach(() => {
    env = setupTestServer({ startAt: SENT_AT + 60_000 });
  });

  afterEach(async () => {
    await env.app.close();
    env.db.close();
  });

  it('37. GET /o/<valid>.gif -> 200, image/gif, 43 bytes, no-store, no etag/last-modified', async () => {
    const { rid } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);
    const res = await env.app.inject({ method: 'GET', url: `/o/${token}.gif` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(res.headers['content-length']).toBe('43');
    expect(res.headers['cache-control']).toContain('no-store');
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers['last-modified']).toBeUndefined();
  });

  it('38. an event row is created with the expected classification; counters bump only when counted', async () => {
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    await env.app.inject({
      method: 'GET',
      url: `/o/${token}.gif`,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' },
    });

    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.classification).toBe('human');
    expect(events[0]?.counted).toBe(1);

    const updated = getRecipient(env.db, recipient.id);
    expect(updated?.open_count).toBe(1);
    expect(updated?.machine_open_count).toBe(0);
  });

  it('39. a tampered token still returns 200 + GIF, records zero events, and audits token.reject', async () => {
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);
    const tampered = `${token.slice(0, -1)}${token.at(-1) === '0' ? '1' : '0'}`;

    const before = countAuditByAction(env.db, 'token.reject');
    const res = await env.app.inject({ method: 'GET', url: `/o/${tampered}.gif` });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(getEventsForRecipient(env.db, recipient.id)).toHaveLength(0);
    expect(countAuditByAction(env.db, 'token.reject')).toBe(before + 1);
  });

  it('39b. no raw IP address ever appears anywhere in the database (any table, any privacy mode)', async () => {
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);
    const testIp = '198.51.100.77';

    await env.app.inject({
      method: 'GET',
      url: `/o/${token}.gif`,
      remoteAddress: testIp,
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    // Also exercise the click and opt-out paths, and a tampered/orphan token, from the same IP -
    // every route that ever sees `req.clientIp` gets a chance to leak it into a row somewhere.
    await env.app.inject({
      method: 'GET',
      url: `/o/${token.slice(0, -1)}0.gif`,
      remoteAddress: testIp,
    });
    const optOutToken = signToken('u', rid, TEST_SECRET);
    await env.app.inject({ method: 'GET', url: `/u/${optOutToken}`, remoteAddress: testIp });

    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events.length).toBeGreaterThan(0);

    // acceptance criterion #7 / finding-driven hardening: scan every row of every table in the
    // database (not just open_events for one recipient) for the raw IP string, so a leak into
    // audit_log, click_events, or any future table would fail this test too.
    const tables = (
      env.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const rows = env.db.prepare(`SELECT * FROM ${table}`).all();
      const dump = JSON.stringify(rows);
      expect(dump, `table ${table} contains the raw IP`).not.toContain(testIp);
    }
  });

  it('40. HEAD /o/<valid>.gif -> 200, no body, recorded as an uncounted bot event (R6, Phase 1.1 amendment)', async () => {
    const { rid, recipient } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    const res = await env.app.inject({ method: 'HEAD', url: `/o/${token}.gif` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');

    // Phase 1.1 amendment (finding #17): HEAD now flows through the same classify+audit pipeline
    // as GET instead of being silently dropped, so it leaves the same trail every other bot signal
    // does - an uncounted `bot` event, never a counted human open.
    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.classification).toBe('bot');
    expect(events[0]?.counted).toBe(0);
    expect(events[0]?.reason).toContain('R6');

    const updated = getRecipient(env.db, recipient.id);
    expect(updated?.open_count).toBe(0);
  });

  it('41. unknown-but-well-signed rid -> 200, no event, token.orphan audit row', async () => {
    const unknownRid = newId();
    const token = signToken('o', unknownRid, TEST_SECRET);
    const before = countAuditByAction(env.db, 'token.orphan');

    const res = await env.app.inject({ method: 'GET', url: `/o/${token}.gif` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    expect(countAuditByAction(env.db, 'token.orphan')).toBe(before + 1);
  });

  it('42. GET /c/<valid> -> 302 to the exact original URL and one click event', async () => {
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

    const { addLink, addClickToken } = await import('../../src/db/repo.js');
    const originalUrl = 'https://example.com/x?a=1&b=two#frag';
    const link = addLink(env.db, { messageId: message.id, url: originalUrl, label: 'go', position: 0 });
    const clickToken = addClickToken(env.db, { linkId: link.id, recipientId: recipient.id });
    const token = signToken('c', clickToken.id, TEST_SECRET);

    const res = await env.app.inject({ method: 'GET', url: `/c/${token}` });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(originalUrl);

    const { getClickEventsForRecipient } = await import('../../src/db/repo.js');
    const clickEvents = getClickEventsForRecipient(env.db, recipient.id);
    expect(clickEvents).toHaveLength(1);
  });

  it('43. GET /u/<valid> opts out; subsequent pixel hit is opt_out, counted 0', async () => {
    const { rid, recipient } = seedMessage(env);
    const optOutToken = signToken('u', rid, TEST_SECRET);

    const res = await env.app.inject({ method: 'GET', url: `/u/${optOutToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');

    const updatedRecipient = getRecipient(env.db, recipient.id);
    expect(updatedRecipient?.opted_out_at).not.toBeNull();

    const { isSuppressed } = await import('../../src/db/repo.js');
    expect(isSuppressed(env.db, 'alice@example.com')).toBe(true);

    const pixelToken = signToken('o', rid, TEST_SECRET);
    await env.app.inject({ method: 'GET', url: `/o/${pixelToken}.gif` });
    const events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.classification).toBe('opt_out');
    expect(events[0]?.counted).toBe(0);

    // Finding #15: a reloaded/prefetched GET /u/<token> must not keep writing audit rows either.
    const { countAuditByAction } = await import('../../src/db/repo.js');
    const optedOutAt = updatedRecipient?.opted_out_at;
    await env.app.inject({ method: 'GET', url: `/u/${optOutToken}` });
    await env.app.inject({ method: 'GET', url: `/u/${optOutToken}` });
    expect(countAuditByAction(env.db, 'optout.record')).toBe(1);
    expect(getRecipient(env.db, recipient.id)?.opted_out_at).toBe(optedOutAt);
  });

  it('POST /u/<valid> is the RFC 8058 one-click endpoint: 200 text/plain, idempotent, suppresses the address', async () => {
    const { rid, recipient } = seedMessage(env);
    const optOutToken = signToken('u', rid, TEST_SECRET);

    const res = await env.app.inject({ method: 'POST', url: `/u/${optOutToken}`, payload: 'anything a mail client sends' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('OK');

    const updatedRecipient = getRecipient(env.db, recipient.id);
    expect(updatedRecipient?.opted_out_at).not.toBeNull();
    const { isSuppressed } = await import('../../src/db/repo.js');
    expect(isSuppressed(env.db, 'alice@example.com')).toBe(true);

    // Idempotent: a second POST is still 200 and does not throw.
    const res2 = await env.app.inject({ method: 'POST', url: `/u/${optOutToken}` });
    expect(res2.statusCode).toBe(200);

    // Finding #15: a replayed POST (RFC 8058 one-click POSTs are machine-generated and easily
    // replayed) must not keep writing a fresh audit row or rewriting opted_out_at - only the FIRST
    // valid hit (GET or POST) should ever record anything.
    const { countAuditByAction } = await import('../../src/db/repo.js');
    const optedOutAt = updatedRecipient?.opted_out_at;
    for (let i = 0; i < 5; i++) {
      await env.app.inject({ method: 'POST', url: `/u/${optOutToken}` });
    }
    expect(countAuditByAction(env.db, 'optout.record')).toBe(1);
    expect(getRecipient(env.db, recipient.id)?.opted_out_at).toBe(optedOutAt);
  });

  it('44. GET /healthz -> 200 {ok:true, schema:<current>}', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // Schema version 10 (Phase 5, 010_phase5.sql).
    expect(body.schema).toBe(10);
    expect(body.expectedSchema).toBe(10);
    expect(body.rangesLoaded).toEqual({ apple: 0, googleProxy: 0, datacenter: 0 });
  });

  it('45. /api/messages on a non-loopback bind requires a bearer token', async () => {
    const nonLoopback = setupTestServer({
      startAt: SENT_AT + 60_000,
      configOverrides: { bindAddress: '0.0.0.0', apiToken: 'secret-token' },
    });
    try {
      const unauthorized = await nonLoopback.app.inject({ method: 'GET', url: '/api/messages' });
      expect(unauthorized.statusCode).toBe(401);

      const authorized = await nonLoopback.app.inject({
        method: 'GET',
        url: '/api/messages',
        headers: { authorization: 'Bearer secret-token' },
      });
      expect(authorized.statusCode).toBe(200);
    } finally {
      await nonLoopback.app.close();
      nonLoopback.db.close();
    }
  });
});
