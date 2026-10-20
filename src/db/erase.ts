import { createHash } from 'node:crypto';
import type { DB } from './index.js';
import { addSuppression, audit } from './repo.js';
import { redactCampaignRowsForAddress } from './campaigns.js';

export interface ForgetCounts {
  recipients: number;
  openEvents: number;
  clickEvents: number;
  clickTokens: number;
  notifications: number;
  deadLetters: number;
  reminders: number;
  messagesDeleted: number;
  bodiesPurged: number;
  suppressionKept: boolean;
  /** docs/07_recipient_semantics.md §4.4: the single-mode aggregate row (and its events) of every
   *  affected message is erased alongside the addressee row, since in single mode that aggregate
   *  row is the ONLY place the tracking data for this address's open/click ever lived - there is no
   *  way to selectively erase one recipient's share of message-level tracking. */
  aggregateRowsErased: number;
  /** docs/08_phase4_spec.md §2.10: `campaign_rows` are redacted (email -> '(erased)', vars_json ->
   *  '{}'), never deleted - so campaign counts stay truthful even after an address is forgotten. */
  campaignRowsRedacted: number;
}

export interface ForgetPlan {
  email: string;
  normalizedEmail: string;
  recipientIds: string[];
  /** The single-mode aggregate row id of every affected message, deleted alongside `recipientIds`
   *  (§4.4). Disjoint from `recipientIds` (an aggregate row is never itself a real address, so it
   *  can never be found by the `email` lookup that produces `recipientIds`). */
  aggregateRecipientIds: string[];
  counts: ForgetCounts;
  messagesToDelete: string[];
  messagesToKeep: string[];
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Computes exactly what `executeForget` would do, without changing anything - used for
 *  `--dry-run` and to print the confirmation prompt (§5.1). */
export function planForget(db: DB, email: string): ForgetPlan {
  const normalized = normalizeEmail(email);
  const recipientRows = db
    .prepare('SELECT id, message_id FROM recipients WHERE lower(trim(email)) = ?')
    .all(normalized) as Array<{ id: string; message_id: string }>;
  const recipientIds = recipientRows.map((r) => r.id);
  const affectedMessageIds = [...new Set(recipientRows.map((r) => r.message_id))];

  // docs/07_recipient_semantics.md §4.4: every affected message sent in single mode also loses its
  // aggregate row - that row (not any addressee row) is where single mode's open/click evidence
  // actually lives, and there is no way to erase just one recipient's share of it.
  const aggregateRecipientIds: string[] = [];
  if (affectedMessageIds.length > 0) {
    const placeholders = affectedMessageIds.map(() => '?').join(',');
    const aggregateRows = db
      .prepare(
        `SELECT r.id AS id FROM recipients r JOIN messages m ON m.id = r.message_id
          WHERE r.message_id IN (${placeholders}) AND r.is_aggregate = 1 AND m.recipient_mode = 'single'`,
      )
      .all(...affectedMessageIds) as Array<{ id: string }>;
    aggregateRecipientIds.push(...aggregateRows.map((r) => r.id));
  }
  const allDeletedRecipientIds = [...recipientIds, ...aggregateRecipientIds];

  const messagesToDelete: string[] = [];
  const messagesToKeep: string[] = [];
  for (const messageId of affectedMessageIds) {
    const remaining = db
      .prepare(
        `SELECT COUNT(*) AS n FROM recipients WHERE message_id = ? AND id NOT IN (${allDeletedRecipientIds.map(() => '?').join(',') || 'NULL'})`,
      )
      .get(messageId, ...allDeletedRecipientIds) as { n: number };
    if (remaining.n === 0) messagesToDelete.push(messageId);
    else messagesToKeep.push(messageId);
  }

  const countRowsFor = (ids: string[], table: string, column = 'recipient_id'): number => {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => '?').join(',');
    return (
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${placeholders})`).get(
        ...ids,
      ) as { n: number }
    ).n;
  };

  const counts: ForgetCounts = {
    recipients: recipientIds.length,
    openEvents: countRowsFor(allDeletedRecipientIds, 'open_events'),
    clickEvents: countRowsFor(allDeletedRecipientIds, 'click_events'),
    clickTokens: countRowsFor(allDeletedRecipientIds, 'click_tokens'),
    notifications: countRowsFor(allDeletedRecipientIds, 'notifications'),
    deadLetters: countRowsFor(allDeletedRecipientIds, 'notification_dead_letters'),
    // Phase 3: reminders.recipient_id has no ON DELETE CASCADE guarantee callers should rely on for
    // *counting* (the column does cascade, but planForget must report the count before anything is
    // deleted), so it is counted the same way as every other per-recipient table.
    reminders: countRowsFor(allDeletedRecipientIds, 'reminders'),
    messagesDeleted: messagesToDelete.length,
    bodiesPurged: 0,
    suppressionKept: true,
    aggregateRowsErased: aggregateRecipientIds.length,
    campaignRowsRedacted: (
      db.prepare(`SELECT COUNT(*) AS n FROM campaign_rows WHERE lower(trim(email)) = ? AND email NOT LIKE '(erased):%'`).get(normalized) as { n: number }
    ).n,
  };

  return {
    email,
    normalizedEmail: normalized,
    recipientIds,
    aggregateRecipientIds,
    counts,
    messagesToDelete,
    messagesToKeep,
  };
}

export interface ExecuteForgetOptions {
  purgeBodies: boolean;
  keepSuppression: boolean;
  ipSalt: string;
  atMs: number;
}

/**
 * Executes the plan in one transaction, in the order §5.1 specifies. `subject_id` is a hash of the
 * address (never the address itself), so the single `forget.execute` audit row it writes carries no
 * raw address (DoD 11).
 */
export function executeForget(db: DB, plan: ForgetPlan, opts: ExecuteForgetOptions): ForgetCounts {
  return db.transaction(() => {
    const { recipientIds, aggregateRecipientIds } = plan;
    // docs/07_recipient_semantics.md §4.4: the aggregate row of every affected single-mode message
    // is deleted right alongside the addressee rows - same tables, same transaction.
    const allIds = [...recipientIds, ...aggregateRecipientIds];
    const placeholders = allIds.map(() => '?').join(',');

    if (allIds.length > 0) {
      db.prepare(`DELETE FROM click_events WHERE recipient_id IN (${placeholders})`).run(...allIds);
      db.prepare(`DELETE FROM open_events WHERE recipient_id IN (${placeholders})`).run(...allIds);
      db.prepare(`DELETE FROM click_tokens WHERE recipient_id IN (${placeholders})`).run(...allIds);
      db.prepare(`DELETE FROM notifications WHERE recipient_id IN (${placeholders})`).run(...allIds);
      db.prepare(`DELETE FROM notification_dead_letters WHERE recipient_id IN (${placeholders})`).run(
        ...allIds,
      );
      // Phase 3: reminders also cascade via `ON DELETE CASCADE` once the recipient row itself is
      // deleted below, but deleting them explicitly first keeps this list self-documenting and
      // correct even if that constraint is ever relaxed.
      db.prepare(`DELETE FROM reminders WHERE recipient_id IN (${placeholders})`).run(...allIds);
      db.prepare(`DELETE FROM recipients WHERE id IN (${placeholders})`).run(...allIds);
    }

    let messagesDeleted = 0;
    for (const messageId of plan.messagesToDelete) {
      const remaining = db
        .prepare('SELECT COUNT(*) AS n FROM recipients WHERE message_id = ?')
        .get(messageId) as { n: number };
      if (remaining.n === 0) {
        db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
        messagesDeleted += 1;
      }
    }

    let bodiesPurged = 0;
    if (opts.purgeBodies && plan.messagesToKeep.length > 0) {
      for (const messageId of plan.messagesToKeep) {
        const result = db
          .prepare('UPDATE messages SET body_html = NULL, body_text = NULL WHERE id = ?')
          .run(messageId);
        bodiesPurged += result.changes;
      }
    }

    if (opts.keepSuppression) {
      addSuppression(db, plan.normalizedEmail, 'erasure');
    } else {
      db.prepare('DELETE FROM suppressions WHERE email = ?').run(plan.normalizedEmail);
    }

    // docs/08_phase4_spec.md §2.10: redacted, not deleted - campaign counts (rows/sent/skipped/
    // failed) must stay truthful even after the address is forgotten.
    const campaignRowsRedacted = redactCampaignRowsForAddress(db, plan.normalizedEmail);

    const finalCounts: ForgetCounts = {
      ...plan.counts,
      messagesDeleted,
      bodiesPurged,
      suppressionKept: opts.keepSuppression,
      campaignRowsRedacted,
    };

    const subjectId = createHash('sha256')
      .update(`${opts.ipSalt}:${plan.normalizedEmail}`)
      .digest('hex')
      .slice(0, 16);
    audit(db, {
      actor: 'operator',
      action: 'forget.execute',
      subjectType: 'email_hash',
      subjectId,
      detail: finalCounts,
    });

    return finalCounts;
  })();
}
