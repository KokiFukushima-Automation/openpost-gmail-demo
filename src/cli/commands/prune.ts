import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { openDb } from '../../db/index.js';
import { pruneEvents } from '../../db/repo.js';
import { pruneDisabledSubscriptions } from '../../db/push.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

export function registerPruneCommand(program: Command): void {
  program
    .command('prune')
    .description('Delete events older than the retention window')
    .option('--days <n>', 'override RETENTION_DAYS')
    .option('--dry-run', 'show counts without deleting')
    .action((opts: { days?: string; dryRun?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        const days = opts.days ? Number(opts.days) : config.retentionDays;
        const olderThanMs = Date.now() - days * 24 * 60 * 60 * 1000;
        const result = pruneEvents(db, olderThanMs, !!opts.dryRun);
        // docs/09_phase5_spec.md §4.3: subscriptions disabled longer than RETENTION_DAYS are
        // deleted alongside the other retention-governed rows - test 435.
        const pushSubscriptions = opts.dryRun
          ? (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE disabled_at IS NOT NULL AND disabled_at < ?').get(olderThanMs) as { n: number }).n
          : pruneDisabledSubscriptions(db, olderThanMs);
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify({ ...result, pushSubscriptions, dryRun: !!opts.dryRun, days })}\n`);
        } else {
          const verb = opts.dryRun ? 'would delete' : 'deleted';
          process.stdout.write(
            `${verb} ${result.opens} open events, ${result.clicks} click events, ${result.audit} audit log rows, ${pushSubscriptions} disabled push subscriptions\n`,
          );
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
