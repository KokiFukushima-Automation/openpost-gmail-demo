import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildReminderDraftMime, createReminderDraft, gmailDraftClient, type DraftClient } from '../../src/mail/draft.js';
import type { GmailClient } from '../../src/mail/gmail.js';

describe('mail/draft', () => {
  it('175a. buildReminderDraftMime sets In-Reply-To/References to the recipient rfc822_msg_id, "Re: " subject (never doubled), and X-Openpost-Reminder', async () => {
    const built = await buildReminderDraftMime({
      from: { email: 'me@example.com' },
      to: [{ email: 'them@example.com' }],
      originalSubject: 'Re: hello',
      html: '',
      threadId: 't1',
      rfc822MessageId: '<orig@example.com>',
      reminderId: 'rem1',
    });
    const raw = built.raw.toString('utf8');
    expect(raw).toContain('In-Reply-To: <orig@example.com>');
    expect(raw).toContain('References: <orig@example.com>');
    expect(raw).toContain('X-Openpost-Reminder: rem1');
    expect(raw).toMatch(/Subject: Re: hello/);
    expect(raw).not.toMatch(/Subject: Re: Re:/);

    const freshSubject = await buildReminderDraftMime({
      from: { email: 'me@example.com' },
      to: [{ email: 'them@example.com' }],
      originalSubject: 'hello',
      html: '',
      threadId: 't1',
      rfc822MessageId: '<orig@example.com>',
      reminderId: 'rem2',
    });
    expect(freshSubject.raw.toString('utf8')).toMatch(/Subject: Re: hello/);
  });

  it('175b. createReminderDraft calls users.drafts.create with message.threadId set, via the injected DraftClient', async () => {
    const calls: Array<{ raw: Buffer; threadId: string }> = [];
    const fakeClient: DraftClient = {
      async createDraft(input) {
        calls.push(input);
        return { draftId: 'd1', messageId: 'm1', threadId: input.threadId };
      },
      async findDraftByHeader() {
        return { status: 'not_found' };
      },
    };
    const result = await createReminderDraft(fakeClient, {
      from: { email: 'me@example.com' },
      to: [{ email: 'them@example.com' }],
      originalSubject: 'hello',
      html: '<p>hi</p>',
      threadId: 'thread-123',
      rfc822MessageId: '<orig@example.com>',
      reminderId: 'rem1',
    });
    expect(result.draftId).toBe('d1');
    expect(result.threadId).toBe('thread-123');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.threadId).toBe('thread-123');
  });

  it('175c. gmailDraftClient.createDraft threads message.threadId through to users.drafts.create', async () => {
    let capturedThreadId: string | undefined;
    const fakeGmail = {
      users: {
        drafts: {
          create: async (params: { requestBody: { message: { threadId: string } } }) => {
            capturedThreadId = params.requestBody.message.threadId;
            return { data: { id: 'draft-id', message: { id: 'msg-id', threadId: params.requestBody.message.threadId } } };
          },
        },
      },
    } as unknown as GmailClient;
    const client = gmailDraftClient(fakeGmail);
    const result = await client.createDraft({ raw: Buffer.from('raw-mime'), threadId: 'thread-xyz' });
    expect(capturedThreadId).toBe('thread-xyz');
    expect(result.draftId).toBe('draft-id');
    expect(result.threadId).toBe('thread-xyz');
  });

  it('M3a. findDraftByHeader pages through drafts.list with pageToken and finds a match on a later page', async () => {
    const listCalls: Array<string | undefined> = [];
    const fakeGmail = {
      users: {
        drafts: {
          list: async (params: { pageToken?: string }) => {
            listCalls.push(params.pageToken);
            if (params.pageToken === undefined) {
              return { data: { drafts: [{ id: 'd1' }], nextPageToken: 'page2' } };
            }
            return { data: { drafts: [{ id: 'd2' }] } }; // last page: no nextPageToken
          },
          get: async ({ id }: { id: string }) => {
            if (id === 'd1') {
              return { data: { message: { threadId: 'other-thread', payload: { headers: [] } } } };
            }
            return {
              data: {
                message: {
                  threadId: 'thread-1',
                  payload: { headers: [{ name: 'X-Openpost-Reminder', value: 'rem1' }] },
                },
              },
            };
          },
        },
      },
    } as unknown as GmailClient;
    const client = gmailDraftClient(fakeGmail);
    const result = await client.findDraftByHeader('thread-1', 'X-Openpost-Reminder', 'rem1');
    expect(result).toEqual({ status: 'found', draftId: 'd2' });
    expect(listCalls).toEqual([undefined, 'page2']);
  });

  it('M3b. findDraftByHeader returns not_found once every page is exhausted with no match', async () => {
    const fakeGmail = {
      users: {
        drafts: {
          list: async () => ({ data: { drafts: [{ id: 'd1' }] } }),
          get: async () => ({ data: { message: { threadId: 'thread-1', payload: { headers: [] } } } }),
        },
      },
    } as unknown as GmailClient;
    const client = gmailDraftClient(fakeGmail);
    const result = await client.findDraftByHeader('thread-1', 'X-Openpost-Reminder', 'rem1');
    expect(result).toEqual({ status: 'not_found' });
  });

  it('M3c. findDraftByHeader returns uncertain (never not_found) when the page bound is exhausted with more pages outstanding', async () => {
    let calls = 0;
    const fakeGmail = {
      users: {
        drafts: {
          // Always claims there is another page - an account with more drafts in flight than the
          // search bound (10 pages of 50) can ever see - so this never legitimately finishes.
          list: async () => {
            calls += 1;
            return { data: { drafts: [], nextPageToken: `p${calls}` } };
          },
          get: async () => ({ data: { message: { threadId: 'thread-1', payload: { headers: [] } } } }),
        },
      },
    } as unknown as GmailClient;
    const client = gmailDraftClient(fakeGmail);
    const result = await client.findDraftByHeader('thread-1', 'X-Openpost-Reminder', 'rem1');
    expect(result).toEqual({ status: 'uncertain' });
    expect(calls).toBe(10); // DRAFT_SEARCH_MAX_PAGES
  });

  it('M3d. findDraftByHeader returns uncertain, not not_found, when a list() call itself fails mid-search', async () => {
    const fakeGmail = {
      users: {
        drafts: {
          list: async () => {
            throw new Error('quota exceeded');
          },
        },
      },
    } as unknown as GmailClient;
    const client = gmailDraftClient(fakeGmail);
    const result = await client.findDraftByHeader('thread-1', 'X-Openpost-Reminder', 'rem1');
    expect(result).toEqual({ status: 'uncertain' });
  });

  it('175d. users.drafts.send is never called anywhere in the codebase', () => {
    // Matches an actual call site (`drafts.send(`), not the doc-comments that name it by way of
    // explanation - those exist precisely to document that this call is never made.
    const out = execSync('grep -rn "drafts\\.send(" src/ || true', { cwd: process.cwd() }).toString();
    expect(out.trim()).toBe('');
  });
});
