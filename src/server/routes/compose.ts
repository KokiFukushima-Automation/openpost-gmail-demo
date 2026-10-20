import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { splitAddresses } from '../../core/addresses.js';
import { textToHtml } from '../../core/html.js';
import { audit } from '../../db/repo.js';
import { listAccounts, resolveAccount } from '../../mail/accounts.js';
import { runSend } from '../../mail/send-run.js';
import type { TransportName } from '../../types.js';
import { hashIp } from '../../core/privacy.js';
import { render } from '../views/html.js';
import { layout } from '../views/layout.js';
import { composePage, type ComposePageModel } from '../views/pages/compose.js';
import type { ResolvedServerDeps } from '../app.js';
import { setDashboardHeaders, setHtmlContentType } from './dashboard.js';
import type { AppConfig } from '../../config/env.js';

interface Bucket {
  count: number;
  windowStartMs: number;
}
const composeAttempts = new Map<string, Bucket>();
const WINDOW_MS = 3_600_000;
let lastSweepAtMs = 0;

/** Test-only, mirrors `_resetLoginRateLimiterForTests` - the compose rate limiter is a
 *  module-level, process-lifetime bucket keyed by session id (or an IP hash in `open` mode). */
export function _resetComposeRateLimiterForTests(): void {
  composeAttempts.clear();
  lastSweepAtMs = 0;
}

function sweep(nowMs: number): void {
  if (nowMs - lastSweepAtMs < WINDOW_MS) return;
  lastSweepAtMs = nowMs;
  for (const [key, bucket] of composeAttempts) {
    if (nowMs - bucket.windowStartMs >= WINDOW_MS) composeAttempts.delete(key);
  }
}

