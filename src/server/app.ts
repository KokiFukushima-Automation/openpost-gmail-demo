import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig, TrustProxyConfig } from '../config/env.js';
import type { DB } from '../db/index.js';
import type { GeoLookup } from '../core/geo.js';
import { EMPTY_RANGE_INDEX, type RangeIndex } from '../core/ranges.js';
import { EventBus } from '../notify/bus.js';
import type { NotifyWorker } from '../notify/worker.js';
import type { Scheduler } from '../jobs/scheduler.js';
import { loadDashboardAssets, type DashboardAsset } from './assets/index.js';
import { registerCorsHook } from './cors.js';
import { registerApiRoutes } from './routes/api.js';
import { registerClickRoute } from './routes/click.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerDashboardAssetRoutes } from './routes/dashboard-assets.js';
import { registerHealthRoute } from './routes/health.js';
import { registerOptOutRoute } from './routes/optout.js';
import { registerPixelRoute } from './routes/pixel.js';
import { registerReclassifyRoute } from './routes/reclassify.js';
import { registerStreamRoute } from './routes/stream.js';

/**
 * The installed Fastify version's own numeric `trustProxy` handling deliberately fails closed
 * (treats any number as "trust nothing", to avoid silently misinterpreting a hop count) - see
 * `@fastify/proxy-addr`. To actually honour an operator-configured hop count (finding #5: trusting
 * *every* forwarded hop lets a client forge its own `ip_net_hash`), we compile it ourselves into a
 * `(address, hop) => boolean` function: `hop` counts outward from the socket peer (hop 0), so
 * trusting exactly N hops means trusting hops `0..N-1` and treating the next entry out as the real
 * client address - the same semantics Express's classic `trust proxy: <number>` used.
 */
export function resolveTrustProxy(
  trustProxy: TrustProxyConfig,
): boolean | string[] | ((address: string, hop: number) => boolean) {
  if (trustProxy === false) return false;
  if (Array.isArray(trustProxy)) return trustProxy;
  const hopCount = trustProxy;
  return (_address: string, hop: number): boolean => hop < hopCount;
}

declare module 'fastify' {
  interface FastifyRequest {
    clientIp: string | null;
  }
}

export interface ServerDeps {
  db: DB;
  config: AppConfig;
  clock?: () => number;
  logger?: boolean | Record<string, unknown>;
  /** Phase 2 (§4.1): shipped Apple relay / Google proxy / datacentre CIDR sets. Defaults to
   *  `EMPTY_RANGE_INDEX` (every IP-range flag false), reproducing Phase 1 behaviour. */
  ranges?: RangeIndex;
  /** Phase 2 (§2.1): in-process fan-out from the record-event path to SSE and the notify worker.
   *  A fresh `EventBus` is created when none is injected, so `buildServer` alone is always usable
   *  (e.g. from tests) without wiring up notifications. */
  bus?: EventBus;
  /** Phase 2 (§2.6): owned and started by `openpost serve`; not created here so tests that only
   *  need `app.inject()` never spin up delivery timers. */
  notifyWorker?: NotifyWorker;
  /** Phase 2 (§5.2): likewise owned by `openpost serve`. */
  scheduler?: Scheduler;
  /** Phase 3 (§2.2): `'full'` (default) registers every route including the pixel/click/opt-out
   *  endpoints; `'dashboard'` registers only `/healthz`, `/api` and `/dashboard` - the split mode
   *  `openpost dashboard` uses when the tracker itself is exposed through a tunnel and the
   *  dashboard should stay on loopback. */
  mode?: 'full' | 'dashboard';
  /** Phase 3 (§2.2): pre-loaded dashboard static assets - tests inject a small fake map so they
   *  never depend on `dist/server/assets` existing. Defaults to `loadDashboardAssets()` reading the
   *  directory this module ships next to. */
  dashboardAssets?: ReadonlyMap<string, DashboardAsset>;
  /** Finding #7 (docs/reports/phase4_review.md): the optional local geo lookup (§5), loaded once at
   *  `serve` start via `createMmdbLookup` (an async operation - it reads and parses the mmdb file -
   *  so it cannot happen lazily inside `buildServer` itself). `null`/omitted means geo is fully
   *  disabled, exactly as before this fix. */
  geoLookup?: GeoLookup | null;
}

