import { resolve4, resolve6 } from 'node:dns/promises';
import { connect } from 'node:tls';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import type { AppConfig } from '../../config/env.js';
import {
  checkAccountsHealth,
  checkAddonConfig,
  checkApiCors,
  checkBackupRecency,
  checkBaseUrl,
  checkClickProbe,
  checkConfig,
  checkDashboardAssets,
  checkDashboardAuth,
  checkDbWritable,
  checkDnsResolve,
  checkGeoDb,
  checkGmailSmtpScope,
  checkNotifyConfig,
  checkPendingDraftReminders,
  checkPixelProbe,
  checkProxyContract,
  checkPushKeys,
  checkPushSecureContext,
  checkPushSubscriptions,
  checkPwaAssets,
  checkRangeIntegrity,
  checkRanges,
  checkRecipientMode,
  checkReplyReader,
  checkTlsCert,
  checkUrlMatchesTrackingBase,
  summarise,
  type CheckResult,
  type PixelProbe,
  type TlsCertInfo,
} from '../../core/doctor.js';
import { loadMasterKey, SecretKeyError } from '../../core/secretbox.js';
import { createMmdbLookup } from '../../core/geo.js';
import { listAccounts, resolveAccount } from '../../mail/accounts.js';
import { loadRangeIndex, EMPTY_RANGE_INDEX, type RangeIndex } from '../../core/ranges.js';
import { newId } from '../../core/ids.js';
import { pixelUrl, signToken } from '../../core/token.js';
import { migrate, openDb, type DB } from '../../db/index.js';
import { audit, getRangeSet, getSetting } from '../../db/repo.js';
import { listReminders } from '../../db/reminders.js';
import { HTMX_EXPECTED_SHA256, PWA_ICON_EXPECTED_SHA256 } from '../../server/assets/index.js';
import { listActiveSubscriptions } from '../../db/push.js';
import { computeAuthStatus } from './auth.js';
import { resolveReplyMode } from '../../mail/reply-setup.js';
import { GMAIL_SCOPE_FULL } from '../../mail/oauth.js';
import { resolveRecipientMode } from '../../mail/recipients.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DoctorOpts {
  url?: string;
  timeout?: string;
  offline?: boolean;
}

async function realResolveDns(host: string): Promise<string[] | null> {
  const [v4, v6] = await Promise.allSettled([resolve4(host), resolve6(host)]);
  const records = [
    ...(v4.status === 'fulfilled' ? v4.value : []),
    ...(v6.status === 'fulfilled' ? v6.value : []),
  ];
  return records.length > 0 ? records : null;
}

function realCheckTls(host: string, port: number, timeoutMs: number): Promise<TlsCertInfo | null> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host, port, servername: host, timeout: timeoutMs }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert.valid_to ? new Date(cert.valid_to).getTime() : null;
      settled = true;
      socket.end();
      if (validTo === null) {
        resolve(null);
        return;
      }
      const daysRemaining = Math.floor((validTo - Date.now()) / (24 * 60 * 60 * 1000));
      resolve({ valid: socket.authorized, daysRemaining });
    });
    socket.on('error', () => {
      if (!settled) resolve(null);
    });
    socket.on('timeout', () => {
      socket.destroy();
      if (!settled) resolve(null);
    });
  });
}

export interface RunDoctorDeps {
  config: AppConfig;
  db: DB;
  ranges: RangeIndex;
  url?: string | undefined;
  timeoutMs: number;
  offline: boolean;
  nowMs?: number;
  fetchImpl?: typeof fetch;
  resolveDns?: (host: string) => Promise<string[] | null>;
  checkTls?: (host: string, port: number, timeoutMs: number) => Promise<TlsCertInfo | null>;
}

/** Runs every §3.3 check. Exported (rather than living only inside the commander action) so
 *  integration tests can drive it with an injected `fetchImpl`/`resolveDns`/`checkTls` and never
 *  touch the real network. */
