import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { AppConfig } from '../config/env.js';
import { base32Encode } from '../core/ids.js';
import type { FetchLike } from '../notify/types.js';

export const GMAIL_SCOPE_SEND = 'https://www.googleapis.com/auth/gmail.send';
export const GMAIL_SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPES_BASE = [GMAIL_SCOPE_SEND, GMAIL_SCOPE_READONLY] as const;
export const GMAIL_SCOPE_INSERT = 'https://www.googleapis.com/auth/gmail.insert';
/** Phase 3 (§3.5): required for `openpost remind --draft` (`users.drafts.create`). Opt-in - never
 *  requested by the base `openpost auth gmail` flow, only by `--with-compose`. */
export const GMAIL_SCOPE_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
/** docs/07_recipient_semantics.md §3.2/§6.3: `gmail.send` is not accepted by Gmail's SMTP
 *  submission front end (`smtp.gmail.com`) - only this restricted, full-mailbox scope is. Requested
 *  only behind `openpost auth gmail --with-smtp`, never by the base flow; a non-issue for a
 *  self-hosted, operator-owned Cloud project in Testing mode, but still worth being deliberate
 *  about since it is far broader than `gmail.send`. */
export const GMAIL_SCOPE_FULL = 'https://mail.google.com/';

export interface GmailTokenStore {
  version: 1;
  clientIdFingerprint: string;
  refreshToken: string;
  scopes: string[];
  obtainedAt: number;
  account: string | null;
}

export class GmailAuthError extends Error {
  readonly remedy: string;
  constructor(message: string, remedy: string) {
    super(message);
    this.name = 'GmailAuthError';
    this.remedy = remedy;
  }
}

function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v.trim() !== '' ? v : undefined;
}

/** `${OPENPOST_CONFIG_DIR ?? \`${HOME}/.config/openpost\`}/gmail-token.json`. Takes `env` (rather
 *  than reading `process.env` directly) so tests can point it at a scratch directory via a
 *  synthetic env object, without touching the real HOME. */
export function tokenStorePath(env: NodeJS.ProcessEnv): string {
  const configDir = nonEmpty(env.OPENPOST_CONFIG_DIR) ?? join(env.HOME ?? homedir(), '.config', 'openpost');
  return join(configDir, 'gmail-token.json');
}

export function readTokenStore(path: string): GmailTokenStore | null {
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<GmailTokenStore>;
    if (parsed.version !== 1 || typeof parsed.refreshToken !== 'string') return null;
    return {
      version: 1,
      clientIdFingerprint: parsed.clientIdFingerprint ?? '',
      refreshToken: parsed.refreshToken,
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes : [],
      obtainedAt: typeof parsed.obtainedAt === 'number' ? parsed.obtainedAt : 0,
      account: parsed.account ?? null,
    };
  } catch {
    return null;
  }
}

/** `mkdir 0700 -> write <path>.tmp with mode 0600 -> rename`; refuses a group/world-writable
 *  parent directory (§6). */
export function writeTokenStore(path: string, store: GmailTokenStore): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const dirMode = statSync(dir).mode & 0o777;
  if ((dirMode & 0o077) !== 0) {
    throw new GmailAuthError(
      `refusing to write the token store: ${dir} is group/world accessible (mode ${dirMode.toString(8)})`,
      `chmod 700 ${dir}`,
    );
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface BuildAuthUrlOpts {
  clientId: string;
  redirectUri: string;
  scopes: string[];
}

/** Loopback + PKCE S256 authorization URL (§6, step 3). */
export function buildAuthUrl(opts: BuildAuthUrlOpts): { url: string; state: string; codeVerifier: string } {
  const state = base32Encode(randomBytes(20)); // 32 chars of base32 from 20 random bytes
  const codeVerifier = base64url(randomBytes(32));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scopes.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, state, codeVerifier };
}

export interface ExchangeCodeOpts {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
}

/** POSTs the authorization code to Google's token endpoint (§6, step 5). Throws `GmailAuthError`
 *  when the exchange fails or the response omits a refresh token (the user had already granted
 *  consent for this client without `prompt=consent` sticking, or similar). */
export async function exchangeCode(
  opts: ExchangeCodeOpts,
  deps: { fetch: FetchLike; clock: () => number },
): Promise<GmailTokenStore> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  }).toString();

  const res = await deps.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // leave parsed as {}
  }

  if (!res.ok) {
    const errorCode = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`;
    throw new GmailAuthError(`Gmail OAuth token exchange failed: ${errorCode}`, 'run `openpost auth gmail` again');
  }
  if (typeof parsed.refresh_token !== 'string') {
    throw new GmailAuthError(
      'Google did not return a refresh token - this Google account may have already granted consent ' +
        'to this OAuth client without re-prompting',
      'revoke access at https://myaccount.google.com/permissions, then run `openpost auth gmail` again',
    );
  }

  const scopes =
    typeof parsed.scope === 'string' ? parsed.scope.split(' ').filter((s) => s.length > 0) : [];

  return {
    version: 1,
    clientIdFingerprint: createHash('sha256').update(opts.clientId).digest('hex').slice(0, 16),
    refreshToken: parsed.refresh_token,
    scopes,
    obtainedAt: deps.clock(),
    account: null,
  };
}

export interface ResolvedRefreshToken {
  token: string;
  source: 'env' | 'file';
  scopes: string[];
}

/** Precedence at send time: `GOOGLE_REFRESH_TOKEN` (env) beats the token file (§6). */
export function resolveRefreshToken(config: AppConfig, env: NodeJS.ProcessEnv): ResolvedRefreshToken | null {
  if (config.googleRefreshToken !== undefined) {
    return { token: config.googleRefreshToken, source: 'env', scopes: [] };
  }
  const store = readTokenStore(tokenStorePath(env));
  if (store) {
    return { token: store.refreshToken, source: 'file', scopes: store.scopes };
  }
  return null;
}
