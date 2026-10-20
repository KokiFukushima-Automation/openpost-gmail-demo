import { describe, expect, it } from 'vitest';
import { openDb, migrate } from '../../src/db/index.js';
import { upsertSubscription, getSubscription, listActiveSubscriptions } from '../../src/db/push.js';
import { generateVapidKeys } from '../../src/core/webpush.js';
import { buildPushPayload, webpushNotifier } from '../../src/notify/channels/webpush.js';
import { redactPushEndpoint } from '../../src/notify/channels/util.js';
import { buildPayload } from '../../src/notify/payload.js';
import type { NotifierDeps, TrackingEvent } from '../../src/notify/types.js';
import { makeSubscriber, makeFakePushService } from '../helpers/fake-push.js';
import { makeConfig } from '../helpers/setup.js';
import { isValidPushEndpoint } from '../../src/server/routes/dashboard-actions.js';

function baseEvent(overrides: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    kind: 'open',
    eventId: 'evt1',
    occurredAt: 1_700_000_000_000,
    messageId: 'msg1',
    subject: 'Hi there',
    recipientId: 'rcpt1',
    recipientEmail: 'alice@example.com',
    classification: 'human',
    reasons: ['R9'],
    counted: true,
    backfilled: false,
    prevState: 'not_opened',
    newState: 'read_confirmed',
    counters: { openCount: 1, machineOpenCount: 0, clickCount: 0, firstOpenAt: 1, lastOpenAt: 1 },
    uaFamily: 'Chrome',
    deviceType: 'desktop',
    linkUrl: null,
    muted: false,
    sentAt: 1_700_000_000_000 - 60_000,
    country: null,
    isAggregate: false,
    recipientCount: 0,
    campaignId: null,
    ...overrides,
  };
}

