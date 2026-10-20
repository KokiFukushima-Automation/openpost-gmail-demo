import { createHash } from 'node:crypto';
import type { DB } from './index.js';
import { base32Encode } from '../core/ids.js';
import { deriveRecipientState } from '../core/classify.js';
import type { RecipientCounters, RecipientState } from '../types.js';

export interface SeedOptions {
  seed: number;
  nowMs: number;
  messages: number;
  reset: boolean;
  force: boolean;
  /** Phase 3.1 (M4): required, on top of `reset`, before wiping a database that contains data
   *  `openpost seed --demo` never produced - `force` alone (originally meant for "seed on top of
   *  real data anyway", not "and also wipe it first") was enough to silently destroy it. */
  yes?: boolean;
}

export interface SeedResult {
  seed: number;
  at: number;
  messages: number;
  recipients: number;
  openEvents: number;
  clickEvents: number;
  clicks: number;
  reminders: number;
  replies: number;
  overrides: number;
  /** Phase 3.1 (M4): row counts actually deleted by `--reset`, per table - `null` when `--reset`
   *  was not passed (nothing was wiped). Printed by the CLI for transparency. */
  wiped: Record<string, number> | null;
  /** Phase 3.1 (M4): suppressions are never wiped by `--reset` (they are legal opt-outs, not demo
   *  fixtures) - this is how many survived the reset, for the same transparency. */
  suppressionsPreserved: number;
}

export class SeedRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedRefusedError';
  }
}

/** Deterministic id: `base32(sha256("<seed>:<kind>:<index>"))[0..16 bytes]`, per §6.4 - never
 *  `newId()`, so the same `--seed` always produces the same ids. */
function seedId(seed: number, kind: string, index: number): string {
  const digest = createHash('sha256').update(`${seed}:${kind}:${index}`).digest();
  return base32Encode(digest.subarray(0, 16));
}

function seedToken(seed: number, index: number): string {
  const digest = createHash('sha256').update(`${seed}:token:${index}`).digest();
  return base32Encode(digest.subarray(0, 16));
}

function seedCacheBuster(seed: number, index: number): string {
  const digest = createHash('sha256').update(`${seed}:cb:${index}`).digest();
  return base32Encode(digest.subarray(0, 5));
}

/** `true` iff `settings.demo_seed` is present - i.e. this database was itself produced by an
 *  earlier `openpost seed --demo` run (regardless of whether it also holds real rows now). */
function hasSeedMark(db: DB): boolean {
  const seededMark = db.prepare(`SELECT value FROM settings WHERE key = 'demo_seed'`).get() as
    | { value: string }
    | undefined;
  return seededMark !== undefined;
}

function isNonEmptyNonSeeded(db: DB): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  return row.n > 0;
}

// Phase 3.1 (M4): `suppressions` (real opt-outs/legal holds) and `settings` (operational state -
// notify backoff timers, and the `demo_seed` marker itself) are deliberately never wiped, reset or
// not - only the tables `seedDemo` itself repopulates from scratch.
const WIPE_TABLES = [
  'notification_dead_letters',
  'notifications',
  'reminders',
  'click_events',
  'open_events',
  'click_tokens',
  'links',
  'recipients',
  'messages',
  'accounts',
  'audit_log',
] as const;

function countRows(db: DB, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** Wipes every `WIPE_TABLES` table and returns how many rows each one held beforehand, for the
 *  CLI to print (M4: "print counts" - an operator running `--reset` should see exactly what just
 *  got deleted, not a silent success). */
function wipe(db: DB): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of WIPE_TABLES) counts[table] = countRows(db, table);
  db.exec(WIPE_TABLES.map((t) => `DELETE FROM ${t};`).join('\n'));
  return counts;
}

const OPEN_KINDS = ['human', 'google_proxy_prefetch', 'apple_mpp', 'self_open', 'bot', 'duplicate'] as const;
const STATE_CYCLE: RecipientState[] = ['not_opened', 'prefetched', 'opened', 'read_confirmed', 'replied'];

/**
 * Deterministic fixture generator (§6.4): same `{seed, now, messages}` -> byte-identical database
 * (ids, timestamps, row counts). Refuses to run against a database that already contains
 * non-seeded rows unless `reset` (wipes everything first) or `force`.
 */
