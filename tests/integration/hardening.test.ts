import { afterEach, describe, expect, it } from 'vitest';
import { signToken } from '../../src/core/token.js';
import { newId } from '../../src/core/ids.js';
import { hashIp } from '../../src/core/privacy.js';
import {
  addClickToken,
  addLink,
  addRecipient,
  audit,
  countAuditByAction,
  createMessage,
  ensureAccount,
  getClickEventsForRecipient,
  getEventsForRecipient,
  getRecipient,
  markMessageSent,
  pruneEvents,
} from '../../src/db/repo.js';
import { setupTestServer, TEST_SECRET } from '../helpers/setup.js';
import type { TestServer } from '../helpers/setup.js';

const SENT_AT = 1_700_000_000_000;
const WELL_AFTER_SEND = SENT_AT + 5 * 60_000; // past R1/R2/R4 windows

function seedMessage(env: TestServer, opts: { clickTracking?: boolean } = {}) {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(env.db, {
    accountId: account.id,
    subject: 'hi',
    bodyHtml: '<p>hi</p>',
    bodyText: 'hi',
    status: 'draft',
    trackingEnabled: true,
    clickTrackingEnabled: !!opts.clickTracking,
  });
  markMessageSent(env.db, message.id, { rfc822MsgId: '<a@b>', sentAt: SENT_AT });
  const rid = newId();
  const recipient = addRecipient(env.db, { messageId: message.id, email: `${rid}@example.com`, token: rid });
  return { message, recipient, rid };
}

