import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { ConfigError, loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { audit, getMessage, getMessageDetail } from '../../db/repo.js';
import { createReminder, type ReminderCondition } from '../../db/reminders.js';
import { parseWhen } from '../../core/time.js';
import { GMAIL_SCOPE_COMPOSE, resolveRefreshToken } from '../../mail/oauth.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface RemindOpts {
  recipient?: string;
  if?: string;
  in?: string;
  at?: string;
  draft?: boolean;
  draftSubject?: string;
  draftBodyFile?: string;
  draftBody?: string;
  note?: string;
}

const CONDITION_MAP: Record<string, ReminderCondition> = {
  'no-reply': 'no_reply',
  no_reply: 'no_reply',
  'no-open': 'no_open',
  no_open: 'no_open',
  always: 'always',
};

export function registerRemindCommand(program: Command): void {
  program
    .command('remind')
    .description('Schedule a reminder for a message (optionally pre-writing a Gmail draft follow-up)')
    .argument('<messageId>', 'message id')
    .option('--recipient <recipientIdOrEmail>', 'limit to one recipient (default: every recipient)')
    .option('--if <condition>', 'no-reply | no-open | always')
    .option('--in <duration>', 'e.g. 3d, 4h, 90m, 45s (mutually exclusive with --at)')
    .option('--at <iso>', 'ISO-8601 due time (mutually exclusive with --in)')
    .option('--draft', 'create a Gmail draft follow-up in the same thread (never sent)')
    .option('--draft-subject <text>', 'override the draft subject (default: "Re: <original>")')
    .option('--draft-body-file <path>', 'HTML file to use as the draft body')
    .option('--draft-body <html>', 'inline HTML to use as the draft body')
    .option('--note <text>', 'free-text note stored with the reminder')
    .action((messageId: string, opts: RemindOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const message = getMessage(db, messageId);
        if (!message) throw new Error(`message not found: ${messageId}`);

        const conditionRaw = opts.if ?? config.reminderDefaultCondition;
        // L7: CONDITION_MAP is a plain object literal - indexing it with an unvalidated string
        // (`--if constructor`) resolves to Object.prototype.constructor rather than undefined,
        // which would silently pass the `!condition` check below and store that Function as the
        // reminder's `condition` value. Object.hasOwn rejects anything not actually one of the
        // three keys this object was given.
        const condition = Object.hasOwn(CONDITION_MAP, conditionRaw) ? CONDITION_MAP[conditionRaw] : undefined;
        if (!condition) {
          throw new ConfigError([`--if must be one of no-reply, no-open, always (got "${conditionRaw}")`]);
        }

        const when = parseWhen({ in: opts.in, at: opts.at }, Date.now(), config.reminderMaxHorizonDays);
        if ('error' in when) {
          throw new ConfigError([when.error]);
        }

        const detail = getMessageDetail(db, messageId);
        if (!detail) throw new Error(`message not found: ${messageId}`);
        // docs/07_recipient_semantics.md §4.4: a reminder may never target the single-mode
        // aggregate row - it is not a real recipient, and "remind the whole thread" is not a
        // meaningful per-recipient follow-up (the message-level no_open degradation lives in
        // src/jobs/reminders.ts instead).
        let targets = detail.recipients.filter((r) => r.is_aggregate === 0);
        if (opts.recipient) {
          const byId = targets.filter((r) => r.id === opts.recipient);
          const byEmail = targets.filter((r) => r.email.toLowerCase() === (opts.recipient as string).toLowerCase());
          const matches = byId.length > 0 ? byId : byEmail;
          if (matches.length === 0) {
            throw new Error(`no recipient matching "${opts.recipient}" on message ${messageId}`);
          }
          if (matches.length > 1) {
            throw new Error(`"${opts.recipient}" matches more than one recipient on message ${messageId} - use the recipient id instead`);
          }
          targets = matches;
        }
        if (targets.length === 0) {
          throw new Error(`message ${messageId} has no recipients`);
        }

        let draftBodyHtml: string | null = null;
        if (opts.draft) {
          if (opts.draftBodyFile) {
            draftBodyHtml = readFileSync(opts.draftBodyFile, 'utf8');
          } else if (opts.draftBody) {
            draftBodyHtml = opts.draftBody;
          }
          const resolved = resolveRefreshToken(config, process.env);
          if (!resolved) {
            process.stderr.write(
              'warning: --draft requires a Gmail refresh token - run `openpost auth gmail --with-compose` ' +
                '(the reminder was still created; its notification will still fire, but no draft will be written)\n',
            );
          } else if (resolved.source === 'file' && !resolved.scopes.includes(GMAIL_SCOPE_COMPOSE)) {
            process.stderr.write(
              'warning: the stored Gmail token lacks the gmail.compose scope - run ' +
                '`openpost auth gmail --with-compose` (the reminder was still created)\n',
            );
          }
        }

        const now = Date.now();
        const created = targets.map((recipient) =>
          createReminder(db, {
            messageId,
            recipientId: recipient.id,
            condition,
            dueAt: when.atMs,
            note: opts.note ?? null,
            draft: !!opts.draft,
            draftSubject: opts.draftSubject ?? null,
            draftBodyHtml,
            createdAt: now,
            createdBy: 'cli',
          }),
        );
        for (const row of created) {
          audit(db, {
            actor: 'operator',
            action: 'reminder.create',
            subjectType: 'reminder',
            subjectId: row.id,
            detail: { messageId, recipientId: row.recipient_id, condition, dueAt: row.due_at, draft: !!opts.draft },
          });
        }
        db.close();

        if (created.length === 1) {
          const row = created[0]!;
          const result = { reminderId: row.id, dueAt: row.due_at, condition };
          if (g.json) process.stdout.write(`${JSON.stringify(result)}\n`);
          else process.stdout.write(`reminder ${row.id} due ${new Date(row.due_at).toISOString()} (${condition})\n`);
        } else {
          const results = created.map((row) => ({
            reminderId: row.id,
            recipientId: row.recipient_id,
            dueAt: row.due_at,
            condition,
          }));
          if (g.json) process.stdout.write(`${JSON.stringify({ reminders: results })}\n`);
          else {
            for (const r of results) {
              process.stdout.write(`reminder ${r.reminderId} (recipient ${r.recipientId}) due ${new Date(r.dueAt).toISOString()} (${condition})\n`);
            }
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