export async function runDoctor(deps: RunDoctorDeps): Promise<{ results: CheckResult[]; summary: ReturnType<typeof summarise> }> {
  const nowMs = deps.nowMs ?? Date.now();
  const results: CheckResult[] = [];

  const schemaVersion = deps.db.pragma('user_version', { simple: true }) as number;
  const fingerprint = getSetting(deps.db, 'tracking_secret_fingerprint');
  results.push(...checkConfig(deps.config, schemaVersion, fingerprint));
  results.push(checkDbWritable(deps.db));
  results.push(...checkBaseUrl(deps.config.trackingBaseUrl));
  results.push(...checkProxyContract(deps.config));
  results.push(...checkRanges(new Map([
    ['apple_relay', deps.ranges.apple],
    ['google_proxy', deps.ranges.googleProxy],
    ['datacenter', deps.ranges.datacenter],
  ]), nowMs));
  results.push(...checkNotifyConfig(deps.config));
  results.push(
    ...checkRangeIntegrity([
      { name: 'apple_relay', computedSha256: deps.ranges.apple.sha256, storedSha256: getRangeSet(deps.db, 'apple_relay')?.sha256 ?? null },
      { name: 'google_proxy', computedSha256: deps.ranges.googleProxy.sha256, storedSha256: getRangeSet(deps.db, 'google_proxy')?.sha256 ?? null },
      { name: 'datacenter', computedSha256: deps.ranges.datacenter.sha256, storedSha256: getRangeSet(deps.db, 'datacenter')?.sha256 ?? null },
    ]),
  );

  // Phase 3: dashboard, reminders, reply detection.
  results.push(checkDashboardAuth(deps.config));
  try {
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'assets');
    const htmxBody = readFileSync(join(assetsDir, 'htmx.min.js'));
    const actualSha256 = createHash('sha256').update(htmxBody).digest('hex');
    results.push(checkDashboardAssets(actualSha256, HTMX_EXPECTED_SHA256));
  } catch (err) {
    results.push({
      id: 'dashboard.assets',
      status: 'warn',
      title: 'dashboard assets',
      detail: `could not read htmx.min.js to verify: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Phase 5 (§7.5): Web Push key/subscription/secure-context checks, PWA icon integrity, and the
  // Gmail add-on's config sanity check.
  results.push(checkPushKeys(deps.config));
  results.push(checkPushSecureContext(deps.config.trackingBaseUrl));
  results.push(checkPushSubscriptions(deps.config, listActiveSubscriptions(deps.db).length));
  try {
    const assetsDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'assets');
    const iconChecks = Object.entries(PWA_ICON_EXPECTED_SHA256).map(([name, expected]) => {
      try {
        const body = readFileSync(join(assetsDir, name));
        return { name, actualSha256: createHash('sha256').update(body).digest('hex'), expectedSha256: expected };
      } catch {
        return { name, actualSha256: null, expectedSha256: expected };
      }
    });
    results.push(checkPwaAssets(iconChecks));
  } catch (err) {
    results.push({ id: 'pwa.assets', status: 'warn', title: 'PWA assets', detail: `could not verify: ${err instanceof Error ? err.message : String(err)}` });
  }
  results.push(checkAddonConfig(deps.config));

  const authStatus = computeAuthStatus(process.env, deps.config, nowMs);
  const pendingDraftReminders = listReminders(deps.db, { status: 'pending' }).filter((r) => r.draft === 1).length;
  results.push(checkPendingDraftReminders(pendingDraftReminders, authStatus.hasComposeScope));
  const resolvedReplyMode = resolveReplyMode(deps.config, process.env);
  results.push(checkReplyReader(deps.config.replyDetection, resolvedReplyMode));

  // docs/07_recipient_semantics.md §6.3.
  results.push(checkRecipientMode(deps.config, resolveRecipientMode));
  const gmailSmtpScopeCheck = checkGmailSmtpScope(
    deps.config.mailTransport,
    authStatus.source,
    authStatus.scopes.includes(GMAIL_SCOPE_FULL),
  );
  if (gmailSmtpScopeCheck) results.push(gmailSmtpScopeCheck);

  // Phase 4: accounts, backup, geo, API CORS.
  {
    const accountSummaries = listAccounts(deps.db);
    const hasEncryptedSecrets = accountSummaries.some((a) => a.secretKind !== null);
    let masterKeyError: string | null = null;
    let configuredKeyFingerprint: string | null = null;
    if (hasEncryptedSecrets) {
      try {
        configuredKeyFingerprint = loadMasterKey(process.env, { required: true })?.fingerprint ?? null;
      } catch (err) {
        masterKeyError = err instanceof SecretKeyError ? err.message : err instanceof Error ? err.message : String(err);
      }
    }
    // Finding #14: compare against what was actually recorded (finding #11) when a secret was
    // first sealed - loud and specific ("wrong key configured") rather than only ever surfacing as
    // an opaque per-account AEAD auth failure indistinguishable from corrupted ciphertext.
    const recordedKeyFingerprint = getSetting(deps.db, 'master_key_fingerprint');
    const defaultAccount = accountSummaries.find((a) => a.isDefault) ?? null;
    const undecryptableLabels: string[] = [];
    if (masterKeyError === null) {
      for (const a of accountSummaries) {
        if (a.secretKind === null) continue;
        try {
          resolveAccount(deps.db, deps.config, a.id).secret();
        } catch {
          undecryptableLabels.push(a.label ?? a.email);
        }
      }
    }
    results.push(
      ...checkAccountsHealth({
        hasEncryptedSecrets,
        masterKeyError,
        accountCount: accountSummaries.length,
        hasDefault: defaultAccount !== null,
        defaultIsDisabled: defaultAccount?.status === 'disabled',
        undecryptableLabels,
        keyFingerprint: { configured: configuredKeyFingerprint, recorded: recordedKeyFingerprint },
      }),
    );
  }

  if (process.env.BACKUP_ENABLED !== undefined || deps.config.backupEnabled) {
    let newestBackupAgeMs: number | null = null;
    try {
      const files = readdirSync(deps.config.backupDir).filter((f) => /^openpost-.*\.sqlite(\.gz)?$/.test(f));
      const mtimes = files.map((f) => statSync(join(deps.config.backupDir, f)).mtimeMs);
      if (mtimes.length > 0) newestBackupAgeMs = nowMs - Math.max(...mtimes);
    } catch {
      // directory doesn't exist yet - treated the same as "no backup found".
    }
    const check = checkBackupRecency({ enabled: deps.config.backupEnabled, newestBackupAgeMs, intervalHours: deps.config.backupIntervalHours });
    if (check) results.push(check);
  }

  {
    // Finding #7: actually attempt the SAME load `serve` performs (createMmdbLookup), rather than
    // just `statSync`-ing the path - a file that exists and is readable but fails to parse (or
    // whose `mmdb-lib` optional dependency is missing) previously still reported "loaded".
    let applied = false;
    let ageDays: number | null = null;
    let notAppliedReason: string | null = null;
    if (deps.config.geoipDbPath) {
      try {
        const stat = statSync(deps.config.geoipDbPath);
        ageDays = Math.floor((nowMs - stat.mtimeMs) / (24 * 60 * 60 * 1000));
      } catch {
        notAppliedReason = 'file not found or unreadable';
      }
      if (notAppliedReason === null) {
        const lookup = await createMmdbLookup(deps.config.geoipDbPath);
        if (lookup === null) {
          notAppliedReason = 'file could not be parsed as an mmdb, or the optional mmdb-lib dependency is not installed';
        } else {
          applied = true;
        }
      }
    }
    const effectiveGranularity = deps.config.privacyMode === 'strict' ? 'none' : deps.config.privacyMode === 'balanced' ? 'country' : deps.config.geoipGranularity;
    results.push(
      checkGeoDb({
        configured: deps.config.geoipDbPath !== undefined,
        applied,
        notAppliedReason,
        ageDays,
        maxAgeDays: deps.config.geoipMaxAgeDays,
        granularity: deps.config.geoipGranularity,
        effectiveGranularity,
      }),
    );
  }

  results.push(checkApiCors({ origins: deps.config.apiCorsOrigins, hasApiToken: deps.config.apiToken !== undefined }));

  if (!deps.offline && deps.url) {
    const target = new URL(deps.url);
    const fetchImpl = deps.fetchImpl ?? fetch;
    const resolveDns = deps.resolveDns ?? realResolveDns;
    const checkTls = deps.checkTls ?? realCheckTls;

    if (!target.hostname.match(/^(127\.|::1$|localhost$)/)) {
      const records = await resolveDns(target.hostname);
      results.push(checkDnsResolve(records));
    }

    if (target.protocol === 'https:') {
      const tlsInfo = await checkTls(target.hostname, target.port ? Number(target.port) : 443, deps.timeoutMs);
      results.push(checkTlsCert(tlsInfo));
    }

    // Finding #18: never sign and send a real token to a host other than the configured
    // TRACKING_BASE_URL - see checkUrlMatchesTrackingBase's doc-comment.
    const urlScope = checkUrlMatchesTrackingBase(deps.config.trackingBaseUrl, deps.url);
    results.push(urlScope);

    if (deps.config.trackingSecret && urlScope.status === 'pass') {
      const syntheticRid = newId();
      const token = signToken('o', syntheticRid, deps.config.trackingSecret);
      const probeUrl = pixelUrl(target.toString().replace(/\/+$/, ''), token, 'doctor');
      try {
        const started = Date.now();
        const res = await fetchImpl(probeUrl, { redirect: 'manual' });
        const elapsedMs = Date.now() - started;
        const bodyBuf = Buffer.from(await res.arrayBuffer());
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => {
          headers[k] = v;
        });
        const probe: PixelProbe = {
          status: res.status,
          headers,
          bodyLength: bodyBuf.length,
          redirected: res.status >= 300 && res.status < 400,
          elapsedMs,
        };
        results.push(...checkPixelProbe(probe));
        audit(deps.db, {
          actor: 'operator',
          action: 'doctor.run',
          detail: { check: 'pixel.reachable', rid: syntheticRid },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ id: 'pixel.reachable.status', status: 'fail', title: 'pixel HTTP status', detail: message });
      }

      try {
        const clickUrl = `${target.toString().replace(/\/+$/, '')}/c/deadbeef`;
        const res = await fetchImpl(clickUrl, { redirect: 'manual' });
        results.push(checkClickProbe(res.status));
      } catch {
        results.push(checkClickProbe(null));
      }
    }
  }

  return { results, summary: summarise(results) };
}

function printHuman(results: CheckResult[], summary: ReturnType<typeof summarise>): string {
  const lines: string[] = [];
  for (const r of results) {
    const marker = r.status === 'pass' ? 'PASS' : r.status === 'warn' ? 'WARN' : 'FAIL';
    lines.push(`[${marker}] ${r.id} - ${r.title}: ${r.detail}${r.remedy ? `\n       remedy: ${r.remedy}` : ''}`);
  }
  lines.push(`\n${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  return lines.join('\n');
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check configuration, database schema, ranges and (optionally) a public URL')
    .option('--url <base>', 'public base URL to probe (pixel/click reachability, DNS, TLS)')
    .option('--timeout <ms>', 'per-network-check timeout', '5000')
    .option('--offline', 'skip every network check')
    .action(async (opts: DoctorOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const dbPath = g.db ?? config.dbPath;
        const db = openDb(dbPath);
        migrate(db);
        const ranges = config.rangesEnabled ? loadRangeIndex(config.rangesDir) : EMPTY_RANGE_INDEX;

        const { results, summary } = await runDoctor({
          config,
          db,
          ranges,
          url: opts.url,
          timeoutMs: Number(opts.timeout ?? 5000),
          offline: !!opts.offline,
        });
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify({ ok: summary.ok, checks: results })}\n`);
        } else {
          process.stdout.write(`${printHuman(results, summary)}\n`);
        }
        if (!summary.ok) process.exit(1);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
