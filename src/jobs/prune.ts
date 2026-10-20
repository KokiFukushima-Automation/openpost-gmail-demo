import type { DB } from '../db/index.js';
import { audit, pruneEvents } from '../db/repo.js';
import { clearVarsForOldCampaigns } from '../db/campaigns.js';
import type { Job } from './scheduler.js';

export interface PruneJobOptions {
  retentionDays: number;
  intervalHours: number;
  vacuumThreshold: number;
}

/** §5.2: `pruneEvents(db, now - RETENTION_DAYS*86400_000, false)`, VACUUMing only past
 *  `PRUNE_VACUUM_THRESHOLD` rows deleted, audited as `prune.run`. */
export function createPruneJob(db: DB, opts: PruneJobOptions): Job {
  return {
    name: 'prune',
    intervalMs: opts.intervalHours * 60 * 60 * 1000,
    async run(nowMs: number): Promise<{ detail?: unknown }> {
      const olderThanMs = nowMs - opts.retentionDays * 24 * 60 * 60 * 1000;
      const result = pruneEvents(db, olderThanMs, false, opts.vacuumThreshold);
      // docs/08_phase4_spec.md §2.10: finished campaigns older than the retention window lose their
      // rows' vars_json (PII from CSV cells) - row counts and statuses are untouched.
      const campaignVarsCleared = clearVarsForOldCampaigns(db, olderThanMs);
      const fullResult = { ...result, campaignVarsCleared };
      audit(db, { actor: 'server', action: 'prune.run', detail: fullResult });
      return { detail: fullResult };
    },
  };
}
