import type { DB, Stmt } from './index.js';
import { newId } from '../core/ids.js';
import { deriveRecipientState } from '../core/classify.js';
import type {
  OpenClassificationKind,
  ClickClassificationKind,
  PriorEventSummary,
  RecipientCounters,
  RecipientState,
} from '../types.js';

export interface AccountRow {
  id: string;
  email: string;
  display_name: string | null;
  transport: string;
  created_at: number;
}

export interface MessageRow {
  id: string;
  account_id: string;
  subject: string;
  body_html: string | null;
  body_text: string | null;
  thread_id: string | null;
  provider_msg_id: string | null;
  rfc822_msg_id: string | null;
  status: string;
  tracking_enabled: number;
  click_tracking_enabled: number;
  sent_at: number | null;
  created_at: number;
  error: string | null;
  self_copy_strategy: string | null;
  self_copy_msg_id: string | null;
  notify_muted: number;
  /** docs/07_recipient_semantics.md §4.1: 'per-recipient' | 'single'. */
  recipient_mode: string;
  /** docs/08_phase4_spec.md §2: null for every non-campaign send. Not set by `createMessage` -
   *  campaign sends set it via a direct UPDATE (src/mail/send-message.ts) once the row exists. */
  campaign_id: string | null;
  /** docs/09_phase5_spec.md §7.2: cli | campaign | dashboard | addon. */
  source: string;
  addon_draft_id: string | null;
}

export interface RecipientRow {
  id: string;
  message_id: string;
  email: string;
  name: string | null;
  kind: string;
  token: string;
  cache_buster: string | null;
  open_count: number;
  machine_open_count: number;
  first_open_at: number | null;
  last_open_at: number | null;
  click_count: number;
  first_click_at: number | null;
  replied_at: number | null;
  opted_out_at: number | null;
  created_at: number;
  provider_msg_id: string | null;
  thread_id: string | null;
  rfc822_msg_id: string | null;
  sent_at: number | null;
  state: RecipientState;
  notify_muted: number;
  reply_checked_at: number | null;
  reply_check_count: number;
  reply_msg_id: string | null;
  /** docs/07_recipient_semantics.md §4.1: 1 for the single-mode aggregate row, 0 for every real
   *  addressee row (in either mode). */
  is_aggregate: number;
  /** The RCPT TO actually used for this row's copy; NULL for every row in single mode (there is no
   *  per-address envelope) and for rows created before migration 006. */
  envelope_to: string | null;
}

export interface LinkRow {
  id: string;
  message_id: string;
  url: string;
  label: string | null;
  position: number;
  created_at: number;
}

export interface ClickTokenRow {
  id: string;
  link_id: string;
  recipient_id: string;
  created_at: number;
}

export interface OpenEventRow {
  id: string;
  recipient_id: string;
  occurred_at: number;
  classification: string;
  confidence: number;
  counted: number;
  reason: string | null;
  ip_hash: string | null;
  ip_net_hash: string | null;
  ua: string | null;
  ua_family: string | null;
  device_type: string | null;
  os: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  created_at: number;
  original_classification: string | null;
  overridden_at: number | null;
}

export interface ClickEventRow {
  id: string;
  link_id: string;
  recipient_id: string;
  occurred_at: number;
  classification: string;
  confidence: number;
  counted: number;
  reason: string | null;
  ip_hash: string | null;
  ip_net_hash: string | null;
  ua: string | null;
  ua_family: string | null;
  device_type: string | null;
  os: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  created_at: number;
  original_classification: string | null;
  overridden_at: number | null;
}

export interface CreateMessageInput {
  accountId: string;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  status: string;
  trackingEnabled: boolean;
  clickTrackingEnabled: boolean;
  createdAt?: number;
  /** docs/07_recipient_semantics.md §4.1. Defaults to 'per-recipient' - every pre-006 caller and
   *  every N=1 send stays exactly as before. */
  recipientMode?: 'per-recipient' | 'single';
  /** docs/09_phase5_spec.md §7.1/§7.2: cli | campaign | dashboard | addon. Defaults to 'cli' - every
   *  pre-Phase-5 caller (and every non-campaign, non-addon, non-dashboard send) is unaffected. */
  source?: 'cli' | 'campaign' | 'dashboard' | 'addon';
  /** docs/09_phase5_spec.md §6.4: the Gmail add-on's own draft id, for its idempotent re-track
   *  path - null for every non-addon message. */
  addonDraftId?: string | null;
}

export interface AddRecipientInput {
  messageId: string;
  email: string;
  name?: string | null;
  kind?: 'to' | 'cc' | 'bcc';
  token: string;
  /** Persisted so the reported pixel URL is stable across repeated `show`/`/api` reads instead of
   *  minting a fresh cache-buster (and therefore a different-looking URL) on every read (finding
   *  #16). */
  cacheBuster?: string | null;
  createdAt?: number;
  /** docs/07_recipient_semantics.md §4.2: true only for the single-mode aggregate row. */
  isAggregate?: boolean;
  /** The RCPT TO actually used for this row's copy (per-recipient mode only). */
  envelopeTo?: string | null;
}

export interface OpenEventInsert {
  recipientId: string;
  occurredAt: number;
  classification: OpenClassificationKind;
  confidence: number;
  counted: boolean;
  reason: string;
  ipHash: string | null;
  ipNetHash: string | null;
  ua: string | null;
  uaFamily: string | null;
  deviceType: string | null;
  os: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
}

export interface ClickEventInsert {
  linkId: string;
  recipientId: string;
  occurredAt: number;
  classification: ClickClassificationKind;
  confidence: number;
  counted: boolean;
  reason: string;
  ipHash: string | null;
  ipNetHash: string | null;
  ua: string | null;
  uaFamily: string | null;
  deviceType: string | null;
  os: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
}

export interface MessageAggregate {
  countedOpens: number;
  machineOpens: number;
  clicks: number;
  recipients: number;
}

export interface MessageListRow {
  message: MessageRow;
  toEmails: string[];
  aggregate: MessageAggregate;
}

export interface MessageDetail {
  message: MessageRow;
  recipients: RecipientRow[];
  links: LinkRow[];
}

const now = (): number => Date.now();

// --- statement cache -------------------------------------------------------

const stmtCache = new WeakMap<DB, Map<string, Stmt>>();

function stmt(db: DB, sql: string): Stmt {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}

// --- accounts ----------------------------------------------------------

export function ensureAccount(
  db: DB,
  input: { email: string; displayName?: string | null | undefined; transport: string },
): AccountRow {
  const existing = stmt(db, 'SELECT * FROM accounts WHERE email = ?').get(input.email) as
    | AccountRow
    | undefined;
  if (existing) return existing;
  const row: AccountRow = {
    id: newId(),
    email: input.email,
    display_name: input.displayName ?? null,
    transport: input.transport,
    created_at: now(),
  };
  stmt(
    db,
    'INSERT INTO accounts (id, email, display_name, transport, created_at) VALUES (@id, @email, @display_name, @transport, @created_at)',
  ).run(row);
  return row;
}

