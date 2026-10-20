import 'dotenv/config';
import { createHmac } from 'node:crypto';
import { ipToBigInt, parseCidr } from '../core/cidr.js';
import { isValidTimeZone } from '../core/time.js';
import { vapidPublicKeyFromPrivate } from '../core/webpush.js';
import type { PrivacyMode, RecipientModeOption, TransportName } from '../types.js';
// Type-only import: notify/types.ts imports `AppConfig` from this module (for NotifierDeps), and
// this module imports these two string-literal union types back from notify/types.ts. Both sides
// use `import type`, so this never becomes a runtime circular dependency (it erases entirely).
import type { ChannelName, NotifyTrigger } from '../notify/types.js';

export type { ChannelName, NotifyTrigger };

/** Accepted by Fastify's own `trustProxy` option: off, a hop count, or a CIDR/IP allowlist. */
export type TrustProxyConfig = false | number | string[];

export type SelfOpenStrategy = 'window' | 'insert' | 'imap-append';

export interface AppConfig {
  trackingSecret: string | undefined;
  trackingSecretPrevious: string | undefined;
  ipSalt: string;
  /** Finding #14: true when neither IP_SALT nor TRACKING_SECRET is set, so `ipSalt` fell back to a
   *  hard-coded, publicly-known constant baked into this source tree - fine for IP hashing (it only
   *  needs to be unpredictable to someone without the codebase, and rotates daily regardless), but
   *  never acceptable for `forget`'s audit-log subject hash, which is meant to prove *which*
   *  install erased *which* address without ever naming it - a known salt makes that hash a
   *  dictionary/rainbow-table target. */
  ipSaltIsDefault: boolean;
  trackingBaseUrl: string;
  dbPath: string;
  port: number;
  bindAddress: string;
  trustProxy: TrustProxyConfig;
  /** Non-fatal startup warning surfaced when TRUST_PROXY=true was collapsed to hop count 1. */
  trustProxyWarning: string | null;
  privacyMode: PrivacyMode;
  respectDnt: boolean;
  openIgnoreSeconds: number;
  proxyPrefetchSeconds: number;
  mppWindowSeconds: number;
  dedupeSeconds: number;
  scannerFanout: number;
  selfIpHashes: string[];
  selfUaPatterns: RegExp[];
  retentionDays: number;
  trackingFallbackUrl: string | undefined;
  outDir: string;
  mailTransport: TransportName;
  smtpHost: string | undefined;
  smtpPort: number;
  smtpUser: string | undefined;
  smtpPass: string | undefined;
  smtpSecure: boolean;
  googleClientId: string | undefined;
  googleClientSecret: string | undefined;
  googleRefreshToken: string | undefined;
  /** docs/07_recipient_semantics.md §6.3. */
  recipientMode: RecipientModeOption;
  gmailSmtpHost: string;
  gmailSmtpPort: number;
  fromEmail: string | undefined;
  fromName: string | undefined;
  apiToken: string | undefined;
  logLevel: string;

  // --- Phase 2: notifications --------------------------------------------------------------
  notifyEnabled: boolean;
  notifyChannels: ChannelName[];
  notifyOn: NotifyTrigger[];
  notifyMaxAttempts: number;
  notifyBackoffBaseMs: number;
  notifyTickSeconds: number;
  notifyTimeoutMs: number;
  notifyIncludeSubject: boolean;
  notifyRedactEmail: boolean;
  /** Finding #4 (phase5.1): the same escape hatch every operator-configured notify URL
   *  (SLACK_WEBHOOK_URL/DISCORD_WEBHOOK_URL/WEBHOOK_URL/NTFY_URL) already honours, now also read by
   *  `isValidPushEndpoint` (`src/server/routes/dashboard-actions.ts`) so a client-submitted Web Push
   *  endpoint is held to the same private/loopback/link-local policy. */
  notifyAllowPrivateUrls: boolean;
  slackWebhookUrl: string | undefined;
  discordWebhookUrl: string | undefined;
  webhookUrl: string | undefined;
  webhookSecret: string | undefined;
  ntfyUrl: string;
  ntfyTopic: string | undefined;
  ntfyToken: string | undefined;
  ntfyPriority: string;
  sseEnabled: boolean;
  sseHeartbeatSeconds: number;
  sseMaxClients: number;

  // --- Phase 2: accuracy ----------------------------------------------------------------
  trackClicksDefault: boolean;
  clickBackfillOpens: boolean;
  rangesDir: string;
  rangesEnabled: boolean;
  selfOpenStrategy: SelfOpenStrategy;
  imapHost: string;
  imapPort: number;
  imapUser: string | undefined;
  imapPass: string | undefined;
  imapSentMailbox: string;

  // --- Phase 2: privacy/ops -------------------------------------------------------------
  pruneEnabled: boolean;
  pruneIntervalHours: number;
  pruneOnStart: boolean;
  pruneVacuumThreshold: number;
  jobsEnabled: boolean;
  openpostConfigDir: string | undefined;
  doctorTimeoutMs: number;

  // --- Phase 3: dashboard -----------------------------------------------------------------
  dashboardEnabled: boolean;
  dashboardLive: boolean;
  dashboardBind: string;
  dashboardPort: number;
  dashboardPassword: string | undefined;
  dashboardSessionHours: number;
  /** `'auto'` resolves to `true` iff `trackingBaseUrl` is `https:` (§2.4). */
  dashboardSecureCookies: boolean | 'auto';
  dashboardPageSize: number;
  dashboardMaxExportRows: number;
  dashboardLoginRatePerMin: number;
  reportTimezone: string;
  /** Phase 3.1 (M6): default `/dashboard/stats` and unwindowed `/api/stats` calls to the last N
   *  days rather than all-time, and refuse to compute stats over a window wider than
   *  `statsMaxWindowDays` - both bound how many recipient rows a single request can aggregate. */
  statsDefaultWindowDays: number;
  statsMaxWindowDays: number;

  // --- Phase 3: reminders -----------------------------------------------------------------
  remindersEnabled: boolean;
  reminderTickSeconds: number;
  reminderLeaseMs: number;
  reminderMaxAttempts: number;
  reminderMaxHorizonDays: number;
  reminderDefaultCondition: 'no_reply' | 'no_open' | 'always';

  // --- Phase 3: reply detection -----------------------------------------------------------
  replyDetection: 'auto' | 'off' | 'gmail' | 'imap';
  replyPollSeconds: number;
  replyPollBatch: number;
  replyWatchDays: number;
  replyQuotaUnitsPerMin: number;
  replyIgnoreSenders: string[];
  imapAllMailMailbox: string;

  // --- Phase 4: campaigns ------------------------------------------------------------------
  campaignsEnabled: boolean;
  campaignTickSeconds: number;
  campaignRatePerMinute: number;
  campaignJitterMs: number;
  campaignLeaseMs: number;
  campaignMaxAttempts: number;
  campaignDailyCap: number;
  campaignMaxRows: number;
  campaignDigestMinutes: number;
  notifyCampaignMode: 'off' | 'digest' | 'per-open';

  // --- Phase 4: multi-account secrets -----------------------------------------------------
  openpostMasterKeyFile: string;

  // --- Phase 4: backup -----------------------------------------------------------------------
  backupEnabled: boolean;
  backupDir: string;
  backupIntervalHours: number;
  backupKeep: number;
  backupGzip: boolean;

