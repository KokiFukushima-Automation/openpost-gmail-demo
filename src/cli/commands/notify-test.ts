import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { newId } from '../../core/ids.js';
import { migrate, openDb } from '../../db/index.js';
import { buildNotifiers } from '../../notify/channels/index.js';
import { resolveTransport } from '../../mail/transport.js';
import { buildPayload } from '../../notify/payload.js';
import type { ChannelName, NotifyTrigger, TrackingEvent } from '../../notify/types.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface NotifyTestOpts {
  channel?: string;
  trigger?: string;
}

// Phase 5 (§4, §5): webpush/email join the four Phase 2 channels.
const CHANNELS: ChannelName[] = ['slack', 'discord', 'webhook', 'ntfy', 'webpush', 'email'];
const TRIGGERS: NotifyTrigger[] = ['first_open', 'read_confirmed', 'click', 'prefetched'];

function buildFakeEvent(trigger: NotifyTrigger): TrackingEvent {
  const now = Date.now();
  const kind = trigger === 'click' ? 'click' : 'open';
  return {
    kind,
    eventId: newId(),
    occurredAt: now,
    messageId: newId(),
    subject: 'Test notification from `openpost notify test`',
    recipientId: newId(),
    recipientEmail: 'test@example.com',
    classification: 'human',
    reasons: ['R9'],
    counted: true,
    backfilled: false,
    prevState: 'not_opened',
    newState: trigger === 'read_confirmed' ? 'read_confirmed' : 'opened',
    counters: { openCount: 1, machineOpenCount: 0, clickCount: kind === 'click' ? 1 : 0, firstOpenAt: now - 60_000, lastOpenAt: now },
    uaFamily: 'Chrome',
    deviceType: 'desktop',
    linkUrl: kind === 'click' ? 'https://example.com/test' : null,
    muted: false,
    sentAt: now - 120_000,
    country: null,
    isAggregate: false,
    recipientCount: 0,
    campaignId: null,
  };
}

export function registerNotifyCommand(program: Command): void {
  const notify = program.command('notify').description('Notification test helper');

  notify
    .command('test')
    .description('Build a synthetic payload and deliver it right now')
    .option('--channel <slack|discord|webhook|ntfy>', 'channel to test (default: every configured channel)')
    .option('--trigger <trigger>', 'first_open | read_confirmed | click | prefetched', 'first_open')
    .action(async (opts: NotifyTestOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        if (opts.channel !== undefined && !CHANNELS.includes(opts.channel as ChannelName)) {
          throw new Error(`--channel must be one of ${CHANNELS.join(', ')}`);
        }
        const trigger = (opts.trigger ?? 'first_open') as NotifyTrigger;
        if (!TRIGGERS.includes(trigger)) {
          throw new Error(`--trigger must be one of ${TRIGGERS.join(', ')}`);
        }

        const notifiers = buildNotifiers(config);
        const targets: ChannelName[] = opts.channel ? [opts.channel as ChannelName] : [...notifiers.keys()];
        if (targets.length === 0) {
          throw new Error('no channel configured - set NOTIFY_CHANNELS (and its URL(s)) or pass --channel explicitly');
        }

        // Phase 5: webpush needs push_subscriptions (fan-out + self-healing); email needs a real
        // transport. Both only ever opened when actually testing one of those two channels.
        const needsDb = targets.includes('webpush');
        const db = needsDb ? openDb(g.db ?? config.dbPath) : null;
        if (db) migrate(db);
        const transport = targets.includes('email') ? resolveTransport(config) : undefined;

        const event = buildFakeEvent(trigger);
        const results: Array<{ channel: ChannelName; ok: boolean; status?: number; error?: string }> = [];
        for (const channel of targets) {
          const notifier = notifiers.get(channel);
          if (!notifier) {
            results.push({ channel, ok: false, error: `channel "${channel}" is not configured` });
            continue;
          }
          const payload = buildPayload(event, trigger, newId(), config);
          const delivery = await notifier.deliver(payload, {
            fetch: fetch as unknown as Parameters<typeof notifier.deliver>[1]['fetch'],
            timeoutMs: config.notifyTimeoutMs,
            clock: () => Date.now(),
            config,
            ...(db ? { db } : {}),
            ...(transport ? { transport } : {}),
          });
          results.push({
            channel,
            ok: delivery.ok,
            ...(delivery.status !== undefined ? { status: delivery.status } : {}),
            ...(delivery.error !== undefined ? { error: delivery.error } : {}),
          });
        }

        db?.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify(results)}\n`);
        } else {
          for (const r of results) {
            process.stdout.write(`${r.channel}: ${r.ok ? 'OK' : 'FAILED'}${r.status ? ` (HTTP ${r.status})` : ''}${r.error ? ` - ${r.error}` : ''}\n`);
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