export function getAccount(db: DB, id: string): AccountRow | null {
  const row = stmt(db, 'SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
  return row ?? null;
}

// --- messages ------------------------------------------------------------

export function createMessage(db: DB, input: CreateMessageInput): MessageRow {
  const row: MessageRow = {
    id: newId(),
    account_id: input.accountId,
    subject: input.subject,
    body_html: input.bodyHtml,
    body_text: input.bodyText,
    thread_id: null,
    provider_msg_id: null,
    rfc822_msg_id: null,
    status: input.status,
    tracking_enabled: input.trackingEnabled ? 1 : 0,
    click_tracking_enabled: input.clickTrackingEnabled ? 1 : 0,
    sent_at: null,
    created_at: input.createdAt ?? now(),
    error: null,
    self_copy_strategy: null,
    self_copy_msg_id: null,
    notify_muted: 0,
    campaign_id: null,
    recipient_mode: input.recipientMode ?? 'per-recipient',
    source: input.source ?? 'cli',
    addon_draft_id: input.addonDraftId ?? null,
  };
  stmt(
    db,
    `INSERT INTO messages
      (id, account_id, subject, body_html, body_text, thread_id, provider_msg_id, rfc822_msg_id,
       status, tracking_enabled, click_tracking_enabled, sent_at, created_at, error,
       self_copy_strategy, self_copy_msg_id, notify_muted, recipient_mode, source, addon_draft_id)
     VALUES
      (@id, @account_id, @subject, @body_html, @body_text, @thread_id, @provider_msg_id, @rfc822_msg_id,
       @status, @tracking_enabled, @click_tracking_enabled, @sent_at, @created_at, @error,
       @self_copy_strategy, @self_copy_msg_id, @notify_muted, @recipient_mode, @source, @addon_draft_id)`,
  ).run(row);
  return row;
}

export function addRecipient(db: DB, input: AddRecipientInput): RecipientRow {
  const row: RecipientRow = {
    id: newId(),
    message_id: input.messageId,
    email: input.email,
    name: input.name ?? null,
    kind: input.kind ?? 'to',
    token: input.token,
    cache_buster: input.cacheBuster ?? null,
    open_count: 0,
    machine_open_count: 0,
    first_open_at: null,
    last_open_at: null,
    click_count: 0,
    first_click_at: null,
    replied_at: null,
    opted_out_at: null,
    created_at: input.createdAt ?? now(),
    provider_msg_id: null,
    thread_id: null,
    rfc822_msg_id: null,
    sent_at: null,
    state: 'not_opened',
    notify_muted: 0,
    reply_checked_at: null,
    reply_check_count: 0,
    reply_msg_id: null,
    is_aggregate: input.isAggregate ? 1 : 0,
    envelope_to: input.envelopeTo ?? null,
  };
  stmt(
    db,
    `INSERT INTO recipients
      (id, message_id, email, name, kind, token, cache_buster, open_count, machine_open_count,
       first_open_at, last_open_at, click_count, first_click_at, replied_at, opted_out_at, created_at,
       provider_msg_id, thread_id, rfc822_msg_id, sent_at, state, notify_muted, is_aggregate, envelope_to)
     VALUES
      (@id, @message_id, @email, @name, @kind, @token, @cache_buster, @open_count, @machine_open_count,
       @first_open_at, @last_open_at, @click_count, @first_click_at, @replied_at, @opted_out_at, @created_at,
       @provider_msg_id, @thread_id, @rfc822_msg_id, @sent_at, @state, @notify_muted, @is_aggregate, @envelope_to)`,
  ).run(row);
  return row;
}

/** docs/07_recipient_semantics.md §4.4: the single-mode aggregate row for one message, or `null` in
 *  per-recipient mode (there is none) or if the message has no recipients at all yet. */
export function getAggregateRecipient(db: DB, messageId: string): RecipientRow | null {
  const row = stmt(db, 'SELECT * FROM recipients WHERE message_id = ? AND is_aggregate = 1').get(
    messageId,
  ) as RecipientRow | undefined;
  return row ?? null;
}

/** docs/07_recipient_semantics.md §4.4/notify §4.5: real addressees only (never the aggregate row)
 *  for one message - used to compute `recipientCount` in the "recipient unknown, N on thread"
 *  attribution text. */
export function countAddressees(db: DB, messageId: string): number {
  const row = stmt(db, 'SELECT COUNT(*) AS n FROM recipients WHERE message_id = ? AND is_aggregate = 0').get(
    messageId,
  ) as { n: number };
  return row.n;
}

/** Records per-recipient send bookkeeping (Phase 1 sent one transport call per recipient but only
 *  ever stored the *first* recipient's provider ids on `messages` - §7.2). */
export function markRecipientSent(
  db: DB,
  recipientId: string,
  input: { providerMsgId?: string | null; threadId?: string | null; rfc822MsgId: string; sentAt: number },
): void {
  stmt(
    db,
    `UPDATE recipients SET provider_msg_id = @providerMsgId, thread_id = @threadId,
       rfc822_msg_id = @rfc822MsgId, sent_at = @sentAt WHERE id = @id`,
  ).run({
    id: recipientId,
    providerMsgId: input.providerMsgId ?? null,
    threadId: input.threadId ?? null,
    rfc822MsgId: input.rfc822MsgId,
    sentAt: input.sentAt,
  });
}

export function markMessageSent(
  db: DB,
  id: string,
  input: {
    providerMsgId?: string | null;
    threadId?: string | null;
    rfc822MsgId: string;
    sentAt: number;
  },
): void {
  stmt(
    db,
    `UPDATE messages SET status = 'sent', provider_msg_id = @providerMsgId, thread_id = @threadId,
       rfc822_msg_id = @rfc822MsgId, sent_at = @sentAt WHERE id = @id`,
  ).run({
    id,
    providerMsgId: input.providerMsgId ?? null,
    threadId: input.threadId ?? null,
    rfc822MsgId: input.rfc822MsgId,
    sentAt: input.sentAt,
  });
}

export function markMessageDryrun(
  db: DB,
  id: string,
  input: { rfc822MsgId: string; sentAt: number },
): void {
  stmt(
    db,
    `UPDATE messages SET status = 'dryrun', rfc822_msg_id = @rfc822MsgId, sent_at = @sentAt WHERE id = @id`,
  ).run({ id, rfc822MsgId: input.rfc822MsgId, sentAt: input.sentAt });
}

export function markMessageFailed(db: DB, id: string, error: string): void {
  stmt(db, `UPDATE messages SET status = 'failed', error = @error WHERE id = @id`).run({ id, error });
}

export function getMessage(db: DB, id: string): MessageRow | null {
  const row = stmt(db, 'SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  return row ?? null;
}

/** Deletes one message; `recipients`/`links` (and everything that cascades from them - click
 *  tokens, open/click events, notifications) go with it via `ON DELETE CASCADE` (§7.2). */
export function deleteMessageCascade(db: DB, id: string): void {
  stmt(db, 'DELETE FROM messages WHERE id = ?').run(id);
}

// --- recipients / tokens ---------------------------------------------------

export function findRecipientByToken(
  db: DB,
  rid: string,
): (RecipientRow & {
  sentAt: number | null;
  trackingEnabled: boolean;
  messageSubject: string;
  messageNotifyMuted: boolean;
  /** docs/08_phase4_spec.md §2.9: additive - null for every pre-Phase-4 message and every
   *  non-campaign send. */
  messageCampaignId: string | null;
}) | null {
  const row = stmt(
    db,
    `SELECT r.*, m.sent_at AS sentAt, m.tracking_enabled AS trackingEnabledRaw,
            m.subject AS messageSubject, m.notify_muted AS messageNotifyMutedRaw,
            m.campaign_id AS messageCampaignId
       FROM recipients r JOIN messages m ON m.id = r.message_id
      WHERE r.token = ?`,
  ).get(rid) as
    | (RecipientRow & {
        sentAt: number | null;
        trackingEnabledRaw: number;
        messageSubject: string;
        messageNotifyMutedRaw: number;
        messageCampaignId: string | null;
      })
    | undefined;
  if (!row) return null;
  const { trackingEnabledRaw, messageNotifyMutedRaw, ...rest } = row;
  return {
    ...rest,
    trackingEnabled: trackingEnabledRaw === 1,
    messageNotifyMuted: messageNotifyMutedRaw === 1,
  };
}

/** docs/07_recipient_semantics.md §2.1: the pre-existing reply-attribution bug fix - credits
 *  whichever addressee of this message actually sent the reply, by exact-normalised email match,
 *  rather than whichever candidate's Message-ID happened to be in the poll batch. Never matches the
 *  aggregate row (`is_aggregate = 0`) - a reply is always from one real person. */
export function findRecipientByMessageAndEmail(db: DB, messageId: string, email: string): RecipientRow | null {
  const row = stmt(
    db,
    `SELECT * FROM recipients WHERE message_id = ? AND is_aggregate = 0 AND lower(trim(email)) = lower(trim(?))`,
  ).get(messageId, email) as RecipientRow | undefined;
  return row ?? null;
}

export function getRecipient(db: DB, id: string): RecipientRow | null {
  const row = stmt(db, 'SELECT * FROM recipients WHERE id = ?').get(id) as RecipientRow | undefined;
  return row ?? null;
}

export function getRecipientWithMessage(
  db: DB,
  id: string,
): (RecipientRow & {
  messageSubject: string;
  messageNotifyMuted: boolean;
  messageSentAt: number | null;
  messageCampaignId: string | null;
}) | null {
  const row = stmt(
    db,
    `SELECT r.*, m.subject AS messageSubject, m.notify_muted AS messageNotifyMutedRaw,
            m.sent_at AS messageSentAt, m.campaign_id AS messageCampaignId
       FROM recipients r JOIN messages m ON m.id = r.message_id WHERE r.id = ?`,
  ).get(id) as
    | (RecipientRow & { messageSubject: string; messageNotifyMutedRaw: number; messageSentAt: number | null; messageCampaignId: string | null })
    | undefined;
  if (!row) return null;
  const { messageNotifyMutedRaw, ...rest } = row;
  return { ...rest, messageNotifyMuted: messageNotifyMutedRaw === 1 };
}

export function recentEventsForRecipient(
  db: DB,
  recipientId: string,
  limit = 50,
): PriorEventSummary[] {
  const rows = stmt(
    db,
    `SELECT occurred_at, ip_net_hash, ua_family, counted, classification FROM open_events
      WHERE recipient_id = ? ORDER BY occurred_at DESC LIMIT ?`,
  ).all(recipientId, limit) as Array<{
    occurred_at: number;
    ip_net_hash: string | null;
    ua_family: string | null;
    counted: number;
    classification: OpenClassificationKind;
  }>;
  return rows.map((r) => ({
    occurredAt: r.occurred_at,
    ipNetHash: r.ip_net_hash,
    uaFamily: r.ua_family,
    counted: r.counted === 1,
    classification: r.classification,
  }));
}

export function fanoutCount(db: DB, ipNetHash: string | null, sinceMs: number): number {
  if (ipNetHash === null) return 0;
  const row = stmt(
    db,
    `SELECT COUNT(DISTINCT recipient_id) AS n FROM open_events
      WHERE ip_net_hash = ? AND occurred_at >= ?`,
  ).get(ipNetHash, sinceMs) as { n: number };
  return row.n;
}

export function insertOpenEvent(db: DB, rec: OpenEventInsert): string {
  const id = newId();
  stmt(
    db,
    `INSERT INTO open_events
      (id, recipient_id, occurred_at, classification, confidence, counted, reason, ip_hash,
       ip_net_hash, ua, ua_family, device_type, os, country, region, city, created_at)
     VALUES
      (@id, @recipient_id, @occurred_at, @classification, @confidence, @counted, @reason, @ip_hash,
       @ip_net_hash, @ua, @ua_family, @device_type, @os, @country, @region, @city, @created_at)`,
  ).run({
    id,
    recipient_id: rec.recipientId,
    occurred_at: rec.occurredAt,
    classification: rec.classification,
    confidence: rec.confidence,
    counted: rec.counted ? 1 : 0,
    reason: rec.reason,
    ip_hash: rec.ipHash,
    ip_net_hash: rec.ipNetHash,
    ua: rec.ua,
    ua_family: rec.uaFamily,
    device_type: rec.deviceType,
    os: rec.os,
    country: rec.country ?? null,
    region: rec.region ?? null,
    city: rec.city ?? null,
    created_at: now(),
  });
  return id;
}

export function bumpRecipientOpenCounters(
  db: DB,
  recipientId: string,
  input: { counted: boolean; atMs: number; isMachine: boolean },
): void {
  if (input.counted) {
    stmt(
      db,
      `UPDATE recipients SET
         open_count = open_count + 1,
         first_open_at = COALESCE(first_open_at, @atMs),
         last_open_at = @atMs
       WHERE id = @id`,
    ).run({ id: recipientId, atMs: input.atMs });
  } else if (input.isMachine) {
    // finding #15: only proxy/MPP/bot/self events count as "machine" activity worth surfacing in
    // the recipient's aggregate counters; dnt/opt_out/duplicate are neither a human open nor
    // evidence of any device having fetched anything new, so they bump nothing.
    stmt(db, `UPDATE recipients SET machine_open_count = machine_open_count + 1 WHERE id = ?`).run(
      recipientId,
    );
  }
}

/** Finding #2 (docs/reports/phase4_review.md): every email-bearing lookup here normalises with
 *  `lower(trim(...))` at the SQL boundary - not just relying on the column's COLLATE NOCASE (which
 *  folds case but not whitespace) - so a suppression recorded from any call site (an interactive
 *  send's opt-out, a campaign import, `forget`) is found by every other, regardless of case or
 *  incidental whitespace in the address as originally typed/pasted. */
export function isSuppressed(db: DB, email: string): boolean {
  const row = stmt(db, 'SELECT 1 FROM suppressions WHERE email = lower(trim(?))').get(email);
  return row !== undefined;
}

export function getSuppressionReason(db: DB, email: string): string | null {
  const row = stmt(db, 'SELECT reason FROM suppressions WHERE email = lower(trim(?))').get(email) as
    | { reason: string }
    | undefined;
  return row?.reason ?? null;
}

export function addSuppression(db: DB, email: string, reason: string): void {
  const normalized = email.trim().toLowerCase();
  stmt(
    db,
    `INSERT INTO suppressions (email, reason, created_at) VALUES (@email, @reason, @created_at)
       ON CONFLICT(email) DO UPDATE SET reason = @reason`,
  ).run({ email: normalized, reason, created_at: now() });
}

export function setRecipientOptedOut(db: DB, recipientId: string, atMs: number): void {
  stmt(db, `UPDATE recipients SET opted_out_at = @atMs WHERE id = @id`).run({
    id: recipientId,
    atMs,
  });
}

// --- links / click tokens / click events -----------------------------------

export function addLink(
  db: DB,
  input: { messageId: string; url: string; label: string | null; position: number },
): LinkRow {
  const existing = stmt(db, 'SELECT * FROM links WHERE message_id = ? AND url = ?').get(
    input.messageId,
    input.url,
  ) as LinkRow | undefined;
  if (existing) return existing;
  const row: LinkRow = {
    id: newId(),
    message_id: input.messageId,
    url: input.url,
    label: input.label,
    position: input.position,
    created_at: now(),
  };
  stmt(
    db,
    `INSERT INTO links (id, message_id, url, label, position, created_at)
     VALUES (@id, @message_id, @url, @label, @position, @created_at)`,
  ).run(row);
  return row;
}

export function getLinksForMessage(db: DB, messageId: string): LinkRow[] {
  return stmt(db, 'SELECT * FROM links WHERE message_id = ? ORDER BY position ASC').all(
    messageId,
  ) as LinkRow[];
}

export interface ClickTokenWithLink {
  id: string; // click token id (the click-token rid)
  link_id: string;
  recipient_id: string;
  url: string;
  label: string | null;
}

export function getClickTokensForMessage(db: DB, messageId: string): ClickTokenWithLink[] {
  return stmt(
    db,
    `SELECT ct.id AS id, ct.link_id AS link_id, ct.recipient_id AS recipient_id, l.url AS url, l.label AS label
       FROM click_tokens ct JOIN links l ON l.id = ct.link_id
      WHERE l.message_id = ?`,
  ).all(messageId) as ClickTokenWithLink[];
}

export function addClickToken(
  db: DB,
  input: { linkId: string; recipientId: string },
): ClickTokenRow {
  const existing = stmt(
    db,
    'SELECT * FROM click_tokens WHERE link_id = ? AND recipient_id = ?',
  ).get(input.linkId, input.recipientId) as ClickTokenRow | undefined;
  if (existing) return existing;
  const row: ClickTokenRow = {
    id: newId(),
    link_id: input.linkId,
    recipient_id: input.recipientId,
    created_at: now(),
  };
  stmt(
    db,
    `INSERT INTO click_tokens (id, link_id, recipient_id, created_at)
     VALUES (@id, @link_id, @recipient_id, @created_at)`,
  ).run(row);
  return row;
}

export interface ClickTokenTarget {
  clickTokenId: string;
  linkId: string;
  recipientId: string;
  url: string;
}

export function findClickTokenTarget(db: DB, rid: string): ClickTokenTarget | null {
  const row = stmt(
    db,
    `SELECT ct.id AS clickTokenId, ct.link_id AS linkId, ct.recipient_id AS recipientId, l.url AS url
       FROM click_tokens ct JOIN links l ON l.id = ct.link_id
      WHERE ct.id = ?`,
  ).get(rid) as ClickTokenTarget | undefined;
  return row ?? null;
}

export function recentClickEventsForRecipient(
  db: DB,
  recipientId: string,
  limit = 50,
): PriorEventSummary[] {
  const rows = stmt(
    db,
    `SELECT occurred_at, ip_net_hash, ua_family, counted, classification FROM click_events
      WHERE recipient_id = ? ORDER BY occurred_at DESC LIMIT ?`,
  ).all(recipientId, limit) as Array<{
    occurred_at: number;
    ip_net_hash: string | null;
    ua_family: string | null;
    counted: number;
    classification: string;
  }>;
  return rows.map((r) => ({
    occurredAt: r.occurred_at,
    ipNetHash: r.ip_net_hash,
    uaFamily: r.ua_family,
    counted: r.counted === 1,
    classification: r.classification as OpenClassificationKind,
  }));
}

export function insertClickEvent(db: DB, rec: ClickEventInsert): string {
  const id = newId();
  stmt(
    db,
    `INSERT INTO click_events
      (id, link_id, recipient_id, occurred_at, classification, confidence, counted, reason, ip_hash,
       ip_net_hash, ua, ua_family, device_type, os, country, region, city, created_at)
     VALUES
      (@id, @link_id, @recipient_id, @occurred_at, @classification, @confidence, @counted, @reason,
       @ip_hash, @ip_net_hash, @ua, @ua_family, @device_type, @os, @country, @region, @city, @created_at)`,
  ).run({
    id,
    link_id: rec.linkId,
    recipient_id: rec.recipientId,
    occurred_at: rec.occurredAt,
    classification: rec.classification,
    confidence: rec.confidence,
    counted: rec.counted ? 1 : 0,
    reason: rec.reason,
    ip_hash: rec.ipHash,
    ip_net_hash: rec.ipNetHash,
    ua: rec.ua,
    ua_family: rec.uaFamily,
    device_type: rec.deviceType,
    os: rec.os,
    country: rec.country ?? null,
    region: rec.region ?? null,
    city: rec.city ?? null,
    created_at: now(),
  });
  return id;
}

export function bumpRecipientClickCounters(db: DB, recipientId: string, atMs: number): void {
  stmt(
    db,
    `UPDATE recipients SET click_count = click_count + 1, first_click_at = COALESCE(first_click_at, @atMs)
     WHERE id = @id`,
  ).run({ id: recipientId, atMs });
}

/** Phase 2 (§4.1): does this recipient already have at least one counted (human) open? Feeds
 *  `ClassifyContext.hasCountedOpen`, which gates click rule R6b. */
export function hasCountedOpen(db: DB, recipientId: string): boolean {
  const row = stmt(db, 'SELECT open_count FROM recipients WHERE id = ?').get(recipientId) as
    | { open_count: number }
    | undefined;
  return (row?.open_count ?? 0) > 0;
}

/** Materialises `recipients.state` (§7.1/§2.1) so it can be read cheaply by presenters, the
 *  notification policy and the dashboard-facing SSE stream without recomputing from event tables
 *  on every read. */
export function setRecipientState(db: DB, recipientId: string, state: RecipientState): void {
  stmt(db, `UPDATE recipients SET state = @state WHERE id = @id`).run({ id: recipientId, state });
}

export function getRecipientState(db: DB, recipientId: string): RecipientState {
  const row = stmt(db, 'SELECT state FROM recipients WHERE id = ?').get(recipientId) as
    | { state: RecipientState }
    | undefined;
  return row?.state ?? 'not_opened';
}

export function setMute(
  db: DB,
  input: { messageId: string; recipientId?: string | null; muted: boolean },
): void {
  if (input.recipientId) {
    stmt(db, `UPDATE recipients SET notify_muted = @muted WHERE id = @id AND message_id = @messageId`).run({
      id: input.recipientId,
      messageId: input.messageId,
      muted: input.muted ? 1 : 0,
    });
  } else {
    stmt(db, `UPDATE messages SET notify_muted = @muted WHERE id = @id`).run({
      id: input.messageId,
      muted: input.muted ? 1 : 0,
    });
  }
}

// --- Phase 2: single-event lookup / manual reclassification ----------------------------------

export function getOpenEvent(db: DB, id: string): OpenEventRow | null {
  const row = stmt(db, 'SELECT * FROM open_events WHERE id = ?').get(id) as OpenEventRow | undefined;
  return row ?? null;
}

export function getClickEvent(db: DB, id: string): ClickEventRow | null {
  const row = stmt(db, 'SELECT * FROM click_events WHERE id = ?').get(id) as
    | ClickEventRow
    | undefined;
  return row ?? null;
}

export interface EventClassificationPatch {
  classification: string;
  counted: boolean;
  confidence: number;
  reason: string;
  /** Set only on the *first* override (the column stays put on subsequent ones - §4.4). */
  originalClassification: string | null;
  overriddenAt: number;
}

export function updateEventClassification(
  db: DB,
  kind: 'open' | 'click',
  id: string,
  patch: EventClassificationPatch,
): void {
  const table = kind === 'open' ? 'open_events' : 'click_events';
  stmt(
    db,
    `UPDATE ${table} SET classification = @classification, counted = @counted, confidence = @confidence,
       reason = @reason, original_classification = COALESCE(original_classification, @originalClassification),
       overridden_at = @overriddenAt
     WHERE id = @id`,
  ).run({
    id,
    classification: patch.classification,
    counted: patch.counted ? 1 : 0,
    confidence: patch.confidence,
    reason: patch.reason,
    originalClassification: patch.originalClassification,
    overriddenAt: patch.overriddenAt,
  });
}

/** Deletes a still-unused back-filled open (an open whose `reason` contains `implied_by_click`)
 *  for this recipient, used when a counted click is demoted away from `human` (§4.4). Returns the
 *  deleted event id, or null if there was none - or if it wasn't safe to delete.
 *
 *  Finding #8: the click just demoted is not necessarily the *only* counted click this recipient
 *  has - `clickBackfillOpens` only ever backs an implied open off the first one (subsequent counted
 *  clicks see `open_count > 0` already and never insert a second implied open). Deleting the
 *  implied open unconditionally, the moment any one click is demoted, could erase the only "this was
 *  read" evidence a still-*counted* other click still relies on. The caller demotes the click's own
 *  `counted` column before calling this, so this count already excludes it. */
export function deleteImpliedOpenForRecipient(db: DB, recipientId: string): string | null {
  const row = stmt(
    db,
    `SELECT id FROM open_events WHERE recipient_id = ? AND reason LIKE '%implied_by_click%' LIMIT 1`,
  ).get(recipientId) as { id: string } | undefined;
  if (!row) return null;

  const remainingCountedClicks = stmt(
    db,
    `SELECT COUNT(*) AS n FROM click_events WHERE recipient_id = ? AND counted = 1`,
  ).get(recipientId) as { n: number };
  if (remainingCountedClicks.n > 0) return null;

  stmt(db, 'DELETE FROM open_events WHERE id = ?').run(row.id);
  return row.id;
}

/**
 * Recomputes `open_count`/`machine_open_count`/`click_count`/`first_open_at`/`last_open_at` from
 * the event tables (never by patching a delta) and rewrites `recipients.state` to match - the
 * single source of truth relied on by `reclassify`, `forget` and pruning (§4.4).
 */
export function recomputeRecipientCounters(
  db: DB,
  recipientId: string,
): RecipientCounters & { state: RecipientState } {
  const openAgg = stmt(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN counted = 1 THEN 1 ELSE 0 END), 0) AS openCount,
       COALESCE(SUM(CASE WHEN counted = 0 AND classification IN
         ('google_proxy_prefetch','apple_mpp','bot','self_open') THEN 1 ELSE 0 END), 0) AS machineOpenCount,
       MIN(CASE WHEN counted = 1 THEN occurred_at END) AS firstOpenAt,
       MAX(CASE WHEN counted = 1 THEN occurred_at END) AS lastOpenAt
     FROM open_events WHERE recipient_id = ?`,
  ).get(recipientId) as {
    openCount: number;
    machineOpenCount: number;
    firstOpenAt: number | null;
    lastOpenAt: number | null;
  };
  const clickAgg = stmt(
    db,
    `SELECT COALESCE(SUM(CASE WHEN counted = 1 THEN 1 ELSE 0 END), 0) AS clickCount,
            MIN(CASE WHEN counted = 1 THEN occurred_at END) AS firstClickAt
       FROM click_events WHERE recipient_id = ?`,
  ).get(recipientId) as { clickCount: number; firstClickAt: number | null };

  const counters: RecipientCounters = {
    openCount: openAgg.openCount,
    machineOpenCount: openAgg.machineOpenCount,
    clickCount: clickAgg.clickCount,
    firstOpenAt: openAgg.firstOpenAt,
    lastOpenAt: openAgg.lastOpenAt,
  };
  // Phase 3 (§4.4): a detected reply must survive a recompute triggered by a later open/click/
  // override - without threading `replied_at` through, this would silently demote `replied` back
  // to whatever the raw counters imply.
  const repliedRow = stmt(db, 'SELECT replied_at FROM recipients WHERE id = ?').get(recipientId) as
    | { replied_at: number | null }
    | undefined;
  const state: RecipientState = deriveRecipientState(counters, { repliedAt: repliedRow?.replied_at ?? null });

  stmt(
    db,
    `UPDATE recipients SET open_count = @openCount, machine_open_count = @machineOpenCount,
       click_count = @clickCount, first_open_at = @firstOpenAt, last_open_at = @lastOpenAt,
       first_click_at = @firstClickAt, state = @state
     WHERE id = @id`,
  ).run({
    id: recipientId,
    openCount: counters.openCount,
    machineOpenCount: counters.machineOpenCount,
    clickCount: counters.clickCount,
    firstOpenAt: counters.firstOpenAt,
    lastOpenAt: counters.lastOpenAt,
    firstClickAt: clickAgg.firstClickAt,
    state,
  });

  return { ...counters, state };
}

// --- Phase 2: ip range sets ------------------------------------------------------------------

export interface IpRangeSetRow {
  name: string;
  source_url: string | null;
  generated_at: number | null;
  updated_at: number;
  entry_count: number;
  sha256: string;
}

export function upsertRangeSet(
  db: DB,
  input: {
    name: string;
    sourceUrl: string | null;
    generatedAt: number | null;
    entryCount: number;
    sha256: string;
    updatedAt: number;
  },
): void {
  stmt(
    db,
    `INSERT INTO ip_range_sets (name, source_url, generated_at, updated_at, entry_count, sha256)
     VALUES (@name, @sourceUrl, @generatedAt, @updatedAt, @entryCount, @sha256)
     ON CONFLICT(name) DO UPDATE SET source_url = @sourceUrl, generated_at = @generatedAt,
       updated_at = @updatedAt, entry_count = @entryCount, sha256 = @sha256`,
  ).run({
    name: input.name,
    sourceUrl: input.sourceUrl,
    generatedAt: input.generatedAt,
    updatedAt: input.updatedAt,
    entryCount: input.entryCount,
    sha256: input.sha256,
  });
}

export function getRangeSet(db: DB, name: string): IpRangeSetRow | null {
  const row = stmt(db, 'SELECT * FROM ip_range_sets WHERE name = ?').get(name) as
    | IpRangeSetRow
    | undefined;
  return row ?? null;
}

// --- listing / detail -------------------------------------------------------

export function listMessages(
  db: DB,
  opts: { limit?: number | undefined; offset?: number | undefined; status?: string | undefined } = {},
): MessageListRow[] {
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;
  const where = opts.status ? 'WHERE status = @status' : '';
  const rows = stmt(
    db,
    `SELECT * FROM messages ${where} ORDER BY created_at DESC LIMIT @limit OFFSET @offset`,
  ).all({ status: opts.status ?? null, limit, offset }) as MessageRow[];

  return rows.map((message) => {
    const recipients = stmt(db, 'SELECT * FROM recipients WHERE message_id = ?').all(
      message.id,
    ) as RecipientRow[];
    // docs/07_recipient_semantics.md §4.4: the "tracked unit" is the aggregate row in single mode
    // (the only row that ever accrues real event counts) and every addressee row otherwise.
    const trackedRows = recipients.filter((r) =>
      message.recipient_mode === 'single' ? r.is_aggregate === 1 : r.is_aggregate === 0,
    );
    const addressees = recipients.filter((r) => r.is_aggregate === 0);
    const aggregate: MessageAggregate = trackedRows.reduce(
      (acc, r) => {
        acc.countedOpens += r.open_count;
        acc.machineOpens += r.machine_open_count;
        acc.clicks += r.click_count;
        acc.recipients += 1;
        return acc;
      },
      { countedOpens: 0, machineOpens: 0, clicks: 0, recipients: 0 },
    );
    return { message, toEmails: addressees.map((r) => r.email), aggregate };
  });
}

export function getMessageDetail(db: DB, id: string): MessageDetail | null {
  const message = getMessage(db, id);
  if (!message) return null;
  const recipients = stmt(db, 'SELECT * FROM recipients WHERE message_id = ?').all(
    id,
  ) as RecipientRow[];
  const links = getLinksForMessage(db, id);
  return { message, recipients, links };
}

export function getEventsForRecipient(db: DB, recipientId: string): OpenEventRow[] {
  return stmt(
    db,
    'SELECT * FROM open_events WHERE recipient_id = ? ORDER BY occurred_at ASC',
  ).all(recipientId) as OpenEventRow[];
}

export function getClickEventsForRecipient(db: DB, recipientId: string): ClickEventRow[] {
  return stmt(
    db,
    'SELECT * FROM click_events WHERE recipient_id = ? ORDER BY occurred_at ASC',
  ).all(recipientId) as ClickEventRow[];
}

// --- audit -------------------------------------------------------------

export function audit(
  db: DB,
  entry: {
    actor: string;
    action: string;
    subjectType?: string | null;
    subjectId?: string | null;
    detail?: unknown;
  },
): void {
  stmt(
    db,
    `INSERT INTO audit_log (id, at, actor, action, subject_type, subject_id, detail_json)
     VALUES (@id, @at, @actor, @action, @subjectType, @subjectId, @detailJson)`,
  ).run({
    id: newId(),
    at: now(),
    actor: entry.actor,
    action: entry.action,
    subjectType: entry.subjectType ?? null,
    subjectId: entry.subjectId ?? null,
    detailJson: entry.detail !== undefined ? JSON.stringify(entry.detail) : null,
  });
}

export interface AuditRow {
  id: string;
  at: number;
  actor: string;
  action: string;
  subject_type: string | null;
  subject_id: string | null;
  detail_json: string | null;
}

export function countAuditByAction(db: DB, action: string): number {
  const row = stmt(db, 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ?').get(action) as {
    n: number;
  };
  return row.n;
}

// --- retention -----------------------------------------------------------

export function pruneEvents(
  db: DB,
  olderThanMs: number,
  dryRun: boolean,
  vacuumThreshold = 0,
): { opens: number; clicks: number; audit: number } {
  const openCount = (
    stmt(db, 'SELECT COUNT(*) AS n FROM open_events WHERE occurred_at < ?').get(
      olderThanMs,
    ) as { n: number }
  ).n;
  const clickCount = (
    stmt(db, 'SELECT COUNT(*) AS n FROM click_events WHERE occurred_at < ?').get(
      olderThanMs,
    ) as { n: number }
  ).n;
  // finding #6: audit_log grows unboundedly otherwise (every rejected token inserts a row); prune
  // it on the same retention window as the events it mostly documents.
  const auditCount = (
    stmt(db, 'SELECT COUNT(*) AS n FROM audit_log WHERE at < ?').get(olderThanMs) as { n: number }
  ).n;
  if (!dryRun) {
    stmt(db, 'DELETE FROM open_events WHERE occurred_at < ?').run(olderThanMs);
    stmt(db, 'DELETE FROM click_events WHERE occurred_at < ?').run(olderThanMs);
    stmt(db, 'DELETE FROM audit_log WHERE at < ?').run(olderThanMs);
    // Phase 2 (§5.2): the scheduled job only VACUUMs past PRUNE_VACUUM_THRESHOLD rows deleted;
    // the default of 0 preserves Phase 1's "VACUUM whenever anything was deleted" behaviour for
    // the `openpost prune` CLI command, which does not pass a threshold.
    if (openCount + clickCount + auditCount > vacuumThreshold) {
      db.exec('VACUUM');
    }
  }
  return { opens: openCount, clicks: clickCount, audit: auditCount };
}

// --- settings ----------------------------------------------------------

export function getSetting(db: DB, key: string): string | null {
  const row = stmt(db, 'SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: DB, key: string, value: string): void {
  stmt(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt`,
  ).run({ key, value, updatedAt: now() });
}

