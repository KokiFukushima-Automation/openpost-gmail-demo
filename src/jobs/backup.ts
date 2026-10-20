import { backupDatabase, pruneBackups } from '../db/backup.js';
import type { DB } from '../db/index.js';
import type { Job } from './scheduler.js';

export interface BackupJobOptions {
  outDir: string;
  keep: number;
  gzip: boolean;
}

/** `BACKUP_ENABLED=true` registers this on the scheduler: a backup every `BACKUP_INTERVAL_HOURS`,
 *  keeping `BACKUP_KEEP` files (docs/08_phase4_spec.md §4.6). */
export function createBackupJob(deps: { db: DB } & BackupJobOptions, intervalMs: number): Job {
  return {
    name: 'backup',
    intervalMs,
    async run(): Promise<{ detail?: unknown }> {
      const result = await backupDatabase(deps.db, { outDir: deps.outDir, gzip: deps.gzip, tag: 'scheduled' });
      const pruned = pruneBackups(deps.outDir, deps.keep);
      return { detail: { path: result.path, bytes: result.manifest.bytes, pruned: pruned.length } };
    },
  };
}
