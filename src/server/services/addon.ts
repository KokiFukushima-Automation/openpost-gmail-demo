/**
 * docs/09_phase5_spec.md §6.4-§6.5: the Gmail add-on's server half. Message-level tracking only
 * (`recipient_mode='single'`) - the add-on knows the draft's current addressees at compose time, but
 * there is no on-send trigger to re-read them, so this is byte-for-byte the same shape
 * `src/mail/send-run.ts`'s single mode already produces: one addressee row per address (own token,
 * never embedded) plus exactly one aggregate row carrying the pixel that actually goes in the body.
 */
import type { AppConfig } from '../../config/env.js';
import { newCacheBuster, pixelUrl, signToken } from '../../core/token.js';
import { isValidAddress } from '../../core/addresses.js';
import { newId } from '../../core/ids.js';
import type { DB } from '../../db/index.js';
import { addRecipient, audit, createMessage, ensureAccount, findRecipientByToken, isSuppressed, markMessageSent, markRecipientSent, recomputeRecipientCounters } from '../../db/repo.js';

export class AddonError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = 'AddonError';
  }
}

const DRAFT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ADDRESSES = 100;
const MAX_SUBJECT_LEN = 512;

export interface AddonTrackInput {
  subject?: string | undefined;
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  draftId?: string | undefined;
}

export interface AddonTrackResult {
  messageId: string;
  token: string;
  pixelUrl: string;
  pixelHtml: string;
  suppressed: boolean;
}

function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function validateAddresses(label: string, addrs: string[] | undefined): string[] {
  if (addrs === undefined) return [];
  for (const a of addrs) {
    if (typeof a !== 'string' || !isValidAddress(a)) {
      throw new AddonError(`invalid ${label} address: ${String(a)}`, 400);
    }
  }
  return addrs;
}

/**
 * §6.4: validates the request, rate limiting is the caller's job (the route). Creates a
 * `recipient_mode:'single'`, `source:'addon'` message: one row per real addressee plus exactly one
 * aggregate row - identical in shape to `runSend`'s single mode. Any suppressed addressee makes the
 * whole message untracked (doc 07 §3.4's all-or-nothing rule, applied identically here).
 */
export function addonTrack(db: DB, config: AppConfig, input: AddonTrackInput): AddonTrackResult {
  const subject = input.subject ?? '';
  if (subject.length > MAX_SUBJECT_LEN) {
    throw new AddonError('subject exceeds 512 characters', 400);
  }
  const to = validateAddresses('to', input.to);
  const cc = validateAddresses('cc', input.cc);
  const bcc = validateAddresses('bcc', input.bcc);
  const all = [...to, ...cc, ...bcc];
  if (all.length === 0) {
    throw new AddonError('at least one address is required', 400);
  }
  if (all.length > MAX_ADDRESSES) {
    throw new AddonError(`too many addresses (max ${MAX_ADDRESSES})`, 400);
  }
  if (input.draftId !== undefined && !DRAFT_ID_RE.test(input.draftId)) {
    throw new AddonError('invalid draftId', 400);
  }

  const fromEmail = config.fromEmail ?? 'addon@localhost';
  const account = ensureAccount(db, { email: fromEmail, displayName: config.fromName, transport: 'gmail' });

  const suppressed = all.some((a) => isSuppressed(db, a));

  const message = createMessage(db, {
    accountId: account.id,
    subject,
    bodyHtml: null,
    bodyText: null,
    status: 'draft',
    trackingEnabled: !suppressed,
    clickTrackingEnabled: false,
    recipientMode: 'single',
    source: 'addon',
    addonDraftId: input.draftId ?? null,
  });

  const addAddresseeRow = (email: string, kind: 'to' | 'cc' | 'bcc'): void => {
    addRecipient(db, { messageId: message.id, email, kind, token: newId(), cacheBuster: newCacheBuster(), isAggregate: false });
  };
  for (const email of to) addAddresseeRow(email, 'to');
  for (const email of cc) addAddresseeRow(email, 'cc');
  for (const email of bcc) addAddresseeRow(email, 'bcc');

  const aggRid = newId();
  const aggCacheBuster = newCacheBuster();
  addRecipient(db, {
    messageId: message.id,
    email: '(all recipients)',
    name: `${all.length} recipients`,
    kind: 'to',
    token: aggRid,
    cacheBuster: aggCacheBuster,
    isAggregate: true,
  });

  const secret = config.trackingSecret as string;
  const pxUrl = pixelUrl(config.trackingBaseUrl, signToken('o', aggRid, secret), aggCacheBuster);
  const pixelHtml = suppressed
    ? ''
    : `<img src="${escapeAttr(pxUrl)}" width="1" height="1" alt="" style="display:none">`;

  audit(db, {
    actor: 'addon',
    action: 'addon.track',
    subjectType: 'message',
    subjectId: message.id,
    detail: { addressCount: all.length, suppressed },
  });

  return { messageId: message.id, token: aggRid, pixelUrl: suppressed ? '' : pxUrl, pixelHtml, suppressed };
}