// --- Phase 3: reply detection -----------------------------------------------------------------

/** Guarded write: `AND replied_at IS NULL` makes a concurrent double-detection (two poll ticks
 *  racing on the same recipient) a safe no-op (§4.3). Returns whether this call was the one that
 *  actually recorded the reply. */
export function setRepliedAt(
  db: DB,
  recipientId: string,
  input: { atMs: number; replyMsgId: string | null },
): boolean {
  const result = stmt(
    db,
    `UPDATE recipients SET replied_at = @atMs, reply_msg_id = @replyMsgId,
       reply_checked_at = @atMs, reply_check_count = reply_check_count + 1
     WHERE id = @id AND replied_at IS NULL`,
  ).run({ id: recipientId, atMs: input.atMs, replyMsgId: input.replyMsgId });
  return result.changes > 0;
}

/** Advances the reply-poll bookkeeping without recording a reply (a clean, negative poll) - keeps
 *  the tiered backoff (§4.1) moving even when nothing was found. */
export function touchReplyCheck(db: DB, recipientId: string, atMs: number): void {
  stmt(
    db,
    `UPDATE recipients SET reply_checked_at = @atMs, reply_check_count = reply_check_count + 1
     WHERE id = @id`,
  ).run({ id: recipientId, atMs });
}

