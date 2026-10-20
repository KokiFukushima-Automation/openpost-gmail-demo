import { createHash } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { isLoopbackAddress } from '../config/env.js';
import { EXPECTED_SCHEMA } from '../db/index.js';
import type { RangeSet } from './cidr.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  status: CheckStatus;
  title: string;
  detail: string;
  remedy?: string;
}

export interface PixelProbe {
  status: number;
  headers: Record<string, string>;
  bodyLength: number;
  redirected: boolean;
  elapsedMs: number;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

/** `config.load`/`secret.length`/`secret.fingerprint`/`db.schema` (§3.3). `db.writable` is checked
 *  separately by `checkDbWritable`, since it needs an open DB handle rather than pure config data. */
export function checkConfig(
  config: AppConfig,
  schemaVersion: number,
  secretFingerprint: string | null,
): CheckResult[] {
  const results: CheckResult[] = [
    { id: 'config.load', status: 'pass', title: 'configuration', detail: 'loaded successfully' },
  ];

  if (config.trackingSecret === undefined || config.trackingSecret.length < 32) {
    results.push({
      id: 'secret.length',
      status: 'fail',
      title: 'TRACKING_SECRET',
      detail: config.trackingSecret === undefined ? 'not set' : `only ${config.trackingSecret.length} characters`,
      remedy: 'set TRACKING_SECRET to a value at least 32 characters long',
    });
  } else {
    results.push({
      id: 'secret.length',
      status: 'pass',
      title: 'TRACKING_SECRET',
      detail: `${config.trackingSecret.length} characters`,
    });
  }

  if (secretFingerprint === null) {
    results.push({
      id: 'secret.fingerprint',
      status: 'warn',
      title: 'secret fingerprint',
      detail: 'no fingerprint stored yet',
      remedy: 'run `openpost init`',
    });
  } else if (config.trackingSecret !== undefined) {
    const current = createHash('sha256').update(config.trackingSecret).digest('hex').slice(0, 16);
    results.push(
      current === secretFingerprint
        ? { id: 'secret.fingerprint', status: 'pass', title: 'secret fingerprint', detail: 'matches settings' }
        : {
            id: 'secret.fingerprint',
            status: 'warn',
            title: 'secret fingerprint',
            detail: 'TRACKING_SECRET does not match the fingerprint stored at init time',
            remedy: 'every previously issued token is now unverifiable - rotate via TRACKING_SECRET_PREVIOUS or re-send',
          },
    );
  }

  results.push(
    schemaVersion === EXPECTED_SCHEMA
      ? { id: 'db.schema', status: 'pass', title: 'database schema', detail: `v${schemaVersion}` }
      : {
          id: 'db.schema',
          status: 'fail',
          title: 'database schema',
          detail: `v${schemaVersion} (expected v${EXPECTED_SCHEMA})`,
          remedy: 'run `openpost migrate`',
        },
  );

  return results;
}

export interface DbWritableProbe {
  db: { exec(sql: string): unknown };
}

/** `BEGIN IMMEDIATE; ROLLBACK` (§3.3) - real local I/O, not network, so this takes a live handle
 *  rather than an injected result. */
export function checkDbWritable(db: DbWritableProbe['db']): CheckResult {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec('ROLLBACK');
    return { id: 'db.writable', status: 'pass', title: 'database writable', detail: 'BEGIN IMMEDIATE succeeded' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'db.writable',
      status: 'fail',
      title: 'database writable',
      detail: message,
      remedy: 'check file permissions / that no other process holds a conflicting lock',
    };
  }
}

/**
 * Finding #18: `doctor --url <host>` used to sign a real, valid open token with the live
 * TRACKING_SECRET and send it to *whatever host the operator typed* - a typo, a stale bookmark, or
 * someone social-engineering "run `openpost doctor --url https://attacker.example`" would leak a
 * verifiably-signed token to a host that never should have seen one (tokens are HMAC-only, not bound
 * to any particular host, so a leaked one is replayable against the real tracking server). Only send
 * a real signed token when `--url`'s origin matches `TRACKING_BASE_URL`; otherwise this returns a
 * warning and the caller skips the pixel/click probe (DNS/TLS checks, which carry no secret, still
 * run either way).
 */
export function checkUrlMatchesTrackingBase(trackingBaseUrl: string, probedUrl: string): CheckResult {
  let configuredOrigin: string;
  let probedOrigin: string;
  try {
    configuredOrigin = new URL(trackingBaseUrl).origin;
    probedOrigin = new URL(probedUrl).origin;
  } catch {
    return {
      id: 'doctor.url_scope',
      status: 'warn',
      title: '--url scope',
      detail: 'could not compare --url against TRACKING_BASE_URL (one of them failed to parse)',
    };
  }
  if (configuredOrigin === probedOrigin) {
    return { id: 'doctor.url_scope', status: 'pass', title: '--url scope', detail: 'matches TRACKING_BASE_URL' };
  }
  return {
    id: 'doctor.url_scope',
    status: 'warn',
    title: '--url scope',
    detail: `--url (${probedOrigin}) is a different origin than TRACKING_BASE_URL (${configuredOrigin}) - skipping the signed pixel/click probe`,
    remedy: 'pass --url matching TRACKING_BASE_URL to probe the real pixel/click endpoints, or omit --url for a config-only check',
  };
}

