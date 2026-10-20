import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DryRunTransport } from '../../src/mail/dryrun.js';
import { emailNotifier } from '../../src/notify/channels/email.js';
import { buildPayload } from '../../src/notify/payload.js';
import { detectReply } from '../../src/mail/threads.js';
import type { NotificationPayload, NotifierDeps, TrackingEvent } from '../../src/notify/types.js';
import { makeConfig } from '../helpers/setup.js';

function baseEvent(overrides: Partial<TrackingEvent> = {}): TrackingEvent {
  return {
    kind: 'open',
    eventId: 'evt1',
    occurredAt: 1_700_000_000_000,
    messageId: 'msg1',
    subject: 'Q3 numbers',
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

let outDir: string;
beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'op-email-notify-'));
});
afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('email-to-self notify channel', () => {
  it('407/408/409. one counted open writes exactly one .eml addressed to NOTIFY_EMAIL_TO, no pixel, no messages row, with the right headers', async () => {
    const config = makeConfig({ notifyEmailTo: 'ops@example.com', outDir });
    const transport = new DryRunTransport(outDir);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', config);
    const deps: NotifierDeps = { config, transport, fetch: (async () => { throw new Error('should not fetch'); }) as never, timeoutMs: 1000, clock: () => Date.now() };

    const result = await emailNotifier.deliver(payload, deps);
    expect(result.ok).toBe(true);

    const files = readdirSync(outDir).filter((f) => f.endsWith('.eml'));
    expect(files).toHaveLength(1);
    const eml = readFileSync(join(outDir, files[0] as string), 'utf8');
    expect(eml).toMatch(/To: ops@example\.com/);
    expect(eml).toMatch(/Auto-Submitted: auto-generated/);
    expect(eml).toMatch(/X-Openpost-Notification: 1/i);
    expect(eml).not.toContain('<img');
  });

  it('410. no NOTIFY_EMAIL_TO/FROM_EMAIL -> non-retryable failure naming the variable', async () => {
    const config = makeConfig({ notifyEmailTo: undefined, fromEmail: undefined, outDir });
    const transport = new DryRunTransport(outDir);
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', config);
    const deps: NotifierDeps = { config, transport, fetch: (async () => { throw new Error('no'); }) as never, timeoutMs: 1000, clock: () => Date.now() };
    const result = await emailNotifier.deliver(payload, deps);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
    expect(result.error).toContain('NOTIFY_EMAIL_TO');
  });

  it('411. the real reply detector ignores a notification email in the same thread (Auto-Submitted)', () => {
    const decision = detectReply(
      [
        {
          id: 'm1',
          threadId: 't1',
          internalDate: 1000,
          from: 'ops@example.com',
          to: 'sender@example.com',
          messageIdHeader: '<notif@x>',
          inReplyTo: null,
          references: null,
          labelIds: [],
          isSelfCopy: false,
          autoSubmitted: 'auto-generated',
          precedence: 'bulk',
          xAutoreply: null,
          xAutorespond: null,
          returnPath: null,
        },
      ],
      { senderEmail: 'ops@example.com', sentAt: 0, ownProviderMsgId: null },
    );
    expect(decision.isReply).toBe(false);
  });

  it('loop safety: refuses to notify when NOTIFY_EMAIL_TO matches the recipient the notification is about', async () => {
    const config = makeConfig({ notifyEmailTo: 'alice@example.com', outDir });
    const transport = new DryRunTransport(outDir);
    const payload = buildPayload(baseEvent({ recipientEmail: 'alice@example.com' }), 'read_confirmed', 'notif1', config);
    const deps: NotifierDeps = { config, transport, fetch: (async () => { throw new Error('no'); }) as never, timeoutMs: 1000, clock: () => Date.now() };
    const result = await emailNotifier.deliver(payload, deps);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(false);
  });

  it('phase5.1 finding #13: a daily_digest notification links to the message list, like webpush', async () => {
    const config = makeConfig({ notifyEmailTo: 'ops@example.com', outDir });
    const transport = new DryRunTransport(outDir);
    const payload: NotificationPayload = {
      version: 1,
      id: 'digest1',
      trigger: 'daily_digest',
      occurredAt: 1_700_000_000_000,
      // daily-digest.ts sets message.id = '' - the email channel must not build
      // `/dashboard/messages/` (a trailing slash with an empty id) out of it.
      message: { id: '', subject: null, sentAt: null },
      recipient: { id: '', email: null, state: 'not_opened', openCount: 0, clickCount: 0, attribution: 'message', recipientCount: null },
      event: { id: '', kind: 'open', classification: 'daily_digest', reasons: [], counted: false, uaFamily: null, deviceType: null, country: null, linkUrl: null },
      digest: { windowFrom: 0, windowTo: 1_700_000_000_000, sent: 3, opened: 2, clicked: 1, replied: 0, openRate: 0.5, topMessages: [] },
    };
    const deps: NotifierDeps = { config, transport, fetch: (async () => { throw new Error('should not fetch'); }) as never, timeoutMs: 1000, clock: () => Date.now() };

    const result = await emailNotifier.deliver(payload, deps);
    expect(result.ok).toBe(true);

    const files = readdirSync(outDir).filter((f) => f.endsWith('.eml'));
    expect(files).toHaveLength(1);
    const eml = readFileSync(join(outDir, files[0] as string), 'utf8');
    // The HTML part is quoted-printable soft-wrapped, so match the plain-text part's unwrapped URL
    // instead of a literal `href="..."` substring.
    expect(eml).toContain(`${config.trackingBaseUrl}/dashboard/messages`);
    expect(eml).not.toContain('/dashboard/messages/');
  });

  it('412. a transport throw is retryable', async () => {
    const config = makeConfig({ notifyEmailTo: 'ops@example.com', outDir });
    const throwingTransport = { name: 'dryrun' as const, send: async () => { throw new Error('disk full'); } };
    const payload = buildPayload(baseEvent(), 'read_confirmed', 'notif1', config);
    const deps: NotifierDeps = { config, transport: throwingTransport, fetch: (async () => { throw new Error('no'); }) as never, timeoutMs: 1000, clock: () => Date.now() };
    const result = await emailNotifier.deliver(payload, deps);
    expect(result.ok).toBe(false);
    expect(result.retryable).toBe(true);
  });

  it('isConfigured is always true (NOTIFY_EMAIL_TO defaults to FROM_EMAIL)', () => {
    expect(emailNotifier.isConfigured(makeConfig())).toBe(true);
  });
});