describe('hardening (Phase 1.1 review findings)', () => {
  let env: TestServer | undefined;

  afterEach(async () => {
    if (env) {
      await env.app.close();
      env.db.close();
      env = undefined;
    }
  });

  it('finding #1: click events are redacted per PRIVACY_MODE, just like open events', async () => {
    for (const mode of ['balanced', 'strict'] as const) {
      env = setupTestServer({ startAt: WELL_AFTER_SEND, configOverrides: { privacyMode: mode } });
      const { message, recipient } = seedMessage(env, { clickTracking: true });
      const link = addLink(env.db, { messageId: message.id, url: 'https://example.com/x', label: 'go', position: 0 });
      const clickToken = addClickToken(env.db, { linkId: link.id, recipientId: recipient.id });
      const token = signToken('c', clickToken.id, TEST_SECRET);

      const res = await env.app.inject({
        method: 'GET',
        url: `/c/${token}`,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' },
        remoteAddress: '198.51.100.9',
      });
      expect(res.statusCode).toBe(302);

      const events = getClickEventsForRecipient(env.db, recipient.id);
      expect(events).toHaveLength(1);
      const e = events[0]!;
      if (mode === 'strict') {
        expect(e.ip_hash).toBeNull();
        expect(e.ip_net_hash).toBeNull();
        expect(e.ua).toBeNull();
        expect(e.ua_family).toBeNull();
        expect(e.device_type).toBeNull();
        expect(e.os).toBeNull();
      } else {
        // balanced: raw UA nulled, but the parsed family/device survive, and hashes are kept
        // (they're needed for R7/R8 and are not raw IP).
        expect(e.ua).toBeNull();
        expect(e.ua_family).toBe('Chrome');
        expect(e.device_type).toBe('desktop');
        expect(e.ip_hash).not.toBeNull();
        expect(e.ip_net_hash).not.toBeNull();
      }
      await env.app.close();
      env.db.close();
      env = undefined;
    }
  });

  it('finding #1 / no gap: full pixel-through-route check for strict and balanced privacy modes', async () => {
    for (const mode of ['balanced', 'strict'] as const) {
      env = setupTestServer({ startAt: WELL_AFTER_SEND, configOverrides: { privacyMode: mode } });
      const { recipient, rid } = seedMessage(env);
      const token = signToken('o', rid, TEST_SECRET);
      await env.app.inject({
        method: 'GET',
        url: `/o/${token}.gif`,
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' },
        remoteAddress: '198.51.100.10',
      });
      const events = getEventsForRecipient(env.db, recipient.id);
      expect(events).toHaveLength(1);
      expect(events[0]?.classification).toBe('human');
      expect(events[0]?.counted).toBe(1);
      if (mode === 'strict') {
        expect(events[0]?.ip_hash).toBeNull();
        expect(events[0]?.ua_family).toBeNull();
        expect(events[0]?.device_type).toBeNull();
      } else {
        expect(events[0]?.ua_family).toBe('Chrome');
        expect(events[0]?.ip_hash).not.toBeNull();
      }
      await env.app.close();
      env.db.close();
      env = undefined;
    }
  });

  it('finding #3: strict-mode dedupe (R8) and fanout (R7) still work via short-lived in-memory correlation', async () => {
    env = setupTestServer({ startAt: WELL_AFTER_SEND, configOverrides: { privacyMode: 'strict' } });
    const { recipient, rid } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);
    const ua = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' };

    await env.app.inject({ method: 'GET', url: `/o/${token}.gif`, headers: ua, remoteAddress: '198.51.100.20' });
    let events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.classification).toBe('human');
    expect(events[0]?.counted).toBe(1);

    // Same recipient, same net/UA, 5s later: without correlation this would also be persisted
    // as counted `human` (a fresh count every hit), because the stored row's ip_net_hash/ua_family
    // are nulled in strict mode.
    env.clock.now += 5_000;
    await env.app.inject({ method: 'GET', url: `/o/${token}.gif`, headers: ua, remoteAddress: '198.51.100.20' });
    events = getEventsForRecipient(env.db, recipient.id);
    expect(events).toHaveLength(2);
    expect(events[1]?.classification).toBe('duplicate');
    expect(events[1]?.counted).toBe(0);

    const updated = getRecipient(env.db, recipient.id);
    expect(updated?.open_count).toBe(1);
  });

  it('finding #4: a message with tracking disabled never produces an open_events row even if probed', async () => {
    env = setupTestServer({ startAt: WELL_AFTER_SEND });
    const account = ensureAccount(env.db, { email: 'sender2@example.com', transport: 'dryrun' });
    const message = createMessage(env.db, {
      accountId: account.id,
      subject: 'no-track',
      bodyHtml: '<p>x</p>',
      bodyText: 'x',
      status: 'draft',
      trackingEnabled: false,
      clickTrackingEnabled: false,
    });
    markMessageSent(env.db, message.id, { rfc822MsgId: '<c@d>', sentAt: SENT_AT });
    const rid = newId();
    const recipient = addRecipient(env.db, { messageId: message.id, email: 'notracked@example.com', token: rid });
    const token = signToken('o', rid, TEST_SECRET);

    const res = await env.app.inject({ method: 'GET', url: `/o/${token}.gif` });
    expect(res.statusCode).toBe(200);
    expect(getEventsForRecipient(env.db, recipient.id)).toHaveLength(0);
  });

  it('finding #5: TRUST_PROXY as a hop count extracts the real client through exactly one trusted proxy', async () => {
    const ipSalt = 'trust-proxy-test-salt';
    const claimedClientIp = '203.0.113.77';
    const proxyHop = '10.1.1.1';
    const selfHash = hashIp(claimedClientIp, ipSalt, WELL_AFTER_SEND) as string;

    // With TRUST_PROXY=1: the header's claimed client IP is used for hashing.
    env = setupTestServer({
      startAt: WELL_AFTER_SEND,
      configOverrides: { ipSalt, trustProxy: 1, selfIpHashes: [selfHash] },
    });
    const { recipient, rid } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);
    await env.app.inject({
      method: 'GET',
      url: `/o/${token}.gif`,
      headers: { 'x-forwarded-for': claimedClientIp },
      remoteAddress: proxyHop,
    });
    const trusted = getEventsForRecipient(env.db, recipient.id);
    expect(trusted).toHaveLength(1);
    expect(trusted[0]?.classification).toBe('self_open');
    await env.app.close();
    env.db.close();

    // With TRUST_PROXY unset (false): the same header is ignored - the socket peer's own address
    // is hashed instead, which never matches selfIpHashes, so this is a normal human open.
    env = setupTestServer({
      startAt: WELL_AFTER_SEND,
      configOverrides: { ipSalt, trustProxy: false, selfIpHashes: [selfHash] },
    });
    const seed2 = seedMessage(env);
    const token2 = signToken('o', seed2.rid, TEST_SECRET);
    await env.app.inject({
      method: 'GET',
      url: `/o/${token2}.gif`,
      headers: { 'x-forwarded-for': claimedClientIp },
      remoteAddress: proxyHop,
    });
    const untrusted = getEventsForRecipient(env.db, seed2.recipient.id);
    expect(untrusted).toHaveLength(1);
    expect(untrusted[0]?.classification).not.toBe('self_open');
  });

  it('finding #6: audit_log is pruned on the same retention window as events', () => {
    const db = setupTestServer().db; // fresh db, no app needed
    audit(db, { actor: 'server', action: 'token.reject', detail: {} });
    db.prepare('UPDATE audit_log SET at = ?').run(1); // force it "old"

    const olderThan = Date.now() - 1000;
    const dryRun = pruneEvents(db, olderThan, true);
    expect(dryRun.audit).toBeGreaterThanOrEqual(1);
    const real = pruneEvents(db, olderThan, false);
    expect(real.audit).toBeGreaterThanOrEqual(1);
    const remaining = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE at < ?').get(olderThan) as {
      n: number;
    };
    expect(remaining.n).toBe(0);
    db.close();
  });

  it('finding #6: rejection audits are rate-limited so a burst of bad tokens cannot grow audit_log without bound', async () => {
    env = setupTestServer({ startAt: WELL_AFTER_SEND });
    const before = countAuditByAction(env.db, 'token.reject');
    for (let i = 0; i < 60; i++) {
      await env.app.inject({ method: 'GET', url: `/o/not-a-valid-token-${i}.gif` });
    }
    const after = countAuditByAction(env.db, 'token.reject');
    expect(after - before).toBeLessThan(60);
    expect(after - before).toBeGreaterThan(0);
  });

  it('finding #10: GET /api/messages?limit=abc -> 400, not a 500', async () => {
    env = setupTestServer();
    const res = await env.app.inject({ method: 'GET', url: '/api/messages?limit=abc' });
    expect(res.statusCode).toBe(400);

    const offsetRes = await env.app.inject({ method: 'GET', url: '/api/messages?offset=-1' });
    expect(offsetRes.statusCode).toBe(400);

    const ok = await env.app.inject({ method: 'GET', url: '/api/messages?limit=5' });
    expect(ok.statusCode).toBe(200);
  });

  it('finding #2: /api requires a bearer whenever API_TOKEN is set, even on a loopback bind', async () => {
    env = setupTestServer({ configOverrides: { apiToken: 'secret-token', bindAddress: '127.0.0.1' } });
    const unauthorized = await env.app.inject({ method: 'GET', url: '/api/messages' });
    expect(unauthorized.statusCode).toBe(401);
    const authorized = await env.app.inject({
      method: 'GET',
      url: '/api/messages',
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(authorized.statusCode).toBe(200);
  });

  it('finding #2: /api never returns signed tokens by default, only when explicitly requested', async () => {
    env = setupTestServer({ startAt: WELL_AFTER_SEND });
    const { message } = seedMessage(env);

    const withoutTokens = await env.app.inject({ method: 'GET', url: `/api/messages/${message.id}` });
    expect(withoutTokens.statusCode).toBe(200);
    const bodyWithout = withoutTokens.json();
    expect(bodyWithout.recipients[0].pixelUrl).toBeNull();
    expect(bodyWithout.recipients[0].optOutUrl).toBeNull();

    const withTokens = await env.app.inject({ method: 'GET', url: `/api/messages/${message.id}?tokens=1` });
    const bodyWith = withTokens.json();
    expect(bodyWith.recipients[0].pixelUrl).toContain('/o/');
  });

  it('finding #15: machine_open_count is bumped only for proxy/MPP/bot/self, not dnt/opt_out/duplicate', async () => {
    env = setupTestServer({ startAt: WELL_AFTER_SEND, configOverrides: { respectDnt: true } });
    const { recipient, rid } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    // dnt -> classification 'dnt', must not bump machine_open_count.
    await env.app.inject({ method: 'GET', url: `/o/${token}.gif`, headers: { dnt: '1' } });
    let updated = getRecipient(env.db, recipient.id);
    expect(updated?.machine_open_count).toBe(0);

    // bot UA -> classification 'bot', must bump machine_open_count.
    await env.app.inject({ method: 'GET', url: `/o/${token}.gif`, headers: { 'user-agent': 'curl/8.5.0' } });
    updated = getRecipient(env.db, recipient.id);
    expect(updated?.machine_open_count).toBe(1);

    // A genuine human open, then an immediate duplicate -> 'duplicate' must not bump either counter.
    await env.app.inject({
      method: 'GET',
      url: `/o/${token}.gif`,
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    updated = getRecipient(env.db, recipient.id);
    const openCountAfterHuman = updated?.open_count ?? 0;
    await env.app.inject({
      method: 'GET',
      url: `/o/${token}.gif`,
      headers: { 'user-agent': 'Mozilla/5.0 Chrome/120.0' },
    });
    updated = getRecipient(env.db, recipient.id);
    expect(updated?.open_count).toBe(openCountAfterHuman);
    expect(updated?.machine_open_count).toBe(1); // unchanged from the bot hit above
  });

  it('finding #16: the reported pixel URL is stable across repeated /api reads (persisted cache-buster)', async () => {
    env = setupTestServer({ startAt: WELL_AFTER_SEND });
    const account = ensureAccount(env.db, { email: 'sender3@example.com', transport: 'dryrun' });
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
    // Persist a cache-buster at recipient-creation time, exactly as `send` now does (finding #16).
    addRecipient(env.db, {
      messageId: message.id,
      email: 'cachebuster@example.com',
      token: newId(),
      cacheBuster: 'fixedcbv',
    });

    const first = await env.app.inject({ method: 'GET', url: `/api/messages/${message.id}?tokens=1` });
    const second = await env.app.inject({ method: 'GET', url: `/api/messages/${message.id}?tokens=1` });
    const urlA = first.json().recipients[0].pixelUrl as string;
    const urlB = second.json().recipients[0].pixelUrl as string;
    expect(urlA).toBe(urlB);
  });

  it('finding #12: a failed open-event insert is recorded as an open.record.failed audit row', async () => {
    env = setupTestServer({ startAt: WELL_AFTER_SEND });
    const { rid } = seedMessage(env);
    const token = signToken('o', rid, TEST_SECRET);

    // Make inserts into open_events fail (reads still work, so classification itself succeeds and
    // only insertOpenEvent's write fails) without touching audit_log at all.
    env.db.exec(
      `CREATE TRIGGER fail_open_event_insert BEFORE INSERT ON open_events
       BEGIN SELECT RAISE(ABORT, 'simulated insert failure'); END;`,
    );

    const before = countAuditByAction(env.db, 'open.record.failed');
    const res = await env.app.inject({ method: 'GET', url: `/o/${token}.gif` });
    // The pixel response was already sent before the DB write was attempted (doc 02 §1.3).
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/gif');
    const after = countAuditByAction(env.db, 'open.record.failed');
    expect(after).toBe(before + 1);
  });
});
