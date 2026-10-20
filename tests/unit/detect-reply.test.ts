import { describe, expect, it } from 'vitest';
import { detectReply, imapThreadReader, type ThreadMessageMeta } from '../../src/mail/threads.js';
import type { ImapLike } from '../../src/mail/imap.js';

const SENT_AT = 1_700_000_000_000;

function msg(overrides: Partial<ThreadMessageMeta>): ThreadMessageMeta {
  return {
    id: 'm1',
    threadId: 't1',
    internalDate: SENT_AT + 60_000,
    from: 'someone@else.example',
    to: 'sender@example.com',
    messageIdHeader: '<m1@else.example>',
    inReplyTo: null,
    references: null,
    labelIds: [],
    isSelfCopy: false,
    autoSubmitted: null,
    precedence: null,
    xAutoreply: null,
    xAutorespond: null,
    returnPath: null,
    ...overrides,
  };
}

describe('mail/threads detectReply', () => {
  const ctx = { senderEmail: 'sender@example.com', sentAt: SENT_AT, ownProviderMsgId: 'own-provider-id' };

  it('177a. accepts a message from another address after sent_at', () => {
    const decision = detectReply([msg({})], ctx);
    expect(decision.isReply).toBe(true);
    expect(decision.messageId).toBe('m1');
  });

  it('177b. rejects a message from the sender', () => {
    const decision = detectReply([msg({ from: 'Sender <sender@example.com>' })], ctx);
    expect(decision.isReply).toBe(false);
  });

  it('177c. rejects X-Openpost-Self-Copy', () => {
    const decision = detectReply([msg({ isSelfCopy: true })], ctx);
    expect(decision.isReply).toBe(false);
  });

  it('177d. rejects a message labelled SENT or DRAFT', () => {
    expect(detectReply([msg({ labelIds: ['SENT'] })], ctx).isReply).toBe(false);
    expect(detectReply([msg({ labelIds: ['DRAFT'] })], ctx).isReply).toBe(false);
  });

  it('177e. rejects a message at exactly sent_at (clock skew)', () => {
    const decision = detectReply([msg({ internalDate: SENT_AT })], ctx);
    expect(decision.isReply).toBe(false);
  });

  it('177f. rejects a message whose id equals provider_msg_id', () => {
    const decision = detectReply([msg({ id: 'own-provider-id' })], ctx);
    expect(decision.isReply).toBe(false);
  });

  it('177g. rejects an address listed in REPLY_IGNORE_SENDERS', () => {
    const decision = detectReply([msg({ from: 'alias@example.com' })], { ...ctx, ignoreSenders: ['alias@example.com'] });
    expect(decision.isReply).toBe(false);
  });

  it('H2a. rejects Auto-Submitted != no (vacation autoresponder / DSN) with reason auto_submitted', () => {
    const decision = detectReply([msg({ autoSubmitted: 'auto-replied' })], ctx);
    expect(decision.isReply).toBe(false);
    expect(decision.reason).toBe('auto_submitted');
  });

  it('H2a2. Auto-Submitted: no is treated as an ordinary message', () => {
    const decision = detectReply([msg({ autoSubmitted: 'no' })], ctx);
    expect(decision.isReply).toBe(true);
  });

  it('H2b. rejects Precedence: bulk/auto_reply/junk/list with reason bulk_precedence', () => {
    for (const p of ['bulk', 'auto_reply', 'junk', 'list', 'LIST']) {
      const decision = detectReply([msg({ precedence: p })], ctx);
      expect(decision.isReply, `precedence=${p}`).toBe(false);
      expect(decision.reason).toBe('bulk_precedence');
    }
  });

  it('H2c. rejects X-Autoreply/X-Autorespond (any value) with reason vacation_autoresponder', () => {
    expect(detectReply([msg({ xAutoreply: 'yes' })], ctx).reason).toBe('vacation_autoresponder');
    expect(detectReply([msg({ xAutorespond: '' })], ctx).reason).toBe('vacation_autoresponder');
  });

  it('H2d. rejects mailer-daemon@/postmaster@ senders (by From or Return-Path) with reason mailer_daemon', () => {
    const byFrom = detectReply([msg({ from: 'Mail Delivery Subsystem <mailer-daemon@else.example>' })], ctx);
    expect(byFrom.isReply).toBe(false);
    expect(byFrom.reason).toBe('mailer_daemon');

    const byReturnPath = detectReply([msg({ from: 'Postmaster <postmaster@else.example>' })], ctx);
    expect(byReturnPath.reason).toBe('mailer_daemon');

    const byReturnPathOnly = detectReply(
      [msg({ from: 'Automated Response <noreply@else.example>', returnPath: '<mailer-daemon@else.example>' })],
      ctx,
    );
    expect(byReturnPathOnly.isReply).toBe(false);
    expect(byReturnPathOnly.reason).toBe('mailer_daemon');
  });

  it('H2e. a genuine reply that arrives after a rejected autoresponder still counts', () => {
    const auto = msg({ id: 'auto1', internalDate: SENT_AT + 30_000, autoSubmitted: 'auto-replied' });
    const real = msg({ id: 'real1', internalDate: SENT_AT + 60_000 });
    const decision = detectReply([auto, real], ctx);
    expect(decision.isReply).toBe(true);
    expect(decision.messageId).toBe('real1');
  });

  it('picks the earliest qualifying message when several are present', () => {
    const late = msg({ id: 'late', internalDate: SENT_AT + 120_000 });
    const early = msg({ id: 'early', internalDate: SENT_AT + 60_000 });
    const decision = detectReply([late, early], ctx);
    expect(decision.messageId).toBe('early');
  });

  it('normalises angle-bracket / case-insensitive addresses', () => {
    const decision = detectReply([msg({ from: '<SENDER@EXAMPLE.COM>' })], ctx);
    expect(decision.isReply).toBe(false);
  });

  it('183b. imapThreadReader searches by References/In-Reply-To against a fake ImapLike and maps its fetch results to ThreadMessageMeta', async () => {
    const calls: { mailbox?: string; search?: Record<string, unknown> } = {};
    const fakeImap: ImapLike = {
      async append() {
        return undefined;
      },
      async logout() {
        return undefined;
      },
      async mailboxOpen(mailbox: string) {
        calls.mailbox = mailbox;
        return undefined;
      },
      async search(query: Record<string, unknown>) {
        calls.search = query;
        return [1];
      },
      async *fetch() {
        yield {
          uid: 1,
          envelope: { date: new Date(SENT_AT + 120_000), from: [{ address: 'alice@else.example' }] },
          headers: Buffer.from('Message-ID: <reply-imap@else.example>\r\nFrom: alice@else.example\r\n'),
        };
      },
    };

    const reader = imapThreadReader(fakeImap, '[Gmail]/All Mail');
    expect(reader.kind).toBe('imap');
    expect(reader.unitCost).toBe(1);
    const messages = await reader.fetchThread({ threadId: 't1', rfc822MessageId: '<orig@example.com>', sinceMs: SENT_AT });

    expect(calls.mailbox).toBe('[Gmail]/All Mail');
    expect(JSON.stringify(calls.search)).toContain('orig@example.com');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.from).toBe('alice@else.example');
    expect(messages[0]?.messageIdHeader).toBe('<reply-imap@else.example>');

    const decision = detectReply(messages, ctx);
    expect(decision.isReply).toBe(true);
  });
});
