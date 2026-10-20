/**
 * docs/09_phase5_spec.md §5.3: one digest per local day, dedupe-key protected against a restart, a
 * clock jump, or two processes racing (the notification queue's `UNIQUE(dedupe_key)` does the actual
 * work, exactly as the campaign digest job already relies on it). `DIGEST_DAILY_AT` unset disables
 * the job entirely (never registered by `openpost serve`).
 */
import { newId } from '../core/ids.js';
import { audit, getSetting, setSetting } from '../db/repo.js';
import { statsReport } from '../db/stats.js';
import type { AppConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import { enqueue } from '../notify/queue.js';
import type { NotificationPayload } from '../notify/types.js';
import type { Job } from './scheduler.js';

const SETTING_KEY = 'daily_digest_window_from';

function localParts(nowMs: number, timeZone: string): { dateStr: string; hhmm: string } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(nowMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '00';
  return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, hhmm: `${get('hour')}:${get('minute')}` };
}

interface TopMessageRow {
  id: string;
  subject: string | null;
  opens: number;
}

function topMessages(db: DB, windowFrom: number, windowTo: number, limit: number): TopMessageRow[] {
  return db
    .prepare(
      `SELECT m.id AS id, m.subject AS subject, COALESCE(SUM(r.open_count), 0) AS opens
         FROM messages m JOIN recipients r ON r.message_id = m.id
        WHERE COALESCE(m.sent_at, m.created_at) >= @from AND COALESCE(m.sent_at, m.created_at) < @to
        GROUP BY m.id
        HAVING opens > 0
        ORDER BY opens DESC, m.id ASC
        LIMIT @limit`,
    )
    .all({ from: windowFrom, to: windowTo, limit }) as TopMessageRow[];
}

function buildDigestPayload(config: AppConfig, windowFrom: number, windowTo: number, db: DB): NotificationPayload {
  const stats = statsReport(db, { sinceMs: windowFrom, untilMs: windowTo, timeZone: config.digestTimezone });
  const top = topMessages(db, windowFrom, windowTo, 5).map((m) => ({
    id: m.id,
    subject: config.notifyIncludeSubject ? m.subject : null,
    opens: m.opens,
  }));
  return {
    version: 1,
    id: newId(),
    trigger: 'daily_digest',
    occurredAt: windowTo,
    message: { id: '', subject: null, sentAt: null },
    recipient: { id: '', email: null, state: 'not_opened', openCount: 0, clickCount: 0, attribution: 'message', recipientCount: null },
    event: { id: '', kind: 'open', classification: 'daily_digest', reasons: [], counted: false, uaFamily: null, deviceType: null, country: null, linkUrl: null },
    digest: {
      windowFrom,
      windowTo,
      sent: stats.totals.messages,
      opened: stats.totals.opened,
      clicked: stats.totals.clicked,
      replied: stats.totals.replied,
      openRate: stats.rates.openRate,
      topMessages: top,
    },
  };
}

export interface DailyDigestDeps {
  db: DB;
  config: AppConfig;
  clock?: () => number;
}

/** Runs one digest check: fires at most once per local calendar day, at or after
 *  `DIGEST_DAILY_AT` (`HH:MM`) in `DIGEST_TIMEZONE`. A no-op (not even a window computation) when
 *  `DIGEST_DAILY_AT` is unset. */
export async function runDailyDigestOnce(deps: DailyDigestDeps, nowMs?: number): Promise<{ sent: boolean }> {
  const { db, config } = deps;
  const clock = deps.clock ?? (() => Date.now());
  const now = nowMs ?? clock();
  if (!config.digestDailyAt) return { sent: false };

  const { dateStr, hhmm } = localParts(now, config.digestTimezone);
  if (hhmm < config.digestDailyAt) return { sent: false };

  const lastSentDate = getSetting(db, `${SETTING_KEY}_date`);
  if (lastSentDate === dateStr) return { sent: false };

  const windowFromRaw = getSetting(db, SETTING_KEY);
  const windowFrom = windowFromRaw !== null ? Number(windowFromRaw) : now - 24 * 3600_000;
  const windowTo = now;

  let anyEnqueued = false;
  for (const channel of config.notifyChannels) {
    const payload = buildDigestPayload(config, windowFrom, windowTo, db);
    const dedupeKey = `${channel}:daily_digest:${dateStr}`;
    const id = enqueue(db, {
      trigger: 'daily_digest',
      channel,
      payload,
      messageId: null,
      recipientId: null,
      eventType: 'daily_digest',
      eventId: dateStr,
      dedupeKey,
      atMs: now,
    });
    if (id !== null) {
      anyEnqueued = true;
      audit(db, { actor: 'server', action: 'notify.enqueue', subjectType: 'daily_digest', subjectId: dateStr, detail: { channel, trigger: 'daily_digest', dedupeKey } });
    }
  }

  setSetting(db, `${SETTING_KEY}_date`, dateStr);
  setSetting(db, SETTING_KEY, String(windowTo));
  return { sent: anyEnqueued };
}

export function createDailyDigestJob(deps: DailyDigestDeps, intervalMs = 60_000): Job {
  return {
    name: 'daily-digest',
    intervalMs,
    async run(nowMs: number): Promise<{ detail?: unknown }> {
      const result = await runDailyDigestOnce(deps, nowMs);
      return { detail: result };
    },
  };
}