const BLOCKLISTED_HOST_SUFFIXES = ['.trycloudflare.com', '.ngrok-free.app', '.ngrok.io'];

/** `base_url.scheme` / `base_url.host` (§3.3). */
export function checkBaseUrl(url: string): CheckResult[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [{ id: 'base_url.scheme', status: 'fail', title: 'TRACKING_BASE_URL', detail: `not a valid URL: ${url}` }];
  }

  const loopback = isLoopbackAddress(parsed.hostname);
  const results: CheckResult[] = [];
  results.push(
    loopback || parsed.protocol === 'https:'
      ? { id: 'base_url.scheme', status: 'pass', title: 'TRACKING_BASE_URL scheme', detail: parsed.protocol }
      : {
          id: 'base_url.scheme',
          status: 'fail',
          title: 'TRACKING_BASE_URL scheme',
          detail: `${parsed.protocol} on a public host`,
          remedy: 'use https for any non-loopback TRACKING_BASE_URL',
        },
  );

  const blocklisted = BLOCKLISTED_HOST_SUFFIXES.some((suffix) => parsed.hostname.endsWith(suffix));
  results.push(
    blocklisted
      ? {
          id: 'base_url.host',
          status: 'warn',
          title: 'TRACKING_BASE_URL host',
          detail: `${parsed.hostname} is a shared/temporary hostname`,
          remedy: 'these hostnames are heavily blocklisted by mail providers - use a Cloudflare Tunnel hostname on your own domain for anything but a quick connectivity test',
        }
      : { id: 'base_url.host', status: 'pass', title: 'TRACKING_BASE_URL host', detail: parsed.hostname },
  );

  return results;
}

/**
 * §3.1's hard rule: `TRUST_PROXY` enabled with a directly reachable non-loopback bind is unsafe
 * (anyone can forge `X-Forwarded-For`); the inverse - `TRUST_PROXY=false` behind what looks like a
 * public HTTPS origin - silently poisons every IP hash with the proxy's own address instead.
 *
 * Deviation note: doc 02's own deployment table lists Fly.io (`BIND_ADDRESS=0.0.0.0`,
 * `TRUST_PROXY=true`) as a *recommended* pattern, which this check cannot distinguish from a
 * directly-exposed misconfiguration by config alone (both look identical: trust-proxy on, bind
 * non-loopback). Test case 107 pins the literal behaviour ("fails for TRUST_PROXY=true +
 * non-loopback bind", full stop), so that is what this implements; a Fly operator who has verified
 * the platform terminates TLS in front of the process should treat this specific `fail` as an
 * expected, reviewed exception rather than a bug.
 */
export function checkProxyContract(config: AppConfig): CheckResult[] {
  const loopback = isLoopbackAddress(config.bindAddress);
  const trustProxyEnabled = config.trustProxy !== false;

  if (trustProxyEnabled && !loopback) {
    return [
      {
        id: 'proxy.contract',
        status: 'fail',
        title: 'TRUST_PROXY / BIND_ADDRESS contract',
        detail: 'TRUST_PROXY is enabled while BIND_ADDRESS is not loopback - anyone who can reach this port can forge X-Forwarded-For',
        remedy: 'bind to 127.0.0.1 behind your proxy/tunnel, or disable TRUST_PROXY if this really is directly exposed',
      },
    ];
  }

  let baseUrlIsPublicHttps = false;
  try {
    const parsed = new URL(config.trackingBaseUrl);
    baseUrlIsPublicHttps = parsed.protocol === 'https:' && !isLoopbackAddress(parsed.hostname);
  } catch {
    // an unparseable base URL is reported by checkBaseUrl instead.
  }
  if (!trustProxyEnabled && baseUrlIsPublicHttps) {
    return [
      {
        id: 'proxy.contract',
        status: 'fail',
        title: 'TRUST_PROXY / BIND_ADDRESS contract',
        detail: 'TRACKING_BASE_URL is a public HTTPS origin but TRUST_PROXY is disabled - every open will hash the same proxy IP',
        remedy: 'set TRUST_PROXY to the correct hop count (or CIDR list) for your reverse proxy/tunnel',
      },
    ];
  }

  return [
    { id: 'proxy.contract', status: 'pass', title: 'TRUST_PROXY / BIND_ADDRESS contract', detail: 'consistent' },
  ];
}