/** Returns true iff this key is still under the per-hour limit (and records this attempt). */
function checkComposeRate(key: string, limitPerHour: number, nowMs: number): boolean {
  sweep(nowMs);
  const bucket = composeAttempts.get(key);
  if (!bucket || nowMs - bucket.windowStartMs >= WINDOW_MS) {
    composeAttempts.set(key, { count: 1, windowStartMs: nowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limitPerHour;
}

function rateLimitKey(req: FastifyRequest, config: AppConfig): string {
  const auth = req.dashboardAuth;
  if (auth?.ok && auth.sid) return `sid:${auth.sid}`;
  return `ip:${hashIp(req.clientIp, config.ipSalt, Date.now()) ?? 'unknown'}`;
}

function accountOptions(deps: ResolvedServerDeps): ComposePageModel['accounts'] {
  return listAccounts(deps.db)
    .filter((a) => a.status === 'active')
    .map((a) => ({ ref: a.id, label: a.label ?? a.email, email: a.email, isDefault: a.isDefault }));
}

/**
 * Finding #1 (phase5.1): the compose page used to render `config.mailTransport` while `runSend`
 * actually resolves the transport via `resolveAccount(...).transport` whenever a `fromAccountRef`
 * is passed (which the compose route always does once >=1 account exists) - the account row's
 * stored transport wins over MAIL_TRANSPORT, so the two could silently disagree (a dry-run banner
 * over a real send, or vice versa). Resolved once, the same way `runSend` resolves it, and passed
 * to both the page model AND `runSend` itself (which then just confirms it via finding #15's check)
 * so the displayed value is always the authoritative one.
 */
function effectiveTransportForAccount(deps: ResolvedServerDeps, accountRef: string | null): TransportName {
  if (accountRef === null) return deps.config.mailTransport;
  try {
    return resolveAccount(deps.db, deps.config, accountRef).transport;
  } catch {
    // An unresolvable/disabled ref: `runSend` itself will raise the same error properly when the
    // form is actually submitted - the read-only display line just falls back to the config default.
    return deps.config.mailTransport;
  }
}

interface ComposeFormBody {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  trackClicks?: string;
  account?: string;
  _csrf?: string;
}

function renderComposePage(
  reply: FastifyReply,
  deps: ResolvedServerDeps,
  csrf: string,
  fields: { to: string; cc: string; bcc: string; subject: string; body: string; trackClicks: boolean; account: string | null },
  error: string | null,
  statusCode = 200,
): void {
  const { config } = deps;
  // Finding #1 (phase5.1): resolved via the selected account, the same way `runSend` will resolve
  // it - never just `config.mailTransport`, which is only the fallback when no account applies.
  const transport = effectiveTransportForAccount(deps, fields.account);
  setDashboardHeaders(reply);
  reply.code(statusCode);
  const html_ = layout({
    title: 'Compose',
    active: 'compose',
    csrf,
    live: config.dashboardLive,
    pwaEnabled: config.pwaEnabled,
    composeEnabled: config.composeEnabled,
    page: 'compose',
    body: composePage({
      to: fields.to,
      cc: fields.cc,
      bcc: fields.bcc,
      subject: fields.subject,
      body: fields.body,
      accounts: accountOptions(deps),
      selectedAccount: fields.account,
      transport,
      trackClicks: fields.trackClicks,
      dryRunForced: transport === 'dryrun',
      error,
      csrf,
      maxBodyBytes: config.composeMaxBodyBytes,
      maxRecipients: config.composeMaxRecipients,
    }),
  });
  setHtmlContentType(reply);
  reply.send(render(html_));
}

/** docs/09_phase5_spec.md §2: `/dashboard/compose` (also the GET Web Share Target) and
 *  `/dashboard/compose/send`. Registered inside the same authenticated plugin scope as the rest of
 *  the dashboard (`registerDashboardRoutes`'s `instance`), so it inherits the auth hook, the CSRF
 *  preHandler, the CSP and every security header with no new code path. */
export function registerComposeRoutes(
  instance: FastifyInstance,
  deps: ResolvedServerDeps,
  helpers: { csrfTokenFromReq: (req: FastifyRequest, config: AppConfig) => string },
): void {
  const { db, config } = deps;
  if (!config.composeEnabled) return;

  instance.get('/compose', async (req, reply) => {
    const query = req.query as { subject?: string; body?: string; shared_url?: string; to?: string };
    const cap = (s: string | undefined, max: number): string => (s ?? '').slice(0, max);
    const subject = cap(query.subject, 512);
    let body = cap(query.body, 8192);
    const sharedUrl = cap(query.shared_url, 2048);
    if (sharedUrl) {
      body = body.length > 0 ? `${body}\n\n${sharedUrl}` : sharedUrl;
    }
    const to = cap(query.to, 2048);
    const csrf = helpers.csrfTokenFromReq(req, config);
    const accounts = accountOptions(deps);
    const defaultRef = accounts.find((a) => a.isDefault)?.ref ?? accounts[0]?.ref ?? null;
    renderComposePage(reply, deps, csrf, { to, cc: '', bcc: '', subject, body, trackClicks: config.trackClicksDefault, account: defaultRef }, null);
  });

  instance.post(
    '/compose/send',
    { bodyLimit: config.composeMaxBodyBytes },
    async (req, reply) => {
      const body = (req.body as ComposeFormBody | undefined) ?? {};
      const csrf = helpers.csrfTokenFromReq(req, config);
      const fields = {
        to: body.to ?? '',
        cc: body.cc ?? '',
        bcc: body.bcc ?? '',
        subject: body.subject ?? '',
        body: body.body ?? '',
        trackClicks: body.trackClicks === 'on',
        account: body.account ?? null,
      };

      if (!checkComposeRate(rateLimitKey(req, config), config.composeRatePerHour, Date.now())) {
        reply.code(429);
        return renderComposePage(reply, deps, csrf, fields, 'Too many sends from this session in the last hour - try again later.', 429);
      }

      const toResult = splitAddresses(fields.to);
      const ccResult = splitAddresses(fields.cc);
      const bccResult = splitAddresses(fields.bcc);
      const allInvalid = [...toResult.invalid, ...ccResult.invalid, ...bccResult.invalid];
      if (toResult.valid.length === 0 || allInvalid.length > 0) {
        return renderComposePage(
          reply,
          deps,
          csrf,
          fields,
          allInvalid.length > 0 ? `Not a valid email address: ${allInvalid[0]}` : 'At least one To recipient is required.',
          400,
        );
      }
      const totalRecipients = toResult.valid.length + ccResult.valid.length + bccResult.valid.length;
      if (totalRecipients > config.composeMaxRecipients) {
        return renderComposePage(
          reply,
          deps,
          csrf,
          fields,
          `Too many recipients (${totalRecipients} > ${config.composeMaxRecipients}) - use \`openpost campaign\` for larger sends.`,
          400,
        );
      }
      if (fields.subject.trim().length === 0) {
        return renderComposePage(reply, deps, csrf, fields, 'Subject is required.', 400);
      }
      if (fields.subject.length > 512) {
        return renderComposePage(reply, deps, csrf, fields, 'Subject is too long (max 512 characters).', 400);
      }
      if (fields.body.trim().length === 0) {
        return renderComposePage(reply, deps, csrf, fields, 'Body is required.', 400);
      }

      const html = textToHtml(fields.body);
      // Finding #1/#15 (phase5.1): pass the SAME transport the page just displayed (or would
      // display on a re-render) explicitly into `runSend`, rather than leaving it to re-derive one
      // implicitly from `fromAccountRef` alone - the send is guaranteed to go out over exactly the
      // transport shown, and `runSend`'s own finding-#15 check throws if the two ever disagree
      // instead of silently letting the account's transport win unannounced.
      const effectiveTransport = effectiveTransportForAccount(deps, fields.account);

      try {
        const result = await runSend(
          { db, config },
          {
            to: toResult.valid,
            cc: ccResult.valid,
            bcc: bccResult.valid,
            subject: fields.subject,
            html,
            text: fields.body,
            fromAccountRef: fields.account ?? undefined,
            transport: fields.account !== null ? effectiveTransport : undefined,
            track: true,
            trackClicks: fields.trackClicks,
            optOutLink: false,
            mute: false,
            source: 'dashboard',
          },
        );

        const anySent = result.recipients.some((r) => r.sent);
        if (!anySent) {
          return renderComposePage(reply, deps, csrf, fields, result.errors[0] ?? 'Send failed.', 400);
        }

        audit(db, { actor: 'dashboard', action: 'send', subjectType: 'message', subjectId: result.messageId, detail: { source: 'compose', recipients: totalRecipients } });
        const allSent = result.recipients.every((r) => r.sent || r.suppressed);
        setDashboardHeaders(reply);
        reply.code(303).header('Location', `/dashboard/messages/${result.messageId}?flash=${allSent ? 'sent' : 'sent_partial'}`).send();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return renderComposePage(reply, deps, csrf, fields, message, 400);
      }
    },
  );
}
