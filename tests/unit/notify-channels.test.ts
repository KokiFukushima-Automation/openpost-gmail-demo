import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildDiscordBody, discordNotifier } from '../../src/notify/channels/discord.js';
import { buildSlackBody, slackNotifier } from '../../src/notify/channels/slack.js';
import { escapeSlackMd } from '../../src/notify/channels/util.js';
import { computeWebhookSignature, webhookNotifier } from '../../src/notify/channels/webhook.js';
import { ntfyNotifier } from '../../src/notify/channels/ntfy.js';
import { redactSecretUrls } from '../../src/notify/channels/util.js';
import { buildPayload } from '../../src/notify/payload.js';
import type { FetchLike, NotifierDeps, TrackingEvent } from '../../src/notify/types.js';
import { makeConfig } from '../helpers/setup.js';

function baseEvent(overrides: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    kind: 'open',
    eventId: 'evt1',
    occurredAt: 1_700_000_000_000,
    messageId: 'msg1',
    subject: 'Hi & <there>',
    recipientId: 'rcpt1',
    recipientEmail: 'alice@example.com',
    classification: 'human',
    reasons: ['R9'],
    counted: true,
    backfilled: false,
    prevState: 'not_opened',
    newState: 'read_confirmed',
    counters: { openCount: 2, machineOpenCount: 0, clickCount: 1, firstOpenAt: 1, lastOpenAt: 2 },
    uaFamily: 'Chrome',
    deviceType: 'desktop',
    linkUrl: null,
    muted: false,
    sentAt: 1_700_000_000_000 - 60_000,
    country: null,
    ...overrides,
  };
}