/** `ranges.loaded` (§3.3): Apple + Google sets must be non-empty; older than 90 days is a `warn`. */
export function checkRanges(sets: Map<string, RangeSet>, nowMs: number): CheckResult[] {
  const results: CheckResult[] = [];
  for (const name of ['apple_relay', 'google_proxy'] as const) {
    const set = sets.get(name);
    if (!set || set.size === 0) {
      results.push({
        id: `ranges.loaded.${name}`,
        status: 'fail',
        title: `${name} ranges`,
        detail: 'empty or not loaded',
        remedy: 'run `openpost update-ranges`',
      });
      continue;
    }
    const ageMs = set.generatedAt !== null ? nowMs - set.generatedAt : null;
    if (ageMs !== null && ageMs > NINETY_DAYS_MS) {
      results.push({
        id: `ranges.loaded.${name}`,
        status: 'warn',
        title: `${name} ranges`,
        detail: `generated ${Math.floor(ageMs / (24 * 60 * 60 * 1000))} days ago`,
        remedy: 'run `openpost update-ranges`',
      });
    } else {
      results.push({ id: `ranges.loaded.${name}`, status: 'pass', title: `${name} ranges`, detail: `${set.size} entries` });
    }
  }
  return results;
}

export interface RangeIntegrityInput {
  name: string;
  computedSha256: string;
  /** The sha256 `openpost update-ranges` recorded the last time it wrote this file, or `null` if
   *  that has never happened (e.g. a fresh checkout still running the shipped defaults). */
  storedSha256: string | null;
}

/**
 * `ranges.integrity` (finding #19): `parseRangeFile` already computes a sha256 of the file it just
 * read, but nothing used to compare it against anything - a `.cidr` file hand-edited to add, say,
 * `0.0.0.0/0` (matching every IPv4 address) loaded silently and took effect with no warning
 * whatsoever. There is only something to compare against once `update-ranges` has run at least once
 * (it is the only thing that ever writes `ip_range_sets.sha256`), so `storedSha256 === null` passes
 * trivially - this check can only ever catch a file that changed *after* a trusted baseline was
 * recorded, not validate a first-ever install of the shipped defaults.
 */
export function checkRangeIntegrity(inputs: RangeIntegrityInput[]): CheckResult[] {
  return inputs.map((input) => {
    if (input.storedSha256 === null) {
      return {
        id: `ranges.integrity.${input.name}`,
        status: 'pass',
        title: `${input.name} file integrity`,
        detail: 'no sha256 on record yet (run `openpost update-ranges` to establish a baseline)',
      };
    }
    if (input.computedSha256 === input.storedSha256) {
      return {
        id: `ranges.integrity.${input.name}`,
        status: 'pass',
        title: `${input.name} file integrity`,
        detail: 'matches the sha256 recorded at the last update-ranges run',
      };
    }
    return {
      id: `ranges.integrity.${input.name}`,
      status: 'fail',
      title: `${input.name} file integrity`,
      detail: 'file content does not match the sha256 recorded at the last `openpost update-ranges` run - it may have been edited, replaced or corrupted since',
      remedy: 'run `openpost update-ranges` again if this is expected, otherwise investigate how the file changed',
    };
  });
}

/** `notify.config` (§3.3): each channel listed in `NOTIFY_CHANNELS` has its required URL(s). */
export function checkNotifyConfig(config: AppConfig): CheckResult[] {
  if (config.notifyChannels.length === 0) {
    return [{ id: 'notify.config', status: 'pass', title: 'notification channels', detail: 'none configured (queue-only)' }];
  }
  const results: CheckResult[] = [];
  for (const channel of config.notifyChannels) {
    let ok = true;
    let detail = 'configured';
    if (channel === 'slack' && config.slackWebhookUrl === undefined) {
      ok = false;
      detail = 'SLACK_WEBHOOK_URL is not set';
    } else if (channel === 'discord' && config.discordWebhookUrl === undefined) {
      ok = false;
      detail = 'DISCORD_WEBHOOK_URL is not set';
    } else if (channel === 'webhook' && (config.webhookUrl === undefined || config.webhookSecret === undefined)) {
      ok = false;
      detail = 'WEBHOOK_URL and/or WEBHOOK_SECRET is not set';
    } else if (channel === 'ntfy' && config.ntfyTopic === undefined) {
      ok = false;
      detail = 'NTFY_TOPIC is not set';
    }
    results.push({
      id: `notify.config.${channel}`,
      status: ok ? 'pass' : 'fail',
      title: `notify channel: ${channel}`,
      detail,
    });
  }
  return results;
}

/** `pixel.reachable` (§3.3): every mismatch is its own `CheckResult` so `doctor` names exactly
 *  which property failed. Header names are lower-cased before comparison. */
