import { describe, expect, it } from 'vitest';
import { appendSentCopy, buildUntrackedMime, insertSentCopy } from '../../src/mail/selfcopy.js';
import type { GmailClient } from '../../src/mail/gmail.js';
import type { ImapLike } from '../../src/mail/imap.js';

describe('buildUntrackedMime / insertSentCopy', () => {
  it('116. calls users.messages.insert with internalDateSource:dateHeader, labelIds:[SENT], and a raw MIME with no pixel, original hrefs, the delivered Message-ID and X-Openpost-Self-Copy: 1', async () => {
    const untracked = await buildUntrackedMime({
      from: { email: 'sender@example.com', name: 'Sender' },
      to: [{ email: 'alice@example.com' }],
      subject: 'hello',
      html: '<p>Hi <a href="https://example.com/original">link</a></p>',
      text: 'Hi link <https://example.com/original>',
      rfc822MessageId: '<abc123@example.com>',
    });
    expect(untracked.raw.toString('utf8')).not.toMatch(/\/o\/[^"']*\.gif/);
    expect(untracked.raw.toString('utf8')).toContain('https://example.com/original');
    expect(untracked.raw.toString('utf8')).toContain('X-Openpost-Self-Copy: 1');
    expect(untracked.raw.toString('utf8')).toContain('<abc123@example.com>');

    let captured: unknown = null;
    const fakeClient = {
      users: {
        messages: {
          insert: async (args: unknown) => {
            captured = args;
            return { data: { id: 'gmail-msg-1', threadId: 'thread-1' } };
          },
        },
      },
    } as unknown as GmailClient;

    const result = await insertSentCopy(fakeClient, { untracked, sentAt: 1_700_000_000_000 });
    expect(result.strategy).toBe('insert');
    expect(result.providerMessageId).toBe('gmail-msg-1');
    expect(result.error).toBeUndefined();

    const req = captured as { userId: string; internalDateSource: string; requestBody: { labelIds: string[]; raw: string } };
    expect(req.userId).toBe('me');
    expect(req.internalDateSource).toBe('dateHeader');
    expect(req.requestBody.labelIds).toEqual(['SENT']);
    const decoded = Buffer.from(req.requestBody.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    expect(decoded).toContain('X-Openpost-Self-Copy: 1');
  });

  it('117. an insert failure never throws - it comes back as { error }', async () => {
    const untracked = await buildUntrackedMime({
      from: { email: 'sender@example.com' },
      to: [{ email: 'alice@example.com' }],
      subject: 'hello',
      html: '<p>hi</p>',
      text: 'hi',
      rfc822MessageId: '<abc@example.com>',
    });
    const failingClient = {
      users: { messages: { insert: async () => { throw new Error('quota exceeded'); } } },
    } as unknown as GmailClient;

    const result = await insertSentCopy(failingClient, { untracked, sentAt: 1000 });
    expect(result.strategy).toBe('insert');
    expect(result.providerMessageId).toBeNull();
    expect(result.error).toContain('quota exceeded');
  });
});

describe('appendSentCopy', () => {
  it('119. calls append(mailbox, raw, [\\Seen], date) on the injected client', async () => {
    const untracked = await buildUntrackedMime({
      from: { email: 'sender@example.com' },
      to: [{ email: 'alice@example.com' }],
      subject: 'hello',
      html: '<p>hi</p>',
      text: 'hi',
      rfc822MessageId: '<abc@example.com>',
    });
    let captured: unknown[] = [];
    const fakeImap: ImapLike = {
      append: async (...args: unknown[]) => {
        captured = args;
      },
      logout: async () => undefined,
    };

    const result = await appendSentCopy(fakeImap, { untracked, sentAt: 1_700_000_000_000 }, '[Gmail]/Sent Mail');
    expect(result.strategy).toBe('imap-append');
    expect(result.error).toBeUndefined();
    expect(captured[0]).toBe('[Gmail]/Sent Mail');
    expect(captured[1]).toBe(untracked.raw);
    expect(captured[2]).toEqual(['\\Seen']);
    expect((captured[3] as Date).getTime()).toBe(1_700_000_000_000);
  });
});
