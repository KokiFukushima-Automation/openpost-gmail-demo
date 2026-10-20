import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';
import { buildMime } from '../../src/mail/mime.js';
import { buildSendPlan, resolveRecipientMode, threadRootMessageId, type AddressInput } from '../../src/mail/recipients.js';

// docs/07_recipient_semantics.md §6.5 - test cases 200-210 (numbering starts at 200 to avoid
// clashing with Phase 3's 121-192).

const FOUR_ADDRESSES: AddressInput[] = [
  { email: 'a@example.com', kind: 'to' },
  { email: 'b@example.com', kind: 'to' },
  { email: 'c@example.com', kind: 'cc' },
  { email: 'd@example.com', kind: 'bcc' },
];

describe('buildSendPlan (header contract, §6.1)', () => {
  it('200. 2 To + 1 Cc + 1 Bcc -> 4 copies, deep-equal headerTo/headerCc, empty headerBcc on every copy', () => {
    const plan = buildSendPlan({
      addresses: FOUR_ADDRESSES,
      mode: 'per-recipient',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    expect(plan.copies).toHaveLength(4);
    const expectedTo = [{ email: 'a@example.com' }, { email: 'b@example.com' }];
    const expectedCc = [{ email: 'c@example.com' }];
    for (const copy of plan.copies) {
      expect(copy.headerTo).toEqual(expectedTo);
      expect(copy.headerCc).toEqual(expectedCc);
      expect(copy.headerBcc).toEqual([]);
      expect(copy.isAggregate).toBe(false);
    }
  });

  it('201. each per-recipient copy has a one-element envelopeTo, and the union equals every input address', () => {
    const plan = buildSendPlan({
      addresses: FOUR_ADDRESSES,
      mode: 'per-recipient',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    for (const copy of plan.copies) {
      expect(copy.envelopeTo).toHaveLength(1);
    }
    const union = new Set(plan.copies.flatMap((c) => c.envelopeTo));
    expect(union).toEqual(new Set(FOUR_ADDRESSES.map((a) => a.email)));
  });

  it('202. every copy\'s To/Cc/Subject/Date header lines are byte-identical (Message-ID excluded)', async () => {
    const plan = buildSendPlan({
      addresses: FOUR_ADDRESSES,
      mode: 'per-recipient',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    const headerLines = async (copy: (typeof plan.copies)[number]) => {
      const { raw } = await buildMime({
        from: { email: 'sender@example.com' },
        to: copy.headerTo,
        cc: copy.headerCc,
        subject: 'recipient semantics',
        html: '<p>hi</p>',
        text: 'hi',
        date: plan.date,
        references: [plan.threadRootMessageId],
      });
      return raw
        .toString('utf8')
        .split(/\r?\n\r?\n/)[0]!
        .split(/\r?\n/)
        .filter((l) => /^(to|cc|subject|date):/i.test(l));
    };
    const lines = await Promise.all(plan.copies.map(headerLines));
    for (const l of lines.slice(1)) {
      expect(l).toEqual(lines[0]);
    }
  });

  it('203. no delivered copy ever carries a Bcc header; assertNoBccHeader throws on a fixture that does', async () => {
    const { assertNoBccHeader } = await import('../../src/mail/mime.js');
    const plan = buildSendPlan({
      addresses: FOUR_ADDRESSES,
      mode: 'per-recipient',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    for (const copy of plan.copies) {
      const { raw } = await buildMime({
        from: { email: 'sender@example.com' },
        to: copy.headerTo,
        cc: copy.headerCc,
        subject: 'hi',
        html: '<p>hi</p>',
        text: 'hi',
        date: plan.date,
        references: [plan.threadRootMessageId],
      });
      expect(() => assertNoBccHeader(raw)).not.toThrow();
    }
    const bccFixture = Buffer.from('From: a@example.com\nTo: b@example.com\nBcc: secret@example.com\n\nbody', 'utf8');
    expect(() => assertNoBccHeader(bccFixture)).toThrow(/HC-3/);
  });

  it('204. each copy gets a unique Message-ID; every copy\'s References equals the Sent copy\'s Message-ID', async () => {
    const plan = buildSendPlan({
      addresses: FOUR_ADDRESSES,
      mode: 'per-recipient',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    const messageIds = new Set<string>();
    for (const copy of plan.copies) {
      const { raw, messageId } = await buildMime({
        from: { email: 'sender@example.com' },
        to: copy.headerTo,
        cc: copy.headerCc,
        subject: 'hi',
        html: '<p>hi</p>',
        text: 'hi',
        date: plan.date,
        references: [plan.threadRootMessageId],
      });
      messageIds.add(messageId);
      expect(raw.toString('utf8')).toContain(`References: ${plan.threadRootMessageId}`);
    }
    expect(messageIds.size).toBe(4);

    // The Sent copy's own Message-ID IS the shared References root.
    const sentCopy = await buildMime({
      from: { email: 'sender@example.com' },
      to: plan.sentCopy.headerTo,
      cc: plan.sentCopy.headerCc,
      bcc: plan.sentCopy.headerBcc,
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
      date: plan.date,
      messageId: plan.threadRootMessageId,
    });
    expect(sentCopy.messageId).toBe(plan.threadRootMessageId);
  });

  it('205. empty --cc produces no Cc header at all', async () => {
    const plan = buildSendPlan({
      addresses: [
        { email: 'a@example.com', kind: 'to' },
        { email: 'b@example.com', kind: 'to' },
      ],
      mode: 'per-recipient',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    for (const copy of plan.copies) {
      expect(copy.headerCc).toEqual([]);
      const { raw } = await buildMime({
        from: { email: 'sender@example.com' },
        to: copy.headerTo,
        cc: copy.headerCc,
        subject: 'hi',
        html: '<p>hi</p>',
        text: 'hi',
      });
      expect(raw.toString('utf8')).not.toMatch(/^cc:/im);
    }
  });

  it('206. display names round-trip identically across copies', () => {
    const plan = buildSendPlan({
      addresses: [
        { email: 'a@example.com', kind: 'to', name: 'Alice A' },
        { email: 'b@example.com', kind: 'to', name: 'Bob B' },
        { email: 'c@example.com', kind: 'cc', name: 'Carol C' },
      ],
      mode: 'per-recipient',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    for (const copy of plan.copies) {
      expect(copy.headerTo).toEqual([
        { email: 'a@example.com', name: 'Alice A' },
        { email: 'b@example.com', name: 'Bob B' },
      ]);
      expect(copy.headerCc).toEqual([{ email: 'c@example.com', name: 'Carol C' }]);
    }
  });
});

describe('resolveRecipientMode (§3.3 decision table)', () => {
  it('207. auto/smtp/3 -> per-recipient; auto/gmail/3 -> single; auto/any/1 -> per-recipient', () => {
    expect(resolveRecipientMode('auto', 'smtp', 3)).toBe('per-recipient');
    expect(resolveRecipientMode('auto', 'gmail-smtp', 3)).toBe('per-recipient');
    expect(resolveRecipientMode('auto', 'dryrun', 3)).toBe('per-recipient');
    expect(resolveRecipientMode('auto', 'gmail', 3)).toBe('single');
    expect(resolveRecipientMode('auto', 'gmail', 1)).toBe('per-recipient');
    expect(resolveRecipientMode('auto', 'smtp', 1)).toBe('per-recipient');
    expect(resolveRecipientMode('single', 'smtp', 1)).toBe('per-recipient');
  });

  it('208. per-recipient + gmail throws, naming both remedies', () => {
    expect(() => resolveRecipientMode('per-recipient', 'gmail', 3)).toThrow(/gmail-smtp/);
    expect(() => resolveRecipientMode('per-recipient', 'gmail', 3)).toThrow(/single/);
  });

  it('209. explicit single is never silently downgraded, on any transport', () => {
    expect(resolveRecipientMode('single', 'smtp', 5)).toBe('single');
    expect(resolveRecipientMode('single', 'dryrun', 5)).toBe('single');
    expect(resolveRecipientMode('single', 'gmail-smtp', 5)).toBe('single');
    expect(resolveRecipientMode('single', 'gmail', 5)).toBe('single');
  });

  it('210. loadConfig rejects RECIPIENT_MODE=per-recipient + MAIL_TRANSPORT=gmail', () => {
    expect(() =>
      loadConfig({
        TRACKING_SECRET: 'x'.repeat(32),
        MAIL_TRANSPORT: 'gmail',
        RECIPIENT_MODE: 'per-recipient',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REFRESH_TOKEN: 'token',
      }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        TRACKING_SECRET: 'x'.repeat(32),
        MAIL_TRANSPORT: 'gmail',
        RECIPIENT_MODE: 'per-recipient',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        GOOGLE_REFRESH_TOKEN: 'token',
      }),
    ).toThrow(/RECIPIENT_MODE=per-recipient/);
  });
});

describe('threadRootMessageId', () => {
  it('derives <op.{messageId}@{fromDomain}>', () => {
    expect(threadRootMessageId('msg1', 'sender@example.com')).toBe('<op.msg1@example.com>');
    expect(threadRootMessageId('msg1', 'no-domain')).toBe('<op.msg1@localhost>');
  });
});

describe('single mode plan shape', () => {
  it('single mode produces exactly one aggregate copy whose envelopeTo is every address', () => {
    const plan = buildSendPlan({
      addresses: FOUR_ADDRESSES,
      mode: 'single',
      transport: 'smtp',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    expect(plan.copies).toHaveLength(1);
    const copy = plan.copies[0]!;
    expect(copy.isAggregate).toBe(true);
    expect(new Set(copy.envelopeTo)).toEqual(new Set(FOUR_ADDRESSES.map((a) => a.email)));
    expect(copy.headerBcc).toEqual([]); // never on non-gmail transports
  });

  it('single mode over gmail transport puts Bcc in the one copy\'s headers (the documented exception)', () => {
    const plan = buildSendPlan({
      addresses: FOUR_ADDRESSES,
      mode: 'single',
      transport: 'gmail',
      messageId: 'msg1',
      fromEmail: 'sender@example.com',
      now: 1_700_000_000_000,
    });
    expect(plan.copies[0]!.headerBcc).toEqual([{ email: 'd@example.com' }]);
  });
});

