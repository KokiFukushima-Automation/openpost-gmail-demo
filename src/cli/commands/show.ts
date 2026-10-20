import Table from 'cli-table3';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { openDb } from '../../db/index.js';
import {
  countAddressees,
  getClickEventsForRecipient,
  getClickTokensForMessage,
  getEventsForRecipient,
  getMessageDetail,
} from '../../db/repo.js';
import { presentClickEvent, presentMessageDetail, presentOpenEvent } from '../../server/present.js';
import { listNotifications } from '../../notify/queue.js';
import { listReminders } from '../../db/reminders.js';
import { messageLevelPhrase } from '../../notify/channels/util.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

export function registerShowCommand(program: Command): void {
  program
    .command('show')
    .description('Show a message and its recipients')
    .argument('<messageId>', 'message id')
    .option('--events', 'include the full per-recipient event timeline')
    .option('--notifications', 'include queued/sent notification status for this message')
    .action((messageId: string, opts: { events?: boolean; notifications?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env);
        const db = openDb(g.db ?? config.dbPath);
        const detail = getMessageDetail(db, messageId);
        if (!detail) {
          throw new Error(`message not found: ${messageId}`);
        }
        const clickTokens = getClickTokensForMessage(db, messageId);
        const presented = presentMessageDetail(config, detail, clickTokens);

        const events = opts.events
          ? presented.recipients.map((r) => ({
              recipientId: r.id,
              email: r.email,
              opens: getEventsForRecipient(db, r.id).map(presentOpenEvent),
              clicks: getClickEventsForRecipient(db, r.id).map(presentClickEvent),
            }))
          : undefined;
        const notifications = opts.notifications
          ? listNotifications(db, { limit: 200 }).filter((n) => n.message_id === messageId)
          : undefined;
        const reminders = listReminders(db, { messageId });
        const addresseeCountForJson = countAddressees(db, messageId);
        db.close();

        if (g.json) {
          // docs/07_recipient_semantics.md §4.5: each recipient gains `attribution` ('recipient' |
          // 'message') and `recipientCount` (only meaningful, and only ever non-null, on the
          // aggregate row).
          const recipientsWithAttribution = presented.recipients.map((r) => ({
            ...r,
            attribution: r.isAggregate ? 'message' : 'recipient',
            recipientCount: r.isAggregate ? addresseeCountForJson : null,
          }));
          process.stdout.write(
            `${JSON.stringify({ ...presented, recipients: recipientsWithAttribution, events, notifications, reminders })}\n`,
          );
          return;
        }

        const isSingle = presented.recipientMode === 'single';
        process.stdout.write(
          `message ${presented.id}\nsubject: ${presented.subject}\nstatus: ${presented.status}\n` +
            `mode: ${presented.recipientMode}\n` +
            `sent_at: ${presented.sentAt ? new Date(presented.sentAt).toISOString() : '-'}\n\n`,
        );
        if (isSingle) {
          process.stdout.write(
            'note: single-mode message - tracking is message-level; per-recipient open/click ' +
              'attribution is not available (see docs/07_recipient_semantics.md §4.5).\n\n',
          );
        }

        // docs/07_recipient_semantics.md §4.5: single mode's addressee rows carry no individual
        // tracking state ("state: -", "tracking: message-level"); the aggregate row is the one that
        // says "recipient unknown, N on thread".
        const addresseeCount = countAddressees(db, messageId);
        const rTable = new Table({ head: ['email', 'kind', 'state', 'opens', 'clicks', 'replied', 'pixel url'] });
        for (const r of presented.recipients) {
          if (isSingle && r.isAggregate) {
            rTable.push([
              `(message-level) - ${r.state}`,
              r.kind,
              messageLevelPhrase(addresseeCount),
              String(r.openCount),
              String(r.clickCount),
              '-',
              r.pixelUrl,
            ]);
          } else if (isSingle) {
            rTable.push([r.email, r.kind, '-', 'message-level', 'message-level', r.repliedAt ? new Date(r.repliedAt).toISOString() : '-', '-']);
          } else {
            rTable.push([r.email, r.kind, r.state, String(r.openCount), String(r.clickCount), r.repliedAt ? new Date(r.repliedAt).toISOString() : '-', r.pixelUrl]);
          }
        }
        process.stdout.write(`${rTable.toString()}\n`);

        if (reminders.length > 0) {
          process.stdout.write('\nreminders:\n');
          const remTable = new Table({ head: ['id', 'recipient', 'condition', 'due_at', 'status', 'draft'] });
          for (const rem of reminders) {
            remTable.push([rem.id, rem.recipient_id ?? '-', rem.condition, new Date(rem.due_at).toISOString(), rem.status, rem.draft === 1 ? (rem.draft_status ?? 'pending') : '-']);
          }
          process.stdout.write(`${remTable.toString()}\n`);
        }

        if (events) {
          for (const e of events) {
            process.stdout.write(`\nevents for ${e.email}:\n`);
            const eTable = new Table({
              head: ['occurred_at', 'type', 'classification', 'confidence', 'counted', 'reasons', 'overridden'],
            });
            for (const o of e.opens) {
              eTable.push([
                new Date(o.occurredAt).toISOString(),
                'open',
                o.classification,
                o.confidence.toFixed(2),
                String(o.counted),
                o.reasons.join(','),
                o.overridden ? `yes (was ${o.originalClassification})` : '',
              ]);
            }
            for (const c of e.clicks) {
              eTable.push([
                new Date(c.occurredAt).toISOString(),
                'click',
                c.classification,
                c.confidence.toFixed(2),
                String(c.counted),
                c.reasons.join(','),
                c.overridden ? `yes (was ${c.originalClassification})` : '',
              ]);
            }
            process.stdout.write(`${eTable.toString()}\n`);
          }
        }

        if (notifications) {
          process.stdout.write('\nnotifications:\n');
          const nTable = new Table({ head: ['trigger', 'channel', 'status', 'attempts', 'last_error'] });
          for (const n of notifications) {
            nTable.push([n.trigger, n.channel, n.status, String(n.attempts), n.last_error ?? '']);
          }
          process.stdout.write(`${nTable.toString()}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