export function checkPixelProbe(p: PixelProbe): CheckResult[] {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(p.headers)) headers[k.toLowerCase()] = v;

  const results: CheckResult[] = [];

  results.push(
    p.status === 200
      ? { id: 'pixel.reachable.status', status: 'pass', title: 'pixel HTTP status', detail: '200' }
      : {
          id: 'pixel.reachable.status',
          status: 'fail',
          title: 'pixel HTTP status',
          detail: `got ${p.status}`,
          remedy: 'check TRACKING_BASE_URL and that `openpost serve` is running and reachable',
        },
  );

  const contentType = headers['content-type'] ?? '';
  results.push(
    /image\/gif/i.test(contentType)
      ? { id: 'pixel.reachable.content-type', status: 'pass', title: 'pixel content-type', detail: contentType }
      : { id: 'pixel.reachable.content-type', status: 'fail', title: 'pixel content-type', detail: `got "${contentType}"` },
  );

  results.push(
    p.bodyLength === 43
      ? { id: 'pixel.reachable.length', status: 'pass', title: 'pixel body length', detail: '43 bytes' }
      : { id: 'pixel.reachable.length', status: 'fail', title: 'pixel body length', detail: `got ${p.bodyLength} bytes` },
  );

  const cacheControl = headers['cache-control'] ?? '';
  results.push(
    /no-store/i.test(cacheControl)
      ? { id: 'pixel.reachable.cache-control', status: 'pass', title: 'pixel cache-control', detail: cacheControl }
      : {
          id: 'pixel.reachable.cache-control',
          status: 'fail',
          title: 'pixel cache-control',
          detail: `missing no-store: "${cacheControl}"`,
        },
  );

  const hasValidators = headers['etag'] !== undefined || headers['last-modified'] !== undefined;
  results.push(
    !hasValidators
      ? { id: 'pixel.reachable.no-validators', status: 'pass', title: 'pixel cache validators', detail: 'none present' }
      : {
          id: 'pixel.reachable.no-validators',
          status: 'fail',
          title: 'pixel cache validators',
          detail: 'ETag/Last-Modified present - a mail client could cache the pixel and never re-fetch it',
        },
  );

  results.push(
    !p.redirected
      ? { id: 'pixel.reachable.redirect', status: 'pass', title: 'pixel redirect', detail: 'not redirected' }
      : { id: 'pixel.reachable.redirect', status: 'fail', title: 'pixel redirect', detail: 'request was redirected' },
  );

  results.push(
    p.elapsedMs < 2000
      ? { id: 'pixel.reachable.latency', status: 'pass', title: 'pixel latency', detail: `${p.elapsedMs}ms` }
      : { id: 'pixel.reachable.latency', status: 'fail', title: 'pixel latency', detail: `${p.elapsedMs}ms (>= 2000ms)` },
  );

  return results;
}

/** `click.reachable` (§3.3): a synthetic click token must 302 to the fallback URL or 404 - never a
 *  5xx or a hang (`status === null`). */
export function checkClickProbe(status: number | null): CheckResult {
  if (status === null) {
    return {
      id: 'click.reachable',
      status: 'fail',
      title: 'click endpoint',
      detail: 'request failed or timed out',
    };
  }
  if (status === 302 || status === 404) {
    return { id: 'click.reachable', status: 'pass', title: 'click endpoint', detail: `HTTP ${status}` };
  }
  return {
    id: 'click.reachable',
    status: status >= 500 ? 'fail' : 'warn',
    title: 'click endpoint',
    detail: `unexpected HTTP ${status}`,
  };
}

export interface DnsResolveResult {
  records: string[] | null;
}

/** `dns.resolve` (§3.3, needs `--url`); `records: null` means the lookup failed (NXDOMAIN etc). */
export function checkDnsResolve(records: string[] | null): CheckResult {
  if (records === null || records.length === 0) {
    return { id: 'dns.resolve', status: 'fail', title: 'DNS resolution', detail: 'no A/AAAA records (NXDOMAIN or lookup failed)' };
  }
  return { id: 'dns.resolve', status: 'pass', title: 'DNS resolution', detail: records.join(', ') };
}

export interface TlsCertInfo {
  valid: boolean;
  daysRemaining: number;
}

/** `tls.cert` (§3.3, needs `--url` + https); `info: null` means the handshake itself failed. */
export function checkTlsCert(info: TlsCertInfo | null): CheckResult {
  if (info === null) {
    return { id: 'tls.cert', status: 'fail', title: 'TLS certificate', detail: 'handshake failed' };
  }
  if (!info.valid) {
    return { id: 'tls.cert', status: 'fail', title: 'TLS certificate', detail: 'invalid certificate chain' };
  }
  if (info.daysRemaining < 7) {
    return { id: 'tls.cert', status: 'fail', title: 'TLS certificate', detail: `expires in ${info.daysRemaining} days` };
  }
  if (info.daysRemaining < 14) {
    return { id: 'tls.cert', status: 'warn', title: 'TLS certificate', detail: `expires in ${info.daysRemaining} days` };
  }
  return { id: 'tls.cert', status: 'pass', title: 'TLS certificate', detail: `valid for ${info.daysRemaining} more days` };
}

/** `dashboard.assets` (Phase 3 §2.1): the vendored `htmx.min.js` must still match the sha256
 *  recorded when it was vendored - a silently swapped asset is a supply-chain risk this catches. */
export function checkDashboardAssets(actualSha256: string, expectedSha256: string): CheckResult {
  if (actualSha256 === expectedSha256) {
    return { id: 'dashboard.assets', status: 'pass', title: 'dashboard assets', detail: 'htmx.min.js matches the recorded sha256' };
  }
  return {
    id: 'dashboard.assets',
    status: 'fail',
    title: 'dashboard assets',
    detail: `htmx.min.js sha256 mismatch (got ${actualSha256}, expected ${expectedSha256})`,
    remedy: 're-vendor src/server/assets/htmx.min.js from the pinned upstream version',
  };
}

