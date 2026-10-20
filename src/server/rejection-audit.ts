import type { DB } from '../db/index.js';
import { audit } from '../db/repo.js';

/**
 * Rate-limits unauthenticated, attacker-triggerable audit writes (`token.reject`, `token.orphan`,
 * `token.disabled`): every bad token otherwise inserts a row, so a trivial scripted scan can grow
 * `audit_log` without bound (finding #6). At most `MAX_PER_WINDOW` rows are written per (db,
 * action) per `WINDOW_MS`; once that budget is spent, further rejections in the same window are
 * simply not persisted (the pixel/click/opt-out response itself is unaffected either way - it is
 * always a plain 200/302, per doc 02 §1.3).
 */
const WINDOW_MS = 1000;
const MAX_PER_WINDOW = 20;

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new WeakMap<DB, Map<string, Bucket>>();

export function auditRejection(
  db: DB,
  entry: { actor: string; action: string; subjectType?: string | null; subjectId?: string | null; detail?: unknown },
  nowMs: number = Date.now(),
): void {
  let dbBuckets = buckets.get(db);
  if (!dbBuckets) {
    dbBuckets = new Map();
    buckets.set(db, dbBuckets);
  }
  let bucket = dbBuckets.get(entry.action);
  if (!bucket || nowMs - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: nowMs, count: 0 };
    dbBuckets.set(entry.action, bucket);
  }
  bucket.count += 1;
  if (bucket.count > MAX_PER_WINDOW) return;
  audit(db, entry);
}
