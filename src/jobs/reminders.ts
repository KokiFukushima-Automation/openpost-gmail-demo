import { hostname } from 'node:os';
import type { AppConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import { audit, getAccount, getAggregateRecipient, getMessage, getRecipient } from '../db/repo.js';
import {
  cancelForMissingTarget,
  claim,
  markFailed,
  markFired,
  markSkipped,
  noteDraftAttempt,
  recordDraft,
  selectDue,
  sweepExhaustedLeases,
  type ReminderRow,
} from '../db/reminders.js';
import { newId } from '../core/ids.js';
import type { EventBus } from '../notify/bus.js';
import type { TrackingEvent } from '../notify/types.js';
import type { Job } from './scheduler.js';
import type { DraftClient } from '../mail/draft.js';
import { createReminderDraft } from '../mail/draft.js';

export interface Logger {
  error: (...args: unknown[]) => void;
}
const noopLogger: Logger = { error: () => undefined };

export interface ReminderJobDeps {
  db: DB;
  config: AppConfig;
  bus: EventBus;
  /** `null` (or omitted) means `--draft` reminders record `draft_status='skipped'` rather than
   *  ever attempting a Gmail call - the default for every test and for an operator who never ran
   *  `openpost auth gmail --with-compose`. */
  draftClient?: DraftClient | null;
  /** Synchronously enqueues (never delivers) whatever this event's notify policy produces - the
   *  same contract as `NotifyWorker.enqueueForEvent` (§2.1's `onEvent` hook pattern), injected so
   *  the crash-safety argument (enqueue happens *before* `markFired`, §3.3) holds without this job
   *  depending on a live `NotifyWorker` instance. Omitted in tests that only care about firing. */
  notifyEnqueue?: (e: TrackingEvent) => boolean;
  clock?: () => number;
  owner?: string;
  /** TEST SEAM ONLY: invoked synchronously right after a reminder is claimed, before any further
   *  processing - the crash-safety test (case 176) calls `process.kill(process.pid, 'SIGKILL')`
   *  here to simulate a process death mid-fire. */
  onClaimed?: (r: ReminderRow) => void;
  /** TEST SEAM ONLY (Phase 3.1, M5): invoked synchronously right after `notifyEnqueue` runs for
   *  this reminder, before `markFired` - the crash-safety test needs to kill the process in
   *  exactly this window to actually exercise the "enqueue happened, fire didn't" half of §3.3's
   *  crash argument (killing at `onClaimed` alone never reaches `notifyEnqueue` at all). */
  onEnqueued?: (r: ReminderRow) => void;
  log?: Logger;
}

export interface RunRemindersResult {
  fired: number;
  skipped: number;
  failed: number;
  claimed: number;
}

function defaultOwner(): string {
  return `${hostname()}:${process.pid}:${newId().slice(0, 6)}`;
}

async function processDraft(
  deps: ReminderJobDeps,
  row: ReminderRow,
  atMs: number,
): Promise<{ status: 'created' | 'uncertain' | 'failed' | 'skipped'; linkUrl: string | null }> {
  const { db } = deps;
  const recipient = getRecipient(db, row.recipient_id ?? '');
  const message = recipient ? getMessage(db, recipient.message_id) : null;

  // Recovery path: a previous attempt on this reminder got as far as noting the attempt but never
  // recorded a draft id (crash between the two writes, §3.5's at-most-once discipline) - search
  // before ever re-creating.
  if (row.draft_attempted_at !== null && row.draft_id === null) {
    if (!deps.draftClient || !recipient || !recipient.thread_id) {
      recordDraft(db, row.id, { draftId: null, threadId: null, status: 'uncertain' });
      return { status: 'uncertain', linkUrl: null };
    }
    try {
      const found = await deps.draftClient.findDraftByHeader(recipient.thread_id, 'X-Openpost-Reminder', row.id);
      if (found.status === 'found') {
        recordDraft(db, row.id, { draftId: found.draftId, threadId: recipient.thread_id, status: 'created' });
        return { status: 'created', linkUrl: null };
      }
      // Phase 3.1 (M3): `uncertain` (the search was bounded/paginated and gave up before seeing
      // every draft, or a page call itself failed) must NEVER fall through to creating a fresh
      // draft - that is exactly the "recovery creates a second draft" bug this path exists to
      // avoid. Only a real `not_found` (every reachable draft was checked) may fall through.
      if (found.status === 'uncertain') {
        recordDraft(db, row.id, { draftId: null, threadId: null, status: 'uncertain' });
        return { status: 'uncertain', linkUrl: null };
      }
    } catch {
      recordDraft(db, row.id, { draftId: null, threadId: null, status: 'uncertain' });
      return { status: 'uncertain', linkUrl: null };
    }
    // found.status === 'not_found' - fall through to a fresh (one-time) creation attempt below.
  }

  if (!deps.draftClient) {
    recordDraft(db, row.id, { draftId: null, threadId: null, status: 'skipped' });
    return { status: 'skipped', linkUrl: null };
  }
  if (!recipient || !message || !recipient.thread_id || !recipient.rfc822_msg_id) {
    recordDraft(db, row.id, { draftId: null, threadId: null, status: 'failed' });
    return { status: 'failed', linkUrl: null };
  }

  noteDraftAttempt(db, row.id, atMs);
  try {
    const account = getAccount(db, message.account_id);
    const result = await createReminderDraft(deps.draftClient, {
      from: { email: account?.email ?? '', name: account?.display_name ?? undefined },
      to: [{ email: recipient.email, name: recipient.name ?? undefined }],
      originalSubject: message.subject,
      subject: row.draft_subject ?? undefined,
      html: row.draft_body_html ?? '',
      threadId: recipient.thread_id,
      rfc822MessageId: recipient.rfc822_msg_id,
      reminderId: row.id,
    });
    recordDraft(db, row.id, { draftId: result.draftId, threadId: result.threadId, status: 'created' });
    return { status: 'created', linkUrl: null };
  } catch (err) {
    recordDraft(db, row.id, { draftId: null, threadId: null, status: 'failed' });
    deps.log?.error(err, `reminders: draft creation failed for ${row.id}`);
    return { status: 'failed', linkUrl: null };
  }
}

async function processClaimed(deps: ReminderJobDeps, row: ReminderRow, atMs: number, owner: string, result: RunRemindersResult): Promise<void> {
  const { db } = deps;

  if (row.recipient_id === null) {
    cancelForMissingTarget(db, row.id, atMs);
    return;
  }
  const recipient = getRecipient(db, row.recipient_id);
  const message = recipient ? getMessage(db, recipient.message_id) : null;
  if (!recipient || !message) {
    cancelForMissingTarget(db, row.id, atMs);
    return;
  }

  // docs/07_recipient_semantics.md §4.4: in single mode a `no_open` condition cannot be evaluated
  // against this addressee's own counters - they never accrue individual opens, only the aggregate
  // row does - so it degrades to the message level: has *the message* been opened by anyone at all.
  const messageLevelNoOpen = row.condition === 'no_open' && message.recipient_mode === 'single';
  const effectiveOpenCount = messageLevelNoOpen
    ? (getAggregateRecipient(db, message.id)?.open_count ?? recipient.open_count)
    : recipient.open_count;

  let skipReason: string | null = null;
  if (row.condition === 'no_reply' && recipient.replied_at !== null) skipReason = 'replied';
  else if (row.condition === 'no_open' && effectiveOpenCount > 0) skipReason = 'opened';

  if (skipReason !== null) {
    markSkipped(db, row.id, owner, atMs, skipReason);
    audit(db, {
      actor: 'server',
      action: 'reminder.skip',
      subjectType: 'reminder',
      subjectId: row.id,
      detail: {
        reminderId: row.id,
        recipientId: recipient.id,
        condition: row.condition,
        reason: skipReason,
        ...(messageLevelNoOpen ? { messageLevel: true } : {}),
      },
    });
    result.skipped += 1;
    return;
  }

  let draftStatus: string | null = null;
  let linkUrl: string | null = null;
  if (row.draft === 1) {
    try {
      const d = await processDraft(deps, row, atMs);
      draftStatus = d.status;
      linkUrl = d.linkUrl;
    } catch (err) {
      draftStatus = 'failed';
      deps.log?.error(err, `reminders: draft handling threw for ${row.id}`);
    }
  }

  const reasons = ['reminder', row.condition, ...(draftStatus ? [`draft:${draftStatus}`] : [])];
  const event: TrackingEvent = {
    kind: 'reminder',
    eventId: row.id,
    occurredAt: atMs,
    messageId: message.id,
    subject: message.subject,
    recipientId: recipient.id,
    recipientEmail: recipient.email,
    classification: 'reminder',
    reasons,
    counted: false,
    backfilled: false,
    prevState: recipient.state,
    newState: recipient.state,
    counters: {
      openCount: recipient.open_count,
      machineOpenCount: recipient.machine_open_count,
      clickCount: recipient.click_count,
      firstOpenAt: recipient.first_open_at,
      lastOpenAt: recipient.last_open_at,
    },
    uaFamily: null,
    deviceType: null,
    linkUrl,
    muted: message.notify_muted === 1 || recipient.notify_muted === 1,
    sentAt: recipient.sent_at,
    country: null,
    isAggregate: false,
    recipientCount: 0,
    campaignId: message.campaign_id,
  };

  try {
    // Enqueue happens BEFORE markFired (§3.3's crash-argument table): a crash between the two
    // leaves a `claimed` reminder plus an already-inserted `notifications` row, and the dedupe key
    // (`${channel}:reminder:${reminderId}`) makes a re-claim's second enqueue attempt a no-op.
    deps.notifyEnqueue?.(event);
    deps.onEnqueued?.(row);
    // Phase 3.1 (M8): `markFired`'s WHERE clause requires this owner to still hold the row in
    // `claimed` - it returns false when a concurrent `cancelPendingForRecipient` (e.g. a reply
    // detected between the claim above and this point) already moved it to `cancelled`, or another
    // process's lease-expiry recovery beat this one to it. The notification was already enqueued
    // (correct - the event did happen), but this call must not then audit/publish "fired" for a
    // reminder whose actual row is no longer `claimed` at all.
    const fired = markFired(db, row.id, owner, atMs);
    if (!fired) return;
    audit(db, {
      actor: 'server',
      action: 'reminder.fire',
      subjectType: 'reminder',
      subjectId: row.id,
      detail: { reminderId: row.id, condition: row.condition, recipientId: recipient.id, draftStatus },
    });
    deps.bus.publish(event);
    result.fired += 1;
  } catch (err) {
    const message2 = err instanceof Error ? err.message : String(err);
    markFailed(db, row.id, owner, atMs, message2);
    result.failed += 1;
  }
}

/** One firing pass (§3.4): sweep exhausted leases, select due reminders, claim each with the
 *  single conditional UPDATE, then evaluate/skip/draft/fire. Never throws for a single reminder's
 *  failure - that reminder is marked `failed` and the pass continues. */
export async function runRemindersOnce(
  deps: ReminderJobDeps,
  nowMs: number,
  limit: number,
): Promise<RunRemindersResult> {
  const result: RunRemindersResult = { fired: 0, skipped: 0, failed: 0, claimed: 0 };
  const owner = deps.owner ?? defaultOwner();

  sweepExhaustedLeases(deps.db, nowMs, deps.config.reminderMaxAttempts);
  const due = selectDue(deps.db, nowMs, limit);

  for (const candidate of due) {
    const claimed = claim(deps.db, candidate.id, owner, nowMs, {
      leaseMs: deps.config.reminderLeaseMs,
      maxAttempts: deps.config.reminderMaxAttempts,
    });
    if (!claimed) continue;
    result.claimed += 1;
    deps.onClaimed?.(claimed);
    try {
      await processClaimed(deps, claimed, nowMs, owner, result);
    } catch (err) {
      deps.log?.error(err, `reminders: processing ${claimed.id} threw`);
      markFailed(deps.db, claimed.id, owner, nowMs, err instanceof Error ? err.message : String(err));
      result.failed += 1;
    }
  }

  return result;
}

/** Registered by `openpost serve`/`openpost dashboard` as a `Scheduler` job (name `'reminders'`)
 *  when `REMINDERS_ENABLED=true`. */
export function createRemindersJob(deps: ReminderJobDeps): Job {
  const clock = deps.clock ?? (() => Date.now());
  const log = deps.log ?? noopLogger;
  return {
    name: 'reminders',
    intervalMs: deps.config.reminderTickSeconds * 1000,
    async run(nowMs: number) {
      const result = await runRemindersOnce({ ...deps, clock, log }, nowMs ?? clock(), 50);
      return { detail: result };
    },
  };
}