export interface ReplyCandidateRow {
  id: string;
  message_id: string;
  thread_id: string | null;
  rfc822_msg_id: string | null;
  provider_msg_id: string | null;
  sent_at: number;
  reply_checked_at: number | null;
  reply_check_count: number;
  subject: string;
  sender_email: string;
}

/** Candidate selection for `src/jobs/replies.ts` (§4.1): an age-tiered poll interval computed in
 *  SQL via `CASE`, the watch window (`REPLY_WATCH_DAYS`), and a batch cap. `mode` picks which
 *  provider-specific id column must be non-null (`thread_id` for Gmail, `rfc822_msg_id` for IMAP). */
export function listReplyCandidates(
  db: DB,
  opts: { nowMs: number; watchDays: number; pollSeconds: number; batch: number; mode: 'gmail' | 'imap' },
): ReplyCandidateRow[] {
  const idColumn = opts.mode === 'imap' ? 'r.rfc822_msg_id' : 'r.thread_id';
  const watchMs = opts.watchDays * 86_400_000;
  return stmt(
    db,
    `SELECT r.id AS id, r.message_id AS message_id, r.thread_id AS thread_id,
            r.rfc822_msg_id AS rfc822_msg_id, r.provider_msg_id AS provider_msg_id, r.sent_at AS sent_at,
            r.reply_checked_at AS reply_checked_at, r.reply_check_count AS reply_check_count,
            m.subject AS subject, a.email AS sender_email
       FROM recipients r
       JOIN messages m ON m.id = r.message_id
       JOIN accounts a ON a.id = m.account_id
      WHERE r.replied_at IS NULL
        AND r.is_aggregate = 0
        AND ${idColumn} IS NOT NULL
        AND r.sent_at IS NOT NULL
        AND r.sent_at >= @sinceWatch
        AND (
          r.reply_checked_at IS NULL
          OR r.reply_checked_at <= @now - (CASE
               WHEN @now - r.sent_at < 7200000   THEN @pollMs
               WHEN @now - r.sent_at < 86400000  THEN 900000
               WHEN @now - r.sent_at < 259200000 THEN 3600000
               ELSE 21600000 END)
        )
      ORDER BY r.sent_at DESC
      LIMIT @batch`,
  ).all({
    now: opts.nowMs,
    sinceWatch: opts.nowMs - watchMs,
    pollMs: opts.pollSeconds * 1000,
    batch: opts.batch,
  }) as ReplyCandidateRow[];
}