  // --- Phase 4: geo --------------------------------------------------------------------------
  geoipDbPath: string | undefined;
  geoipGranularity: 'country' | 'region' | 'city';
  geoipMaxAgeDays: number;

  // --- Phase 4: in-Gmail checkmarks server half --------------------------------------------
  apiCorsOrigins: string[];
  threadLookupDays: number;

  // --- Phase 5: mobile compose + PWA -------------------------------------------------------
  composeEnabled: boolean;
  composeMaxRecipients: number;
  composeMaxBodyBytes: number;
  composeRatePerHour: number;
  pwaEnabled: boolean;

  // --- Phase 5: Web Push ---------------------------------------------------------------------
  vapidPublicKey: string | undefined;
  vapidPrivateKey: string | undefined;
  vapidSubject: string;
  pushTtlSeconds: number;
  pushUrgency: string;
  pushMaxSubscriptions: number;
  pushMaxFailures: number;

  // --- Phase 5: email-to-self + daily digest ------------------------------------------------
  notifyEmailTo: string | undefined;
  notifyEmailFrom: string | undefined;
  digestDailyAt: string | undefined;
  digestTimezone: string;

  // --- Phase 5: Gmail add-on (experimental) -------------------------------------------------
  addonEnabled: boolean;
  addonRatePerHour: number;
  addonLinkTimeoutHours: number;
}

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export interface LoadConfigOptions {
  /** Set false for commands (e.g. `init`) that must run before a secret exists. Default true. */
  requireSecret?: boolean;
}

const PRIVACY_MODES: PrivacyMode[] = ['off', 'balanced', 'strict'];
const TRANSPORTS: TransportName[] = ['dryrun', 'smtp', 'gmail', 'gmail-smtp'];
const RECIPIENT_MODES: RecipientModeOption[] = ['auto', 'per-recipient', 'single'];

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== '' ? v : undefined;
}

function parseBool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v.trim() === '') return def;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function parseIntBounded(
  name: string,
  v: string | undefined,
  def: number,
  issues: string[],
  opts: { min?: number } = {},
): number {
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || (opts.min !== undefined && n < opts.min)) {
    issues.push(`${name} must be an integer${opts.min !== undefined ? ` >= ${opts.min}` : ''}`);
    return def;
  }
  return n;
}

function parseList(v: string | undefined): string[] {
  if (v === undefined || v.trim() === '') return [];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Finding #8: bound both the number and the size of operator-supplied regexes so a misconfigured
// (or malicious) SELF_UA_PATTERNS cannot become a ReDoS vector - see also classify.ts's UA-length
// cap, which bounds the *input* these patterns ever run against.
const SELF_UA_PATTERNS_MAX_COUNT = 20;
const SELF_UA_PATTERN_MAX_LEN = 200;

function parsePatternList(name: string, v: string | undefined, issues: string[]): RegExp[] {
  const sources = parseList(v);
  if (sources.length > SELF_UA_PATTERNS_MAX_COUNT) {
    issues.push(`${name} may contain at most ${SELF_UA_PATTERNS_MAX_COUNT} patterns`);
    return [];
  }
  const patterns: RegExp[] = [];
  for (const src of sources) {
    if (src.length > SELF_UA_PATTERN_MAX_LEN) {
      issues.push(`${name} pattern exceeds ${SELF_UA_PATTERN_MAX_LEN} characters: ${src.slice(0, 40)}...`);
      continue;
    }
    try {
      patterns.push(new RegExp(src, 'i'));
    } catch {
      issues.push(`${name} contains an invalid regular expression: ${src}`);
    }
  }
  return patterns;
}

/** Derives a default IP_SALT from TRACKING_SECRET via HMAC with a fixed label (HKDF-style),
 *  rather than reusing the secret's raw bytes as the salt (finding #13). */
function deriveDefaultIpSalt(trackingSecret: string | undefined): string {
  const keyMaterial = trackingSecret ?? 'openpost-default-salt';
  return createHmac('sha256', keyMaterial).update('openpost:ip-salt:v1').digest('hex');
}

export interface TrustProxyParseResult {
  value: TrustProxyConfig;
  warning: string | null;
}

/** TRUST_PROXY accepts: unset/false (no proxy trusted), `true` (collapsed to hop count 1, with a
 *  startup warning), an integer hop count, or a comma-separated CIDR/IP allowlist (finding #5). */
export function parseTrustProxy(v: string | undefined, issues: string[]): TrustProxyParseResult {
  if (v === undefined || v.trim() === '') return { value: false, warning: null };
  const trimmed = v.trim();
  if (/^(false|0)$/i.test(trimmed)) return { value: false, warning: null };
  if (/^true$/i.test(trimmed)) {
    return {
      value: 1,
      warning:
        'TRUST_PROXY=true trusts exactly one proxy hop (hop count 1); set an explicit hop count ' +
        'or a comma-separated CIDR list if your topology has more than one trusted proxy.',
    };
  }
  if (/^\d+$/.test(trimmed)) {
    const hops = Number(trimmed);
    return { value: hops === 0 ? false : hops, warning: null };
  }
  const list = parseList(trimmed);
  if (list.length === 0) {
    issues.push('TRUST_PROXY must be false, true, an integer hop count, or a comma-separated CIDR list');
    return { value: false, warning: null };
  }
  return { value: list, warning: null };
}

/** `127.0.0.1`, `::1`, `localhost`, or any `127.0.0.0/8` address. */
export function isLoopbackAddress(addr: string): boolean {
  return addr === '127.0.0.1' || addr === '::1' || addr === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr);
}

// Finding #9: SLACK_WEBHOOK_URL/DISCORD_WEBHOOK_URL/WEBHOOK_URL/NTFY_URL are validated at config
// load time, not merely used as-is - an operator-supplied malformed or internal-network URL only
// ever surfaces (via NOTIFY_ALLOW_PRIVATE_URLS aside) as a startup error, never as a runtime SSRF
// probe against the server's own private network every time the worker ticks.
const PRIVATE_HOST_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '0.0.0.0/8',
  '::1/128',
  'fe80::/10',
  'fc00::/7',
];

/** True for `localhost` or any literal IP address inside a private/loopback/link-local range.
 *  A non-literal public hostname (the common case) is deliberately treated as *not* private here -
 *  full SSRF protection would need to resolve DNS at request time and is out of scope; this catches
 *  the operator-facing footgun of pointing a webhook straight at an internal address. */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  // A `URL`'s `.hostname` keeps the surrounding brackets for an IPv6 literal host (`[::1]`) -
  // `ipToBigInt` expects the bare address, so strip them first or every bracketed IPv6 literal
  // (including plain loopback, `[::1]`) would parse as null and slip through as "not private".
  const bare = hostname.length >= 2 && hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (bare.toLowerCase() === 'localhost') return true;
  const parsed = ipToBigInt(bare);
  if (parsed === null) return false;
  for (const cidr of PRIVATE_HOST_CIDRS) {
    const range = parseCidr(cidr);
    if (range && range.v6 === parsed.v6 && parsed.value >= range.start && parsed.value <= range.end) {
      return true;
    }
  }
  return false;
}

/** Validates a notification-channel URL (SLACK_WEBHOOK_URL, DISCORD_WEBHOOK_URL, WEBHOOK_URL,
 *  NTFY_URL): must parse, must be http/https, and - unless `allowPrivate` (NOTIFY_ALLOW_PRIVATE_URLS)
 *  - must not point at a loopback/link-local/RFC1918 address, closing off the easiest
 *  server-side-request-forgery target (the tracking server's own internal network) for a value an
 *  operator pastes in from a compromised or untrusted source. Pushes onto `issues` and returns
 *  nothing on failure, mirroring every other validator in this module. */
