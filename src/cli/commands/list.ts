import Table from 'cli-table3';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { openDb } from '../../db/index.js';
import { listMessages } from '../../db/repo.js';
import { presentMessageListRow } from '../../server/present.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List sent messages')
    .option('--limit <n>', 'maximum rows', '20')
    .option('--status <status>', 'filter by status: sent | dryrun | failed')
    .action((opts: { limit: string; status?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        const rows = listMessages(db, { limit: Number(opts.limit), status: opts.status });
        const presented = rows.map(presentMessageListRow);
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify(presented)}\n`);
          return;
        }

        const table = new Table({ head: ['id', 'sent_at', 'subject', 'to', 'opens', 'clicks', 'state'] });
        for (const r of presented) {
          table.push([
            r.id.slice(0, 10),
            r.sentAt ? new Date(r.sentAt).toISOString() : '-',
            r.subject,
            r.to.join(', '),
            `${r.opens.counted}/${r.opens.total}`,
            String(r.clicks),
            r.status,
          ]);
        }
        process.stdout.write(`${table.toString()}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