export interface AddonLinkInput {
  token?: string | undefined;
  gmailMessageId?: string | undefined;
  threadId?: string | undefined;
  rfc822MessageId?: string | undefined;
  sentAt?: number | undefined;
}

export interface AddonLinkResult {
  linked: boolean;
  changed: boolean;
}

/** Repair historic compose-time counts once Gmail confirms the actual send time. */
function suppressPreSendOpens(db: DB, messageId: string, sentAt: number): number {
  return db.transaction(() => {
    const updated = db.prepare(`UPDATE open_events SET original_classification = COALESCE(original_classification, classification),
      classification = 'self_open', counted = 0, confidence = 1, reason = 'pre_send_image', overridden_at = ?
      WHERE counted = 1 AND occurred_at < ? AND recipient_id IN (SELECT id FROM recipients WHERE message_id = ?)`)
      .run(Date.now(), sentAt, messageId).changes;
    if (updated) {
      const rows = db.prepare('SELECT id FROM recipients WHERE message_id = ?').all(messageId) as Array<{id:string}>;
      for (const row of rows) recomputeRecipientCounters(db, row.id);
      audit(db, {actor:'addon',action:'addon.pre_send.suppress',subjectType:'message',subjectId:messageId,detail:{events:updated}});
    }
    return updated;
  })();
}

/**
 * §6.5: resolves the message by the aggregate recipient's token, stamps provider/thread/rfc822 ids
 * on every row (aggregate included - the "single mode stamps one set of ids on every row" rule),
 * flips status to 'sent'. Idempotent for an identical repeat; a conflicting repeat (different
 * `gmailMessageId`) is rejected rather than silently rebinding a tracked message to another Gmail
 * message.
 */
export function addonLink(db: DB, config: AppConfig, input: AddonLinkInput): AddonLinkResult {
  const token = input.token ?? '';
  if (token.length === 0) throw new AddonError('token is required', 400);
  const gmailMessageId = input.gmailMessageId ?? '';
  if (gmailMessageId.length === 0) throw new AddonError('gmailMessageId is required', 400);

  const aggregate = findRecipientByToken(db, token);
  if (!aggregate || !aggregate.is_aggregate) {
    throw new AddonError('unknown token', 404);
  }
  const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(aggregate.message_id) as { id: string; source: string; status: string; created_at: number; sent_at:number|null } | undefined;
  if (!message) throw new AddonError('unknown message', 404);
  if (message.source !== 'addon') {
    throw new AddonError('message was not created by the add-on', 409);
  }

  if (aggregate.provider_msg_id !== null) {
    if (aggregate.provider_msg_id === gmailMessageId) {
      const repaired = message.sent_at === null ? 0 : suppressPreSendOpens(db, message.id, message.sent_at);
      return { linked: true, changed: repaired > 0 };
    }
    audit(db, { actor: 'addon', action: 'addon.link.conflict', subjectType: 'message', subjectId: message.id, detail: { existing: aggregate.provider_msg_id, attempted: gmailMessageId } });
    throw new AddonError('message is already linked to a different Gmail message', 409);
  }

  const now = Date.now();
  const requestedSentAt = input.sentAt ?? now;
  // §6.5: the client supplies sentAt, so it is not trusted to reorder history or defeat the R1
  // self-open window - clamped to [created_at, now + 5 minutes].
  const sentAt = Math.min(Math.max(requestedSentAt, message.created_at), now + 5 * 60_000);

  const threadId = input.threadId ?? gmailMessageId;
  const rfc822MessageId = input.rfc822MessageId ?? `<${gmailMessageId}@mail.gmail.com>`;

  const rows = db.prepare('SELECT id FROM recipients WHERE message_id = ?').all(message.id) as Array<{ id: string }>;
  const stampArgs = { providerMsgId: gmailMessageId, threadId, rfc822MsgId: rfc822MessageId, sentAt };
  for (const r of rows) {
    markRecipientSent(db, r.id, stampArgs);
  }
  markMessageSent(db, message.id, stampArgs);
  suppressPreSendOpens(db, message.id, sentAt);

  audit(db, { actor: 'addon', action: 'addon.link', subjectType: 'message', subjectId: message.id, detail: { gmailMessageId, threadId } });

  return { linked: true, changed: true };
}
