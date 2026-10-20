import { describe, expect, it } from 'vitest';
import { classifyClick, classifyOpen, deriveRecipientState } from '../../src/core/classify.js';
import { redactForMode } from '../../src/core/privacy.js';
import { parseUserAgent } from '../../src/core/ua.js';
import type { ClassifyConfig, ClassifyContext, OpenSignal, PriorEventSummary } from '../../src/types.js';

const CONFIG: ClassifyConfig = {
  openIgnoreSeconds: 10,
  proxyPrefetchSeconds: 60,
  mppWindowSeconds: 900,
  dedupeSeconds: 30,
  scannerFanout: 5,
  respectDnt: true,
};

const SENT_AT = 1_700_000_000_000;
const PROXY_UA =
  'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)';
const APPLE_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Mail/16.0 CFNetwork/1408.0.4 Darwin/22.5.0';
const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function baseContext(overrides: Partial<ClassifyContext> = {}): ClassifyContext {
  return {
    sentAt: SENT_AT,
    optedOut: false,
    priorEvents: [],
    ipHash: 'iphash1',
    ipNetHash: 'nethash1',
    uaInfo: parseUserAgent(CHROME_UA),
    fanoutCount: 0,
    config: CONFIG,
    selfIpHashes: new Set(),
    selfUaPatterns: [],
    isAppleRelayIp: false,
    isGoogleProxyIp: false,
    isDatacenterIp: false,
    hasCountedOpen: false,
    ...overrides,
  };
}

function signal(overrides: Partial<OpenSignal> = {}): OpenSignal {
  return {
    occurredAt: SENT_AT + 5_000,
    ip: '203.0.113.10',
    ua: CHROME_UA,
    method: 'GET',
    accept: 'image/gif,image/*,*/*;q=0.8',
    dnt: false,
    ...overrides,
  };
}