function fakeResponse(status: number, body = '', headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function deps(config = makeConfig(), fetchImpl: FetchLike, timeoutMs = 5000): NotifierDeps {
  return { fetch: fetchImpl, timeoutMs, clock: () => 1_700_000_000_000, config };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('slack channel', () => {
  it('69. body has text + two blocks; escapes &/</>; NOTIFY_REDACT_EMAIL=true redacts the email', () => {
    const config = makeConfig({ slackWebhookUrl: 'https://hooks.slack.test/x' });
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', config);
    const body = buildSlackBody(payload);
    expect(body.text).toContain('alice@example.com');
    expect(Array.isArray(body.blocks)).toBe(true);
    expect((body.blocks as unknown[]).length).toBe(2);
    const sectionText = (body.blocks as Array<{ text: { text: string } }>)[0]?.text.text ?? '';
    expect(sectionText).toContain('&amp;');
    expect(sectionText).toContain('&lt;there&gt;');

    const redactedConfig = makeConfig({ slackWebhookUrl: 'https://hooks.slack.test/x', notifyRedactEmail: true });
    const redactedPayload = buildPayload(baseEvent(), 'read_confirmed', 'notif2', redactedConfig);
    const redactedBody = buildSlackBody(redactedPayload);
    expect(redactedBody.text).toContain('a***@example.com');
    expect(redactedBody.text).not.toContain('alice@example.com');
  });

  it('finding #15: escapeSlackMd neutralises *, _, ~ and ` as well as &/</>', () => {
    expect(escapeSlackMd('*bold* _italic_ ~strike~ `code`')).toBe('\\*bold\\* \\_italic\\_ \\~strike\\~ \\`code\\`');
    expect(escapeSlackMd('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');

    const payload = buildPayload(
      baseEvent({ subject: 'Q3 numbers *URGENT* _do not share_' }),
      'first_open',
      'n1',
      makeConfig({ slackWebhookUrl: 'https://hooks.slack.test/x' }),
    );
    const body = buildSlackBody(payload);
    const sectionText = (body.blocks as Array<{ text: { text: string } }>)[0]?.text.text ?? '';
    expect(sectionText).toContain('\\*URGENT\\*');
    expect(sectionText).toContain('\\_do not share\\_');
  });

  it('delivers with a 200 and fails otherwise', async () => {
    const config = makeConfig({ slackWebhookUrl: 'https://hooks.slack.test/x' });
    const payload = buildPayload(baseEvent(), 'first_open', 'n1', config);
    const fetchOk = vi.fn(async () => fakeResponse(200));
    const ok = await slackNotifier.deliver(payload, deps(config, fetchOk as unknown as FetchLike));
    expect(ok.ok).toBe(true);
    const fetchBad = vi.fn(async () => fakeResponse(500));
    const bad = await slackNotifier.deliver(payload, deps(config, fetchBad as unknown as FetchLike));
    expect(bad.ok).toBe(false);
    expect(bad.retryable).toBe(true);
  });
});

describe('discord channel', () => {
  it('70. one embed with title/description/color/fields; 429 + Retry-After -> retryable + retryAfterMs', () => {
    const config = makeConfig({ discordWebhookUrl: 'https://discord.test/x' });
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'n1', config);
    const body = buildDiscordBody(payload);
    const embeds = body.embeds as Array<Record<string, unknown>>;
    expect(embeds).toHaveLength(1);
    expect(embeds[0]?.title).toBe('Read confirmed');
    expect(typeof embeds[0]?.description).toBe('string');
    expect(typeof embeds[0]?.color).toBe('number');
    expect(Array.isArray(embeds[0]?.fields)).toBe(true);
  });

  it('429 with Retry-After: 2 -> retryable true, retryAfterMs 2000', async () => {
    const config = makeConfig({ discordWebhookUrl: 'https://discord.test/x' });
    const payload = buildPayload(baseEvent(), 'first_open', 'n1', config);
    const fetchImpl = vi.fn(async () => fakeResponse(429, '', { 'retry-after': '2' }));
    const result = await discordNotifier.deliver(payload, deps(config, fetchImpl as unknown as FetchLike));
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(2000);
  });

  it('success on 200 or 204', async () => {
    const config = makeConfig({ discordWebhookUrl: 'https://discord.test/x' });
    const payload = buildPayload(baseEvent(), 'first_open', 'n1', config);
    const fetch204 = vi.fn(async () => fakeResponse(204));
    const result = await discordNotifier.deliver(payload, deps(config, fetch204 as unknown as FetchLike));
    expect(result.ok).toBe(true);
  });
});

describe('webhook channel', () => {
  it('71. sends exactly the documented headers; signature = sha256=HMAC(secret, `${ts}.${body}`)', async () => {
    const config = makeConfig({ webhookUrl: 'https://hook.test/x', webhookSecret: 'shh-secret' });
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'n1', config);
    let captured: { url: string; init: { headers: Record<string, string>; body?: string } } | null = null;
    const fetchImpl = vi.fn(async (url: string, init: never) => {
      captured = { url, init: init as never };
      return fakeResponse(200);
    });
    await webhookNotifier.deliver(payload, deps(config, fetchImpl as unknown as FetchLike));

    expect(captured).not.toBeNull();
    const { init } = captured as unknown as { init: { headers: Record<string, string>; body: string } };
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(init.headers['User-Agent']).toMatch(/^openpost\//);
    expect(init.headers['X-Openpost-Event']).toBe('read_confirmed');
    expect(init.headers['X-Openpost-Delivery']).toBe('n1');
    const ts = Number(init.headers['X-Openpost-Timestamp']);
    expect(Number.isFinite(ts)).toBe(true);
    const expectedSig = `sha256=${computeWebhookSignature('shh-secret', ts, init.body as string)}`;
    expect(init.headers['X-Openpost-Signature']).toBe(expectedSig);

    // manual recompute matching the exact algorithm, not just round-tripping through the helper
    const manual = createHmac('sha256', 'shh-secret').update(`${ts}.${init.body}`).digest('hex');
    expect(init.headers['X-Openpost-Signature']).toBe(`sha256=${manual}`);
  });

  it('71b. the docs/notifications.md Node verifier accepts the delivery and rejects a tampered body / stale timestamp', async () => {
    const config = makeConfig({ webhookUrl: 'https://hook.test/x', webhookSecret: 'shh-secret' });
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'n1', config);
    let captured: { headers: Record<string, string>; body: string } | null = null;
    const fetchImpl = vi.fn(async (_url: string, init: { headers: Record<string, string>; body?: string }) => {
      captured = { headers: init.headers, body: init.body ?? '' };
      return fakeResponse(200);
    });
    await webhookNotifier.deliver(payload, deps(config, fetchImpl as unknown as FetchLike));
    const { headers, body } = captured as unknown as { headers: Record<string, string>; body: string };

    const docText = readFileSync(join(process.cwd(), 'docs/notifications.md'), 'utf8');
    const match = /## Node\.js verifier\s*```js\n([\s\S]*?)\n```/.exec(docText);
    expect(match).not.toBeNull();
    const code = match?.[1] as string;
    const moduleObj: { exports: { verifySignature: (args: unknown) => boolean } } = { exports: { verifySignature: () => false } };
    const fakeCryptoModule = { createHmac, timingSafeEqual };
    const fn = new Function('module', 'require', code);
    fn(moduleObj, (name: string) => (name === 'node:crypto' ? fakeCryptoModule : undefined));
    const { verifySignature } = moduleObj.exports;

    const lowerHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;
    const nowSeconds = Number(lowerHeaders['x-openpost-timestamp']);

    expect(verifySignature({ secret: 'shh-secret', headers: lowerHeaders, rawBody: body, nowSeconds })).toBe(true);
    expect(
      verifySignature({ secret: 'shh-secret', headers: lowerHeaders, rawBody: `${body}x`, nowSeconds }),
    ).toBe(false);
    expect(
      verifySignature({ secret: 'shh-secret', headers: lowerHeaders, rawBody: body, nowSeconds: nowSeconds + 601 }),
    ).toBe(false);
  });

  it('72. 500 retryable; 400 not retryable; 408/429 retryable', async () => {
    const config = makeConfig({ webhookUrl: 'https://hook.test/x', webhookSecret: 'shh-secret' });
    const payload = buildPayload(baseEvent(), 'first_open', 'n1', config);
    for (const [status, expectRetryable] of [[500, true], [400, false], [408, true], [429, true]] as const) {
      const fetchImpl = vi.fn(async () => fakeResponse(status));
      const result = await webhookNotifier.deliver(payload, deps(config, fetchImpl as unknown as FetchLike));
      expect(result.ok).toBe(false);
      expect(result.retryable, `status ${status}`).toBe(expectRetryable);
    }
  });
});

describe('ntfy channel', () => {
  it('73. posts to ${NTFY_URL}/${NTFY_TOPIC} with Title/Priority/Tags; Authorization only when NTFY_TOKEN is set', async () => {
    const config = makeConfig({ ntfyUrl: 'https://ntfy.example', ntfyTopic: 'openpost-alerts' });
    const payload = buildPayload(baseEvent(), 'first_open', 'n1', config);
    let capturedUrl = '';
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return fakeResponse(200);
    });
    await ntfyNotifier.deliver(payload, deps(config, fetchImpl as unknown as FetchLike));
    expect(capturedUrl).toBe('https://ntfy.example/openpost-alerts');
    expect(capturedHeaders.Title).toBeDefined();
    expect(capturedHeaders.Priority).toBe('default');
    expect(capturedHeaders.Tags).toBe('envelope');
    expect(capturedHeaders.Authorization).toBeUndefined();

    const withToken = makeConfig({ ntfyUrl: 'https://ntfy.example', ntfyTopic: 'x', ntfyToken: 'tok123' });
    const payload2 = buildPayload(baseEvent(), 'first_open', 'n2', withToken);
    const fetchImpl2 = vi.fn(async (_url: string, init: { headers: Record<string, string> }) => {
      capturedHeaders = init.headers;
      return fakeResponse(200);
    });
    await ntfyNotifier.deliver(payload2, deps(withToken, fetchImpl2 as unknown as FetchLike));
    expect(capturedHeaders.Authorization).toBe('Bearer tok123');
  });
});

