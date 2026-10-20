import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

export function registerMigrateCommand(program: Command): void {
  program
    .command('migrate')
    .description('Apply pending database migrations')
    .action((_opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const dbPath = g.db ?? config.dbPath;
        const db = openDb(dbPath);
        const before = db.pragma('user_version', { simple: true }) as number;
        const after = migrate(db);
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify({ before, after })}\n`);
        } else if (before === after) {
          process.stdout.write('schema: up to date\n');
        } else {
          process.stdout.write(`schema: ${before} -> ${after}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
