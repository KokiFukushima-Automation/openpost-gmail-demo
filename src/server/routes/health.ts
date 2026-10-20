import type { FastifyInstance } from 'fastify';
import { VERSION } from '../../version.js';
import { EXPECTED_SCHEMA } from '../../db/index.js';
import type { ResolvedServerDeps } from '../app.js';

const startedAt = Date.now();

export function registerHealthRoute(app: FastifyInstance, deps: ResolvedServerDeps): void {
  app.get('/healthz', async (_req, reply) => {
    let dbStatus: 'ok' | 'error' = 'ok';
    let schema = 0;
    try {
      schema = deps.db.pragma('user_version', { simple: true }) as number;
    } catch {
      dbStatus = 'error';
    }
    const rangesLoaded = {
      apple: deps.ranges.apple.size,
      googleProxy: deps.ranges.googleProxy.size,
      datacenter: deps.ranges.datacenter.size,
    };
    reply.header('Cache-Control', 'no-store');
    return {
      ok: dbStatus === 'ok' && schema === EXPECTED_SCHEMA,
      version: VERSION,
      schema,
      expectedSchema: EXPECTED_SCHEMA,
      db: dbStatus,
      rangesLoaded,
      uptimeMs: Date.now() - startedAt,
    };
  });
}
