import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { audit } from '../../db/repo.js';
import {
  cancelAllPending,
  cancelPendingForMessage,
  cancelReminder,
  getReminder,
  listReminders,
  type ReminderStatus,
} from '../../db/reminders.js';
import { runRemindersOnce } from '../../jobs/reminders.js';
import { buildDraftClient } from '../../mail/reply-setup.js';
import { EventBus } from '../../notify/bus.js';
import { NotifyWorker } from '../../notify/worker.js';
import { parseDuration } from '../../core/time.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

const VALID_STATUSES: Array<ReminderStatus | 'all'> = [
  'pending',
  'claimed',
  'fired',
  'skipped',
  'cancelled',
  'failed',
  'all',
];

function parseDueBefore(v: string | undefined, nowMs: number): number | undefined {
  if (v === undefined) return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  const dur = parseDuration(v);
  if (dur !== null) return nowMs + dur;
  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return parsed;
  throw new Error(`invalid --due-before value: "${v}"`);
}

export function registerRemindersCommand(program: Command): void {
  const reminders = program.command('reminders').description('List, cancel or manually fire reminders');

  reminders
    .command('list')
    .description('List reminders')
    .option('--status <status>', 'pending | claimed | fired | skipped | cancelled | failed | all', 'all')
    .option('--message <id>', 'limit to one message')
    .option('--due-before <iso|dur>', 'limit to reminders due before this time')
    .option('--limit <n>', 'max rows', '200')
    .action((opts: { status?: string; message?: string; dueBefore?: string; limit?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const status = (opts.status ?? 'all') as ReminderStatus | 'all';
        if (!VALID_STATUSES.includes(status)) {
          throw new Error(`--status must be one of ${VALID_STATUSES.join(', ')}`);
        }
        const dueBefore = parseDueBefore(opts.dueBefore, Date.now());
        const listOpts: Parameters<typeof listReminders>[1] = {
          status,
          limit: opts.limit ? Number(opts.limit) : 200,
        };
        if (opts.message !== undefined) listOpts.messageId = opts.message;
        if (dueBefore !== undefined) listOpts.dueBefore = dueBefore;
        const rows = listReminders(db, listOpts);
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify({ reminders: rows })}\n`);
        } else if (rows.length === 0) {
          process.stdout.write('no reminders\n');
        } else {
          for (const r of rows) {
            process.stdout.write(
              `${r.id}  ${r.status.padEnd(9)} due ${new Date(r.due_at).toISOString()}  ${r.condition}  message=${r.message_id} recipient=${r.recipient_id ?? '-'}\n`,
            );
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  reminders
    .command('cancel')
    .description('Cancel one reminder, every pending reminder for a message, or every pending reminder')
    .argument('[id]', 'reminder id')
    .option('--message <id>', 'cancel every pending reminder for this message')
    .option('--all-pending', 'cancel every pending reminder')
    .option('--yes', 'do not prompt (no-op today - kept for parity with other destructive commands)')
    .action((id: string | undefined, opts: { message?: string; allPending?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const atMs = Date.now();

        let result: { cancelled: number };
        if (id) {
          const before = getReminder(db, id);
          if (!before) throw new Error(`reminder not found: ${id}`);
          const changed = cancelReminder(db, id, atMs, 'manual');
          result = { cancelled: changed ? 1 : 0 };
          if (changed) {
            audit(db, { actor: 'operator', action: 'reminder.cancel', subjectType: 'reminder', subjectId: id });
          }
        } else if (opts.message) {
          const n = cancelPendingForMessage(db, opts.message, atMs, 'manual');
          result = { cancelled: n };
          audit(db, { actor: 'operator', action: 'reminder.cancel', subjectType: 'message', subjectId: opts.message, detail: { count: n } });
        } else if (opts.allPending) {
          const n = cancelAllPending(db, atMs, 'manual');
          result = { cancelled: n };
          audit(db, { actor: 'operator', action: 'reminder.cancel', detail: { count: n, scope: 'all-pending' } });
        } else {
          throw new Error('pass a reminder id, --message <id> or --all-pending');
        }
        db.close();

        if (g.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else process.stdout.write(`cancelled ${result.cancelled} reminder(s)\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  reminders
    .command('run')
    .description('Run one firing pass now (for cron or manual testing)')
    .option('--now <iso>', 'override the clock')
    .option('--limit <n>', 'max reminders to claim', '50')
    .action(async (opts: { now?: string; limit?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const nowMs = opts.now ? Date.parse(opts.now) : Date.now();
        if (Number.isNaN(nowMs)) throw new Error(`invalid --now: "${opts.now}"`);

        const bus = new EventBus();
        // Not started (no interval, no attach()) - `runRemindersOnce` only ever needs its
        // synchronous `enqueueForEvent` to make the notification durability argument hold (§3.3).
        const notifyWorker = new NotifyWorker({ db, config, bus });
        const draftClient = await buildDraftClient(config, process.env).catch(() => null);
        const result = await runRemindersOnce(
          { db, config, bus, draftClient, notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e) },
          nowMs,
          opts.limit ? Number(opts.limit) : 50,
        );
        db.close();

        if (g.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else process.stdout.write(`fired=${result.fired} skipped=${result.skipped} failed=${result.failed} claimed=${result.claimed}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
