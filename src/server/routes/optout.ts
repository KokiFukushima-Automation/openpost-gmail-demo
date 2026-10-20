import type { FastifyInstance } from 'fastify';
import { addSuppression, audit, findRecipientByToken, setRecipientOptedOut } from '../../db/repo.js';
import { verifyToken } from '../../core/token.js';
import { auditRejection } from '../rejection-audit.js';
import type { ServerDeps } from '../app.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function registerOptOutRoute(
  app: FastifyInstance,
  deps: ServerDeps,
  clock: () => number,
): void {
  const { db, config } = deps;
  const secrets = { current: config.trackingSecret ?? '', previous: config.trackingSecretPrevious };

  app.get('/u/:token', async (req, reply) => {
    const { token } = req.params as { token: string };
    const verify = verifyToken('u', token, secrets);

    reply.header('Content-Type', 'text/html; charset=utf-8').code(200);

    if (!verify.ok) {
      auditRejection(db, {
        actor: 'server',
        action: 'token.reject',
        detail: { purpose: 'u', reason: verify.reason },
      });
      return reply.send(confirmationHtml());
    }

    const recipient = findRecipientByToken(db, verify.rid);
    if (!recipient) {
      auditRejection(db, {
        actor: 'server',
        action: 'token.orphan',
        detail: { purpose: 'u', rid: verify.rid },
      });
      return reply.send(confirmationHtml());
    }

    // Finding #15: opting out is idempotent (the suppression itself never changes on a replay), but
    // every valid hit used to write a fresh audit row and rewrite opted_out_at regardless - unlike
    // auditRejection (rate-limited), this path had no limiter, and an unsubscribe link can be
    // fetched/prefetched/reloaded arbitrarily many times by something other than the recipient.
    // Skip the writes entirely once already opted out; the response is identical either way.
    if (recipient.opted_out_at === null) {
      const atMs = clock();
      addSuppression(db, recipient.email, 'recipient_optout');
      setRecipientOptedOut(db, recipient.id, atMs);
      audit(db, {
        actor: 'server',
        action: 'optout.record',
        subjectType: 'recipient',
        subjectId: recipient.id,
      });
    }

    return reply.send(confirmationHtml(recipient.email));
  });

  // docs/08_phase4_spec.md §2.5: RFC 8058 one-click unsubscribe. Same verification/suppression/
  // audit as the GET above; exempt from CSRF (it carries no ambient credential - a token-bearing
  // URL, exactly like the GET), idempotent, and accepts any body (a mail client's one-click POST
  // sends no body it expects us to read) - registered in its own encapsulated context so a
  // wildcard "don't parse the body" content-type parser applies only to this route, not globally.
  void app.register(async (instance) => {
    instance.addContentTypeParser('*', (_req, _payload, done) => {
      done(null, undefined);
    });
    instance.post('/u/:token', async (req, reply) => {
      const { token } = req.params as { token: string };
      const verify = verifyToken('u', token, secrets);

      reply.header('Content-Type', 'text/plain; charset=utf-8').code(200);

      if (!verify.ok) {
        auditRejection(db, {
          actor: 'server',
          action: 'token.reject',
          detail: { purpose: 'u', reason: verify.reason, method: 'POST' },
        });
        return reply.send('OK');
      }

      const recipient = findRecipientByToken(db, verify.rid);
      if (!recipient) {
        auditRejection(db, {
          actor: 'server',
          action: 'token.orphan',
          detail: { purpose: 'u', rid: verify.rid, method: 'POST' },
        });
        return reply.send('OK');
      }

      // Finding #15: RFC 8058 one-click POSTs are machine-generated and can be replayed (a mail
      // client retrying, or anyone holding one leaked unsubscribe URL) far more readily than a
      // human re-visiting the GET page - skip the audit/update once already opted out, same as GET.
      if (recipient.opted_out_at === null) {
        const atMs = clock();
        addSuppression(db, recipient.email, 'recipient_optout');
        setRecipientOptedOut(db, recipient.id, atMs);
        audit(db, {
          actor: 'server',
          action: 'optout.record',
          subjectType: 'recipient',
          subjectId: recipient.id,
          detail: { method: 'POST' },
        });
      }

      return reply.send('OK');
    });
  });
}

function confirmationHtml(email?: string): string {
  const who = email ? ` for <strong>${escapeHtml(email)}</strong>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed</title></head>` +
    `<body><p>You have been unsubscribed from open tracking${who}. You will no longer be tracked ` +
    `by this sender.</p></body></html>`;
}