/** `dashboard.auth` (Phase 3 §2.4): reports which auth mode the dashboard will actually use -
 *  `assertSafeToServeDashboard` already refuses an unsafe combination at startup, so this is
 *  informational except for the `open` case, which is worth a nudge even on loopback. */
export function checkDashboardAuth(config: AppConfig): CheckResult {
  if (!config.dashboardEnabled) {
    return { id: 'dashboard.auth', status: 'pass', title: 'dashboard auth', detail: 'dashboard disabled' };
  }
  if (config.apiToken !== undefined) {
    return { id: 'dashboard.auth', status: 'pass', title: 'dashboard auth', detail: 'bearer (API_TOKEN)' };
  }
  if (config.dashboardPassword !== undefined) {
    return { id: 'dashboard.auth', status: 'pass', title: 'dashboard auth', detail: 'password session (DASHBOARD_PASSWORD)' };
  }
  return {
    id: 'dashboard.auth',
    status: 'warn',
    title: 'dashboard auth',
    detail: 'no DASHBOARD_PASSWORD or API_TOKEN configured - the dashboard is reachable with no login on loopback',
    remedy: 'set DASHBOARD_PASSWORD if this instance is ever reached through a tunnel or shared machine',
  };
}

/** `reminders.pending` (Phase 3 §3.5): a `--draft` reminder cannot write a Gmail draft without the
 *  `gmail.compose` scope - warn rather than silently letting every such reminder fire with
 *  `draft_status='skipped'`. */
export function checkPendingDraftReminders(pendingDraftCount: number, hasComposeScope: boolean): CheckResult {
  if (pendingDraftCount === 0 || hasComposeScope) {
    return { id: 'reminders.pending', status: 'pass', title: 'pending draft reminders', detail: `${pendingDraftCount} pending --draft reminder(s), compose scope ${hasComposeScope ? 'present' : 'not required'}` };
  }
  return {
    id: 'reminders.pending',
    status: 'warn',
    title: 'pending draft reminders',
    detail: `${pendingDraftCount} pending --draft reminder(s) but no gmail.compose scope - they will fire with draft_status="skipped"`,
    remedy: 'run `openpost auth gmail --with-compose`',
  };
}

/** `reply.reader` (Phase 3 §4.2): reports which reader `REPLY_DETECTION=auto` resolved to, or
 *  warns when reply detection is wanted but no usable reader could be set up. */
export function checkReplyReader(configured: AppConfig['replyDetection'], resolved: 'gmail' | 'imap' | 'off'): CheckResult {
  if (configured === 'off') {
    return { id: 'reply.reader', status: 'pass', title: 'reply detection', detail: 'disabled (REPLY_DETECTION=off)' };
  }
  if (resolved === 'off') {
    return {
      id: 'reply.reader',
      status: 'warn',
      title: 'reply detection',
      detail: 'REPLY_DETECTION is not "off" but no reader could be set up',
      remedy: 'run `openpost auth gmail` (needs gmail.readonly) or set IMAP_USER/IMAP_PASS',
    };
  }
  return { id: 'reply.reader', status: 'pass', title: 'reply detection', detail: `using ${resolved}` };
}

/**
 * docs/07_recipient_semantics.md §6.3: `doctor` reports how `RECIPIENT_MODE` actually resolves for
 * this install's `MAIL_TRANSPORT` (probed against a representative 2-recipient send, since N=1
 * always resolves to per-recipient regardless), and - for `gmail-smtp` - whether the stored Gmail
 * credential carries the `https://mail.google.com/` scope SMTP submission needs.
 */
export function checkRecipientMode(
  config: Pick<AppConfig, 'recipientMode' | 'mailTransport'>,
  resolveMode: (mode: AppConfig['recipientMode'], transport: AppConfig['mailTransport'], n: number) => string,
): CheckResult {
  try {
    const resolved = resolveMode(config.recipientMode, config.mailTransport, 2);
    return {
      id: 'recipient_mode.resolves',
      status: 'pass',
      title: 'recipient mode',
      detail: `RECIPIENT_MODE=${config.recipientMode} + MAIL_TRANSPORT=${config.mailTransport} resolves to "${resolved}" for a multi-recipient send`,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      id: 'recipient_mode.resolves',
      status: 'fail',
      title: 'recipient mode',
      detail: `RECIPIENT_MODE=${config.recipientMode} + MAIL_TRANSPORT=${config.mailTransport} is impossible for a multi-recipient send: ${message}`,
      remedy: 'set MAIL_TRANSPORT=gmail-smtp, or RECIPIENT_MODE=single, or change MAIL_TRANSPORT',
    };
  }
}

