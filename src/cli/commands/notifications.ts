import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { audit } from '../../db/repo.js';
import { listFailedIds, listNotifications, purgeNotifications, requeue } from '../../notify/queue.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface ListOpts {
  status?: string;
  limit?: string;
}

export function registerNotificationsCommand(program: Command): void {
  const notifications = program.command('notifications').description('Inspect and manage the notification queue');

  notifications
    .command('list')
    .description('List notification queue rows')
    .option('--status <pending|sending|sent|failed>', 'filter by status')
    .option('--limit <n>', 'maximum rows', '20')
    .action((opts: ListOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        if (opts.status !== undefined && !['pending', 'sending', 'sent', 'failed'].includes(opts.status)) {
          throw new Error('--status must be pending, sending, sent or failed');
        }
        const rows = listNotifications(db, {
          ...(opts.status !== undefined
            ? { status: opts.status as 'pending' | 'sending' | 'sent' | 'failed' }
            : {}),
          limit: Number(opts.limit ?? 20),
        });
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify(rows)}\n`);
        } else {
          for (const r of rows) {
            process.stdout.write(
              `${r.id}  ${r.trigger}  ${r.channel}  ${r.status}  attempts=${r.attempts}${r.last_error ? `  error=${r.last_error}` : ''}\n`,
            );
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  notifications
    .command('retry')
    .description('Move a failed notification back to pending')
    .argument('[id]', 'notification id')
    .option('--all-failed', 'requeue every failed notification')
    .action((id: string | undefined, opts: { allFailed?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const now = Date.now();
        const ids = opts.allFailed ? listFailedIds(db) : id ? [id] : [];
        if (ids.length === 0) {
          throw new Error('pass a notification id or --all-failed');
        }
        const requeued: string[] = [];
        for (const notificationId of ids) {
          if (requeue(db, notificationId, now)) {
            requeued.push(notificationId);
            audit(db, { actor: 'operator', action: 'notify.retry', subjectType: 'notification', subjectId: notificationId });
          }
        }
        db.close();

        if (g.json) process.stdout.write(`${JSON.stringify({ requeued })}\n`);
        else process.stdout.write(`requeued ${requeued.length} of ${ids.length}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  notifications
    .command('purge')
    .description(
      'Delete sent notifications and old dead letters (finding #13: this also frees their dedupe ' +
        'keys - see the doc-comment on purgeNotifications() for the theoretical re-notification edge case)',
    )
    .option('--days <n>', 'retention window in days', '365')
    .action((opts: { days?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const days = Number(opts.days ?? 365);
        const now = Date.now();
        const result = purgeNotifications(db, {
          sentOlderThanMs: now - days * 24 * 60 * 60 * 1000,
          deadLettersOlderThanMs: now - 90 * 24 * 60 * 60 * 1000,
        });
        db.close();

        if (g.json) process.stdout.write(`${JSON.stringify(result)}\n`);
        else process.stdout.write(`purged ${result.sent} sent notifications and ${result.deadLetters} dead letters\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
