import type { FastifyInstance } from 'fastify';
import type { DashboardAsset } from '../assets/index.js';

/** `GET /dashboard/assets/:name` (§2.2): serves from a frozen `Map` built once at startup - unknown
 *  names 404 with no filesystem access, and there is no path join of user input anywhere. Public
 *  (no data), so it is registered in its own plugin scope with none of the auth/CSP hooks the rest
 *  of the dashboard carries. */
export function registerDashboardAssetRoutes(app: FastifyInstance, assets: ReadonlyMap<string, DashboardAsset>): void {
  app.register(
    async (instance) => {
      instance.get('/assets/:name', async (req, reply) => {
        const { name } = req.params as { name: string };
        const asset = assets.get(name);
        if (!asset) {
          reply.code(404).send({ error: 'not_found' });
          return;
        }
        reply.header('Cache-Control', asset.cacheControl).header('ETag', asset.etag).header('Content-Type', asset.type);
        // Phase 5 (§2.5): lets the service worker registered at this URL control every page under
        // /dashboard/, not just /dashboard/assets/ (its own default scope).
        if (name === 'sw.js') {
          reply.header('Service-Worker-Allowed', '/dashboard/');
        }
        const inm = req.headers['if-none-match'];
        if (inm === asset.etag) {
          reply.code(304).send();
          return;
        }
        reply.send(asset.body);
      });

      // Phase 5 (§2.1): served at the bare path (not /assets/offline.html) so the service worker's
      // own `caches.match('/dashboard/offline.html')` fallback and a direct navigation both resolve
      // the same public, CSP-header-free response.
      instance.get('/offline.html', async (_req, reply) => {
        const asset = assets.get('offline.html');
        if (!asset) {
          reply.code(404).send({ error: 'not_found' });
          return;
        }
        reply.header('Cache-Control', asset.cacheControl).header('Content-Type', asset.type).send(asset.body);
      });
    },
    { prefix: '/dashboard' },
  );
}