/**
 * `source` mirrors `resolveTransport`'s own leniency (docs/07_recipient_semantics.md §6.2): an
 * env-sourced `GOOGLE_REFRESH_TOKEN` has no discoverable scopes, so `resolveTransport` trusts it
 * rather than refusing to start - this check does the same (`warn`, not `fail`) instead of
 * reporting a false failure for a perfectly valid env-sourced setup.
 */
export function checkGmailSmtpScope(
  mailTransport: AppConfig['mailTransport'],
  source: 'env' | 'file' | null,
  hasFullScope: boolean,
): CheckResult | null {
  if (mailTransport !== 'gmail-smtp') return null;
  if (source === null) {
    return {
      id: 'gmail_smtp.scope',
      status: 'fail',
      title: 'gmail-smtp scope',
      detail: 'no Gmail credential configured',
      remedy: 'run `openpost auth gmail --with-smtp`',
    };
  }
  if (source === 'env') {
    return {
      id: 'gmail_smtp.scope',
      status: 'warn',
      title: 'gmail-smtp scope',
      detail: 'GOOGLE_REFRESH_TOKEN is set via the environment - its scopes cannot be verified here',
      remedy: 'ensure this token was obtained with the https://mail.google.com/ scope (openpost auth gmail --with-smtp)',
    };
  }
  return hasFullScope
    ? { id: 'gmail_smtp.scope', status: 'pass', title: 'gmail-smtp scope', detail: 'https://mail.google.com/ scope present' }
    : {
        id: 'gmail_smtp.scope',
        status: 'fail',
        title: 'gmail-smtp scope',
        detail: 'the stored Gmail credential lacks the https://mail.google.com/ scope required for SMTP submission',
        remedy: 'run `openpost auth gmail --with-smtp`',
      };
}

// --- Phase 4 -------------------------------------------------------------------------------

export interface AccountsHealthInput {
  hasEncryptedSecrets: boolean;
  masterKeyError: string | null; // set when loadMasterKey() threw a SecretKeyError
  accountCount: number;
  hasDefault: boolean;
  defaultIsDisabled: boolean;
  undecryptableLabels: string[];
  /** Finding #14: the configured key's fingerprint (src/core/secretbox.ts's `keyFingerprint`) and
   *  the one recorded (finding #11) when a secret was first sealed. A mismatch is a LOUD, specific
   *  failure - "the wrong master key is configured" - rather than only surfacing later as an opaque
   *  AEAD auth failure indistinguishable from corrupted ciphertext. `null` for either side means
   *  "nothing to compare" (no setting recorded yet, or the key itself failed to load), not a match. */
  keyFingerprint?: { configured: string | null; recorded: string | null };
}

/** `accounts.key` / `accounts.default` / `accounts.secret` (docs/08_phase4_spec.md §7.5). */
export function checkAccountsHealth(input: AccountsHealthInput): CheckResult[] {
  const results: CheckResult[] = [];
  const fp = input.keyFingerprint;
  const fingerprintMismatch = fp !== undefined && fp.configured !== null && fp.recorded !== null && fp.configured !== fp.recorded;
  if (input.hasEncryptedSecrets && input.masterKeyError !== null) {
    results.push({ id: 'accounts.key', status: 'fail', title: 'account secrets master key', detail: input.masterKeyError, remedy: 'run `openpost accounts init-key` or set OPENPOST_MASTER_KEY' });
  } else if (fingerprintMismatch) {
    results.push({
      id: 'accounts.key',
      status: 'fail',
      title: 'account secrets master key',
      detail: `configured key fingerprint ${fp!.configured} does not match ${fp!.recorded}, the key that sealed existing secrets`,
      remedy: 'restore the matching keyfile, or run `openpost accounts rotate-key` if this key change was intentional',
    });
  } else {
    results.push({
      id: 'accounts.key',
      status: 'pass',
      title: 'account secrets master key',
      detail: input.hasEncryptedSecrets ? 'loaded and usable' : 'not needed yet - no encrypted secrets',
    });
  }

  if (input.accountCount > 1 && !input.hasDefault) {
    results.push({ id: 'accounts.default', status: 'warn', title: 'default account', detail: 'more than one account and none is default', remedy: 'run `openpost accounts default <ref>`' });
  } else if (input.hasDefault && input.defaultIsDisabled) {
    results.push({ id: 'accounts.default', status: 'fail', title: 'default account', detail: 'the default account is disabled', remedy: 'run `openpost accounts enable <ref>` or `openpost accounts default <other>`' });
  } else {
    results.push({ id: 'accounts.default', status: 'pass', title: 'default account', detail: input.hasDefault ? 'set' : 'none needed (env fallback)' });
  }

  if (input.undecryptableLabels.length > 0) {
    results.push({ id: 'accounts.secret', status: 'fail', title: 'account secrets', detail: `cannot decrypt: ${input.undecryptableLabels.join(', ')}`, remedy: 'check OPENPOST_MASTER_KEY / keyfile' });
  } else {
    results.push({ id: 'accounts.secret', status: 'pass', title: 'account secrets', detail: 'all decryptable' });
  }
  return results;
}

