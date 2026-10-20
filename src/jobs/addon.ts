/**
 * docs/09_phase5_spec.md §6.5: an add-on message never linked within `ADDON_LINK_TIMEOUT_HOURS`
 * becomes `status='abandoned'` - the honest outcome for a draft the Gmail add-on tracked but that
 * was never (or not yet) actually sent, or whose sent-mail linker (`addon/Linker.gs`) is not
 * installed at all.
 */
import { audit } from '../db/repo.js';
import type { DB } from '../db/index.js';
import type { Job } from './scheduler.js';

export interface AddonReaperDeps {
  db: DB;
  timeoutHours: number;
  clock?: () => number;
}

export function runAddonReaperOnce(deps: AddonReaperDeps, nowMs?: number): { reaped: number } {
  const { db, timeoutHours } = deps;
  const clock = deps.clock ?? (() => Date.now());
  const now = nowMs ?? clock();
  const cutoff = now - timeoutHours * 3600_000;

  const due = db
    .prepare(`SELECT id FROM messages WHERE source = 'addon' AND status = 'draft' AND created_at < ?`)
    .all(cutoff) as Array<{ id: string }>;

  for (const row of due) {
    db.prepare(`UPDATE messages SET status = 'abandoned', error = @error WHERE id = @id`).run({
      id: row.id,
      error: 'addon: never linked to a sent message',
    });
    audit(db, { actor: 'server', action: 'addon.reap', subjectType: 'message', subjectId: row.id });
  }
  return { reaped: due.length };
}

export function createAddonReaperJob(deps: AddonReaperDeps, intervalMs = 15 * 60_000): Job {
  return {
    name: 'addon-reaper',
    intervalMs,
    async run(nowMs: number): Promise<{ detail?: unknown }> {
      const result = runAddonReaperOnce(deps, nowMs);
      return { detail: result };
    },
  };
}