function validateNotifyUrl(name: string, value: string, allowPrivate: boolean, issues: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push(`${name} is not a valid URL`);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    issues.push(`${name} must use http or https`);
    return;
  }
  if (!allowPrivate && isPrivateOrLoopbackHost(parsed.hostname)) {
    issues.push(
      `${name} points at a loopback/private-network host (${parsed.hostname}) - set NOTIFY_ALLOW_PRIVATE_URLS=true if this is intentional (e.g. local testing)`,
    );
  }
}

/**
 * Refuses to let the server start unauthenticated on a network-reachable bind: a non-loopback
 * BIND_ADDRESS, or TRUST_PROXY enabled (which makes `req.ip` reflect a client-supplied header),
 * requires API_TOKEN to be set (finding #2). Called by `openpost serve`, not by `loadConfig`
 * itself, so tests and library callers that build a server for `app.inject()` are unaffected.
 */
export function assertSafeToBind(config: AppConfig): void {
  const loopback = isLoopbackAddress(config.bindAddress);
  const trustProxyEnabled = config.trustProxy !== false;
  if ((!loopback || trustProxyEnabled) && !config.apiToken) {
    throw new ConfigError([
      'API_TOKEN is required when BIND_ADDRESS is not loopback or TRUST_PROXY is enabled ' +
        '(refusing to start unauthenticated on a network-reachable bind)',
    ]);
  }
}

/**
 * Refuses to serve the dashboard on a network-reachable bind with no auth secret configured (Phase
 * 3 §2.4, DoD 5). `effectiveBind` is the address the dashboard will actually be reached on
 * (`DASHBOARD_BIND`, defaulting to `BIND_ADDRESS`). Also refuses a `DASHBOARD_BIND` that names a
 * non-loopback address different from the effective server bind - a configuration that cannot mean
 * anything - and, when a secret *is* configured, prints a one-line warning to stderr for a
 * non-loopback `DASHBOARD_BIND` rather than refusing to start.
 */
export function assertSafeToServeDashboard(config: AppConfig, effectiveBind: string, serverBindAddress?: string): void {
  if (!config.dashboardEnabled) return;
  const loopback = isLoopbackAddress(effectiveBind);
  const trustProxyEnabled = config.trustProxy !== false;
  const hasSecret = config.dashboardPassword !== undefined || config.apiToken !== undefined;
  if ((!loopback || trustProxyEnabled) && !hasSecret) {
    throw new ConfigError([
      'DASHBOARD_PASSWORD (or API_TOKEN) is required when the dashboard is reachable off loopback ' +
        '(BIND_ADDRESS=0.0.0.0 or TRUST_PROXY enabled) - refusing to serve a dashboard with no auth',
    ]);
  }
  // Phase 3.1 (L8): in a single-process bind (`openpost serve`), the dashboard is actually reached
  // wherever the WHOLE server is bound, never at DASHBOARD_BIND alone - so a DASHBOARD_BIND that
  // names a loopback address while `serverBindAddress` (the real listen address) is not loopback
  // would otherwise fool the check above into skipping the "requires a secret" refusal entirely.
  // `assertSafeToBind` already independently requires API_TOKEN for a non-loopback bind, so this is
  // defence in depth (no reachable hole today) rather than closing an active one.
  if (serverBindAddress !== undefined && loopback && !isLoopbackAddress(serverBindAddress)) {
    throw new ConfigError([
      `DASHBOARD_BIND (${effectiveBind}) names a loopback address but the server itself is bound to ` +
        `${serverBindAddress}, which is not loopback - the dashboard is reachable wherever the server ` +
        'is reachable; set DASHBOARD_BIND to match (or leave it unset), or run `openpost dashboard` in ' +
        'split mode instead',
    ]);
  }
  if (!loopback && hasSecret) {
    process.stderr.write(
      `warning: DASHBOARD_BIND (${effectiveBind}) is not loopback - the dashboard is reachable ` +
        'from off this machine\n',
    );
  }
}

