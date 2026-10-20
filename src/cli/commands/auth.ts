import { timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { audit } from '../../db/repo.js';
import {
  GMAIL_SCOPES_BASE,
  GMAIL_SCOPE_COMPOSE,
  GMAIL_SCOPE_FULL,
  GMAIL_SCOPE_INSERT,
  GmailAuthError,
  buildAuthUrl,
  exchangeCode,
  readTokenStore,
  resolveRefreshToken,
  tokenStorePath,
  writeTokenStore,
  type GmailTokenStore,
} from '../../mail/oauth.js';
import type { FetchLike } from '../../notify/types.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

function timingSafeStringEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Finding #16: `start` is a `cmd.exe` builtin, not a standalone executable, so launching it at all
 * requires going through a shell - the previous code did that with `shell: true`, which means the
 * OS re-parses the whole command line and treats `&` (a valid, unremarkable URL query-string
 * separator) as a shell command separator, letting a URL like
 * `http://x/?a=1&calc.exe` run an arbitrary second command. `cmd /c start "" <url>` reaches the same
 * builtin without `shell: true`: each array element is passed to `cmd.exe` as a literal argv entry,
 * never re-interpreted. The empty `""` is `start`'s own window-title argument - without it, a URL
 * wrapped in quotes would be swallowed by `start` as the title instead of the target.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  try {
    if (platform === 'win32') {
      spawn('cmd', ['/c', 'start', '""', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      const cmd = platform === 'darwin' ? 'open' : 'xdg-open';
      spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    // best-effort only
  }
}

const DEFAULT_AUTH_TIMEOUT_MS = 5 * 60_000;

export interface AuthGmailDeps {
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  clock: () => number;
  port: number;
  withInsert: boolean;
  /** Phase 3 (§3.5): requests `gmail.compose`, required for `openpost remind --draft`'s
   *  `users.drafts.create` call. */
  withCompose?: boolean;
  /** docs/07_recipient_semantics.md §3.2/§6.3: requests the full-mailbox `https://mail.google.com/`
   *  scope, required for `MAIL_TRANSPORT=gmail-smtp` (Gmail's SMTP front end refuses `gmail.send`).
   *  Never requested by the base flow - opt-in only, since it is far broader than every other scope
   *  this command can request. */
  withSmtp?: boolean;
  openBrowser?: (url: string) => void;
  getAccountEmail?: (refreshToken: string) => Promise<string | null>;
  /** Lets a test observe the authorization URL/state and drive the callback itself instead of a
   *  real browser. */
  onAuthUrl?: (url: string, state: string, redirectUri: string) => void;
  /** Finding #17: an abandoned flow (the user never finishes/cancels the browser consent screen)
   *  used to leave the loopback HTTP server listening forever - `listen()` keeps the event loop
   *  alive, so the CLI process itself never exited. Defaults to 5 minutes; tests pass a much
   *  shorter value. */
  timeoutMs?: number;
}

/**
 * The loopback + PKCE S256 flow (§6), factored out of the commander action so it can be driven end
 * to end in tests with an injected `fetchImpl` (the token exchange) and `onAuthUrl` (which fires
 * the callback itself instead of a real browser) - no real Google network call is ever made in
 * tests.
 */
export async function runAuthGmailFlow(deps: AuthGmailDeps): Promise<{ store: GmailTokenStore; path: string }> {
  const clientId = deps.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = deps.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new GmailAuthError(
      'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required',
      'create a Desktop-app OAuth client in Google Cloud Console and set both in .env',
    );
  }

  const scopes = [
    ...GMAIL_SCOPES_BASE,
    ...(deps.withInsert ? [GMAIL_SCOPE_INSERT] : []),
    ...(deps.withCompose ? [GMAIL_SCOPE_COMPOSE] : []),
    ...(deps.withSmtp ? [GMAIL_SCOPE_FULL] : []),
  ];

  return new Promise((resolve, reject) => {
    // Filled in once `listen`'s callback runs and the actual (possibly ephemeral) port is known;
    // the request handler below only ever runs after that, so this is never read uninitialised.
    const pending: { state: string; codeVerifier: string; redirectUri: string } = {
      state: '',
      codeVerifier: '',
      redirectUri: '',
    };

    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      server.close();
      fn();
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>openpost</title><body>You can close this tab.</body>');

      if (error) {
        settle(() => reject(new GmailAuthError(`Google returned an error: ${error}`, 'run `openpost auth gmail` again')));
        return;
      }
      if (!code || !returnedState || !timingSafeStringEqual(returnedState, pending.state)) {
        settle(() => reject(new GmailAuthError('OAuth state mismatch or missing code', 'run `openpost auth gmail` again')));
        return;
      }

      exchangeCode(
        { clientId, clientSecret, redirectUri: pending.redirectUri, code, codeVerifier: pending.codeVerifier },
        { fetch: deps.fetchImpl, clock: deps.clock },
      )
        .then(async (store) => {
          const account = deps.getAccountEmail ? await deps.getAccountEmail(store.refreshToken).catch(() => null) : null;
          const finalStore: GmailTokenStore = { ...store, account };
          const path = tokenStorePath(deps.env);
          writeTokenStore(path, finalStore);
          settle(() => resolve({ store: finalStore, path }));
        })
        .catch((err) => settle(() => reject(err)));
    });

    // Finding #17: without this, an abandoned flow (browser tab closed, consent screen ignored)
    // left this server listening - and the CLI process alive - forever.
    const timeoutTimer = setTimeout(() => {
      settle(() =>
        reject(
          new GmailAuthError(
            `timed out waiting for the OAuth callback (${Math.round((deps.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS) / 1000)}s)`,
            'run `openpost auth gmail` again and complete the consent screen promptly',
          ),
        ),
      );
    }, deps.timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
    timeoutTimer.unref();

    server.on('error', (err) => settle(() => reject(err)));
    server.listen(deps.port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      pending.redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const built = buildAuthUrl({ clientId, redirectUri: pending.redirectUri, scopes });
      pending.state = built.state;
      pending.codeVerifier = built.codeVerifier;
      deps.onAuthUrl?.(built.url, built.state, pending.redirectUri);
      if (deps.openBrowser) deps.openBrowser(built.url);
    });
  });
}

