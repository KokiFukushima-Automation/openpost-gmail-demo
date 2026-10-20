import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../../src/config/env.js';
import { loadConfig } from '../../src/config/env.js';
import type { DB } from '../../src/db/index.js';
import { migrate, openDb } from '../../src/db/index.js';
import type { GeoLookup } from '../../src/core/geo.js';
import { EMPTY_RANGE_INDEX, type RangeIndex } from '../../src/core/ranges.js';
import { EventBus } from '../../src/notify/bus.js';
import type { NotifyWorker } from '../../src/notify/worker.js';
import { buildServer } from '../../src/server/app.js';

export const TEST_SECRET = 'test-secret-value-padded-to-32-chars!!';

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    TRACKING_SECRET: TEST_SECRET,
    TRACKING_BASE_URL: 'http://127.0.0.1:8787',
    DB_PATH: ':memory:',
    FROM_EMAIL: 'sender@example.com',
    FROM_NAME: 'Sender',
  });
  return { ...base, ...overrides };
}

export interface MutableClock {
  now: number;
}

export interface TestServer {
  db: DB;
  config: AppConfig;
  app: FastifyInstance;
  clock: MutableClock;
  ranges: RangeIndex;
  bus: EventBus;
}

export function setupTestServer(opts: {
  startAt?: number;
  configOverrides?: Partial<AppConfig>;
  ranges?: RangeIndex;
  bus?: EventBus;
  /** Wires a NotifyWorker into the server so pixel/click routes enqueue notifications inside the
   *  event transaction (finding #6) - omit for tests that don't exercise notifications at all.
   *  Called with this same server's `db`/`config`/`bus` so the worker's queue writes land in the
   *  same database the routes use. */
  buildNotifyWorker?: (db: DB, config: AppConfig, bus: EventBus) => NotifyWorker;
  /** Finding #7: an injected fake GeoLookup, so a test can prove opens/clicks actually get geo
   *  tagged without shipping a real mmdb file. Omit (the default) to keep geo fully disabled, same
   *  as every test before this fix. */
  geoLookup?: GeoLookup | null;
} = {}): TestServer {
  const db = openDb(':memory:');
  migrate(db);
  const config = makeConfig(opts.configOverrides);
  const clock: MutableClock = { now: opts.startAt ?? Date.now() };
  const ranges = opts.ranges ?? EMPTY_RANGE_INDEX;
  const bus = opts.bus ?? new EventBus();
  const notifyWorker = opts.buildNotifyWorker ? opts.buildNotifyWorker(db, config, bus) : null;
  const app = buildServer({ db, config, clock: () => clock.now, ranges, bus, notifyWorker, geoLookup: opts.geoLookup ?? null });
  return { db, config, app, clock, ranges, bus };
}