// --- Phase 3: dashboard message list / filter -----------------------------------------------

export interface MessageFilter {
  q?: string;
  status?: string;
  state?: RecipientState;
  has?: 'opens' | 'clicks' | 'replies' | 'none';
  sinceMs?: number;
  untilMs?: number;
}

export type MessageSort = 'sent_desc' | 'sent_asc' | 'opens_desc';

/** Ordinal "how far along" a recipient's state is - used to pick the worst-case badge across a
 *  message's recipients (§2.6: "State (worst-case badge across recipients)"). */
export const RECIPIENT_STATE_ORDER: Record<RecipientState, number> = {
  not_opened: 0,
  prefetched: 1,
  opened: 2,
  read_confirmed: 3,
  replied: 4,
};

export interface DashboardMessageRow {
  message: MessageRow;
  toEmails: string[];
  recipientCount: number;
  aggregate: MessageAggregate;
  repliedCount: number;
  worstState: RecipientState;
  pendingReminder: boolean;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function buildMessageFilterSql(filter: MessageFilter): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.q !== undefined && filter.q.trim() !== '') {
    const like = `%${escapeLike(filter.q.trim())}%`;
    clauses.push(
      `(m.subject LIKE @qLike ESCAPE '\\' OR EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.email LIKE @qLike ESCAPE '\\'))`,
    );
    params.qLike = like;
  }
  if (filter.status !== undefined) {
    clauses.push('m.status = @status');
    params.status = filter.status;
  }
  if (filter.sinceMs !== undefined) {
    clauses.push('COALESCE(m.sent_at, m.created_at) >= @sinceMs');
    params.sinceMs = filter.sinceMs;
  }
  if (filter.untilMs !== undefined) {
    clauses.push('COALESCE(m.sent_at, m.created_at) <= @untilMs');
    params.untilMs = filter.untilMs;
  }
  if (filter.state !== undefined) {
    clauses.push('EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.state = @state)');
    params.state = filter.state;
  }
  if (filter.has !== undefined) {
    const hasSql: Record<NonNullable<MessageFilter['has']>, string> = {
      opens: 'EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.open_count > 0)',
      clicks: 'EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.click_count > 0)',
      replies: 'EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND r.replied_at IS NOT NULL)',
      none:
        'NOT EXISTS (SELECT 1 FROM recipients r WHERE r.message_id = m.id AND (r.open_count > 0 OR r.click_count > 0 OR r.replied_at IS NOT NULL))',
    };
    clauses.push(hasSql[filter.has]);
  }

  return { where: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
}