describe('classifyOpen', () => {
  it('14. open 3s after send with proxy UA -> google_proxy_prefetch, not counted (R1)', () => {
    const sig = signal({ occurredAt: SENT_AT + 3_000, ua: PROXY_UA });
    const ctx = baseContext({ uaInfo: parseUserAgent(PROXY_UA) });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('google_proxy_prefetch');
    expect(result.counted).toBe(false);
    expect(result.reasons).toContain('R1');
  });

  it('15. open 30s after send with proxy UA -> google_proxy_prefetch (R2, within 60s)', () => {
    const sig = signal({ occurredAt: SENT_AT + 30_000, ua: PROXY_UA });
    const ctx = baseContext({ uaInfo: parseUserAgent(PROXY_UA) });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('google_proxy_prefetch');
    expect(result.counted).toBe(false);
    expect(result.reasons).toContain('R2');
  });

  it('16. open 5 minutes after send with proxy UA -> human, counted, device=proxy (R3)', () => {
    const sig = signal({ occurredAt: SENT_AT + 5 * 60_000, ua: PROXY_UA });
    // Parse the UA independently from the fixture used to build `ctx`, so this asserts what
    // classifyOpen's caller would actually persist for this UA (device_type='proxy'), not merely
    // that a value handed in unchanged comes back out unchanged.
    const uaInfoFromSignal = parseUserAgent(sig.ua);
    const ctx = baseContext({ uaInfo: uaInfoFromSignal });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('human');
    expect(result.counted).toBe(true);
    expect(result.reasons).toContain('R3');

    // What the pixel route would actually write to open_events.device_type for this result: R3's
    // whole point is that the Gmail proxy fetch outside the prefetch window is a real render, so
    // the persisted row must still show device_type='proxy' (never redacted away by 'off'/'balanced').
    for (const mode of ['off', 'balanced'] as const) {
      const fields = redactForMode({ device_type: uaInfoFromSignal.deviceType }, mode);
      expect(fields.device_type).toBe('proxy');
    }
  });

  it('17. Apple relay IP, first event, 2 min after send -> apple_mpp, not counted (R4)', () => {
    const sig = signal({ occurredAt: SENT_AT + 2 * 60_000, ua: APPLE_UA });
    const ctx = baseContext({ isAppleRelayIp: true, uaInfo: parseUserAgent(APPLE_UA), priorEvents: [] });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('apple_mpp');
    expect(result.counted).toBe(false);
    expect(result.reasons).toContain('R4');
  });

  it('18. UA/IP matching SELF_* -> self_open (R5)', () => {
    const sig = signal({ occurredAt: SENT_AT + 60_000 });
    const ctxByIp = baseContext({ selfIpHashes: new Set(['iphash1']) });
    const byIp = classifyOpen(sig, ctxByIp);
    expect(byIp.classification).toBe('self_open');
    expect(byIp.reasons).toContain('R5');

    const ctxByUa = baseContext({ selfUaPatterns: [/Chrome\/120/] });
    const byUa = classifyOpen(sig, ctxByUa);
    expect(byUa.classification).toBe('self_open');
    expect(byUa.reasons).toContain('R5');
  });

  it('19. curl, python-requests, HeadlessChrome, null UA, HEAD method -> bot (R6)', () => {
    const cases: Partial<OpenSignal>[] = [
      { ua: 'curl/8.5.0' },
      { ua: 'python-requests/2.32.0' },
      { ua: 'Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36' },
      { ua: null },
      { method: 'HEAD' },
    ];
    for (const overrides of cases) {
      const sig = signal({ occurredAt: SENT_AT + 60_000, ...overrides });
      const ctx = baseContext({ uaInfo: parseUserAgent(sig.ua) });
      const result = classifyOpen(sig, ctx);
      expect(result.classification, JSON.stringify(overrides)).toBe('bot');
      expect(result.counted).toBe(false);
      expect(result.reasons).toContain('R6');
    }
  });

  it('20. fanout of 6 distinct recipients from one net in 10 min -> bot (R7)', () => {
    const sig = signal({ occurredAt: SENT_AT + 60_000 });
    const ctx = baseContext({ fanoutCount: 6 });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('bot');
    expect(result.counted).toBe(false);
    expect(result.reasons).toContain('R7');
  });

  it('21. second identical open 10s later -> duplicate (R8); 60s later -> counted (R9)', () => {
    const first = signal({ occurredAt: SENT_AT + 60_000 });
    const ctx1 = baseContext();
    const firstResult = classifyOpen(first, ctx1);
    expect(firstResult.classification).toBe('human');
    expect(firstResult.counted).toBe(true);

    const priorAfterFirst: PriorEventSummary[] = [
      {
        occurredAt: first.occurredAt,
        ipNetHash: ctx1.ipNetHash,
        uaFamily: ctx1.uaInfo.family,
        counted: true,
        classification: 'human',
      },
    ];

    const dup = signal({ occurredAt: first.occurredAt + 10_000 });
    const ctx2 = baseContext({ priorEvents: priorAfterFirst });
    const dupResult = classifyOpen(dup, ctx2);
    expect(dupResult.classification).toBe('duplicate');
    expect(dupResult.counted).toBe(false);
    expect(dupResult.reasons).toContain('R8');

    const priorAfterDup: PriorEventSummary[] = [
      {
        occurredAt: dup.occurredAt,
        ipNetHash: ctx1.ipNetHash,
        uaFamily: ctx1.uaInfo.family,
        counted: false,
        classification: 'duplicate',
      },
      ...priorAfterFirst,
    ];
    const later = signal({ occurredAt: dup.occurredAt + 60_000 });
    const ctx3 = baseContext({ priorEvents: priorAfterDup });
    const laterResult = classifyOpen(later, ctx3);
    expect(laterResult.classification).toBe('human');
    expect(laterResult.counted).toBe(true);
    expect(laterResult.reasons).toContain('R9');
  });

  it('22. DNT:1 with RESPECT_DNT=true -> dnt, not counted; with false -> normal path', () => {
    const sig = signal({ occurredAt: SENT_AT + 60_000, dnt: true });
    const respecting = baseContext();
    const result = classifyOpen(sig, respecting);
    expect(result.classification).toBe('dnt');
    expect(result.counted).toBe(false);

    const notRespecting = baseContext({ config: { ...CONFIG, respectDnt: false } });
    const result2 = classifyOpen(sig, notRespecting);
    expect(result2.classification).toBe('human');
    expect(result2.counted).toBe(true);
  });

  it('23. opted-out recipient -> opt_out, not counted, regardless of other signals', () => {
    const sig = signal({ occurredAt: SENT_AT + 60_000, ua: 'curl/8.5.0' });
    const ctx = baseContext({ optedOut: true, uaInfo: parseUserAgent('curl/8.5.0') });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('opt_out');
    expect(result.counted).toBe(false);
  });

  it('56. Apple relay IP, non-Apple UA, 2 min after send -> apple_mpp via R4 with apple_ip marker', () => {
    const sig = signal({ occurredAt: SENT_AT + 2 * 60_000, ua: CHROME_UA });
    const ctx = baseContext({ isAppleRelayIp: true, uaInfo: parseUserAgent(CHROME_UA) });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('apple_mpp');
    expect(result.counted).toBe(false);
    expect(result.reasons).toEqual(['R4', 'apple_ip']);
  });

  it('57. Google-proxy IP alone (no matching UA) outside the prefetch window does NOT earn R3 - falls through to an ordinary R9 human open', () => {
    // Phase 2.1 amendment (finding #3): the IP-only signal is real evidence, but on its own it is
    // only strong enough to suppress a same-window prefetch (R2, tested below) - crediting it at R3
    // regardless of UA is what let a non-proxy UA borrow the "Gmail rendered this" classification.
    const sig = signal({ occurredAt: SENT_AT + 5 * 60_000, ua: CHROME_UA });
    const ctx = baseContext({ isGoogleProxyIp: true, uaInfo: parseUserAgent(CHROME_UA) });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('human');
    expect(result.counted).toBe(true);
    expect(result.reasons).toEqual(['R9']);
    expect(result.reasons).not.toContain('R3');
  });

  it('finding #3 regression: a Google-proxy IP with a curl UA outside the prefetch window is bot (R6), never a counted R3 human open', () => {
    // The reviewer-verified exploit: "34.64.0.1 + curl/8.0 -> human, counted, R3". R3 must now
    // require the actual GoogleImageProxy UA, so this falls through to R6 (bot UA) instead.
    const sig = signal({ occurredAt: SENT_AT + 5 * 60_000, ua: 'curl/8.0' });
    const ctx = baseContext({ isGoogleProxyIp: true, uaInfo: parseUserAgent('curl/8.0') });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('bot');
    expect(result.counted).toBe(false);
    expect(result.reasons).toContain('R6');
  });

  it('the IP-only Google signal still suppresses a same-window prefetch at R2 (non-terminal use only)', () => {
    const sig = signal({ occurredAt: SENT_AT + 30_000, ua: CHROME_UA });
    const ctx = baseContext({ isGoogleProxyIp: true, uaInfo: parseUserAgent(CHROME_UA) });
    const result = classifyOpen(sig, ctx);
    expect(result.classification).toBe('google_proxy_prefetch');
    expect(result.counted).toBe(false);
    expect(result.reasons).toContain('R2');
  });
});

