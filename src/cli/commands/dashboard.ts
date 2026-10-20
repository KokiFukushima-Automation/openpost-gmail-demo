import type { Command } from 'commander';
import { assertSafeToBind, assertSafeToServeDashboard, loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { EMPTY_RANGE_INDEX, loadRangeIndex } from '../../core/ranges.js';
import { EventBus } from '../../notify/bus.js';
import { buildServer } from '../../server/app.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

/** `openpost dashboard` (§2.2/§6.4): serves only `/healthz`, `/api` and `/dashboard` - no `/o`,
 *  `/c`, `/u`. The recommended split when the tracker itself is exposed through a tunnel: the pixel
 *  endpoint stays public on `openpost serve`, the dashboard stays on loopback here. */
export function registerDashboardCommand(program: Command): void {
  program
    .command('dashboard')
    .description('Serve only the dashboard (no pixel/click/opt-out endpoints)')
    .option('--port <n>', 'port to listen on')
    .option('--host <addr>', 'address to bind')
    .action(async (opts: { port?: string; host?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env);
        const dbPath = g.db ?? config.dbPath;
        const db = openDb(dbPath);
        migrate(db);

        const port = opts.port ? Number(opts.port) : config.dashboardPort;
        const host = opts.host ?? config.dashboardBind;
        const boundConfig = { ...config, port, bindAddress: host, dashboardBind: host };

        assertSafeToBind(boundConfig);
        assertSafeToServeDashboard(boundConfig, host);

        const ranges = config.rangesEnabled ? loadRangeIndex(config.rangesDir) : EMPTY_RANGE_INDEX;
        const bus = new EventBus();
        const app = buildServer({ db, config: boundConfig, ranges, bus, mode: 'dashboard' });

        await app.listen({ port, host });
        const authKind = boundConfig.apiToken ? 'bearer' : boundConfig.dashboardPassword ? 'password' : 'open (loopback, no secret configured)';
        process.stdout.write(`openpost dashboard listening on http://${host}:${port}/dashboard (auth: ${authKind})\n`);

        const shutdown = (): void => {
          void app.close().finally(() => {
            db.close();
            process.exit(0);
          });
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