function buildDashboardRow(db: DB, message: MessageRow): DashboardMessageRow {
  const recipients = stmt(db, 'SELECT * FROM recipients WHERE message_id = ?').all(message.id) as RecipientRow[];
  const isSingle = message.recipient_mode === 'single';
  const addressees = recipients.filter((r) => r.is_aggregate === 0);
  // docs/07_recipient_semantics.md §4.4/§4.5: in single mode the aggregate row is the only one that
  // ever accrues real event counts or a materialised state, so both the summary counters and the
  // worst-case state badge come from it, never from the (permanently `not_opened`) addressee rows.
  const trackedRows = isSingle ? recipients.filter((r) => r.is_aggregate === 1) : addressees;

  const aggregate: MessageAggregate = trackedRows.reduce(
    (acc, r) => {
      acc.countedOpens += r.open_count;
      acc.machineOpens += r.machine_open_count;
      acc.clicks += r.click_count;
      acc.recipients += 1;
      return acc;
    },
    { countedOpens: 0, machineOpens: 0, clicks: 0, recipients: 0 },
  );
  // Reply attribution is always per-addressee (src/jobs/replies.ts matches From against
  // recipients.email), even for a single-mode message, so repliedCount is always over addressees.
  const repliedCount = addressees.filter((r) => r.replied_at !== null).length;
  // Phase 3.1 (M2): initialising at 'read_confirmed' (order 3) meant a message whose every
  // recipient had actually replied (order 4, the highest/best state) could never show 'replied' -
  // no recipient's order is ever less than 3 in that case, so the initial value always won. Start
  // from the best possible state instead, so the loop's own "keep the minimum" logic is the only
  // thing that ever changes it.
  let worstState: RecipientState = 'replied';
  for (const r of trackedRows) {
    if (RECIPIENT_STATE_ORDER[r.state] < RECIPIENT_STATE_ORDER[worstState]) worstState = r.state;
  }
  if (trackedRows.length === 0) worstState = 'not_opened';
  const pendingReminder =
    (
      stmt(
        db,
        `SELECT 1 AS present FROM reminders WHERE message_id = ? AND status IN ('pending','claimed') LIMIT 1`,
      ).get(message.id) as { present: number } | undefined
    ) !== undefined;

  return {
    message,
    toEmails: addressees.map((r) => r.email),
    recipientCount: addressees.length,
    aggregate,
    repliedCount,
    worstState,
    pendingReminder,
  };
}