describe('classifyClick', () => {
  it('reuses R0 (opt-out / dnt)', () => {
    const sig = signal({ occurredAt: SENT_AT + 60_000 });
    expect(classifyClick(sig, baseContext({ optedOut: true })).classification).toBe('opt_out');
    expect(
      classifyClick(signal({ occurredAt: SENT_AT + 60_000, dnt: true }), baseContext()).classification,
    ).toBe('dnt');
  });

  it('reuses R6 (bot UA / HEAD)', () => {
    const sig = signal({ occurredAt: SENT_AT + 60_000, ua: 'curl/8.5.0' });
    const ctx = baseContext({ uaInfo: parseUserAgent('curl/8.5.0') });
    const result = classifyClick(sig, ctx);
    expect(result.classification).toBe('scanner');
    expect(result.counted).toBe(false);

    const headResult = classifyClick(signal({ occurredAt: SENT_AT + 60_000, method: 'HEAD' }), baseContext());
    expect(headResult.classification).toBe('scanner');
  });

  it('reuses R8 (duplicate within the dedupe window)', () => {
    const first = signal({ occurredAt: SENT_AT + 60_000 });
    const ctx = baseContext({
      priorEvents: [
        {
          occurredAt: first.occurredAt - 5_000,
          ipNetHash: 'nethash1',
          uaFamily: 'Chrome',
          counted: true,
          classification: 'human',
        },
      ],
    });
    const result = classifyClick(first, ctx);
    expect(result.classification).toBe('duplicate');
    expect(result.counted).toBe(false);
  });

  it('otherwise a counted human click', () => {
    const result = classifyClick(signal({ occurredAt: SENT_AT + 60_000 }), baseContext());
    expect(result.classification).toBe('human');
    expect(result.counted).toBe(true);
  });

  it('58. click from a datacentre IP with hasCountedOpen=false -> scanner (R6b)', () => {
    const result = classifyClick(
      signal({ occurredAt: SENT_AT + 60_000 }),
      baseContext({ isDatacenterIp: true, hasCountedOpen: false }),
    );
    expect(result.classification).toBe('scanner');
    expect(result.counted).toBe(false);
    expect(result.reasons).toEqual(['R6b']);
  });

  it('59. same click with hasCountedOpen=true -> human, counted', () => {
    const result = classifyClick(
      signal({ occurredAt: SENT_AT + 60_000 }),
      baseContext({ isDatacenterIp: true, hasCountedOpen: true }),
    );
    expect(result.classification).toBe('human');
    expect(result.counted).toBe(true);
  });
});

