import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { RangeIndex } from '../core/ranges.js';
import { loadRangeIndex } from '../core/ranges.js';
import type { DB } from '../db/index.js';
import { audit } from '../db/repo.js';
import type { Job } from './scheduler.js';

const FILES = ['apple-relay.cidr', 'google-proxy.cidr', 'datacenter.cidr'];

function mtimesOf(dir: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const file of FILES) {
    try {
      result[file] = statSync(join(dir, file)).mtimeMs;
    } catch {
      result[file] = -1;
    }
  }
  return result;
}

/** §5.2: reloads `data/ranges/*` when any file's mtime changed, mutating the *same* `RangeIndex`
 *  object the server's routes already hold a reference to (its fields are plain, not `readonly`,
 *  precisely so this in-place swap is possible without threading a fresh object through every
 *  route closure). Audits `ranges.reload` only when something actually changed. */
export function createRangesReloadJob(db: DB, index: RangeIndex, dir: string, intervalMs: number): Job {
  let lastMtimes = mtimesOf(dir);
  return {
    name: 'ranges-reload',
    intervalMs,
    async run(): Promise<{ detail?: unknown }> {
      const currentMtimes = mtimesOf(dir);
      const changed = FILES.some((f) => currentMtimes[f] !== lastMtimes[f]);
      if (!changed) return { detail: { reloaded: false } };

      const fresh = loadRangeIndex(dir);
      index.apple = fresh.apple;
      index.googleProxy = fresh.googleProxy;
      index.datacenter = fresh.datacenter;
      index.loadedAt = fresh.loadedAt;
      lastMtimes = currentMtimes;

      audit(db, {
        actor: 'server',
        action: 'ranges.reload',
        detail: {
          apple: fresh.apple.size,
          googleProxy: fresh.googleProxy.size,
          datacenter: fresh.datacenter.size,
        },
      });
      return { detail: { reloaded: true } };
    },
  };
}