// --- exports used by cli registration and by other mail code paths ---------------------------

export interface AuthStatusResult {
  configured: boolean;
  source: 'env' | 'file' | null;
  scopes: string[];
  account: string | null;
  ageMs: number | null;
  hasInsertScope: boolean;
  hasComposeScope: boolean;
  hasFullScope: boolean;
}

export function computeAuthStatus(env: NodeJS.ProcessEnv, config: ReturnType<typeof loadConfig>, nowMs: number): AuthStatusResult {
  const resolved = resolveRefreshToken(config, env);
  if (!resolved) {
    return {
      configured: false,
      source: null,
      scopes: [],
      account: null,
      ageMs: null,
      hasInsertScope: false,
      hasComposeScope: false,
      hasFullScope: false,
    };
  }
  const store = resolved.source === 'file' ? readTokenStore(tokenStorePath(env)) : null;
  return {
    configured: true,
    source: resolved.source,
    scopes: resolved.scopes,
    account: store?.account ?? null,
    ageMs: store ? nowMs - store.obtainedAt : null,
    hasInsertScope: resolved.scopes.includes(GMAIL_SCOPE_INSERT),
    hasComposeScope: resolved.scopes.includes(GMAIL_SCOPE_COMPOSE),
    hasFullScope: resolved.scopes.includes(GMAIL_SCOPE_FULL),
  };
}

