/**
 * CORS for `/api`, off by default (docs/08_phase4_spec.md §6.2c) - the server-side half of the
 * future in-Gmail extension. `API_CORS_ORIGINS` is validated at config-load time (env.ts): empty by
 * default, `*` rejected, and requiring `API_TOKEN` to be set at all - never expose an
 * unauthenticated API cross-origin.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppConfig } from '../config/env.js';

export function resolveCorsHeaders(config: AppConfig, origin: string | undefined): Record<string, string> | null {
  if (config.apiCorsOrigins.length === 0) return null;
  if (origin === undefined) return null;
  if (!config.apiCorsOrigins.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age': '600',
    // Deliberately never present: a cross-origin request is authenticated by bearer only (see
    // api.ts's own auth hook), never by the dashboard session cookie, so there is nothing for
    // Access-Control-Allow-Credentials to legitimately unlock.
  };
}

function applyCorsHeaders(reply: FastifyReply, headers: Record<string, string>): void {
  for (const [key, value] of Object.entries(headers)) reply.header(key, value);
}

/** Registered only when `API_CORS_ORIGINS` is non-empty - with it empty (the default), no CORS
 *  headers are emitted at all and `OPTIONS` is not specially handled (test 337). */
export function registerCorsHook(app: FastifyInstance, config: AppConfig): void {
  if (config.apiCorsOrigins.length === 0) return;

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    const originHeader = req.headers.origin;
    const origin = typeof originHeader === 'string' ? originHeader : undefined;
    const headers = resolveCorsHeaders(config, origin);
    if (headers) applyCorsHeaders(reply, headers);
    if (req.method === 'OPTIONS') {
      reply.code(204);
      await reply.send();
    }
  });
}

/** True when this request carries an `Origin` header (a cross-origin fetch, or same-origin fetch
 *  from a browser that always sends one) - used to refuse the dashboard-cookie auth fallback for
 *  any such request once CORS is enabled at all, closing the CSRF hole that convenience would
 *  otherwise open the moment `/api` becomes cross-origin-reachable (test 337). */
export function isCrossOriginRequest(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  return typeof req.headers.origin === 'string';
}
