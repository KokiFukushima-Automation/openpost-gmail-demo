import type { DB } from '../db/index.js';
import type { PriorEventSummary } from '../types.js';

/**
 * In `PRIVACY_MODE=strict`, `open_events`/`click_events` rows have `ip_net_hash`/`ua_family` nulled
 * before they are ever persisted (doc 02 §4: "Records only (recipient_id, occurred_at,
 * classification, counted). Everything else is NULL."). Read back from the DB, those nulled rows
 * make R7 (fanout) and R8 (dedupe) compare `null === null` against the *live* request's hashes,
 * which never matches a live (non-null) value - dedupe and fanout silently stop working in strict
 * mode (finding #3).
 *
 * The fix is a short-lived, process-memory-only correlation window: never persisted, never written
 * to the database, gone on restart. It stores only values that are already one-way salted hashes
 * (`ipNetHash`) or a coarse UA family label - never a raw IP or raw UA - so it does not weaken
 * strict mode's on-disk guarantee at all; it only lets *this running process* recognise "I saw this
 * net/family for this recipient a moment ago" long enough for R7/R8 to do their job.
 */
export type CorrelationKind = 'open' | 'click';

interface CorrelationEntry {
  kind: CorrelationKind;
  recipientId: string;
  occurredAt: number;
  ipNetHash: string | null;
  uaFamily: string | null;
}

// Generous upper bound covering both the fanout window (10 min, fixed) and any reasonable
// DEDUPE_SECONDS configuration; entries older than this are pruned lazily on write.
const MAX_AGE_MS = 30 * 60 * 1000;
const MAX_ENTRIES_PER_DB = 10_000;

const store = new WeakMap<DB, CorrelationEntry[]>();

function getEntries(db: DB): CorrelationEntry[] {
  let entries = store.get(db);
  if (!entries) {
    entries = [];
    store.set(db, entries);
  }
  return entries;
}

function prune(entries: CorrelationEntry[], nowMs: number): void {
  const cutoff = nowMs - MAX_AGE_MS;
  let start = 0;
  while (start < entries.length && (entries[start] as CorrelationEntry).occurredAt < cutoff) {
    start += 1;
  }
  if (start > 0) entries.splice(0, start);
  const excess = entries.length - MAX_ENTRIES_PER_DB;
  if (excess > 0) entries.splice(0, excess);
}

/** Records a live (recipient, ipNetHash, uaFamily) sighting for later strict-mode correlation. */
export function recordCorrelation(
  db: DB,
  entry: { kind: CorrelationKind; recipientId: string; occurredAt: number; ipNetHash: string | null; uaFamily: string | null },
): void {
  const entries = getEntries(db);
  entries.push({ ...entry });
  prune(entries, entry.occurredAt);
}

/** In-memory equivalent of `recentEventsForRecipient`/`recentClickEventsForRecipient`, newest first. */
export function correlationPriorEvents(
  db: DB,
  kind: CorrelationKind,
  recipientId: string,
  nowMs: number,
  limit = 50,
): PriorEventSummary[] {
  const entries = getEntries(db);
  prune(entries, nowMs);
  const matches = entries.filter((e) => e.kind === kind && e.recipientId === recipientId);
  return matches
    .slice(-limit)
    .reverse()
    .map((e) => ({
      occurredAt: e.occurredAt,
      ipNetHash: e.ipNetHash,
      uaFamily: e.uaFamily,
      // Not tracked in-memory (only needed for classification comparisons, not for re-deriving
      // counted/classification history); a neutral, non-'human' placeholder is safe because
      // classifyOpen's only other reader of prior classification (priorHadRuleMatch) merely
      // affects confidence, never counted/classification itself.
      counted: false,
      classification: 'unknown' as const,
    }));
}

/** In-memory equivalent of `fanoutCount` for strict mode. */
export function correlationFanoutCount(
  db: DB,
  ipNetHash: string,
  sinceMs: number,
  nowMs: number,
): number {
  const entries = getEntries(db);
  prune(entries, nowMs);
  const recipients = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'open' && e.ipNetHash === ipNetHash && e.occurredAt >= sinceMs) {
      recipients.add(e.recipientId);
    }
  }
  return recipients.size;
}
