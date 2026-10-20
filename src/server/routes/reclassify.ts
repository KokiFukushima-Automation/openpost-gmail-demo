import type { FastifyInstance } from 'fastify';
import { isValidApiBearer } from '../api-auth.js';
import { ReclassifyInvalidError, ReclassifyNotFoundError, reclassify } from '../services/reclassify.js';
import type { ResolvedServerDeps } from '../app.js';

interface ReclassifyBody {
  classification?: string;
  counted?: boolean;
  note?: string;
  actor?: string;
}

const RECLASSIFY_BODY_KEYS = new Set(['classification', 'counted', 'note', 'actor']);

/** `POST /api/events/:kind/:eventId/reclassify` (§4.4). Supersedes doc 01 §5's
 *  `POST /api/messages/:id/recipients/:rid/reclassify`, which cannot address a single event when a
 *  recipient has more than one - the deviation is recorded here and in docs/05_phase2_spec.md. */
export function registerReclassifyRoute(app: FastifyInstance, deps: ResolvedServerDeps): void {
  const { db, config } = deps;

  app.register(
    async (instance) => {
      instance.addHook('onRequest', async (req, reply) => {
        if (!isValidApiBearer(config, req.headers['authorization'])) {
          reply.code(401).send({ error: 'unauthorized' });
        }
      });

      instance.post('/events/:kind/:eventId/reclassify', async (req, reply) => {
        const { kind, eventId } = req.params as { kind: string; eventId: string };
        if (kind !== 'open' && kind !== 'click') {
          reply.code(400);
          return { error: 'invalid_kind' };
        }
        const body = (req.body ?? {}) as ReclassifyBody;
        // Finding #12: `body.counted` used to flow straight into `reclassify()` unvalidated - a
        // JSON body of `{"counted": "false"}` (a *string*) is truthy in JS, so `!!"false"` silently
        // counted an event the caller explicitly asked to mark uncounted. Reject anything but an
        // actual boolean, and reject unknown top-level keys outright rather than silently ignoring
        // client typos (e.g. `counter` instead of `counted`).
        const unknownKeys = Object.keys(body as Record<string, unknown>).filter((k) => !RECLASSIFY_BODY_KEYS.has(k));
        if (unknownKeys.length > 0) {
          reply.code(400);
          return { error: `unknown field(s): ${unknownKeys.join(', ')}` };
        }
        if (typeof body.classification !== 'string' || body.classification.length === 0) {
          reply.code(400);
          return { error: 'classification is required' };
        }
        if (body.counted !== undefined && typeof body.counted !== 'boolean') {
          reply.code(400);
          return { error: 'counted must be a boolean' };
        }
        if (body.note !== undefined && typeof body.note !== 'string') {
          reply.code(400);
          return { error: 'note must be a string' };
        }
        if (body.actor !== undefined && typeof body.actor !== 'string') {
          reply.code(400);
          return { error: 'actor must be a string' };
        }

        try {
          const result = reclassify(db, {
            kind,
            eventId,
            classification: body.classification,
            ...(body.counted !== undefined ? { counted: body.counted } : {}),
            ...(body.note !== undefined ? { note: body.note } : {}),
            actor: body.actor ?? 'api',
            atMs: Date.now(),
          });
          return result;
        } catch (err) {
          if (err instanceof ReclassifyNotFoundError) {
            reply.code(404);
            return { error: 'not_found' };
          }
          if (err instanceof ReclassifyInvalidError) {
            reply.code(400);
            return { error: err.message };
          }
          throw err;
        }
      });
    },
    { prefix: '/api' },
  );
}