/** `backup.recent` - warns when BACKUP_ENABLED but the newest backup is stale. */
export function checkBackupRecency(input: { enabled: boolean; newestBackupAgeMs: number | null; intervalHours: number }): CheckResult | null {
  if (!input.enabled) return null;
  if (input.newestBackupAgeMs === null) {
    return { id: 'backup.recent', status: 'warn', title: 'recent backup', detail: 'no backup found yet', remedy: 'run `openpost backup` or wait for the scheduled job' };
  }
  const staleAfterMs = 2 * input.intervalHours * 60 * 60 * 1000;
  if (input.newestBackupAgeMs > staleAfterMs) {
    return { id: 'backup.recent', status: 'warn', title: 'recent backup', detail: `newest backup is ${Math.round(input.newestBackupAgeMs / 3_600_000)}h old`, remedy: 'check the scheduled backup job' };
  }
  return { id: 'backup.recent', status: 'pass', title: 'recent backup', detail: 'within the expected interval' };
}

/** `geo.db` - GEOIP_DB_PATH health (unreadable/unparseable is a fail; stale is a warn). */
/** Finding #7 (docs/reports/phase4_review.md): geo was fully written and unit-tested but never
 *  actually called from the pixel/click path - `doctor` reported it "loaded"/healthy purely from a
 *  `statSync` on GEOIP_DB_PATH, which says nothing about whether anything downstream actually uses
 *  it. Now that src/server/context.ts wires `geoForEvent`/the mmdb lookup into the redaction step,
 *  `applied` here means the SAME loader (`createMmdbLookup`) the server itself uses actually
 *  succeeded - a real, not merely file-exists, proxy for "opens/clicks will get geo tags". */
export function checkGeoDb(input: { configured: boolean; applied: boolean; notAppliedReason: string | null; ageDays: number | null; maxAgeDays: number; granularity: string; effectiveGranularity: string }): CheckResult {
  if (!input.configured) {
    return { id: 'geo.db', status: 'pass', title: 'geo database', detail: 'GEOIP_DB_PATH not set - geo disabled' };
  }
  if (!input.applied) {
    return {
      id: 'geo.db',
      status: 'fail',
      title: 'geo database',
      detail: `GEOIP_DB_PATH is configured but not applied: ${input.notAppliedReason ?? 'could not be loaded'}`,
      remedy: 'check the file path and that mmdb-lib is installed',
    };
  }
  if (input.ageDays !== null && input.ageDays > input.maxAgeDays) {
    return { id: 'geo.db', status: 'warn', title: 'geo database', detail: `mmdb file is ${input.ageDays} days old (max ${input.maxAgeDays})`, remedy: 'download a fresh GeoLite2/GeoIP2 file from MaxMind' };
  }
  const downgraded = input.granularity !== input.effectiveGranularity;
  return {
    id: 'geo.db',
    status: 'pass',
    title: 'geo database',
    detail: downgraded
      ? `loaded and applied to opens/clicks; granularity downgraded from ${input.granularity} to ${input.effectiveGranularity} by PRIVACY_MODE`
      : 'loaded and applied to opens/clicks',
  };
}

/** `api.cors` - a load-time ConfigError already prevents most of this, but a fresh install that
 *  has somehow reached doctor with an invalid combination is reported rather than silently passed. */
export function checkApiCors(input: { origins: string[]; hasApiToken: boolean }): CheckResult {
  if (input.origins.length === 0) {
    return { id: 'api.cors', status: 'pass', title: 'API CORS', detail: 'disabled (no origins configured)' };
  }
  if (!input.hasApiToken) {
    return { id: 'api.cors', status: 'fail', title: 'API CORS', detail: 'API_CORS_ORIGINS is set but API_TOKEN is not', remedy: 'set API_TOKEN or clear API_CORS_ORIGINS' };
  }
  if (input.origins.includes('*')) {
    return { id: 'api.cors', status: 'fail', title: 'API CORS', detail: 'API_CORS_ORIGINS contains "*" - only exact origins are allowed', remedy: 'list exact origins' };
  }
  return { id: 'api.cors', status: 'pass', title: 'API CORS', detail: `${input.origins.length} origin(s) allowed` };
}

// --- Phase 5 (docs/09_phase5_spec.md §7.5) ---------------------------------------------------

/** `push.keys` - pass when both keys decode to the right lengths and agree; fail when `webpush` is
 *  enabled and they do not; skip (a pass with a neutral detail) when the channel is off. The actual
 *  agreement check happens at config-load time (a `ConfigError` there is fatal); this exists so
 *  `doctor --offline` on an already-running config can still report the fact. */
export function checkPushKeys(config: AppConfig): CheckResult {
  const enabled = config.notifyChannels.includes('webpush');
  if (!enabled) {
    return { id: 'push.keys', status: 'pass', title: 'Web Push keys', detail: 'webpush channel not enabled' };
  }
  if (config.vapidPublicKey === undefined || config.vapidPrivateKey === undefined) {
    return {
      id: 'push.keys',
      status: 'fail',
      title: 'Web Push keys',
      detail: 'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not set',
      remedy: 'run `openpost push keys --write-env`',
    };
  }
  // Config load already validated length/agreement; reaching here with webpush enabled and both
  // keys present means they were accepted.
  return { id: 'push.keys', status: 'pass', title: 'Web Push keys', detail: 'VAPID key pair present and valid' };
}