/**
 * Loads and validates configuration from `env` (pure w.r.t. the object passed, so tests can pass
 * literals). Throws ConfigError listing every missing/invalid variable.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  opts: LoadConfigOptions = {},
): AppConfig {
  const requireSecret = opts.requireSecret ?? true;
  const issues: string[] = [];

  const trackingSecret = nonEmpty(env.TRACKING_SECRET);
  if (requireSecret && trackingSecret === undefined) {
    issues.push('TRACKING_SECRET is required (>= 32 characters)');
  } else if (trackingSecret !== undefined && trackingSecret.length < 32) {
    issues.push('TRACKING_SECRET must be at least 32 characters');
  }

  const trackingSecretPrevious = nonEmpty(env.TRACKING_SECRET_PREVIOUS);
  if (trackingSecretPrevious !== undefined && trackingSecretPrevious.length < 32) {
    issues.push('TRACKING_SECRET_PREVIOUS must be at least 32 characters');
  }

  const ipSaltIsDefault = nonEmpty(env.IP_SALT) === undefined && trackingSecret === undefined;
  const ipSalt = nonEmpty(env.IP_SALT) ?? deriveDefaultIpSalt(trackingSecret);

  let trackingBaseUrl = nonEmpty(env.TRACKING_BASE_URL) ?? 'http://127.0.0.1:8787';
  trackingBaseUrl = trackingBaseUrl.replace(/\/+$/, '');

  const dbPath = nonEmpty(env.DB_PATH) ?? './data/openpost.db';

  const port = parseIntBounded('PORT', env.PORT, 8787, issues, { min: 1 });
  const bindAddress = nonEmpty(env.BIND_ADDRESS) ?? '127.0.0.1';
  const trustProxyParsed = parseTrustProxy(env.TRUST_PROXY, issues);
  const trustProxy = trustProxyParsed.value;
  const trustProxyWarning = trustProxyParsed.warning;

  const privacyModeRaw = nonEmpty(env.PRIVACY_MODE) ?? 'balanced';
  if (!PRIVACY_MODES.includes(privacyModeRaw as PrivacyMode)) {
    issues.push(`PRIVACY_MODE must be one of ${PRIVACY_MODES.join(', ')}`);
  }
  const privacyMode: PrivacyMode = PRIVACY_MODES.includes(privacyModeRaw as PrivacyMode)
    ? (privacyModeRaw as PrivacyMode)
    : 'balanced';

  const respectDnt = parseBool(env.RESPECT_DNT, true);

  const openIgnoreSeconds = parseIntBounded('OPEN_IGNORE_SECONDS', env.OPEN_IGNORE_SECONDS, 10, issues, {
    min: 0,
  });
  const proxyPrefetchSeconds = parseIntBounded(
    'PROXY_PREFETCH_SECONDS',
    env.PROXY_PREFETCH_SECONDS,
    60,
    issues,
    { min: 0 },
  );
  const mppWindowSeconds = parseIntBounded('MPP_WINDOW_SECONDS', env.MPP_WINDOW_SECONDS, 900, issues, {
    min: 0,
  });
  const dedupeSeconds = parseIntBounded('DEDUPE_SECONDS', env.DEDUPE_SECONDS, 30, issues, { min: 0 });
  const scannerFanout = parseIntBounded('SCANNER_FANOUT', env.SCANNER_FANOUT, 5, issues, { min: 1 });

  const selfIpHashes = parseList(env.SELF_IP_HASHES);
  const selfUaPatterns = parsePatternList('SELF_UA_PATTERNS', env.SELF_UA_PATTERNS, issues);

  const retentionDays = parseIntBounded('RETENTION_DAYS', env.RETENTION_DAYS, 365, issues, { min: 1 });

  const trackingFallbackUrl = nonEmpty(env.TRACKING_FALLBACK_URL);
  const outDir = nonEmpty(env.OUT_DIR) ?? './out';

  const mailTransportRaw = nonEmpty(env.MAIL_TRANSPORT) ?? 'dryrun';
  if (!TRANSPORTS.includes(mailTransportRaw as TransportName)) {
    issues.push(`MAIL_TRANSPORT must be one of ${TRANSPORTS.join(', ')}`);
  }
  const mailTransport: TransportName = TRANSPORTS.includes(mailTransportRaw as TransportName)
    ? (mailTransportRaw as TransportName)
    : 'dryrun';

  const smtpHost = nonEmpty(env.SMTP_HOST);
  const smtpPort = parseIntBounded('SMTP_PORT', env.SMTP_PORT, 587, issues, { min: 1 });
  const smtpUser = nonEmpty(env.SMTP_USER);
  const smtpPass = nonEmpty(env.SMTP_PASS);
  const smtpSecure = parseBool(env.SMTP_SECURE, false);
  if (mailTransport === 'smtp' && smtpHost === undefined) {
    issues.push('SMTP_HOST is required when MAIL_TRANSPORT=smtp');
  }

  const googleClientId = nonEmpty(env.GOOGLE_CLIENT_ID);
  const googleClientSecret = nonEmpty(env.GOOGLE_CLIENT_SECRET);
  const googleRefreshToken = nonEmpty(env.GOOGLE_REFRESH_TOKEN);
  if (mailTransport === 'gmail') {
    if (googleClientId === undefined) issues.push('GOOGLE_CLIENT_ID is required when MAIL_TRANSPORT=gmail');
    if (googleClientSecret === undefined)
      issues.push('GOOGLE_CLIENT_SECRET is required when MAIL_TRANSPORT=gmail');
    if (googleRefreshToken === undefined)
      issues.push('GOOGLE_REFRESH_TOKEN is required when MAIL_TRANSPORT=gmail');
  }

  // docs/07_recipient_semantics.md §6.3: gmail-smtp reuses the gmail OAuth credential shape, but
  // authenticates against smtp.gmail.com via XOAUTH2 rather than the REST API.
  const gmailSmtpHost = nonEmpty(env.GMAIL_SMTP_HOST) ?? 'smtp.gmail.com';
  const gmailSmtpPort = parseIntBounded('GMAIL_SMTP_PORT', env.GMAIL_SMTP_PORT, 465, issues, { min: 1 });
  if (mailTransport === 'gmail-smtp') {
    if (googleClientId === undefined) issues.push('GOOGLE_CLIENT_ID is required when MAIL_TRANSPORT=gmail-smtp');
    if (googleClientSecret === undefined)
      issues.push('GOOGLE_CLIENT_SECRET is required when MAIL_TRANSPORT=gmail-smtp');
    // Deliberately NOT requiring GOOGLE_REFRESH_TOKEN here (unlike MAIL_TRANSPORT=gmail below): the
    // documented gmail-smtp setup path is `openpost auth gmail --with-smtp`, which stores the token
    // on disk rather than in the environment - `resolveTransport` resolves env-or-file at runtime
    // and throws its own GmailAuthError (naming that exact remedy) when neither is available.
    if (nonEmpty(env.FROM_EMAIL) === undefined)
      issues.push('FROM_EMAIL is required when MAIL_TRANSPORT=gmail-smtp (used as the XOAUTH2 identity)');
  }

  // docs/07_recipient_semantics.md §3.3/§6.3: RECIPIENT_MODE=per-recipient is a config-time error
  // when paired with MAIL_TRANSPORT=gmail - always impossible (there is no envelope override),
  // regardless of how many recipients any particular send has, so this is caught here rather than
  // only at send time (`resolveRecipientMode` throws the same class of error for a runtime
  // `--recipient-mode`/`--transport` override that lands on this same impossible combination).
  const recipientModeRaw = nonEmpty(env.RECIPIENT_MODE) ?? 'auto';
  if (!RECIPIENT_MODES.includes(recipientModeRaw as RecipientModeOption)) {
    issues.push(`RECIPIENT_MODE must be one of ${RECIPIENT_MODES.join(', ')}`);
  }
  const recipientMode: RecipientModeOption = RECIPIENT_MODES.includes(recipientModeRaw as RecipientModeOption)
    ? (recipientModeRaw as RecipientModeOption)
    : 'auto';
  if (recipientMode === 'per-recipient' && mailTransport === 'gmail') {
    issues.push(
      'RECIPIENT_MODE=per-recipient is not possible with MAIL_TRANSPORT=gmail (the Gmail REST API has no ' +
        'envelope override) - set MAIL_TRANSPORT=gmail-smtp, or RECIPIENT_MODE=single',
    );
  }

  const fromEmail = nonEmpty(env.FROM_EMAIL);
  const fromName = nonEmpty(env.FROM_NAME);
  const apiToken = nonEmpty(env.API_TOKEN);
  const logLevel = nonEmpty(env.LOG_LEVEL) ?? 'info';

  // --- Phase 2: notifications --------------------------------------------------------------
  // Phase 5 (§4, §5): 'webpush' (Web Push to the operator's own devices) and 'email' (email-to-self)
  // join the existing four channels.
  const CHANNELS: ChannelName[] = ['slack', 'discord', 'webhook', 'ntfy', 'webpush', 'email'];
  // Phase 3 (§3.6): widened additively - `reply`/`reminder` join the existing four triggers.
  // `campaign_digest`/`daily_digest` are deliberately absent here (as `campaign_digest` always was):
  // neither is ever produced by `decideTriggers`/settable via NOTIFY_ON - the digest jobs enqueue
  // them directly for every configured channel.
  const TRIGGERS: NotifyTrigger[] = ['first_open', 'read_confirmed', 'click', 'prefetched', 'reply', 'reminder'];

  const notifyEnabled = parseBool(env.NOTIFY_ENABLED, true);
  const notifyChannelsRaw = parseList(env.NOTIFY_CHANNELS);
  const notifyChannels: ChannelName[] = [];
  for (const c of notifyChannelsRaw) {
    if (CHANNELS.includes(c as ChannelName)) {
      notifyChannels.push(c as ChannelName);
    } else {
      issues.push(`NOTIFY_CHANNELS contains an unknown channel: ${c}`);
    }
  }
  // Phase 3 (§3.6): the default gains `reply,reminder` - no existing test asserts the old default
  // (verified before this change).
  const notifyOnRaw = nonEmpty(env.NOTIFY_ON) !== undefined
    ? parseList(env.NOTIFY_ON)
    : ['first_open', 'read_confirmed', 'click', 'reply', 'reminder'];
  const notifyOn: NotifyTrigger[] = [];
  for (const t of notifyOnRaw) {
    if (TRIGGERS.includes(t as NotifyTrigger)) {
      notifyOn.push(t as NotifyTrigger);
    } else {
      issues.push(`NOTIFY_ON contains an unknown trigger: ${t}`);
    }
  }
  const notifyMaxAttempts = parseIntBounded('NOTIFY_MAX_ATTEMPTS', env.NOTIFY_MAX_ATTEMPTS, 4, issues, {
    min: 1,
  });
  const notifyBackoffBaseMs = parseIntBounded(
    'NOTIFY_BACKOFF_BASE_MS',
    env.NOTIFY_BACKOFF_BASE_MS,
    1000,
    issues,
    { min: 1 },
  );
  const notifyTickSeconds = parseIntBounded('NOTIFY_TICK_SECONDS', env.NOTIFY_TICK_SECONDS, 5, issues, {
    min: 1,
  });
  const notifyTimeoutMs = parseIntBounded('NOTIFY_TIMEOUT_MS', env.NOTIFY_TIMEOUT_MS, 5000, issues, {
    min: 1,
  });
  const notifyIncludeSubject = parseBool(env.NOTIFY_INCLUDE_SUBJECT, true);
  const notifyRedactEmail = parseBool(env.NOTIFY_REDACT_EMAIL, false);
  // Finding #9: opt-in escape hatch for a deliberately local/private notify URL (e.g. the smoke-test
  // fake receiver, or a webhook proxy on the same host) - every URL below is otherwise rejected if
  // it resolves to a loopback/link-local/RFC1918 literal.
  const notifyAllowPrivateUrls = parseBool(env.NOTIFY_ALLOW_PRIVATE_URLS, false);

  const slackWebhookUrl = nonEmpty(env.SLACK_WEBHOOK_URL);
  if (notifyChannels.includes('slack') && slackWebhookUrl === undefined) {
    issues.push('SLACK_WEBHOOK_URL is required when NOTIFY_CHANNELS includes slack');
  }
  if (slackWebhookUrl !== undefined) {
    validateNotifyUrl('SLACK_WEBHOOK_URL', slackWebhookUrl, notifyAllowPrivateUrls, issues);
  }
  const discordWebhookUrl = nonEmpty(env.DISCORD_WEBHOOK_URL);
  if (notifyChannels.includes('discord') && discordWebhookUrl === undefined) {
    issues.push('DISCORD_WEBHOOK_URL is required when NOTIFY_CHANNELS includes discord');
  }
  if (discordWebhookUrl !== undefined) {
    validateNotifyUrl('DISCORD_WEBHOOK_URL', discordWebhookUrl, notifyAllowPrivateUrls, issues);
  }
  const webhookUrl = nonEmpty(env.WEBHOOK_URL);
  const webhookSecret = nonEmpty(env.WEBHOOK_SECRET);
  if (webhookUrl !== undefined && webhookSecret === undefined) {
    issues.push('WEBHOOK_SECRET is required when WEBHOOK_URL is set');
  }
  if (notifyChannels.includes('webhook') && webhookUrl === undefined) {
    issues.push('WEBHOOK_URL is required when NOTIFY_CHANNELS includes webhook');
  }
  if (webhookUrl !== undefined) {
    validateNotifyUrl('WEBHOOK_URL', webhookUrl, notifyAllowPrivateUrls, issues);
  }
  const ntfyUrl = (nonEmpty(env.NTFY_URL) ?? 'https://ntfy.sh').replace(/\/+$/, '');
  if (nonEmpty(env.NTFY_URL) !== undefined) {
    validateNotifyUrl('NTFY_URL', ntfyUrl, notifyAllowPrivateUrls, issues);
  }
  const ntfyTopic = nonEmpty(env.NTFY_TOPIC);
  const ntfyToken = nonEmpty(env.NTFY_TOKEN);
  const ntfyPriority = nonEmpty(env.NTFY_PRIORITY) ?? 'default';
  if (notifyChannels.includes('ntfy') && ntfyTopic === undefined) {
    issues.push('NTFY_TOPIC is required when NOTIFY_CHANNELS includes ntfy');
  }

  const sseEnabled = parseBool(env.SSE_ENABLED, true);
  const sseHeartbeatSeconds = parseIntBounded(
    'SSE_HEARTBEAT_SECONDS',
    env.SSE_HEARTBEAT_SECONDS,
    15,
    issues,
    { min: 1 },
  );
  const sseMaxClients = parseIntBounded('SSE_MAX_CLIENTS', env.SSE_MAX_CLIENTS, 16, issues, { min: 1 });

  // --- Phase 2: accuracy ------------------------------------------------------------------
  const trackClicksDefault = parseBool(env.TRACK_CLICKS_DEFAULT, true);
  const clickBackfillOpens = parseBool(env.CLICK_BACKFILL_OPENS, true);
  const rangesDir = nonEmpty(env.RANGES_DIR) ?? './data/ranges';
  const rangesEnabled = parseBool(env.RANGES_ENABLED, true);

  const SELF_OPEN_STRATEGIES: SelfOpenStrategy[] = ['window', 'insert', 'imap-append'];
  const selfOpenStrategyRaw = nonEmpty(env.SELF_OPEN_STRATEGY) ?? 'window';
  if (!SELF_OPEN_STRATEGIES.includes(selfOpenStrategyRaw as SelfOpenStrategy)) {
    issues.push(`SELF_OPEN_STRATEGY must be one of ${SELF_OPEN_STRATEGIES.join(', ')}`);
  }
  const selfOpenStrategy: SelfOpenStrategy = SELF_OPEN_STRATEGIES.includes(
    selfOpenStrategyRaw as SelfOpenStrategy,
  )
    ? (selfOpenStrategyRaw as SelfOpenStrategy)
    : 'window';

  const imapHost = nonEmpty(env.IMAP_HOST) ?? 'imap.gmail.com';
  const imapPort = parseIntBounded('IMAP_PORT', env.IMAP_PORT, 993, issues, { min: 1 });
  const imapUser = nonEmpty(env.IMAP_USER);
  const imapPass = nonEmpty(env.IMAP_PASS);
  const imapSentMailbox = nonEmpty(env.IMAP_SENT_MAILBOX) ?? '[Gmail]/Sent Mail';

  if (selfOpenStrategy === 'insert') {
    // docs/07_recipient_semantics.md §3.1: gmail-smtp writes no Sent copy of its own (it is a plain
    // SMTP submission), so `insert` is just as usable there as over plain smtp; only `gmail` (the
    // REST API, which always writes its own tracked Sent copy) is excluded.
    if (mailTransport !== 'smtp' && mailTransport !== 'gmail-smtp') {
      issues.push(
        'SELF_OPEN_STRATEGY=insert requires MAIL_TRANSPORT=smtp or gmail-smtp (users.messages.send over ' +
          'plain MAIL_TRANSPORT=gmail always writes its own tracked Sent copy)',
      );
    }
    if (googleClientId === undefined || googleClientSecret === undefined) {
      issues.push(
        'SELF_OPEN_STRATEGY=insert requires GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (used to insert an untracked Sent copy via the Gmail API)',
      );
    }
  }
  if (selfOpenStrategy === 'imap-append') {
    if (imapUser === undefined || imapPass === undefined) {
      issues.push('SELF_OPEN_STRATEGY=imap-append requires IMAP_USER and IMAP_PASS');
    }
  }

  // --- Phase 2: privacy/ops ---------------------------------------------------------------
  const pruneEnabled = parseBool(env.PRUNE_ENABLED, true);
  const pruneIntervalHours = parseIntBounded('PRUNE_INTERVAL_HOURS', env.PRUNE_INTERVAL_HOURS, 24, issues, {
    min: 1,
  });
  const pruneOnStart = parseBool(env.PRUNE_ON_START, false);
  const pruneVacuumThreshold = parseIntBounded(
    'PRUNE_VACUUM_THRESHOLD',
    env.PRUNE_VACUUM_THRESHOLD,
    10000,
    issues,
    { min: 0 },
  );
  const jobsEnabled = parseBool(env.JOBS_ENABLED, true);
  const openpostConfigDir = nonEmpty(env.OPENPOST_CONFIG_DIR);
  const doctorTimeoutMs = parseIntBounded('DOCTOR_TIMEOUT_MS', env.DOCTOR_TIMEOUT_MS, 5000, issues, {
    min: 1,
  });

  // --- Phase 3: dashboard -----------------------------------------------------------------
  const dashboardEnabled = parseBool(env.DASHBOARD_ENABLED, true);
  const dashboardLive = parseBool(env.DASHBOARD_LIVE, true);
  const dashboardBind = nonEmpty(env.DASHBOARD_BIND) ?? bindAddress;
  const dashboardPort = parseIntBounded('DASHBOARD_PORT', env.DASHBOARD_PORT, 8788, issues, { min: 1 });
  const dashboardPassword = nonEmpty(env.DASHBOARD_PASSWORD);
  const dashboardSessionHours = parseIntBounded(
    'DASHBOARD_SESSION_HOURS',
    env.DASHBOARD_SESSION_HOURS,
    12,
    issues,
    { min: 1 },
  );
  const dashboardSecureCookiesRaw = (nonEmpty(env.DASHBOARD_SECURE_COOKIES) ?? 'auto').toLowerCase();
  let dashboardSecureCookies: boolean | 'auto' = 'auto';
  if (dashboardSecureCookiesRaw === 'auto') dashboardSecureCookies = 'auto';
  else if (/^(1|true|yes|on)$/.test(dashboardSecureCookiesRaw)) dashboardSecureCookies = true;
  else if (/^(0|false|no|off)$/.test(dashboardSecureCookiesRaw)) dashboardSecureCookies = false;
  else issues.push('DASHBOARD_SECURE_COOKIES must be "auto", true or false');
  const dashboardPageSizeRaw = parseIntBounded('DASHBOARD_PAGE_SIZE', env.DASHBOARD_PAGE_SIZE, 25, issues, {
    min: 1,
  });
  const dashboardPageSize = [25, 50, 100].includes(dashboardPageSizeRaw) ? dashboardPageSizeRaw : 25;
  const dashboardMaxExportRows = parseIntBounded(
    'DASHBOARD_MAX_EXPORT_ROWS',
    env.DASHBOARD_MAX_EXPORT_ROWS,
    50_000,
    issues,
    { min: 1 },
  );
  const dashboardLoginRatePerMin = parseIntBounded(
    'DASHBOARD_LOGIN_RATE_PER_MIN',
    env.DASHBOARD_LOGIN_RATE_PER_MIN,
    10,
    issues,
    { min: 1 },
  );
  const reportTimezone = nonEmpty(env.REPORT_TIMEZONE) ?? 'UTC';
  if (!isValidTimeZone(reportTimezone)) {
    issues.push(`REPORT_TIMEZONE is not a recognised IANA time zone: ${reportTimezone}`);
  }
  const statsDefaultWindowDays = parseIntBounded(
    'STATS_DEFAULT_WINDOW_DAYS',
    env.STATS_DEFAULT_WINDOW_DAYS,
    90,
    issues,
    { min: 1 },
  );
  const statsMaxWindowDays = parseIntBounded('STATS_MAX_WINDOW_DAYS', env.STATS_MAX_WINDOW_DAYS, 366, issues, {
    min: 1,
  });

  // --- Phase 3: reminders -----------------------------------------------------------------
  const remindersEnabled = parseBool(env.REMINDERS_ENABLED, true);
  const reminderTickSeconds = parseIntBounded(
    'REMINDER_TICK_SECONDS',
    env.REMINDER_TICK_SECONDS,
    30,
    issues,
    { min: 1 },
  );
  const reminderLeaseMs = parseIntBounded('REMINDER_LEASE_MS', env.REMINDER_LEASE_MS, 120_000, issues, {
    min: 1000,
  });
  const reminderMaxAttempts = parseIntBounded(
    'REMINDER_MAX_ATTEMPTS',
    env.REMINDER_MAX_ATTEMPTS,
    3,
    issues,
    { min: 1 },
  );
  const reminderMaxHorizonDays = parseIntBounded(
    'REMINDER_MAX_HORIZON_DAYS',
    env.REMINDER_MAX_HORIZON_DAYS,
    365,
    issues,
    { min: 1 },
  );
  const REMINDER_CONDITIONS = ['no_reply', 'no_open', 'always'] as const;
  const reminderDefaultConditionRaw = nonEmpty(env.REMINDER_DEFAULT_CONDITION) ?? 'no_reply';
  if (!REMINDER_CONDITIONS.includes(reminderDefaultConditionRaw as (typeof REMINDER_CONDITIONS)[number])) {
    issues.push(`REMINDER_DEFAULT_CONDITION must be one of ${REMINDER_CONDITIONS.join(', ')}`);
  }
  const reminderDefaultCondition = REMINDER_CONDITIONS.includes(
    reminderDefaultConditionRaw as (typeof REMINDER_CONDITIONS)[number],
  )
    ? (reminderDefaultConditionRaw as (typeof REMINDER_CONDITIONS)[number])
    : 'no_reply';

  // --- Phase 3: reply detection -----------------------------------------------------------
  const REPLY_MODES = ['auto', 'off', 'gmail', 'imap'] as const;
  const replyDetectionRaw = nonEmpty(env.REPLY_DETECTION) ?? 'auto';
  if (!REPLY_MODES.includes(replyDetectionRaw as (typeof REPLY_MODES)[number])) {
    issues.push(`REPLY_DETECTION must be one of ${REPLY_MODES.join(', ')}`);
  }
  const replyDetection = REPLY_MODES.includes(replyDetectionRaw as (typeof REPLY_MODES)[number])
    ? (replyDetectionRaw as (typeof REPLY_MODES)[number])
    : 'auto';
  const replyPollSeconds = parseIntBounded('REPLY_POLL_SECONDS', env.REPLY_POLL_SECONDS, 300, issues, {
    min: 1,
  });
  const replyPollBatch = parseIntBounded('REPLY_POLL_BATCH', env.REPLY_POLL_BATCH, 25, issues, { min: 1 });
  const replyWatchDays = parseIntBounded('REPLY_WATCH_DAYS', env.REPLY_WATCH_DAYS, 14, issues, { min: 1 });
  const replyQuotaUnitsPerMin = parseIntBounded(
    'REPLY_QUOTA_UNITS_PER_MIN',
    env.REPLY_QUOTA_UNITS_PER_MIN,
    300,
    issues,
    { min: 1 },
  );
  const replyIgnoreSenders = parseList(env.REPLY_IGNORE_SENDERS).map((s) => s.toLowerCase());
  const imapAllMailMailbox = nonEmpty(env.IMAP_ALL_MAIL_MAILBOX) ?? '[Gmail]/All Mail';

  // --- Phase 4: campaigns -----------------------------------------------------------------
  const campaignsEnabled = parseBool(env.CAMPAIGNS_ENABLED, true);
  const campaignTickSeconds = parseIntBounded('CAMPAIGN_TICK_SECONDS', env.CAMPAIGN_TICK_SECONDS, 15, issues, { min: 1 });
  const campaignRatePerMinute = parseIntBounded('CAMPAIGN_RATE_PER_MINUTE', env.CAMPAIGN_RATE_PER_MINUTE, 20, issues, { min: 1 });
  const campaignJitterMs = parseIntBounded('CAMPAIGN_JITTER_MS', env.CAMPAIGN_JITTER_MS, 4000, issues, { min: 0 });
  const campaignLeaseMs = parseIntBounded('CAMPAIGN_LEASE_MS', env.CAMPAIGN_LEASE_MS, 120_000, issues, { min: 1000 });
  const campaignMaxAttempts = parseIntBounded('CAMPAIGN_MAX_ATTEMPTS', env.CAMPAIGN_MAX_ATTEMPTS, 3, issues, { min: 1 });
  const campaignDailyCap = parseIntBounded('CAMPAIGN_DAILY_CAP', env.CAMPAIGN_DAILY_CAP, 400, issues, { min: 1 });
  const campaignMaxRows = parseIntBounded('CAMPAIGN_MAX_ROWS', env.CAMPAIGN_MAX_ROWS, 10_000, issues, { min: 1 });
  const campaignDigestMinutes = parseIntBounded('CAMPAIGN_DIGEST_MINUTES', env.CAMPAIGN_DIGEST_MINUTES, 60, issues, { min: 1 });
  const CAMPAIGN_MODES = ['off', 'digest', 'per-open'] as const;
  const notifyCampaignModeRaw = nonEmpty(env.NOTIFY_CAMPAIGN_MODE) ?? 'digest';
  if (!CAMPAIGN_MODES.includes(notifyCampaignModeRaw as (typeof CAMPAIGN_MODES)[number])) {
    issues.push(`NOTIFY_CAMPAIGN_MODE must be one of ${CAMPAIGN_MODES.join(', ')}`);
  }
  const notifyCampaignMode = CAMPAIGN_MODES.includes(notifyCampaignModeRaw as (typeof CAMPAIGN_MODES)[number])
    ? (notifyCampaignModeRaw as (typeof CAMPAIGN_MODES)[number])
    : 'digest';

  // --- Phase 4: multi-account secrets -------------------------------------------------------
  const openpostMasterKeyFile = nonEmpty(env.OPENPOST_MASTER_KEY_FILE) ?? `${nonEmpty(env.OPENPOST_CONFIG_DIR) ?? `${env.HOME ?? '.'}/.config/openpost`}/master.key`;

  // --- Phase 4: backup -----------------------------------------------------------------------
  const backupEnabled = parseBool(env.BACKUP_ENABLED, false);
  const backupDir = nonEmpty(env.BACKUP_DIR) ?? './data/backups';
  const backupIntervalHours = parseIntBounded('BACKUP_INTERVAL_HOURS', env.BACKUP_INTERVAL_HOURS, 24, issues, { min: 1 });
  const backupKeep = parseIntBounded('BACKUP_KEEP', env.BACKUP_KEEP, 7, issues, { min: 1 });
  const backupGzip = parseBool(env.BACKUP_GZIP, true);

  // --- Phase 4: geo --------------------------------------------------------------------------
  const geoipDbPath = nonEmpty(env.GEOIP_DB_PATH);
  const GEO_GRANULARITIES = ['country', 'region', 'city'] as const;
  const geoipGranularityRaw = nonEmpty(env.GEOIP_GRANULARITY) ?? 'country';
  if (!GEO_GRANULARITIES.includes(geoipGranularityRaw as (typeof GEO_GRANULARITIES)[number])) {
    issues.push(`GEOIP_GRANULARITY must be one of ${GEO_GRANULARITIES.join(', ')}`);
  }
  const geoipGranularity = GEO_GRANULARITIES.includes(geoipGranularityRaw as (typeof GEO_GRANULARITIES)[number])
    ? (geoipGranularityRaw as (typeof GEO_GRANULARITIES)[number])
    : 'country';
  const geoipMaxAgeDays = parseIntBounded('GEOIP_MAX_AGE_DAYS', env.GEOIP_MAX_AGE_DAYS, 90, issues, { min: 1 });

  // --- Phase 4: in-Gmail checkmarks server half ---------------------------------------------
  const apiCorsOrigins = parseList(env.API_CORS_ORIGINS);
  if (apiCorsOrigins.length > 0) {
    if (apiCorsOrigins.includes('*')) {
      issues.push('API_CORS_ORIGINS must not contain "*" - list exact origins only');
    }
    if (nonEmpty(env.API_TOKEN) === undefined) {
      issues.push('API_CORS_ORIGINS requires API_TOKEN to be set - never expose an unauthenticated API cross-origin');
    }
  }
  const threadLookupDays = parseIntBounded('THREAD_LOOKUP_DAYS', env.THREAD_LOOKUP_DAYS, 30, issues, { min: 1 });

  // --- Phase 5: mobile compose + PWA -------------------------------------------------------
  const composeEnabled = parseBool(env.COMPOSE_ENABLED, true);
  const composeMaxRecipients = parseIntBounded('COMPOSE_MAX_RECIPIENTS', env.COMPOSE_MAX_RECIPIENTS, 25, issues, { min: 1 });
  const composeMaxBodyBytes = parseIntBounded('COMPOSE_MAX_BODY_BYTES', env.COMPOSE_MAX_BODY_BYTES, 262_144, issues, { min: 1 });
  const composeRatePerHour = parseIntBounded('COMPOSE_RATE_PER_HOUR', env.COMPOSE_RATE_PER_HOUR, 20, issues, { min: 1 });
  const pwaEnabled = parseBool(env.PWA_ENABLED, true);

  // --- Phase 5: Web Push ---------------------------------------------------------------------
  const vapidPublicKey = nonEmpty(env.VAPID_PUBLIC_KEY);
  const vapidPrivateKey = nonEmpty(env.VAPID_PRIVATE_KEY);
  const vapidSubjectRaw = nonEmpty(env.VAPID_SUBJECT) ?? (nonEmpty(env.FROM_EMAIL) ? `mailto:${env.FROM_EMAIL as string}` : 'mailto:openpost@localhost');
  const pushTtlSeconds = parseIntBounded('PUSH_TTL_SECONDS', env.PUSH_TTL_SECONDS, 3600, issues, { min: 0 });
  // Finding #14 (phase5.1): RFC 8030 defines exactly these four values - an arbitrary operator
  // value (including one containing CR/LF) previously reached the wire unvalidated and would only
  // fail, if at all, as a runtime header error from undici deep inside the notify worker.
  const PUSH_URGENCIES = ['very-low', 'low', 'normal', 'high'] as const;
  const pushUrgency = nonEmpty(env.PUSH_URGENCY) ?? 'normal';
  if (!PUSH_URGENCIES.includes(pushUrgency as (typeof PUSH_URGENCIES)[number])) {
    issues.push(`PUSH_URGENCY must be one of ${PUSH_URGENCIES.join(', ')}`);
  }
  const pushMaxSubscriptions = parseIntBounded('PUSH_MAX_SUBSCRIPTIONS', env.PUSH_MAX_SUBSCRIPTIONS, 10, issues, { min: 1 });
  const pushMaxFailures = parseIntBounded('PUSH_MAX_FAILURES', env.PUSH_MAX_FAILURES, 10, issues, { min: 1 });

  if (!/^mailto:|^https:/.test(vapidSubjectRaw)) {
    issues.push('VAPID_SUBJECT must start with mailto: or https:');
  }
  const webpushEnabled = notifyChannels.includes('webpush');
  function decodedLength(name: string, value: string): number | null {
    try {
      return Buffer.from(value, 'base64url').length;
    } catch {
      issues.push(`${name} is not valid base64url`);
      return null;
    }
  }
  if (webpushEnabled) {
    if (vapidPublicKey === undefined || vapidPrivateKey === undefined) {
      issues.push('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are required when NOTIFY_CHANNELS includes webpush - run `openpost push keys --write-env`');
    } else {
      const pubLen = decodedLength('VAPID_PUBLIC_KEY', vapidPublicKey);
      const privLen = decodedLength('VAPID_PRIVATE_KEY', vapidPrivateKey);
      if (pubLen !== null && pubLen !== 65) {
        issues.push('VAPID_PUBLIC_KEY must decode to 65 bytes (an uncompressed P-256 point) - run `openpost push keys --write-env`');
      }
      if (privLen !== null && privLen !== 32) {
        issues.push('VAPID_PRIVATE_KEY must decode to 32 bytes - run `openpost push keys --write-env`');
      }
      if (pubLen === 65 && privLen === 32) {
        try {
          if (vapidPublicKeyFromPrivate(vapidPrivateKey) !== vapidPublicKey) {
            issues.push('VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY - run `openpost push keys --write-env` to regenerate a matching pair');
          }
        } catch {
          issues.push('VAPID_PRIVATE_KEY is not a valid P-256 private key');
        }
      }
    }
  } else if (vapidPublicKey !== undefined && vapidPrivateKey !== undefined) {
    // Keys present but the channel isn't enabled yet: still sanity-check lengths (a corrupted value
    // should be caught before an operator flips NOTIFY_CHANNELS on), but never require agreement to
    // avoid punishing an operator mid-rotation.
    decodedLength('VAPID_PUBLIC_KEY', vapidPublicKey);
    decodedLength('VAPID_PRIVATE_KEY', vapidPrivateKey);
  }

  // --- Phase 5: email-to-self + daily digest ------------------------------------------------
  const notifyEmailTo = nonEmpty(env.NOTIFY_EMAIL_TO);
  const notifyEmailFrom = nonEmpty(env.NOTIFY_EMAIL_FROM);
  const digestDailyAt = nonEmpty(env.DIGEST_DAILY_AT);
  if (digestDailyAt !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(digestDailyAt)) {
    issues.push('DIGEST_DAILY_AT must be HH:MM (24-hour, zero-padded)');
  }
  const digestTimezone = nonEmpty(env.DIGEST_TIMEZONE) ?? reportTimezone;
  if (!isValidTimeZone(digestTimezone)) {
    issues.push(`DIGEST_TIMEZONE is not a recognised IANA time zone: ${digestTimezone}`);
  }

  // --- Phase 5: Gmail add-on (experimental) -------------------------------------------------
  const addonEnabled = parseBool(env.ADDON_ENABLED, false);
  const addonRatePerHour = parseIntBounded('ADDON_RATE_PER_HOUR', env.ADDON_RATE_PER_HOUR, 120, issues, { min: 1 });
  const addonLinkTimeoutHours = parseIntBounded('ADDON_LINK_TIMEOUT_HOURS', env.ADDON_LINK_TIMEOUT_HOURS, 48, issues, { min: 1 });
  if (addonEnabled && nonEmpty(env.API_TOKEN) === undefined) {
    issues.push('ADDON_ENABLED=true requires API_TOKEN to be set - never expose an unauthenticated token-minting endpoint');
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    trackingSecret,
    trackingSecretPrevious,
    ipSalt,
    ipSaltIsDefault,
    trackingBaseUrl,
    dbPath,
    port,
    bindAddress,
    trustProxy,
    trustProxyWarning,
    privacyMode,
    respectDnt,
    openIgnoreSeconds,
    proxyPrefetchSeconds,
    mppWindowSeconds,
    dedupeSeconds,
    scannerFanout,
    selfIpHashes,
    selfUaPatterns,
    retentionDays,
    trackingFallbackUrl,
    outDir,
    mailTransport,
    smtpHost,
    smtpPort,
    smtpUser,
    smtpPass,
    smtpSecure,
    googleClientId,
    googleClientSecret,
    googleRefreshToken,
    recipientMode,
    gmailSmtpHost,
    gmailSmtpPort,
    fromEmail,
    fromName,
    apiToken,
    logLevel,

    notifyEnabled,
    notifyChannels,
    notifyOn,
    notifyMaxAttempts,
    notifyBackoffBaseMs,
    notifyTickSeconds,
    notifyTimeoutMs,
    notifyIncludeSubject,
    notifyRedactEmail,
    notifyAllowPrivateUrls,
    slackWebhookUrl,
    discordWebhookUrl,
    webhookUrl,
    webhookSecret,
    ntfyUrl,
    ntfyTopic,
    ntfyToken,
    ntfyPriority,
    sseEnabled,
    sseHeartbeatSeconds,
    sseMaxClients,

    trackClicksDefault,
    clickBackfillOpens,
    rangesDir,
    rangesEnabled,
    selfOpenStrategy,
    imapHost,
    imapPort,
    imapUser,
    imapPass,
    imapSentMailbox,

    pruneEnabled,
    pruneIntervalHours,
    pruneOnStart,
    pruneVacuumThreshold,
    jobsEnabled,
    openpostConfigDir,
    doctorTimeoutMs,

    dashboardEnabled,
    dashboardLive,
    dashboardBind,
    dashboardPort,
    dashboardPassword,
    dashboardSessionHours,
    dashboardSecureCookies,
    dashboardPageSize,
    dashboardMaxExportRows,
    dashboardLoginRatePerMin,
    reportTimezone,
    statsDefaultWindowDays,
    statsMaxWindowDays,

    remindersEnabled,
    reminderTickSeconds,
    reminderLeaseMs,
    reminderMaxAttempts,
    reminderMaxHorizonDays,
    reminderDefaultCondition,

    replyDetection,
    replyPollSeconds,
    replyPollBatch,
    replyWatchDays,
    replyQuotaUnitsPerMin,
    replyIgnoreSenders,
    imapAllMailMailbox,

    campaignsEnabled,
    campaignTickSeconds,
    campaignRatePerMinute,
    campaignJitterMs,
    campaignLeaseMs,
    campaignMaxAttempts,
    campaignDailyCap,
    campaignMaxRows,
    campaignDigestMinutes,
    notifyCampaignMode,

    openpostMasterKeyFile,

    backupEnabled,
    backupDir,
    backupIntervalHours,
    backupKeep,
    backupGzip,

    geoipDbPath,
    geoipGranularity,
    geoipMaxAgeDays,

    apiCorsOrigins,
    threadLookupDays,

    composeEnabled,
    composeMaxRecipients,
    composeMaxBodyBytes,
    composeRatePerHour,
    pwaEnabled,

    vapidPublicKey,
    vapidPrivateKey,
    vapidSubject: vapidSubjectRaw,
    pushTtlSeconds,
    pushUrgency,
    pushMaxSubscriptions,
    pushMaxFailures,

    notifyEmailTo,
    notifyEmailFrom,
    digestDailyAt,
    digestTimezone,

    addonEnabled,
    addonRatePerHour,
    addonLinkTimeoutHours,
  };
}