export function seedDemo(db: DB, opts: SeedOptions): SeedResult {
  if (!opts.reset && !opts.force) {
    // L12: a database this function itself already seeded hits seedId()'s deterministic ids again
    // and dies with a raw SQLITE_CONSTRAINT (primary-key collision) rather than a friendly refusal
    // - check for that case explicitly, separately from "contains other, non-seeded data" below.
    if (hasSeedMark(db)) {
      throw new SeedRefusedError(
        'database already contains seed data (a `demo_seed` marker is present) - pass --reset to wipe it and reseed, or --force to overwrite (may fail with a constraint error if ids collide)',
      );
    }
    if (isNonEmptyNonSeeded(db)) {
      throw new SeedRefusedError(
        'refusing to seed a non-empty database that was not itself produced by `openpost seed --demo` - pass --reset to wipe it first, or --force to seed anyway',
      );
    }
  }

  let wiped: Record<string, number> | null = null;
  if (opts.reset) {
    // M4: `--reset` used to wipe unconditionally, including a database that happens to also hold
    // real (non-demo) data - require explicit confirmation (`--yes`) before destroying anything
    // that was not itself produced by an earlier `openpost seed --demo` run. A DB that is empty, or
    // was itself seeded before, needs no extra confirmation to reseed.
    if (!opts.force && !opts.yes && isNonEmptyNonSeeded(db) && !hasSeedMark(db)) {
      throw new SeedRefusedError(
        '--reset would wipe a database containing data not produced by `openpost seed --demo` - pass --yes to confirm ' +
          '(suppressions and settings are never touched by --reset regardless)',
      );
    }
    wiped = wipe(db);
  }
  const suppressionsPreserved = countRows(db, 'suppressions');

  const DAY_MS = 86_400_000;
  const HOUR_MS = 3_600_000;

  const accountId = seedId(opts.seed, 'account', 0);
  db.prepare(
    `INSERT INTO accounts (id, email, display_name, transport, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(accountId, 'demo-sender@example.com', 'Demo Sender', 'dryrun', opts.nowMs - opts.messages * DAY_MS);

  let openEventCount = 0;
  let clickEventCount = 0;
  let clickCount = 0;
  let replyCount = 0;
  let recipientIndex = 0;
  let reminderIndex = 0;
  const reminderPlan: Array<{ messageId: string; recipientId: string; status: 'pending' | 'fired' | 'cancelled' }> = [];
  let overrideEventId: string | null = null;
  let overrideRecipientId: string | null = null;

  const insertMessage = db.prepare(
    `INSERT INTO messages
      (id, account_id, subject, body_html, body_text, thread_id, provider_msg_id, rfc822_msg_id,
       status, tracking_enabled, click_tracking_enabled, sent_at, created_at, error,
       self_copy_strategy, self_copy_msg_id, notify_muted)
     VALUES (@id, @account_id, @subject, @body_html, @body_text, @thread_id, @provider_msg_id,
       @rfc822_msg_id, @status, 1, 1, @sent_at, @created_at, @error, NULL, NULL, 0)`,
  );
  const insertRecipient = db.prepare(
    `INSERT INTO recipients
      (id, message_id, email, name, kind, token, cache_buster, open_count, machine_open_count,
       first_open_at, last_open_at, click_count, first_click_at, replied_at, opted_out_at,
       created_at, provider_msg_id, thread_id, rfc822_msg_id, sent_at, state, notify_muted,
       reply_checked_at, reply_check_count, reply_msg_id)
     VALUES (@id, @message_id, @email, @name, @kind, @token, @cache_buster, @open_count,
       @machine_open_count, @first_open_at, @last_open_at, @click_count, @first_click_at,
       @replied_at, NULL, @created_at, @provider_msg_id, @thread_id, @rfc822_msg_id, @sent_at,
       @state, 0, @reply_checked_at, @reply_check_count, @reply_msg_id)`,
  );
  const insertOpen = db.prepare(
    `INSERT INTO open_events
      (id, recipient_id, occurred_at, classification, confidence, counted, reason, ip_hash,
       ip_net_hash, ua, ua_family, device_type, os, country, region, city, created_at,
       original_classification, overridden_at)
     VALUES (@id, @recipient_id, @occurred_at, @classification, @confidence, @counted, @reason,
       @ip_hash, @ip_net_hash, @ua, @ua_family, @device_type, @os, NULL, NULL, NULL, @created_at,
       @original_classification, @overridden_at)`,
  );
  const insertLink = db.prepare(
    `INSERT INTO links (id, message_id, url, label, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertClickToken = db.prepare(
    `INSERT INTO click_tokens (id, link_id, recipient_id, created_at) VALUES (?, ?, ?, ?)`,
  );
  const insertClick = db.prepare(
    `INSERT INTO click_events
      (id, link_id, recipient_id, occurred_at, classification, confidence, counted, reason,
       ip_hash, ip_net_hash, ua, ua_family, device_type, os, country, region, city, created_at,
       original_classification, overridden_at)
     VALUES (@id, @link_id, @recipient_id, @occurred_at, @classification, @confidence, @counted,
       @reason, @ip_hash, @ip_net_hash, @ua, @ua_family, @device_type, @os, NULL, NULL, NULL,
       @created_at, @original_classification, @overridden_at)`,
  );
  const insertAudit = db.prepare(
    `INSERT INTO audit_log (id, at, actor, action, subject_type, subject_id, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const finalizeRecipient = db.prepare(
    `UPDATE recipients SET open_count = @open_count, machine_open_count = @machine_open_count,
       first_open_at = @first_open_at, last_open_at = @last_open_at, click_count = @click_count,
       first_click_at = @first_click_at, replied_at = @replied_at, state = @state,
       reply_checked_at = @reply_checked_at, reply_check_count = @reply_check_count,
       reply_msg_id = @reply_msg_id
     WHERE id = @id`,
  );

  for (let mi = 0; mi < opts.messages; mi++) {
    const messageId = seedId(opts.seed, 'message', mi);
    const statusCycle = ['sent', 'sent', 'dryrun', 'sent', 'failed', 'sent'];
    const status = statusCycle[mi % statusCycle.length] as string;
    const createdAt = opts.nowMs - (opts.messages - mi) * DAY_MS;
    const sentAt = status === 'failed' ? null : createdAt + 5 * 60_000;
    insertMessage.run({
      id: messageId,
      account_id: accountId,
      subject: `Demo message ${mi + 1}`,
      body_html: `<p>Hello - this is demo message ${mi + 1}.</p>`,
      body_text: `Hello - this is demo message ${mi + 1}.`,
      thread_id: sentAt !== null ? seedId(opts.seed, 'thread', mi) : null,
      provider_msg_id: sentAt !== null ? seedId(opts.seed, 'provider', mi) : null,
      rfc822_msg_id: sentAt !== null ? `<${seedId(opts.seed, 'rfc822', mi)}@example.com>` : null,
      status,
      sent_at: sentAt,
      created_at: createdAt,
      error: status === 'failed' ? 'demo: simulated send failure' : null,
    });

    const linkId = seedId(opts.seed, 'link', mi);
    insertLink.run(linkId, messageId, 'https://example.com/landing', 'Landing page', 0, createdAt);

    const recipientsThisMessage = mi % 3 === 0 ? 3 : mi % 3 === 1 ? 2 : 1;
    for (let ri = 0; ri < recipientsThisMessage; ri++) {
      const idx = recipientIndex++;
      const recipientId = seedId(opts.seed, 'recipient', idx);
      const targetState = STATE_CYCLE[idx % STATE_CYCLE.length] as RecipientState;
      const recipientSentAt = sentAt;
      const recipientThreadId = sentAt !== null ? seedId(opts.seed, 'thread', mi) : null;
      const recipientRfc822 = sentAt !== null ? `<${seedId(opts.seed, 'rfc822', mi)}@example.com>` : null;
      const recipientProviderMsgId = sentAt !== null ? seedId(opts.seed, 'provider-recip', idx) : null;

      // A stub row first (zero counters, `not_opened`) so the event tables' FK on recipient_id is
      // satisfiable - the real counters/state are written back with an UPDATE once every event for
      // this recipient has been generated below.
      insertRecipient.run({
        id: recipientId,
        message_id: messageId,
        email: `recipient${idx}@example.com`,
        name: `Recipient ${idx}`,
        kind: idx % 5 === 4 ? 'cc' : 'to',
        token: seedToken(opts.seed, idx),
        cache_buster: seedCacheBuster(opts.seed, idx),
        open_count: 0,
        machine_open_count: 0,
        first_open_at: null,
        last_open_at: null,
        click_count: 0,
        first_click_at: null,
        replied_at: null,
        created_at: createdAt + 1000,
        provider_msg_id: recipientProviderMsgId,
        thread_id: recipientThreadId,
        rfc822_msg_id: recipientRfc822,
        sent_at: recipientSentAt,
        state: 'not_opened',
        reply_checked_at: null,
        reply_check_count: 0,
        reply_msg_id: null,
      });

      let counted: RecipientCounters = {
        openCount: 0,
        machineOpenCount: 0,
        clickCount: 0,
        firstOpenAt: null,
        lastOpenAt: null,
      };
      let repliedAt: number | null = null;
      let replyMsgId: string | null = null;

      // Phase 3.1: `click_tokens` is unique on (link_id, recipient_id) - one token per recipient
      // per link - but the state-specific click fixture below, the bot+scanner fixture, and the
      // implied-by-click fixture each independently plant a click token for THIS recipient's own
      // link, keyed only on `idx % n` for three different `n`. Past `--messages 12` (the only value
      // any test used before), recipientIndex grows past the point where two of those conditions
      // coincide (e.g. idx=26 satisfies both `idx % 7 === 5` and `idx % 9 === 8`) and the second
      // insert hits the unique constraint. Guard all three with one flag so at most one plants a
      // token per recipient - byte-identical output for every seed that never hit the collision.
      let clickTokenPlanted = false;
      const canHaveEvents = sentAt !== null;
      if (canHaveEvents) {
        if (targetState === 'prefetched') {
          const kind = OPEN_KINDS[1 + (idx % (OPEN_KINDS.length - 2))] as string; // machine kinds only
          const occurredAt = sentAt + 30_000;
          insertOpen.run({
            id: seedId(opts.seed, 'open', idx),
            recipient_id: recipientId,
            occurred_at: occurredAt,
            classification: kind,
            confidence: 0.7,
            counted: 0,
            reason: kind === 'google_proxy_prefetch' ? 'R2' : kind === 'apple_mpp' ? 'R4' : kind === 'self_open' ? 'R5' : 'R6',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: kind === 'google_proxy_prefetch' ? 'GoogleImageProxy' : null,
            ua_family: kind === 'google_proxy_prefetch' ? 'GoogleImageProxy' : null,
            device_type: 'proxy',
            os: null,
            created_at: occurredAt,
            original_classification: null,
            overridden_at: null,
          });
          openEventCount += 1;
          counted = { ...counted, machineOpenCount: 1 };
        } else if (targetState === 'opened') {
          const occurredAt = sentAt + 5 * 60_000;
          const eventId = seedId(opts.seed, 'open', idx);
          insertOpen.run({
            id: eventId,
            recipient_id: recipientId,
            occurred_at: occurredAt,
            classification: 'human',
            confidence: 0.6,
            counted: 1,
            reason: 'R9',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36',
            ua_family: 'Chrome',
            device_type: 'desktop',
            os: 'macOS',
            created_at: occurredAt,
            original_classification: null,
            overridden_at: null,
          });
          openEventCount += 1;
          counted = { ...counted, openCount: 1, firstOpenAt: occurredAt, lastOpenAt: occurredAt };
          if (overrideEventId === null && idx % 5 === 2) {
            // Demote this one to a "manual override" fixture later (bot -> human already counted
            // would be uninteresting; instead we mark a *different* bot-classified open below).
          }
        } else if (targetState === 'read_confirmed') {
          const firstAt = sentAt + 2 * 60_000;
          const secondAt = firstAt + 2 * HOUR_MS;
          insertOpen.run({
            id: seedId(opts.seed, 'open', idx),
            recipient_id: recipientId,
            occurred_at: firstAt,
            classification: 'human',
            confidence: 0.6,
            counted: 1,
            reason: 'R9',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mail/17.0',
            ua_family: 'AppleMail',
            device_type: 'mobile',
            os: 'iOS',
            created_at: firstAt,
            original_classification: null,
            overridden_at: null,
          });
          openEventCount += 1;
          // A duplicate (R8) shortly after the first, uncounted - covers the `duplicate`
          // classification (§6.4's fixture list).
          insertOpen.run({
            id: seedId(opts.seed, 'open-dup', idx),
            recipient_id: recipientId,
            occurred_at: firstAt + 5000,
            classification: 'duplicate',
            confidence: 0.99,
            counted: 0,
            reason: 'R8',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mail/17.0',
            ua_family: 'AppleMail',
            device_type: 'mobile',
            os: 'iOS',
            created_at: firstAt + 5000,
            original_classification: null,
            overridden_at: null,
          });
          openEventCount += 1;
          insertOpen.run({
            id: seedId(opts.seed, 'open2', idx),
            recipient_id: recipientId,
            occurred_at: secondAt,
            classification: 'human',
            confidence: 0.85,
            counted: 1,
            reason: 'R9',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mail/17.0',
            ua_family: 'AppleMail',
            device_type: 'mobile',
            os: 'iOS',
            created_at: secondAt,
            original_classification: null,
            overridden_at: null,
          });
          openEventCount += 1;
          counted = { ...counted, openCount: 2, firstOpenAt: firstAt, lastOpenAt: secondAt };

          // Every third read_confirmed recipient also gets a click - one plain human click, one
          // scanner click (R6b) on a recipient with no counted open yet is handled separately
          // below via the `bot`-open recipient; here we cover the `human` click and, once, the
          // back-filled `implied_by_click` open.
          if (idx % 6 === 3 && !clickTokenPlanted) {
            clickTokenPlanted = true;
            const clickAt = secondAt + 10 * 60_000;
            insertClickToken.run(seedId(opts.seed, 'clicktoken', idx), linkId, recipientId, clickAt);
            insertClick.run({
              id: seedId(opts.seed, 'click', idx),
              link_id: linkId,
              recipient_id: recipientId,
              occurred_at: clickAt,
              classification: 'human',
              confidence: 0.6,
              counted: 1,
              reason: 'R9',
              ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
              ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
              ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/129.0 Safari/537.36',
              ua_family: 'Chrome',
              device_type: 'desktop',
              os: 'macOS',
              created_at: clickAt,
              original_classification: null,
              overridden_at: null,
            });
            clickEventCount += 1;
            clickCount += 1;
            counted = { ...counted, clickCount: 1 };
          }
        } else if (targetState === 'replied') {
          const firstAt = sentAt + 3 * 60_000;
          insertOpen.run({
            id: seedId(opts.seed, 'open', idx),
            recipient_id: recipientId,
            occurred_at: firstAt,
            classification: 'human',
            confidence: 0.6,
            counted: 1,
            reason: 'R9',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0',
            ua_family: 'Chrome',
            device_type: 'desktop',
            os: 'Windows',
            created_at: firstAt,
            original_classification: null,
            overridden_at: null,
          });
          openEventCount += 1;
          counted = { ...counted, openCount: 1, firstOpenAt: firstAt, lastOpenAt: firstAt };
          repliedAt = sentAt + 4 * HOUR_MS;
          replyMsgId = `<${seedId(opts.seed, 'reply', idx)}@example.com>`;
          replyCount += 1;
        }

        // A dedicated `bot` open + a `scanner` click fixture, planted on one specific recipient
        // per full cycle so both classifications show up regardless of which state that
        // recipient otherwise landed on.
        if (idx % 7 === 5) {
          const botAt = sentAt + 45_000;
          insertOpen.run({
            id: seedId(opts.seed, 'open-bot', idx),
            recipient_id: recipientId,
            occurred_at: botAt,
            classification: 'bot',
            confidence: 0.9,
            counted: 0,
            reason: 'R6',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: 'curl/8.0',
            ua_family: 'curl',
            device_type: 'bot',
            os: null,
            created_at: botAt,
            original_classification: overrideEventId === null ? 'bot' : null,
            overridden_at: null,
          });
          openEventCount += 1;
          if (overrideEventId === null) {
            overrideEventId = seedId(opts.seed, 'open-bot', idx);
            overrideRecipientId = recipientId;
          }

          if (!clickTokenPlanted) {
            clickTokenPlanted = true;
            const scanAt = botAt + 60_000;
            insertClickToken.run(seedId(opts.seed, 'clicktoken-scan', idx), linkId, recipientId, scanAt);
            insertClick.run({
              id: seedId(opts.seed, 'click-scan', idx),
              link_id: linkId,
              recipient_id: recipientId,
              occurred_at: scanAt,
              classification: 'scanner',
              confidence: 0.85,
              counted: 0,
              reason: 'R6b',
              ip_hash: seedId(opts.seed, 'iphash-scan', idx).slice(0, 16),
              ip_net_hash: seedId(opts.seed, 'ipnet-scan', idx).slice(0, 16),
              ua: 'Mozilla/5.0 (compatible; datacenter-scanner)',
              ua_family: null,
              device_type: 'bot',
              os: null,
              created_at: scanAt,
              original_classification: null,
              overridden_at: null,
            });
            clickEventCount += 1;
          }
        }

        // One back-filled `implied_by_click` open, planted once.
        if (idx % 9 === 8 && targetState !== 'not_opened' && counted.openCount === 0 && !clickTokenPlanted) {
          clickTokenPlanted = true;
          const clickAt = sentAt + 20 * 60_000;
          insertOpen.run({
            id: seedId(opts.seed, 'open-implied', idx),
            recipient_id: recipientId,
            occurred_at: clickAt,
            classification: 'human',
            confidence: 0.8,
            counted: 1,
            reason: 'R10,implied_by_click',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: null,
            ua_family: null,
            device_type: null,
            os: null,
            created_at: clickAt,
            original_classification: null,
            overridden_at: null,
          });
          openEventCount += 1;
          insertClickToken.run(seedId(opts.seed, 'clicktoken-imp', idx), linkId, recipientId, clickAt);
          insertClick.run({
            id: seedId(opts.seed, 'click-imp', idx),
            link_id: linkId,
            recipient_id: recipientId,
            occurred_at: clickAt,
            classification: 'human',
            confidence: 0.6,
            counted: 1,
            reason: 'R9',
            ip_hash: seedId(opts.seed, 'iphash', idx).slice(0, 16),
            ip_net_hash: seedId(opts.seed, 'ipnet', idx).slice(0, 16),
            ua: null,
            ua_family: null,
            device_type: null,
            os: null,
            created_at: clickAt,
            original_classification: null,
            overridden_at: null,
          });
          clickEventCount += 1;
          clickCount += 1;
          counted = {
            ...counted,
            openCount: counted.openCount + 1,
            clickCount: counted.clickCount + 1,
            firstOpenAt: counted.firstOpenAt ?? clickAt,
            lastOpenAt: clickAt,
          };
        }
      }

      const state = deriveRecipientState(counted, { repliedAt });
      finalizeRecipient.run({
        id: recipientId,
        open_count: counted.openCount,
        machine_open_count: counted.machineOpenCount,
        first_open_at: counted.firstOpenAt,
        last_open_at: counted.lastOpenAt,
        click_count: counted.clickCount,
        first_click_at: counted.clickCount > 0 ? (counted.lastOpenAt ?? counted.firstOpenAt) : null,
        replied_at: repliedAt,
        state,
        reply_checked_at: recipientSentAt !== null && repliedAt === null ? recipientSentAt + HOUR_MS : repliedAt,
        reply_check_count: recipientSentAt !== null ? 1 : 0,
        reply_msg_id: replyMsgId,
      });

      // Plant exactly three reminders (pending / fired / cancelled) on the first three
      // recipients that actually have a `sent_at` (a reminder needs a real send to be meaningful).
      if (canHaveEvents && reminderPlan.length < 3) {
        const status = (['pending', 'fired', 'cancelled'] as const)[reminderPlan.length] as
          | 'pending'
          | 'fired'
          | 'cancelled';
        reminderPlan.push({ messageId, recipientId, status });
      }
    }
  }

  for (const plan of reminderPlan) {
    const dueAt = opts.nowMs + (plan.status === 'pending' ? DAY_MS : -HOUR_MS);
    const createdAt = opts.nowMs - HOUR_MS;
    db.prepare(
      `INSERT INTO reminders
        (id, message_id, recipient_id, condition, due_at, status, attempts, lease_owner,
         lease_expires_at, claimed_at, fired_at, cancelled_at, cancel_reason, last_error, note,
         draft, draft_subject, draft_body_html, draft_attempted_at, draft_id, draft_thread_id,
         draft_status, created_at, created_by)
       VALUES (@id, @message_id, @recipient_id, 'no_reply', @due_at, @status, @attempts, NULL,
         NULL, NULL, @fired_at, @cancelled_at, @cancel_reason, NULL, 'demo fixture', 0, NULL,
         NULL, NULL, NULL, NULL, NULL, @created_at, 'seed')`,
    ).run({
      id: seedId(opts.seed, 'reminder', reminderIndex),
      message_id: plan.messageId,
      recipient_id: plan.recipientId,
      due_at: dueAt,
      status: plan.status,
      attempts: plan.status === 'fired' ? 1 : 0,
      fired_at: plan.status === 'fired' ? opts.nowMs - HOUR_MS : null,
      cancelled_at: plan.status === 'cancelled' ? opts.nowMs - HOUR_MS : null,
      cancel_reason: plan.status === 'cancelled' ? 'manual' : null,
      created_at: createdAt,
    });
    reminderIndex += 1;
    if (plan.status === 'fired') {
      insertAudit.run(
        seedId(opts.seed, 'audit-reminder', reminderIndex),
        opts.nowMs - HOUR_MS,
        'server',
        'reminder.fire',
        'reminder',
        seedId(opts.seed, 'reminder', reminderIndex - 1),
        JSON.stringify({ reminderId: seedId(opts.seed, 'reminder', reminderIndex - 1), condition: 'no_reply' }),
      );
    }
  }

  // The manual-override fixture: flip the planted `bot` open to `human`, counted, and record it
  // exactly like `reclassify()` would (§4.4) - a `bot -> human` audit row for the audit view/DoD 2.
  let overrides = 0;
  if (overrideEventId !== null && overrideRecipientId !== null) {
    db.prepare(
      `UPDATE open_events SET classification = 'human', counted = 1, confidence = 1, reason = 'manual',
         original_classification = 'bot', overridden_at = @at WHERE id = @id`,
    ).run({ id: overrideEventId, at: opts.nowMs - 30 * 60_000 });
    const row = db.prepare('SELECT open_count, machine_open_count, click_count, first_open_at, last_open_at FROM recipients WHERE id = ?').get(overrideRecipientId) as {
      open_count: number;
      machine_open_count: number;
      click_count: number;
      first_open_at: number | null;
      last_open_at: number | null;
    };
    const openRow = db.prepare('SELECT occurred_at FROM open_events WHERE id = ?').get(overrideEventId) as {
      occurred_at: number;
    };
    const newFirstOpen = row.first_open_at !== null ? Math.min(row.first_open_at, openRow.occurred_at) : openRow.occurred_at;
    const newLastOpen = row.last_open_at !== null ? Math.max(row.last_open_at, openRow.occurred_at) : openRow.occurred_at;
    const newCounters: RecipientCounters = {
      openCount: row.open_count + 1,
      machineOpenCount: row.machine_open_count,
      clickCount: row.click_count,
      firstOpenAt: newFirstOpen,
      lastOpenAt: newLastOpen,
    };
    const priorReplied = db.prepare('SELECT replied_at FROM recipients WHERE id = ?').get(overrideRecipientId) as {
      replied_at: number | null;
    };
    const newState = deriveRecipientState(newCounters, { repliedAt: priorReplied.replied_at });
    db.prepare(
      `UPDATE recipients SET open_count = @openCount, machine_open_count = @machineOpenCount,
         click_count = @clickCount, first_open_at = @firstOpenAt, last_open_at = @lastOpenAt, state = @state
       WHERE id = @id`,
    ).run({
      id: overrideRecipientId,
      openCount: newCounters.openCount,
      machineOpenCount: newCounters.machineOpenCount,
      clickCount: newCounters.clickCount,
      firstOpenAt: newCounters.firstOpenAt,
      lastOpenAt: newCounters.lastOpenAt,
      state: newState,
    });
    insertAudit.run(
      seedId(opts.seed, 'audit-override', 0),
      opts.nowMs - 30 * 60_000,
      'operator',
      'reclassify.override',
      'open_event',
      overrideEventId,
      JSON.stringify({
        kind: 'open',
        eventId: overrideEventId,
        before: { classification: 'bot', counted: false, confidence: 0.9, reason: 'R6' },
        after: { classification: 'human', counted: true, confidence: 1, reason: 'manual' },
        note: 'demo fixture override',
      }),
    );
    overrides = 1;
  }

  insertAudit.run(
    seedId(opts.seed, 'audit-seed', 0),
    opts.nowMs,
    'operator',
    'seed.demo',
    null,
    null,
    JSON.stringify({ seed: opts.seed, messages: opts.messages, recipients: recipientIndex }),
  );

  const result: SeedResult = {
    seed: opts.seed,
    at: opts.nowMs,
    messages: opts.messages,
    recipients: recipientIndex,
    openEvents: openEventCount,
    clickEvents: clickEventCount,
    clicks: clickCount,
    reminders: reminderPlan.length,
    replies: replyCount,
    overrides,
    wiped,
    suppressionsPreserved,
  };
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('demo_seed', @value, @at)
       ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @at`,
  ).run({ value: JSON.stringify(result), at: opts.nowMs });


  return result;
}