describe('deriveRecipientState', () => {
  it('24. returns the four states for the four counter shapes', () => {
    expect(
      deriveRecipientState({
        openCount: 0,
        machineOpenCount: 0,
        clickCount: 0,
        firstOpenAt: null,
        lastOpenAt: null,
      }),
    ).toBe('not_opened');

    expect(
      deriveRecipientState({
        openCount: 0,
        machineOpenCount: 2,
        clickCount: 0,
        firstOpenAt: null,
        lastOpenAt: null,
      }),
    ).toBe('prefetched');

    expect(
      deriveRecipientState({
        openCount: 1,
        machineOpenCount: 0,
        clickCount: 0,
        firstOpenAt: 1000,
        lastOpenAt: 1000,
      }),
    ).toBe('opened');

    expect(
      deriveRecipientState({
        openCount: 1,
        machineOpenCount: 0,
        clickCount: 1,
        firstOpenAt: 1000,
        lastOpenAt: 1000,
      }),
    ).toBe('read_confirmed');

    expect(
      deriveRecipientState({
        openCount: 2,
        machineOpenCount: 0,
        clickCount: 0,
        firstOpenAt: 1000,
        lastOpenAt: 1000 + 61_000,
      }),
    ).toBe('read_confirmed');
  });

  it('finding #8: a counted click alone (openCount=0, e.g. its implied open was removed by a reclassification elsewhere) still yields read_confirmed, never not_opened', () => {
    expect(
      deriveRecipientState({
        openCount: 0,
        machineOpenCount: 0,
        clickCount: 1,
        firstOpenAt: null,
        lastOpenAt: null,
      }),
    ).toBe('read_confirmed');
  });
});
