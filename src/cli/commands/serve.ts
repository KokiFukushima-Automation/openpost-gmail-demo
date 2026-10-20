import type { Command } from 'commander';
import { assertSafeToBind, assertSafeToServeDashboard, loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { EMPTY_RANGE_INDEX, loadRangeIndex } from '../../core/ranges.js';
import { createMmdbLookup } from '../../core/geo.js';
import { EventBus } from '../../notify/bus.js';
import { NotifyWorker } from '../../notify/worker.js';
import { Scheduler } from '../../jobs/scheduler.js';
import { createPruneJob } from '../../jobs/prune.js';
import { createRangesReloadJob } from '../../jobs/ranges.js';
import { createRemindersJob } from '../../jobs/reminders.js';
import { createReplyPollJob } from '../../jobs/replies.js';
import { createCampaignsJob, recoverCampaign } from '../../jobs/campaigns.js';
import { createCampaignDigestJob } from '../../jobs/campaign-digest.js';
import { createDailyDigestJob } from '../../jobs/daily-digest.js';
import { createAddonReaperJob } from '../../jobs/addon.js';
import { createBackupJob } from '../../jobs/backup.js';
import { purgeNotifications } from '../../notify/queue.js';
import { buildReplyReader, buildDraftClient } from '../../mail/reply-setup.js';
import { buildServer } from '../../server/app.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

export interface ShutdownDeps {
  app: { close: () => Promise<unknown> };
  scheduler: { stop: () => Promise<unknown> };
  notifyWorker: { stop: () => Promise<unknown> };
  detachNotifyWorker: () => void;
  db: { close: () => void };
  log?: { error: (...args: unknown[]) => void };
  exit?: (code: number) => void;
  /** Forces an exit if the graceful chain below hasn't finished by this point - a long-lived SSE
   *  connection (§2.8) never closes on its own, so `app.close()` alone could otherwise wait forever
   *  for a socket that was never going to close and the process would never actually exit for
   *  whatever sent SIGTERM/SIGINT (finding #22). Defaults to 10s. */
  drainTimeoutMs?: number;
}

/**
 * Finding #22: the original shutdown chain had exactly one `.catch()`, on `app.close()` alone - a
 * rejection from `scheduler.stop()`, `notifyWorker.stop()` or the final `db.close()` had nothing
 * downstream to catch it and became an unhandled rejection instead of ever reaching `process.exit`.
 * Every step here is independently caught and logged (so one failing step never stops the rest from
 * running), and a watchdog timer guarantees `exit()` is eventually called even if a step hangs
 * altogether. Exported (with everything it touches injectable) so this can be driven end to end in
 * tests without a real Fastify server, scheduler or process exit.
 */
export function createShutdown(deps: ShutdownDeps): () => void {
  const log = deps.log ?? { error: (...a: unknown[]) => console.error(...a) };
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const drainTimeoutMs = deps.drainTimeoutMs ?? 10_000;
  let shuttingDown = false;

  return () => {
    if (shuttingDown) return;
    shuttingDown = true;

    let finished = false;
    const watchdog = setTimeout(() => {
      if (finished) return;
      finished = true;
      log.error(new Error(`serve: shutdown did not complete within ${drainTimeoutMs}ms - forcing exit`));
      exit(1);
    }, drainTimeoutMs);
    watchdog.unref();

    const step = async (name: string, fn: () => Promise<unknown> | void): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        log.error(err, `serve: shutdown step "${name}" failed`);
      }
    };

    void (async () => {
      await step('app.close', () => deps.app.close());
      await step('scheduler.stop', () => deps.scheduler.stop());
      await step('notifyWorker.stop', () => deps.notifyWorker.stop());
      await step('detachNotifyWorker', () => deps.detachNotifyWorker());
      await step('db.close', () => deps.db.close());
      if (finished) return;
      finished = true;
      clearTimeout(watchdog);
      exit(0);
    })();
  };
}

