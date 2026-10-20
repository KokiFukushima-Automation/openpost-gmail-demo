import { describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import {
  addRecipient,
  createMessage,
  ensureAccount,
  getRecipient,
  listReplyCandidates,
  markMessageSent,
  markRecipientSent,
} from '../../src/db/repo.js';
import { runReplyPollOnce } from '../../src/jobs/replies.js';
import { EventBus } from '../../src/notify/bus.js';
import type { ThreadMessageMeta, ThreadReader } from '../../src/mail/threads.js';
import { newId } from '../../src/core/ids.js';
import { makeConfig } from '../helpers/setup.js';

// docs/07_recipient_semantics.md §2.1: pre-existing reply-attribution bug fix in
// src/jobs/replies.ts - match the reply's From against recipients.email for the same message_id
// FIRST, falling back to the MID-chain candidate only when From matches no addressee. Test cases
// 214-216 (numbering per docs/07_recipient_semantics.md §6.5, starting at 200 to avoid clashing
// with Phase 3's 121-192).

const SENT_AT = 1_700_000_000_000;

function fakeReader(messages: ThreadMessageMeta[]): ThreadReader {
  return {
    kind: 'gmail',
    unitCost: 10,
    async fetchThread() {
      return messages;
    },
  };
}

describe('reply attribution fix (docs/07_recipient_semantics.md §2.1)', () => {
  it('214. Bob replies to Alice\'s reply (From: bob, thread shared with Alice\'s Message-ID) credits Bob, not Alice', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'hi',
      bodyHtml: null,
      bodyText: null,
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    markMessageSent(db, message.id, { rfc822MsgId: '<root@example.com>', sentAt: SENT_AT });

    const alice = addRecipient(db, { messageId: message.id, email: 'alice@example.com', token: newId() });
    const bob = addRecipient(db, { messageId: message.id, email: 'bob@example.com', token: newId() });
    // Both share the same thread (a real 4-way Gmail conversation would look exactly like this) -
    // the pre-fix bug: whichever recipient's row happens to be the poll candidate gets credited
    // regardless of who the reply's From header actually names.
    for (const r of [alice, bob]) {
      markRecipientSent(db, r.id, { rfc822MsgId: '<root@example.com>', sentAt: SENT_AT, threadId: 'thread-1', providerMsgId: 'own-msg-1' });
    }

    // The thread now contains one reply, from Bob, In-Reply-To Alice's own outgoing Message-ID
    // (a real "Bob replies to Alice's reply" scenario looks exactly like this to the poller).
    const bobsReply: ThreadMessageMeta = {
      id: 'reply-bob-1',
      threadId: 'thread-1',
      internalDate: SENT_AT + 3_600_000,
      from: 'Bob <bob@example.com>',
      to: 'sender@example.com, alice@example.com',
      messageIdHeader: '<reply-bob-1@example.com>',
      inReplyTo: '<root@example.com>',
      references: '<root@example.com>',
      labelIds: [],
      isSelfCopy: false,
    };

    const config = makeConfig();
    const bus = new EventBus();
    const result = await runReplyPollOnce({ db, config, bus, reader: fakeReader([bobsReply]) }, SENT_AT + 3_700_000);
    expect(result.replied).toBe(1);

    const aliceAfter = getRecipient(db, alice.id);
    const bobAfter = getRecipient(db, bob.id);
    expect(bobAfter?.replied_at).toBe(SENT_AT + 3_600_000);
    expect(bobAfter?.state).toBe('replied');
    expect(aliceAfter?.replied_at).toBeNull();
    expect(aliceAfter?.state).not.toBe('replied');

    // Only one reply.detected row - whichever of Alice/Bob was this tick's poll candidate, the
    // audit subject is always Bob (the actual sender of the reply), never Alice.
    const auditRows = db
      .prepare(`SELECT subject_id, detail_json FROM audit_log WHERE action = 'reply.detected'`)
      .all() as Array<{ subject_id: string; detail_json: string }>;
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.subject_id).toBe(bob.id);
    db.close();
  });

  it('215. listReplyCandidates never returns the single-mode aggregate row', () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'hi',
      bodyHtml: null,
      bodyText: null,
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
      recipientMode: 'single',
    });
    markMessageSent(db, message.id, { providerMsgId: 'p1', threadId: 'thread-1', rfc822MsgId: '<root@example.com>', sentAt: SENT_AT });
    const addressee = addRecipient(db, { messageId: message.id, email: 'alice@example.com', token: newId() });
    const aggregate = addRecipient(db, {
      messageId: message.id,
      email: '(all recipients)',
      name: '1 recipients',
      token: newId(),
      isAggregate: true,
    });
    for (const r of [addressee, aggregate]) {
      markRecipientSent(db, r.id, { providerMsgId: 'p1', threadId: 'thread-1', rfc822MsgId: '<root@example.com>', sentAt: SENT_AT });
    }

    const candidates = listReplyCandidates(db, {
      nowMs: SENT_AT + 3_700_000,
      watchDays: 14,
      pollSeconds: 300,
      batch: 25,
      mode: 'gmail',
    });
    expect(candidates.map((c) => c.id)).toEqual([addressee.id]);
    expect(candidates.map((c) => c.id)).not.toContain(aggregate.id);
    db.close();
  });

  it('216. two independent replies on two independent recipients each credit the right row', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
    const message = createMessage(db, {
      accountId: account.id,
      subject: 'hi',
      bodyHtml: null,
      bodyText: null,
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: false,
    });
    markMessageSent(db, message.id, { rfc822MsgId: '<root@example.com>', sentAt: SENT_AT });

    const alice = addRecipient(db, { messageId: message.id, email: 'alice@example.com', token: newId() });
    const carol = addRecipient(db, { messageId: message.id, email: 'carol@example.com', token: newId() });
    markRecipientSent(db, alice.id, { rfc822MsgId: '<alice-copy@example.com>', sentAt: SENT_AT, threadId: 'thread-alice', providerMsgId: 'm-alice' });
    markRecipientSent(db, carol.id, { rfc822MsgId: '<carol-copy@example.com>', sentAt: SENT_AT, threadId: 'thread-carol', providerMsgId: 'm-carol' });

    const aliceReply: ThreadMessageMeta = {
      id: 'reply-alice',
      threadId: 'thread-alice',
      internalDate: SENT_AT + 1_000_000,
      from: 'alice@example.com',
      to: 'sender@example.com',
      messageIdHeader: '<reply-alice@example.com>',
      inReplyTo: '<alice-copy@example.com>',
      references: '<alice-copy@example.com>',
      labelIds: [],
      isSelfCopy: false,
    };
    const carolReply: ThreadMessageMeta = {
      id: 'reply-carol',
      threadId: 'thread-carol',
      internalDate: SENT_AT + 2_000_000,
      from: 'carol@example.com',
      to: 'sender@example.com',
      messageIdHeader: '<reply-carol@example.com>',
      inReplyTo: '<carol-copy@example.com>',
      references: '<carol-copy@example.com>',
      labelIds: [],
      isSelfCopy: false,
    };

    const byThread = new Map<string, ThreadMessageMeta[]>([
      ['thread-alice', [aliceReply]],
      ['thread-carol', [carolReply]],
    ]);
    const reader: ThreadReader = {
      kind: 'gmail',
      unitCost: 10,
      async fetchThread(ref) {
        return byThread.get(ref.threadId) ?? [];
      },
    };

    const config = makeConfig();
    const bus = new EventBus();
    const result = await runReplyPollOnce({ db, config, bus, reader }, SENT_AT + 3_000_000);
    expect(result.replied).toBe(2);

    const aliceAfter = getRecipient(db, alice.id);
    const carolAfter = getRecipient(db, carol.id);
    expect(aliceAfter?.replied_at).toBe(SENT_AT + 1_000_000);
    expect(carolAfter?.replied_at).toBe(SENT_AT + 2_000_000);
    db.close();
  });
});