/** `push.secure_context` - browsers refuse to register a service worker (and therefore Web Push)
 *  outside a secure context; loopback is exempt for local testing. */
export function checkPushSecureContext(trackingBaseUrl: string): CheckResult {
  let isHttps = false;
  let isLoopback = false;
  try {
    const url = new URL(trackingBaseUrl);
    isHttps = url.protocol === 'https:';
    isLoopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
  } catch {
    // fall through to warn below
  }
  if (isHttps || isLoopback) {
    return { id: 'push.secure_context', status: 'pass', title: 'secure context', detail: isHttps ? 'https' : 'loopback (exempt)' };
  }
  return {
    id: 'push.secure_context',
    status: 'warn',
    title: 'secure context',
    detail: `TRACKING_BASE_URL (${trackingBaseUrl}) is neither https nor loopback`,
    remedy: 'browsers refuse to register a service worker (and therefore Web Push) outside a secure context',
  };
}

/** `push.subscriptions` - pass with >=1 active; warn at 0 when `webpush` is enabled. */
export function checkPushSubscriptions(config: AppConfig, activeCount: number): CheckResult {
  if (!config.notifyChannels.includes('webpush')) {
    return { id: 'push.subscriptions', status: 'pass', title: 'push subscriptions', detail: 'webpush channel not enabled' };
  }
  if (activeCount === 0) {
    return {
      id: 'push.subscriptions',
      status: 'warn',
      title: 'push subscriptions',
      detail: 'no device has subscribed yet',
      remedy: 'open /dashboard/settings on your phone and tap "Enable on this device"',
    };
  }
  return { id: 'push.subscriptions', status: 'pass', title: 'push subscriptions', detail: `${activeCount} active device(s)` };
}

/** `pwa.assets` - fails when any of `sw.js`, `manifest.webmanifest` or the four icons is missing or
 *  its sha256 differs from the recorded constant (the same pattern `dashboard.assets` already uses
 *  for the vendored htmx file). */
export function checkPwaAssets(input: { name: string; actualSha256: string | null; expectedSha256: string }[]): CheckResult {
  const missing = input.filter((i) => i.actualSha256 === null).map((i) => i.name);
  const mismatched = input.filter((i) => i.actualSha256 !== null && i.actualSha256 !== i.expectedSha256).map((i) => i.name);
  if (missing.length === 0 && mismatched.length === 0) {
    return { id: 'pwa.assets', status: 'pass', title: 'PWA assets', detail: `${input.length} icon(s) verified` };
  }
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing: ${missing.join(', ')}`);
  if (mismatched.length > 0) parts.push(`sha256 mismatch: ${mismatched.join(', ')}`);
  return {
    id: 'pwa.assets',
    status: 'fail',
    title: 'PWA assets',
    detail: parts.join('; '),
    remedy: 'run `node scripts/gen-icons.mjs` to regenerate the committed icons',
  };
}

/** `addon.config` - fails when `ADDON_ENABLED=true` with no `API_TOKEN` (already a load-time
 *  ConfigError, so unreachable in practice - defence in depth), or with a loopback
 *  `TRACKING_BASE_URL` (Google's servers, not the operator's phone, make the `UrlFetchApp` call, so
 *  a loopback-only instance can never work with the add-on). */
export function checkAddonConfig(config: AppConfig): CheckResult {
  if (!config.addonEnabled) {
    return { id: 'addon.config', status: 'pass', title: 'Gmail add-on', detail: 'disabled' };
  }
  if (config.apiToken === undefined) {
    return { id: 'addon.config', status: 'fail', title: 'Gmail add-on', detail: 'ADDON_ENABLED=true but API_TOKEN is not set', remedy: 'set API_TOKEN' };
  }
  try {
    const url = new URL(config.trackingBaseUrl);
    const isLoopback = url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === 'localhost';
    if (isLoopback) {
      return {
        id: 'addon.config',
        status: 'fail',
        title: 'Gmail add-on',
        detail: `TRACKING_BASE_URL (${config.trackingBaseUrl}) is loopback`,
        remedy: "Google's servers, not your phone, make the UrlFetchApp call - the add-on needs a publicly reachable HTTPS hostname",
      };
    }
  } catch {
    // malformed TRACKING_BASE_URL is already caught elsewhere (checkBaseUrl)
  }
  return { id: 'addon.config', status: 'pass', title: 'Gmail add-on', detail: 'enabled and reachable in principle' };
}

export function summarise(results: CheckResult[]): { ok: boolean; pass: number; warn: number; fail: number } {
  let pass = 0;
  let warn = 0;
  let fail = 0;
  for (const r of results) {
    if (r.status === 'pass') pass += 1;
    else if (r.status === 'warn') warn += 1;
    else fail += 1;
  }
  return { ok: fail === 0, pass, warn, fail };
}
