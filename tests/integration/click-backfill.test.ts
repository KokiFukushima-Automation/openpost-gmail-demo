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
  getRecipient,
} from '../../src/db/repo.js';
import { newId } from '../../src/core/ids.js';
import { signToken } from '../../src/core/token.js';
import { NotifyWorker } from '../../src/notify/worker.js';
import type { FetchLike } from '../../src/notify/types.js';

const SENT_AT = 1_700_000_000_000;
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const TARGET_URL = 'https://example.com/x?a=1#f';

function setupMessageWithLink(env: TestServer) {
  const account = ensureAccount(env.db, { email: 'sender@example.com', transport: 'dryrun' });
  const message = createMessage(env.db, {
    accountId: account.id,
    subject: 'hello',
    bodyHtml: `<p><a href="${TARGET_URL}">link</a></p>`,
    bodyText: 'hi',
    status: 'sent',
    trackingEnabled: true,
    clickTrackingEnabled: true,
  });
  env.db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(SENT_AT, message.id);
  const recipient = addRecipient(env.db, { messageId: message.id, email: 'alice@example.com', token: newId() });
  const link = addLink(env.db, { messageId: message.id, url: TARGET_URL, label: 'link', position: 0 });
  const clickToken = addClickToken(env.db, { linkId: link.id, recipientId: recipient.id });
  return { message, recipient, link, clickToken };
}

describe('click tracking + click->open back-fill', () => {
  let env: TestServer;

  beforeEach(() => {
    env = setupTestServer({ startAt: SENT_AT + 60_000 });
  });

  it('89. a counted click with no prior open redirects to the exact original URL, counts one click, back-fills one open, and moves state to read_confirmed', async () => {
    const { recipient, clickToken } = setupMessageWithLink(env);
    const secret = env.config.trackingSecret as string;
    const signed = signToken('c', clickToken.id, secret);

    const res = await env.app.inject({ method: 'GET', url: `/c/${signed}`, headers: { 'user-agent': CHROME_UA } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(TARGET_URL);

    const clicks = getClickEventsForRecipient(env.db, recipient.id);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.counted).toBe(1);

    const opens = getEventsForRecipient(env.db, recipient.id);
    expect(opens).toHaveLength(1);
    expect(opens[0]?.reason).toContain('implied_by_click');
    expect(opens[0]?.counted).toBe(1);

    const updated = getRecipient(env.db, recipient.id);
    expect(updated?.open_count).toBe(1);
    expect(updated?.state).toBe('read_confirmed');
  });

  it('90. HEAD on the click URL -> scanner, counted 0, no back-fill', async () => {
    const { recipient, clickToken } = setupMessageWithLink(env);
    const secret = env.config.trackingSecret as string;
    const signed = signToken('c', clickToken.id, secret);

    const res = await env.app.inject({ method: 'HEAD', url: `/c/${signed}` });
    expect(res.statusCode).toBe(302);

    const clicks = getClickEventsForRecipient(env.db, recipient.id);
    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.classification).toBe('scanner');
    expect(clicks[0]?.counted).toBe(0);

    const opens = getEventsForRecipient(env.db, recipient.id);
    expect(opens).toHaveLength(0);
  });

  it('91. a second counted click adds no second implied open', async () => {
    const { recipient, clickToken } = setupMessageWithLink(env);
    const secret = env.config.trackingSecret as string;
    const signed = signToken('c', clickToken.id, secret);

    await env.app.inject({ method: 'GET', url: `/c/${signed}`, headers: { 'user-agent': CHROME_UA } });
    env.clock.now += 5000;
    await env.app.inject({ method: 'GET', url: `/c/${signed}`, headers: { 'user-agent': CHROME_UA } });

    const clicks = getClickEventsForRecipient(env.db, recipient.id);
    expect(clicks).toHaveLength(2);
    const opens = getEventsForRecipient(env.db, recipient.id);
    expect(opens).toHaveLength(1);
  });

  it('92. click events are redacted per PRIVACY_MODE and store confidence/reason', async () => {
    const balancedEnv = setupTestServer({ startAt: SENT_AT + 60_000, configOverrides: { privacyMode: 'balanced' } });
    const { recipient: balancedRecipient, clickToken: balancedToken } = setupMessageWithLink(balancedEnv);
    const secret = balancedEnv.config.trackingSecret as string;
    await balancedEnv.app.inject({
      method: 'GET',
      url: `/c/${signToken('c', balancedToken.id, secret)}`,
      headers: { 'user-agent': CHROME_UA },
    });
    const balancedClicks = getClickEventsForRecipient(balancedEnv.db, balancedRecipient.id);
    expect(balancedClicks[0]?.ua).toBeNull();
    expect(balancedClicks[0]?.ua_family).toBe('Chrome');
    expect(balancedClicks[0]?.confidence).toBeGreaterThan(0);
    expect(balancedClicks[0]?.reason).not.toBeNull();

    const strictEnv = setupTestServer({ startAt: SENT_AT + 60_000, configOverrides: { privacyMode: 'strict' } });
    const { recipient: strictRecipient, clickToken: strictToken } = setupMessageWithLink(strictEnv);
    const strictSecret = strictEnv.config.trackingSecret as string;
    await strictEnv.app.inject({
      method: 'GET',
      url: `/c/${signToken('c', strictToken.id, strictSecret)}`,
      headers: { 'user-agent': CHROME_UA },
    });
    const strictClicks = getClickEventsForRecipient(strictEnv.db, strictRecipient.id);
    expect(strictClicks[0]?.ua).toBeNull();
    expect(strictClicks[0]?.ua_family).toBeNull();
    expect(strictClicks[0]?.ip_hash).toBeNull();
    expect(strictClicks[0]?.device_type).toBeNull();
  });

  it('finding #2/#6 regression: a back-filling click enqueues exactly one notification row, atomically with the event', async () => {
    // A stub `fetch` that always fails fast: real notifiers (built from config, so
    // isConfigured('webhook') is true) are used for the enqueue-time check, but nothing ever
    // reaches the network - this test only exercises enqueue, never a real delivery.
    const stubFetch: FetchLike = (async () => ({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => '',
    })) as unknown as FetchLike;
    const wiredEnv = setupTestServer({
      startAt: SENT_AT + 60_000,
      buildNotifyWorker: (db, config, bus) => new NotifyWorker({ db, config, bus, fetch: stubFetch }),
      configOverrides: {
        notifyChannels: ['webhook'],
        webhookUrl: 'https://hook.test/x',
        webhookSecret: 'shh-secret-value',
        notifyOn: ['first_open', 'read_confirmed', 'click'],
      },
    });
    const { clickToken } = setupMessageWithLink(wiredEnv);
    const secret = wiredEnv.config.trackingSecret as string;
    const signed = signToken('c', clickToken.id, secret);

    const res = await wiredEnv.app.inject({ method: 'GET', url: `/c/${signed}`, headers: { 'user-agent': CHROME_UA } });
    expect(res.statusCode).toBe(302);

    const rowCount = wiredEnv.db.prepare('SELECT COUNT(*) AS n FROM notifications').get() as { n: number };
    expect(rowCount.n).toBe(1);
    const row = wiredEnv.db.prepare('SELECT trigger FROM notifications').get() as { trigger: string };
    expect(row.trigger).toBe('click');
  });
});