export function registerAuthCommand(program: Command): void {
  const auth = program.command('auth').description('Gmail OAuth helper (loopback + PKCE)');

  auth
    .command('gmail')
    .description('Run the loopback OAuth consent flow and store a refresh token')
    .option('--port <n>', 'loopback port (0 = ephemeral)', '0')
    .option('--with-insert', 'also request the gmail.insert scope (SELF_OPEN_STRATEGY=insert)')
    .option('--with-compose', 'also request the gmail.compose scope (openpost remind --draft)')
    .option('--with-smtp', 'also request the https://mail.google.com/ scope (MAIL_TRANSPORT=gmail-smtp)')
    .option('--no-browser', 'do not attempt to open a browser')
    .option('--print-only', 'print the authorization URL instead of opening a browser')
    .action(async (opts: { port: string; withInsert?: boolean; withCompose?: boolean; withSmtp?: boolean; browser?: boolean; printOnly?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const shouldOpenBrowser = !opts.printOnly && opts.browser !== false;
        const { store, path } = await runAuthGmailFlow({
          env: process.env,
          fetchImpl: fetch as unknown as FetchLike,
          clock: () => Date.now(),
          port: Number(opts.port ?? 0),
          withInsert: !!opts.withInsert,
          withCompose: !!opts.withCompose,
          withSmtp: !!opts.withSmtp,
          onAuthUrl: (url) => {
            process.stdout.write(`Open this URL to authorize openpost:\n\n  ${url}\n\n`);
          },
          ...(shouldOpenBrowser ? { openBrowser } : {}),
          getAccountEmail: async (refreshToken) => {
            try {
              // Finding #30: dynamic import - `auth status`/`auth revoke` never reach this closure
              // at all, so they never pay for loading `googleapis`.
              const { google } = await import('googleapis');
              const authClient = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
              authClient.setCredentials({ refresh_token: refreshToken });
              const gmail = google.gmail({ version: 'v1', auth: authClient });
              const profile = await gmail.users.getProfile({ userId: 'me' });
              return profile.data.emailAddress ?? null;
            } catch {
              return null;
            }
          },
        });

        audit(db, {
          actor: 'operator',
          action: 'auth.gmail.grant',
          detail: { fingerprint: store.clientIdFingerprint, scopes: store.scopes },
        });
        db.close();

        const result = { path, scopes: store.scopes, account: store.account };
        if (g.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          process.stdout.write(
            `refresh token stored (fingerprint sha256:${store.clientIdFingerprint}, scopes: ${store.scopes.join(', ')})\n`,
          );
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  auth
    .command('status')
    .description('Show which Gmail credential source is active')
    .action((_opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const status = computeAuthStatus(process.env, config, Date.now());
        if (g.json) {
          process.stdout.write(`${JSON.stringify(status)}\n`);
        } else if (!status.configured) {
          process.stdout.write('no Gmail credential configured (run `openpost auth gmail`)\n');
        } else {
          process.stdout.write(
            `source: ${status.source}\nscopes: ${status.scopes.join(', ') || '(unknown - from env)'}\n` +
              `account: ${status.account ?? 'unknown'}\nage: ${status.ageMs !== null ? `${Math.floor(status.ageMs / 86_400_000)}d` : 'unknown'}\n` +
              `gmail.insert scope: ${status.hasInsertScope ? 'yes' : 'no'}\n` +
              `gmail.compose scope: ${status.hasComposeScope ? 'yes' : 'no'}\n` +
              `https://mail.google.com/ scope (gmail-smtp): ${status.hasFullScope ? 'yes' : 'no'}\n`,
          );
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  auth
    .command('revoke')
    .description('Revoke the stored Gmail refresh token and delete the local token file')
    .option('--yes', 'do not prompt for confirmation')
    .action(async (opts: { yes?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const path = tokenStorePath(process.env);
        const store = readTokenStore(path);
        if (!store) {
          process.stdout.write('no stored Gmail token to revoke\n');
          return;
        }
        if (!opts.yes && !g.json) {
          process.stdout.write(`This will revoke the stored refresh token and delete ${path}. Re-run with --yes to confirm.\n`);
          return;
        }
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(store.refreshToken)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }).catch(() => undefined);
        const { unlinkSync } = await import('node:fs');
        try {
          unlinkSync(path);
        } catch {
          // already gone
        }
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        audit(db, { actor: 'operator', action: 'auth.gmail.revoke', detail: { fingerprint: store.clientIdFingerprint } });
        db.close();
        process.stdout.write('revoked and removed the local token file\n');
      } catch (err) {
        fail(err, g.json);
      }
    });
}
