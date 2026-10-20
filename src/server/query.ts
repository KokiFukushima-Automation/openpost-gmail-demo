import { RECIPIENT_STATES } from '../types.js';
import type { RecipientState } from '../types.js';
import type { AuditFilter, MessageFilter, MessageSort } from '../db/repo.js';
import { parseDuration } from '../core/time.js';

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryValidationError';
  }
}

const MESSAGE_STATUSES = new Set(['draft', 'sent', 'dryrun', 'failed', 'abandoned']);
const HAS_VALUES = new Set(['opens', 'clicks', 'replies', 'none']);
const SORT_VALUES: MessageSort[] = ['sent_desc', 'sent_asc', 'opens_desc'];
const LIMIT_VALUES = [25, 50, 100];

function parseEpochOrDuration(v: string, nowMs: number, name: string): number {
  if (/^\d+$/.test(v)) return Number(v);
  const dur = parseDuration(v);
  if (dur !== null) return nowMs - dur;
  throw new QueryValidationError(`invalid ${name}: "${v}"`);
}

export interface ParsedMessageQuery {
  filter: MessageFilter;
  limit: number;
  offset: number;
  sort: MessageSort;
}

/** Parses and validates `/dashboard/messages` and `/dashboard/export.*`'s shared query string
 *  (§2.6/§2.8) - throws `QueryValidationError` (mapped to 400) on anything invalid. `q` is bounded
 *  to 100 chars (the LIKE-escaping itself lives in `db/repo.ts`). */
export function parseMessageFilter(
  query: Record<string, string | undefined>,
  opts: { nowMs: number; defaultLimit: number },
): ParsedMessageQuery {
  const filter: MessageFilter = {};

  if (query.q !== undefined && query.q !== '') {
    if (query.q.length > 100) throw new QueryValidationError('q must be at most 100 characters');
    filter.q = query.q;
  }
  if (query.status !== undefined && query.status !== '') {
    if (!MESSAGE_STATUSES.has(query.status)) throw new QueryValidationError(`invalid status: "${query.status}"`);
    filter.status = query.status;
  }
  if (query.state !== undefined && query.state !== '') {
    if (!RECIPIENT_STATES.includes(query.state as RecipientState)) {
      throw new QueryValidationError(`invalid state: "${query.state}"`);
    }
    filter.state = query.state as RecipientState;
  }
  if (query.has !== undefined && query.has !== '') {
    if (!HAS_VALUES.has(query.has)) throw new QueryValidationError(`invalid has: "${query.has}"`);
    filter.has = query.has as 'opens' | 'clicks' | 'replies' | 'none';
  }
  if (query.since !== undefined && query.since !== '') {
    filter.sinceMs = parseEpochOrDuration(query.since, opts.nowMs, 'since');
  }
  if (query.until !== undefined && query.until !== '') {
    filter.untilMs = parseEpochOrDuration(query.until, opts.nowMs, 'until');
  }

  let limit = opts.defaultLimit;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!LIMIT_VALUES.includes(n)) throw new QueryValidationError('limit must be 25, 50 or 100');
    limit = n;
  }
  let offset = 0;
  if (query.offset !== undefined && query.offset !== '') {
    const n = Number(query.offset);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new QueryValidationError('invalid offset');
    offset = n;
  }
  let sort: MessageSort = 'sent_desc';
  if (query.sort !== undefined && query.sort !== '') {
    if (!SORT_VALUES.includes(query.sort as MessageSort)) throw new QueryValidationError(`invalid sort: "${query.sort}"`);
    sort = query.sort as MessageSort;
  }

  return { filter, limit, offset, sort };
}

/** Turns a parsed filter back into a query string (export links, pager links) - identical param
 *  names as `parseMessageFilter` expects, so the two are always in sync. */
export function filterToQueryString(filter: MessageFilter, extra: Record<string, string | number | undefined> = {}): Record<string, string | number | undefined> {
  return {
    q: filter.q,
    status: filter.status,
    state: filter.state,
    has: filter.has,
    since: filter.sinceMs,
    until: filter.untilMs,
    ...extra,
  };
}

export interface ParsedStatsWindow {
  sinceMs: number;
  untilMs: number;
}

/**
 * Phase 3.1 (M6): resolves `/dashboard/stats` and `/api/stats`'s `?since=`/`?until=` into a bounded
 * window - defaulting to the last `defaultWindowDays` days (never all-time) and never spanning more
 * than `maxWindowDays`, regardless of what an explicit `since`/`until` pair asked for. This is what
 * keeps a single stats request from aggregating an unbounded number of recipient rows.
 */
export function parseStatsWindow(
  query: Record<string, string | undefined>,
  opts: { nowMs: number; defaultWindowDays: number; maxWindowDays: number },
): ParsedStatsWindow {
  let untilMs = opts.nowMs;
  if (query.until !== undefined && query.until !== '') {
    untilMs = parseEpochOrDuration(query.until, opts.nowMs, 'until');
  }
  const defaultSpanMs = opts.defaultWindowDays * 86_400_000;
  const maxSpanMs = opts.maxWindowDays * 86_400_000;

  let sinceMs = untilMs - defaultSpanMs;
  if (query.since !== undefined && query.since !== '') {
    sinceMs = parseEpochOrDuration(query.since, opts.nowMs, 'since');
  }
  if (sinceMs > untilMs) sinceMs = untilMs;
  if (untilMs - sinceMs > maxSpanMs) sinceMs = untilMs - maxSpanMs;
  return { sinceMs, untilMs };
}

export interface ParsedAuditQuery {
  filter: AuditFilter;
  limit: number;
  offset: number;
}

export function parseAuditFilter(
  query: Record<string, string | undefined>,
  opts: { nowMs: number; defaultLimit: number },
): ParsedAuditQuery {
  const filter: AuditFilter = {};
  // Phase 3.1 (L5): mirror parseMessageFilter's own bounds on free-text query params - an
  // unbounded `action`/`subject` is stored nowhere, but it is echoed straight into a SQL parameter
  // and a rendered `<option>`/filter-summary, so an absurdly long value is still worth rejecting
  // up front rather than silently truncating deep inside a query.
  if (query.action !== undefined && query.action !== '') {
    if (query.action.length > 100) throw new QueryValidationError('action must be at most 100 characters');
    filter.action = query.action;
  }
  if (query.subject !== undefined && query.subject !== '') {
    if (query.subject.length > 100) throw new QueryValidationError('subject must be at most 100 characters');
    filter.subject = query.subject;
  }
  if (query.since !== undefined && query.since !== '') {
    filter.sinceMs = parseEpochOrDuration(query.since, opts.nowMs, 'since');
  }
  let limit = opts.defaultLimit;
  if (query.limit !== undefined && query.limit !== '') {
    const n = Number(query.limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) throw new QueryValidationError('invalid limit');
    limit = n;
  }
  let offset = 0;
  if (query.offset !== undefined && query.offset !== '') {
    const n = Number(query.offset);
    if (!Number.isInteger(n) || n < 0 || n > 1_000_000) throw new QueryValidationError('invalid offset');
    offset = n;
  }
  return { filter, limit, offset };
}
