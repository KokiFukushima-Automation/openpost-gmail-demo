import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { backupDatabase, inspectBackup, restoreDatabase } from '../../db/backup.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

export function registerBackupCommand(program: Command): void {
  program
    .command('backup')
    .description('Back up the database via the SQLite online backup API')
    .option('--out <dir>', 'destination directory', './data/backups')
    .option('--tag <t>', 'suffix for the backup filename')
    .option('--gzip', 'gzip the backup')
    .action(async (opts: { out?: string; tag?: string; gzip?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const result = await backupDatabase(db, { outDir: opts.out ?? './data/backups', tag: opts.tag, gzip: opts.gzip });
        db.close();
        const output = { path: result.path, manifestPath: result.manifestPath, manifest: result.manifest };
        if (g.json) {
          process.stdout.write(`${JSON.stringify(output)}\n`);
        } else {
          process.stdout.write(`backed up to ${result.path} (${result.manifest.bytes} bytes, sha256 ${result.manifest.sha256.slice(0, 12)}…)\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  program
    .command('restore <file>')
    .description('Restore a backup produced by `openpost backup`. Stop the server first: restoring over a live database (or one with an unremoved -wal/-shm file) is refused unless --force is passed, and is never actually safe even then.')
    .option('--to <db>', 'destination database path')
    .option('--force', 'overwrite a non-empty/live destination (stop the server first regardless)')
    .option('--dry-run', 'run every check and print the manifest without writing anything')
    .action(async (file: string, opts: { to?: string; force?: boolean; dryRun?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const to = opts.to ?? g.db ?? config.dbPath;
        if (opts.dryRun) {
          const check = inspectBackup(file);
          process.stdout.write(g.json ? `${JSON.stringify(check)}\n` : `${check.ok ? 'ok' : 'problems: ' + check.problems.join('; ')}\n`);
          if (!check.ok) process.exit(1);
          return;
        }
        const result = await restoreDatabase({ from: file, to, force: opts.force });
        if (g.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          process.stdout.write(`restored ${result.restored}: schema ${result.schemaBefore} -> ${result.schemaAfter}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