const SORT_SQL: Record<MessageSort, string> = {
  sent_desc: 'COALESCE(m.sent_at, m.created_at) DESC',
  sent_asc: 'COALESCE(m.sent_at, m.created_at) ASC',
  opens_desc:
    '(SELECT COALESCE(SUM(r.open_count), 0) FROM recipients r WHERE r.message_id = m.id) DESC, COALESCE(m.sent_at, m.created_at) DESC',
};

export function listMessagesFiltered(
  db: DB,
  filter: MessageFilter,
  opts: { limit: number; offset: number; sort: MessageSort },
): DashboardMessageRow[] {
  const { where, params } = buildMessageFilterSql(filter);
  const rows = db
    .prepare(`SELECT m.* FROM messages m WHERE ${where} ORDER BY ${SORT_SQL[opts.sort]} LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: opts.limit, offset: opts.offset }) as MessageRow[];
  return rows.map((m) => buildDashboardRow(db, m));
}

/** One message's dashboard row, by id - used to rebuild the `/dashboard/fragments/message-row/:id`
 *  live-replacement fragment without re-running the full filtered list query. */
export function getDashboardMessageRow(db: DB, id: string): DashboardMessageRow | null {
  const message = getMessage(db, id);
  if (!message) return null;
  return buildDashboardRow(db, message);
}

export function countMessagesFiltered(db: DB, filter: MessageFilter): number {
  const { where, params } = buildMessageFilterSql(filter);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM messages m WHERE ${where}`).get(params) as { n: number };
  return row.n;
}