describe('finding #9: never follow a redirect, and never persist a channel URL/token verbatim', () => {
  it('every channel requests redirect: "error"', async () => {
    const config = makeConfig({
      slackWebhookUrl: 'https://hooks.slack.test/x',
      discordWebhookUrl: 'https://discord.test/x',
      webhookUrl: 'https://hook.test/x',
      webhookSecret: 'shh-secret',
      ntfyUrl: 'https://ntfy.example',
      ntfyTopic: 'openpost-alerts',
    });
    const payload = buildPayload(baseEvent(), 'first_open', 'n1', config);
    const capturedInits: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: unknown) => {
      capturedInits.push(init);
      return fakeResponse(200);
    });
    for (const notifier of [slackNotifier, discordNotifier, webhookNotifier, ntfyNotifier]) {
      await notifier.deliver(payload, deps(config, fetchImpl as unknown as FetchLike));
    }
    expect(capturedInits).toHaveLength(4);
    for (const init of capturedInits) {
      expect((init as { redirect?: string }).redirect).toBe('error');
    }
  });

  it('redactSecretUrls scrubs every configured channel URL/token out of an error message', () => {
    const config = makeConfig({
      slackWebhookUrl: 'https://hooks.slack.test/services/SECRET1',
      webhookUrl: 'https://hook.test/SECRET2',
      ntfyToken: 'tk_SECRET3',
    });
    const message = `fetch failed: connect ECONNREFUSED while POSTing https://hook.test/SECRET2 (auth tk_SECRET3, also tried https://hooks.slack.test/services/SECRET1)`;
    const redacted = redactSecretUrls(message, config);
    expect(redacted).not.toContain('SECRET1');
    expect(redacted).not.toContain('SECRET2');
    expect(redacted).not.toContain('SECRET3');
    expect(redacted).toContain('[redacted]');
  });

  it('finding #9 (phase5.1): PUSH_ENDPOINT_RE now redacts push-shaped URLs the old narrow regex missed', () => {
    const config = makeConfig();
    // Mozilla autopush and Apple web push endpoints don't match /fcm/send, /wp/ or /push/ - the
    // regex was broadened to any https:// URL rather than any one push service's path shape.
    const message =
      'delivery failed for https://updates.push.services.mozilla.com/wpush/v2/gAAAAA and ' +
      'https://web.push.apple.com/QsW2m3z8k1';
    const redacted = redactSecretUrls(message, config);
    expect(redacted).not.toContain('mozilla.com');
    expect(redacted).not.toContain('apple.com');
    expect(redacted).toContain('[redacted-push-endpoint]');
  });
});

describe('timeout handling', () => {
  it('74. a fetch that never resolves is aborted after timeoutMs and returns a retryable error', async () => {
    const config = makeConfig({ slackWebhookUrl: 'https://hooks.slack.test/x' });
    const payload = buildPayload(baseEvent(), 'first_open', 'n1', config);
    const neverResolvingFetch = vi.fn((_url: string, init: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    const result = await slackNotifier.deliver(
      payload,
      deps(config, neverResolvingFetch as unknown as FetchLike, 20),
    );
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  }, 2000);
});