/**
 * Options for the default logger, honouring `LOG_LEVEL` (finding #12: it was parsed by
 * `loadConfig` but never actually wired up, and Fastify's default request serializer logs
 * `remoteAddress`/`remotePort`, which doc 02 §4 promises never happens). Exported so a unit test
 * can assert the shape without needing a bound server.
 */
export function buildLoggerOptions(config: AppConfig): Record<string, unknown> {
  return {
    level: config.logLevel,
    serializers: {
      req(req: { method: string; url: string }): Record<string, unknown> {
        // Deliberately omit remoteAddress/remotePort - the raw client IP must never reach the log
        // stream, only the hashed, privacy-mode-redacted fields that reach the database.
        return { method: req.method, url: req.url };
      },
    },
  };
}

function defaultLogger(config: AppConfig): boolean | Record<string, unknown> {
  // vitest sets NODE_ENV=test; avoid flooding test output with structured logs from every
  // app.inject() call while still exercising buildLoggerOptions() directly in unit tests.
  if (process.env.NODE_ENV === 'test') return false;
  return buildLoggerOptions(config);
}

/** The subset of ServerDeps every route actually receives, with the optional fields defaulted -
 *  keeps every route module's signature simple while `ServerDeps` itself stays fully optional for
 *  callers (tests, `openpost serve`). */
export interface ResolvedServerDeps {
  db: DB;
  config: AppConfig;
  ranges: RangeIndex;
  bus: EventBus;
  /** Phase 2.1 (finding #6): when `openpost serve` owns one, the pixel/click routes enqueue
   *  notifications synchronously inside the same DB transaction that records the event, rather than
   *  only afterwards via the bus - see `src/server/services/record.ts`'s `onEvent` hook. `null` when
   *  no worker was wired in (e.g. most tests build a server with `app.inject()` only). */
  notifyWorker: NotifyWorker | null;
  /** Finding #7: `null` when GEOIP_DB_PATH is unset or failed to load - every geo call site treats
   *  that identically to "geo disabled", never as an error. */
  geoLookup: GeoLookup | null;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const clock = deps.clock ?? (() => Date.now());
  const resolved: ResolvedServerDeps = {
    db: deps.db,
    config: deps.config,
    ranges: deps.ranges ?? EMPTY_RANGE_INDEX,
    bus: deps.bus ?? new EventBus(),
    notifyWorker: deps.notifyWorker ?? null,
    geoLookup: deps.geoLookup ?? null,
  };

  const app = Fastify({
    trustProxy: resolveTrustProxy(deps.config.trustProxy),
    logger: deps.logger ?? defaultLogger(deps.config),
  });

  app.decorateRequest('clientIp', null);
  app.addHook('onRequest', async (req) => {
    req.clientIp = req.ip ?? null;
  });

  const mode = deps.mode ?? 'full';

  registerHealthRoute(app, resolved);
  if (mode !== 'dashboard') {
    registerPixelRoute(app, resolved, clock);
    registerClickRoute(app, resolved, clock);
    registerOptOutRoute(app, deps, clock);
  }
  registerCorsHook(app, deps.config);
  registerApiRoutes(app, deps);
  registerReclassifyRoute(app, resolved);
  if (deps.config.sseEnabled) {
    registerStreamRoute(app, resolved, { mountDashboard: deps.config.dashboardEnabled });
  }
  if (deps.config.dashboardEnabled) {
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), 'assets');
    const assets = deps.dashboardAssets ?? loadDashboardAssets(assetsDir);
    registerDashboardAssetRoutes(app, assets);
    registerDashboardRoutes(app, resolved);
  }

  return app;
}
