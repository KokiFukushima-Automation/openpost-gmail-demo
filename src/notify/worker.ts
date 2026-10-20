import type { AppConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import { audit } from '../db/repo.js';
import { newId } from '../core/ids.js';
import type { EventBus } from './bus.js';
import { dedupeKey, decideTriggers } from './policy.js';
import { buildPayload } from './payload.js';
import {
  backoffMs,
  claimDue,
  enqueue,
  markFailed,
  markRetry,
  markSent,
  type NotificationRow,
} from './queue.js';
import { buildNotifiers, defaultEmailTransportFactory, redactSecretUrls } from './channels/index.js';
import type { ChannelName, FetchLike, NotificationPayload, Notifier, TrackingEvent } from './types.js';
import type { Transport } from '../mail/transport.js';

export interface Logger {
  error: (...args: unknown[]) => void;
}

const noopLogger: Logger = { error: () => undefined };

export interface NotifyWorkerDeps {
  db: DB;
  config: AppConfig;
  bus: EventBus;
  notifiers?: Map<ChannelName, Notifier>;
  fetch?: FetchLike;
  clock?: () => number;
  rand?: () => number;
  log?: Logger;
  /** Phase 5 (§5.2): resolves the mail transport the `email` channel sends through. Defaults to
   *  `defaultEmailTransportFactory` (a dynamic `import('../mail/transport.js')` under the hood, so
   *  the notify path never pulls nodemailer/googleapis at startup for a dashboard-only process).
   *  Tests inject a fake transport factory directly. */
  transportFactory?: (config: AppConfig) => Transport | Promise<Transport>;
}

export interface TickResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

const DEFAULT_CLAIM_LIMIT = 50;

export class NotifyWorker {
  private readonly db: DB;
  private readonly config: AppConfig;
  private readonly bus: EventBus;
  private readonly notifiers: Map<ChannelName, Notifier>;
  private readonly fetchImpl: FetchLike;
  private readonly clock: () => number;
  private readonly rand: () => number;
  private readonly log: Logger;
  private readonly transportFactory: (config: AppConfig) => Transport | Promise<Transport>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<TickResult> | null = null;

  constructor(deps: NotifyWorkerDeps) {
    this.db = deps.db;
    this.config = deps.config;
    this.bus = deps.bus;
    this.notifiers = deps.notifiers ?? buildNotifiers(deps.config);
    this.fetchImpl = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
    this.clock = deps.clock ?? (() => Date.now());
    this.rand = deps.rand ?? Math.random;
    this.log = deps.log ?? noopLogger;
    this.transportFactory = deps.transportFactory ?? defaultEmailTransportFactory;
  }

  attach(): () => void {
    return this.bus.subscribe((e) => {
      this.onTrackingEvent(e);
    });
  }

  onTrackingEvent(e: TrackingEvent): void {
    const enqueuedAny = this.enqueueForEvent(e);
    // DoD 3: the first delivery must not wait for the tick interval.
    if (enqueuedAny) {
      this.kickTick();
    }
  }

  /**
   * Enqueues (never delivers) whatever this event's policy triggers produce, for every configured
   * channel, and returns whether anything was newly enqueued. `INSERT OR IGNORE` against the
   * dedupe-key unique index (queue.ts) makes a repeated call for the same event a safe no-op, so
   * this is deliberately callable from more than one place:
   *
   * - `onTrackingEvent` (above), via the bus subscription `attach()` sets up - the historical path.
   * - `src/server/services/record.ts`, synchronously, from *inside* the same DB transaction that
   *   inserts the open/click event row (finding #6). Enqueuing there closes the durability gap the
   *   bus-based path alone has: publishing to the bus only ever happens after that transaction has
   *   already committed, so a crash in the gap between "event committed" and "bus.publish ran"
   *   would otherwise lose the notification for an event that did, in fact, happen.
   */
  enqueueForEvent(e: TrackingEvent): boolean {
    if (!this.config.notifyEnabled) return false;
    const atMs = this.clock();
    const triggers = decideTriggers(e, {
      on: this.config.notifyOn,
      channels: this.config.notifyChannels,
      campaignMode: this.config.notifyCampaignMode,
    });
    if (triggers.length === 0) return false;

    let enqueuedAny = false;
    for (const trigger of triggers) {
      for (const channel of this.config.notifyChannels) {
        const notifier = this.notifiers.get(channel);
        if (!notifier || !notifier.isConfigured(this.config)) continue;
        const notificationId = newId();
        const payload = buildPayload(e, trigger, notificationId, this.config);
        const dk = dedupeKey(trigger, e, channel);
        const id = enqueue(this.db, {
          trigger,
          channel,
          payload,
          messageId: e.messageId,
          recipientId: e.recipientId,
          eventType: e.kind,
          eventId: e.eventId,
          dedupeKey: dk,
          atMs,
        });
        if (id !== null) {
          enqueuedAny = true;
          try {
            audit(this.db, {
              actor: 'server',
              action: 'notify.enqueue',
              subjectType: 'recipient',
              subjectId: e.recipientId,
              detail: { channel, trigger, dedupeKey: dk },
            });
          } catch (err) {
            this.log.error(err, 'notify: failed to audit notify.enqueue');
          }
        }
      }
    }

    return enqueuedAny;
  }

  /** Fires a tick without awaiting it, but never as an unhandled rejection (finding #1): a
   *  `tickOnce()` failure (e.g. SQLITE_BUSY partway through a batch) must be logged, not left to
   *  crash the whole `serve` process out from under a pixel/click response that has already been
   *  sent. */
  private kickTick(): void {
    this.tickOnce().catch((err) => {
      this.log.error(err, 'notify: tick failed');
    });
  }

  start(): void {
    if (this.interval !== null) return;
    this.interval = setInterval(() => {
      this.kickTick();
    }, this.config.notifyTickSeconds * 1000);
    this.interval.unref();
  }

  async stop(): Promise<void> {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => undefined);
    }
  }

  tickOnce(): Promise<TickResult> {
    const run = this.runTick();
    this.inFlight = run;
    void run.finally(() => {
      if (this.inFlight === run) this.inFlight = null;
    });
    return run;
  }

  private async runTick(): Promise<TickResult> {
    const result: TickResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
    if (!this.config.notifyEnabled) return result;

    const now = this.clock();
    const rows = claimDue(this.db, now, DEFAULT_CLAIM_LIMIT);

    for (const row of rows) {
      try {
        await this.deliverRow(row, result);
      } catch (err) {
        // finding #1: an unexpected throw from one row (a notifier bug, a DB hiccup between the
        // claim and the write-back, ...) must not abort the rest of the batch, and must never
        // become an unhandled rejection further up (tickOnce/kickTick).
        this.log.error(err, `notify: delivering row ${row.id} threw`);
        result.failed += 1;
      }
    }
    return result;
  }

  private async deliverRow(row: NotificationRow, result: TickResult): Promise<void> {
    const channel = row.channel;
    const notifier = this.notifiers.get(channel);
    if (!notifier) {
      // The channel was removed from configuration after this row was enqueued: it will never be
      // deliverable, so dead-letter it immediately without counting it as a delivery failure.
      markFailed(this.db, row.id, `channel "${channel}" is no longer configured`, this.clock());
      this.safeAudit('notify.deadletter', row, { reason: 'channel_removed' });
      result.skipped += 1;
      return;
    }

    let payload: NotificationPayload;
    try {
      payload = JSON.parse(row.payload_json) as NotificationPayload;
    } catch {
      markFailed(this.db, row.id, 'corrupt payload_json', this.clock());
      this.safeAudit('notify.deadletter', row, { reason: 'corrupt_payload' });
      result.skipped += 1;
      return;
    }

    const started = this.clock();
    const notifierDeps: Parameters<Notifier['deliver']>[1] = {
      fetch: this.fetchImpl,
      timeoutMs: this.config.notifyTimeoutMs,
      clock: this.clock,
      config: this.config,
      db: this.db,
    };
    if (channel === 'email') {
      notifierDeps.transport = await this.transportFactory(this.config);
    }
    const delivery = await notifier.deliver(payload, notifierDeps);
    const elapsedMs = this.clock() - started;
    const atMs = this.clock();

    if (delivery.ok) {
      markSent(this.db, row.id, atMs);
      this.safeAudit('notify.deliver', row, { status: 'sent', elapsedMs });
      result.sent += 1;
      return;
    }

    // Finding #9: scrub every configured channel URL/token out of the error text before it is ever
    // persisted to `notifications.last_error` (printed as-is by `notifications list`).
    const error = redactSecretUrls(delivery.error ?? 'delivery failed', this.config);
    if (!delivery.retryable) {
      markFailed(this.db, row.id, error, atMs);
      this.safeAudit('notify.deliver', row, { status: 'failed', elapsedMs });
      this.safeAudit('notify.deadletter', row, { reason: 'non_retryable' });
      result.failed += 1;
      return;
    }

    if (row.attempts >= this.config.notifyMaxAttempts) {
      markFailed(this.db, row.id, error, atMs);
      this.safeAudit('notify.deliver', row, { status: 'failed', elapsedMs });
      this.safeAudit('notify.deadletter', row, { reason: 'max_attempts' });
      result.failed += 1;
      return;
    }

    const delayMs = delivery.retryAfterMs ?? backoffMs(row.attempts, this.config.notifyBackoffBaseMs, this.rand);
    markRetry(this.db, row.id, error, atMs + delayMs);
    this.safeAudit('notify.fail', row, { elapsedMs, nextAttemptInMs: delayMs });
    result.retried += 1;
  }

  private safeAudit(action: string, row: NotificationRow, extra: Record<string, unknown>): void {
    try {
      audit(this.db, {
        actor: 'server',
        action,
        subjectType: 'notification',
        subjectId: row.id,
        detail: { channel: row.channel, trigger: row.trigger, ...extra },
      });
    } catch (err) {
      this.log.error(err, `notify: failed to audit ${action}`);
    }
  }
}