export function registerServeCommand(program: Command): void {
  program
    .command('serve')
    .description('Start the Fastify tracking server')
    .option('--port <n>', 'port to listen on')
    .option('--host <addr>', 'address to bind')
    .action(async (opts: { port?: string; host?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env);
        const dbPath = g.db ?? config.dbPath;
        const db = openDb(dbPath);
        migrate(db);

        const port = opts.port ? Number(opts.port) : config.port;
        const host = opts.host ?? config.bindAddress;
        // Phase 3: an explicit --host cascades to DASHBOARD_BIND too, unless the operator set
        // DASHBOARD_BIND explicitly to something else in the environment.
        const dashboardBind = opts.host && process.env.DASHBOARD_BIND === undefined ? host : config.dashboardBind;
        const boundConfig = { ...config, port, bindAddress: host, dashboardBind };

        // finding #2: refuse to start unauthenticated on a network-reachable bind.
        assertSafeToBind(boundConfig);
        assertSafeToServeDashboard(boundConfig, dashboardBind, host);
        if (config.trustProxyWarning) {
          process.stderr.write(`warning: ${config.trustProxyWarning}\n`);
        }

        const ranges = config.rangesEnabled ? loadRangeIndex(config.rangesDir) : EMPTY_RANGE_INDEX;
        const bus = new EventBus();
        const notifyWorker = new NotifyWorker({ db, config: boundConfig, bus, log: { error: (...a) => console.error(...a) } });
        // Finding #7: previously loaded by nothing at all - geoForEvent/createMmdbLookup were fully
        // written and unit-tested but never called from the running server. A failed load (missing
        // file, unparseable, mmdb-lib not installed) degrades to geo disabled, same as unset.
        const geoLookup = config.geoipDbPath ? await createMmdbLookup(config.geoipDbPath) : null;
        if (config.geoipDbPath && !geoLookup) {
          process.stderr.write(`warning: GEOIP_DB_PATH is set (${config.geoipDbPath}) but could not be loaded - geo is disabled; run \`openpost doctor\` for details\n`);
        }

        const app = buildServer({ db, config: boundConfig, ranges, bus, notifyWorker, geoLookup });

        const detachNotifyWorker = notifyWorker.attach();
        if (config.notifyEnabled) {
          notifyWorker.start();
        }

        const scheduler = new Scheduler({ db, log: { error: (...a) => console.error(...a) } });
        if (config.jobsEnabled) {
          if (config.pruneEnabled) {
            scheduler.register(
              createPruneJob(db, {
                retentionDays: config.retentionDays,
                intervalHours: config.pruneIntervalHours,
                vacuumThreshold: config.pruneVacuumThreshold,
              }),
            );
          }
          scheduler.register(createRangesReloadJob(db, ranges, config.rangesDir, 60 * 60 * 1000));
          scheduler.register({
            name: 'notifications-purge',
            intervalMs: 24 * 60 * 60 * 1000,
            async run() {
              return {
                detail: purgeNotifications(db, {
                  sentOlderThanMs: Date.now() - config.retentionDays * 24 * 60 * 60 * 1000,
                  deadLettersOlderThanMs: Date.now() - 90 * 24 * 60 * 60 * 1000,
                }),
              };
            },
          });
          if (config.remindersEnabled) {
            const draftClient = await buildDraftClient(boundConfig, process.env).catch(() => null);
            scheduler.register(
              createRemindersJob({
                db,
                config: boundConfig,
                bus,
                draftClient,
                notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e),
                log: { error: (...a) => console.error(...a) },
              }),
            );
          }
          if (config.replyDetection !== 'off') {
            const reader = await buildReplyReader(boundConfig, process.env).catch((err) => {
              console.error('serve: failed to set up reply detection reader', err);
              return null;
            });
            if (reader) {
              scheduler.register(
                createReplyPollJob({
                  db,
                  config: boundConfig,
                  bus,
                  reader,
                  notifyEnqueue: (e) => notifyWorker.enqueueForEvent(e),
                  log: { error: (...a) => console.error(...a) },
                }),
              );
            } else {
              process.stderr.write('warning: REPLY_DETECTION is not "off" but no reader could be set up (no Gmail token and no IMAP credentials) - reply detection is disabled\n');
            }
          }
          if (config.campaignsEnabled) {
            // §2.7: recover every campaign's expired leases once at start, before the drain job's
            // own per-tick recovery - a stuck lease left by a process that died before this restart
            // must never sit un-recovered until the next tick happens to touch that campaign.
            const runningCampaigns = db.prepare(`SELECT id FROM campaigns WHERE status = 'running'`).all() as Array<{ id: string }>;
            for (const c of runningCampaigns) recoverCampaign(db, c.id, Date.now(), config.campaignLeaseMs);
            scheduler.register(createCampaignsJob({ db, config: boundConfig }, { intervalMs: config.campaignTickSeconds * 1000 }));
            scheduler.register(createCampaignDigestJob({ db, config: boundConfig }, 60_000));
          }
          if (config.digestDailyAt) {
            scheduler.register(createDailyDigestJob({ db, config: boundConfig }, 60_000));
          }
          if (config.addonEnabled) {
            scheduler.register(createAddonReaperJob({ db, timeoutHours: config.addonLinkTimeoutHours }, 15 * 60_000));
          }
          if (config.backupEnabled) {
            scheduler.register(createBackupJob({ db, outDir: config.backupDir, keep: config.backupKeep, gzip: config.backupGzip }, config.backupIntervalHours * 60 * 60 * 1000));
          }
          if (config.pruneOnStart) {
            await scheduler.runDue(Date.now());
          }
          scheduler.start(Math.min(60_000, config.reminderTickSeconds * 1000));
        }

        await app.listen({ port, host });
        process.stdout.write(`openpost listening on http://${host}:${port}\n`);
        process.stdout.write(`pixel base URL: ${config.trackingBaseUrl}\n`);
        if (boundConfig.dashboardEnabled) {
          const authKind = boundConfig.apiToken ? 'bearer' : boundConfig.dashboardPassword ? 'password' : 'open (loopback, no secret configured)';
          process.stdout.write(`dashboard: http://${host}:${port}/dashboard (auth: ${authKind})\n`);
        }

        const shutdown = createShutdown({
          app,
          scheduler,
          notifyWorker,
          detachNotifyWorker,
          db,
          log: { error: (...a) => console.error(...a) },
        });
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