function setupDb() {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

function baseDeps(db: ReturnType<typeof setupDb>, fetchImpl: NotifierDeps['fetch']): NotifierDeps {
  const keys = generateVapidKeys();
  const config = makeConfig({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:ops@example.com' });
  return { db, config, fetch: fetchImpl, timeoutMs: 5000, clock: () => 1_700_000_000_000 };
}

describe('webpush notify channel', () => {
  it('402/403. payload honours NOTIFY_INCLUDE_SUBJECT/NOTIFY_REDACT_EMAIL and url is always a /dashboard/-prefixed path', () => {
    const config = makeConfig({ notifyIncludeSubject: false, notifyRedactEmail: true });
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', config);
    const json = buildPushPayload(payload, config);
    expect(json.url).toBe('/dashboard/messages/msg1');
    expect(json.url.startsWith('/dashboard/')).toBe(true);
    expect(json.body).not.toContain('Hi there');
    expect(json.tag).toBe('msg1');
    // finding #10 (phase5.1): also assert the redacted recipient address never leaks into the push
    // body itself when NOTIFY_REDACT_EMAIL is on.
    expect(json.body).not.toContain('alice@example.com');
  });

  it('404. zero active subscriptions -> row sent, zero fetches, no dead letter', async () => {
    const db = setupDb();
    let calls = 0;
    const fetchImpl: NotifierDeps['fetch'] = async () => {
      calls += 1;
      return { status: 201, ok: true, headers: { get: () => null }, text: async () => '' };
    };
    const deps = baseDeps(db, fetchImpl);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', deps.config);
    const result = await webpushNotifier.deliver(payload, deps);
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it('397/398. a 410 disables exactly that subscription; with one 410 + two successes the row is sent and posts to exactly 2 endpoints next time', async () => {
    const db = setupDb();
    const subA = makeSubscriber('https://push.example.com/wp/a');
    const subB = makeSubscriber('https://push.example.com/wp/b');
    const subC = makeSubscriber('https://push.example.com/wp/c');
    for (const s of [subA, subB, subC]) {
      upsertSubscription(db, { endpoint: s.subscription.endpoint, p256dh: s.subscription.keys.p256dh, auth: s.subscription.keys.auth, createdAt: 1 });
    }
    const responses = new Map([[subA.subscription.endpoint, { status: 410 } as const]]);
    const fake = makeFakePushService(responses);
    const deps = baseDeps(db, fake.fetch);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', deps.config);

    const result = await webpushNotifier.deliver(payload, deps);
    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(3);

    const active = listActiveSubscriptions(db);
    expect(active).toHaveLength(2);
    expect(active.map((r) => r.endpoint).sort()).toEqual([subB.subscription.endpoint, subC.subscription.endpoint].sort());

    // A subsequent notification posts only to the two survivors.
    const result2 = await webpushNotifier.deliver(buildPayload(baseEvent({ eventId: 'evt2' }), 'read_confirmed', 'notif2', deps.config), deps);
    expect(result2.ok).toBe(true);
    expect(fake.requests).toHaveLength(5);
  });

  it('the encrypted body decrypts (RFC 8291) to the expected JSON, with the correct headers', async () => {
    const db = setupDb();
    const sub = makeSubscriber('https://push.example.com/wp/one');
    upsertSubscription(db, { endpoint: sub.subscription.endpoint, p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth, createdAt: 1 });
    const fake = makeFakePushService(new Map());
    const deps = baseDeps(db, fake.fetch);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', deps.config);

    const result = await webpushNotifier.deliver(payload, deps);
    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(1);
    const req = fake.requests[0]!;
    expect(req.headers['Content-Encoding']).toBe('aes128gcm');
    expect(req.headers['TTL']).toBeDefined();
    expect(req.headers['Authorization']).toMatch(/^vapid t=.+, k=.+$/);

    const decrypted = sub.decrypt(req.body as Uint8Array);
    const json = JSON.parse(decrypted.toString('utf8'));
    expect(json).toEqual(buildPushPayload(payload, deps.config));

    const activeRow = getSubscription(db, listActiveSubscriptions(db)[0]!.id);
    expect(activeRow?.last_ok_at).not.toBeNull();
  });

  it('399. a 429 with Retry-After marks the row retryable with that delay', async () => {
    const db = setupDb();
    const sub = makeSubscriber('https://push.example.com/wp/rate');
    upsertSubscription(db, { endpoint: sub.subscription.endpoint, p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth, createdAt: 1 });
    const fake = makeFakePushService(new Map([[sub.subscription.endpoint, { status: 429, retryAfter: '30' } as const]]));
    const deps = baseDeps(db, fake.fetch);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', deps.config);
    const result = await webpushNotifier.deliver(payload, deps);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(30_000);
  });

  it('400/401. a 413 dead-letters non-retryably, and no endpoint URL ever appears in the error text', async () => {
    const db = setupDb();
    const sub = makeSubscriber('https://push.example.com/wp/big-secret-path');
    upsertSubscription(db, { endpoint: sub.subscription.endpoint, p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth, createdAt: 1 });
    const fake = makeFakePushService(new Map([[sub.subscription.endpoint, { status: 413 } as const]]));
    const deps = baseDeps(db, fake.fetch);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', deps.config);
    const result = await webpushNotifier.deliver(payload, deps);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).not.toContain(sub.subscription.endpoint);
    expect(result.error).not.toContain('big-secret-path');
  });

  it('a network throw is retryable and never leaks the endpoint in the error text', async () => {
    const db = setupDb();
    const sub = makeSubscriber('https://push.example.com/wp/network-secret');
    upsertSubscription(db, { endpoint: sub.subscription.endpoint, p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth, createdAt: 1 });
    const fake = makeFakePushService(new Map([[sub.subscription.endpoint, { throw: true, message: `connect ECONNREFUSED ${sub.subscription.endpoint}` } as const]]));
    const deps = baseDeps(db, fake.fetch);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', deps.config);
    const result = await webpushNotifier.deliver(payload, deps);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
    expect(result.error).not.toContain('network-secret');
  });

  it('405. isValidPushEndpoint rejects non-HTTPS/oversized/private endpoints and accepts a plain https one', () => {
    // finding #10 (phase5.1): the original case 405 asserted URL/Buffer trivia, never the project's
    // own validator - replaced with the real thing.
    const allow = { notifyAllowPrivateUrls: false };
    expect(isValidPushEndpoint('https://push.example.com/wp/x', allow)).toBe(true);
    expect(isValidPushEndpoint('http://push.example.com/x', allow)).toBe(false);
    expect(isValidPushEndpoint(`https://push.example.com/${'a'.repeat(2100)}`, allow)).toBe(false);
    expect(isValidPushEndpoint('not a url', allow)).toBe(false);
    // finding #4: private/loopback/link-local hosts are rejected by default, over https too.
    expect(isValidPushEndpoint('https://169.254.169.254/latest/meta-data/', allow)).toBe(false);
    expect(isValidPushEndpoint('https://10.0.0.5/internal', allow)).toBe(false);
    expect(isValidPushEndpoint('https://[::1]/y', allow)).toBe(false);
    expect(isValidPushEndpoint('https://localhost/z', allow)).toBe(false);
    // the http loopback carve-out exists ONLY under the explicit escape hatch.
    expect(isValidPushEndpoint('http://127.0.0.1:9999/wp/x', allow)).toBe(false);
    expect(isValidPushEndpoint('http://127.0.0.1:9999/wp/x', { notifyAllowPrivateUrls: true })).toBe(true);
    expect(isValidPushEndpoint('https://10.0.0.5/internal', { notifyAllowPrivateUrls: true })).toBe(true);
  });

  it('finding #5 (phase5.1): a fetch that never resolves is aborted after timeoutMs and classified retryable', async () => {
    const db = setupDb();
    const sub = makeSubscriber('https://push.example.com/wp/hangs-forever');
    upsertSubscription(db, { endpoint: sub.subscription.endpoint, p256dh: sub.subscription.keys.p256dh, auth: sub.subscription.keys.auth, createdAt: 1 });
    // A fetch that only ever settles when its AbortSignal fires - proves the channel wires one up
    // itself (every other channel already does, via `deliverHttp`; the webpush channel called
    // `deps.fetch` directly with no `signal` at all).
    const fetchImpl: NotifierDeps['fetch'] = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    const keys = generateVapidKeys();
    const config = makeConfig({ vapidPublicKey: keys.publicKey, vapidPrivateKey: keys.privateKey, vapidSubject: 'mailto:ops@example.com' });
    const deps: NotifierDeps = { db, config, fetch: fetchImpl, timeoutMs: 20, clock: () => 1_700_000_000_000 };
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', config);

    const result = await webpushNotifier.deliver(payload, deps);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  }, 2000);

  it('finding #9 (phase5.1): redactPushEndpoint scrubs the exact endpoint AND any other https:// URL', () => {
    const endpoint = 'https://push.example.com/wp/secret-path';
    expect(redactPushEndpoint(`connect ECONNREFUSED ${endpoint}`, endpoint)).not.toContain('secret-path');
    // A different https URL appearing in the same message (e.g. a mangled/re-encoded echo of the
    // endpoint) is caught by the broadened backstop even though it isn't a byte-exact match.
    const other = 'fetch failed for https://web.push.apple.com/otherToken123';
    expect(redactPushEndpoint(other, endpoint)).not.toContain('otherToken123');
    expect(redactPushEndpoint(other, endpoint)).toContain('[redacted-push-endpoint]');
  });

  it('isConfigured is false without both VAPID keys', () => {
    const config = makeConfig({ vapidPublicKey: undefined, vapidPrivateKey: undefined });
    expect(webpushNotifier.isConfigured(config)).toBe(false);
  });
});