// --- Phase 3: audit log listing (dashboard audit view) ----------------------------------------

export interface AuditFilter {
  action?: string;
  subject?: string;
  sinceMs?: number;
}

function buildAuditFilterSql(filter: AuditFilter): { where: string; params: Record<string, unknown> } {
  const clauses: string[] = [];
  const params: Record<string, unknown> = {};
  if (filter.action !== undefined && filter.action.trim() !== '') {
    clauses.push('action = @action');
    params.action = filter.action;
  }
  if (filter.subject !== undefined && filter.subject.trim() !== '') {
    clauses.push('subject_id = @subject');
    params.subject = filter.subject;
  }
  if (filter.sinceMs !== undefined) {
    clauses.push('at >= @sinceMs');
    params.sinceMs = filter.sinceMs;
  }
  return { where: clauses.length > 0 ? clauses.join(' AND ') : '1=1', params };
}

export function listAuditLog(
  db: DB,
  filter: AuditFilter,
  opts: { limit: number; offset: number },
): AuditRow[] {
  const { where, params } = buildAuditFilterSql(filter);
  return db
    .prepare(`SELECT * FROM audit_log WHERE ${where} ORDER BY at DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: opts.limit, offset: opts.offset }) as AuditRow[];
}

export function countAuditLog(db: DB, filter: AuditFilter): number {
  const { where, params } = buildAuditFilterSql(filter);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE ${where}`).get(params) as { n: number };
  return row.n;
}

export function listDistinctAuditActions(db: DB, limit = 200): string[] {
  const rows = db
    .prepare('SELECT DISTINCT action FROM audit_log ORDER BY action ASC LIMIT ?')
    .all(limit) as Array<{ action: string }>;
  return rows.map((r) => r.action);
}

// --- Phase 3: export ---------------------------------------------------------------------------

export interface ExportRow {
  message_id: string;
  sent_at: number | null;
  eff_sent_at: number;
  subject: string;
  recipient_id: string;
  email: string;
  kind: string;
  state: RecipientState;
  open_count: number;
  machine_open_count: number;
  first_open_at: number | null;
  last_open_at: number | null;
  click_count: number;
  first_click_at: number | null;
  replied_at: number | null;
  opted_out_at: number | null;
  thread_id: string | null;
  status: string;
  is_aggregate: number;
  recipient_mode: string;
}

/** One row per recipient, matching the same `MessageFilter` the list page and export share
 *  (§2.8). `limit` is the caller's `DASHBOARD_MAX_EXPORT_ROWS + 1` so it can detect an over-limit
 *  filter without counting the whole (possibly huge) result set twice. */
export function listRecipientsForExport(db: DB, filter: MessageFilter, limit: number): ExportRow[] {
  const { where, params } = buildMessageFilterSql(filter);
  return db
    .prepare(
      `SELECT r.message_id AS message_id, m.sent_at AS sent_at,
              COALESCE(r.sent_at, m.sent_at, m.created_at) AS eff_sent_at,
              m.subject AS subject, r.id AS recipient_id, r.email AS email, r.kind AS kind,
              r.state AS state, r.open_count AS open_count, r.machine_open_count AS machine_open_count,
              r.first_open_at AS first_open_at, r.last_open_at AS last_open_at,
              r.click_count AS click_count, r.first_click_at AS first_click_at,
              r.replied_at AS replied_at, r.opted_out_at AS opted_out_at,
              r.thread_id AS thread_id, m.status AS status, r.is_aggregate AS is_aggregate,
              m.recipient_mode AS recipient_mode
         FROM messages m JOIN recipients r ON r.message_id = m.id
        WHERE ${where}
        -- L14: a final recipient_id tiebreak - COALESCE(sent_at, created_at) plus r.created_at can
        -- both tie (e.g. several addressees of one send share the same created_at millisecond),
        -- which left the export's row order - and therefore its byte content - dependent on SQLite's
        -- otherwise-unspecified tie order. r.id is unique, so this makes the order fully
        -- deterministic (§6.4's byte-stable export).
        ORDER BY COALESCE(m.sent_at, m.created_at) DESC, r.created_at ASC, r.id ASC
        LIMIT @limit`,
    )
    .all({ ...params, limit }) as ExportRow[];
}
