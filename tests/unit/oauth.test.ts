import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { get as httpGet } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GMAIL_SCOPES_BASE,
  GMAIL_SCOPE_INSERT,
  GmailAuthError,
  buildAuthUrl,
  readTokenStore,
  resolveRefreshToken,
  tokenStorePath,
} from '../../src/mail/oauth.js';
const spawnMock = vi.fn(() => {
  const fake = new EventEmitter() as EventEmitter & { unref: () => void };
  fake.unref = () => undefined;
  return fake;
});
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import { openBrowser, runAuthGmailFlow } from '../../src/cli/commands/auth.js';
import { GmailTransport, isInvalidGrantError } from '../../src/mail/gmail.js';
import type { FetchLike } from '../../src/notify/types.js';
import { makeConfig } from '../helpers/setup.js';

let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'openpost-oauth-'));
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

describe('buildAuthUrl', () => {
  it('111. contains access_type=offline, prompt=consent, code_challenge_method=S256, the loopback redirect_uri and every requested scope', () => {
    const withoutInsert = buildAuthUrl({ clientId: 'id1', redirectUri: 'http://127.0.0.1:5555/oauth2callback', scopes: [...GMAIL_SCOPES_BASE] });
    const url = new URL(withoutInsert.url);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:5555/oauth2callback');
    for (const scope of GMAIL_SCOPES_BASE) {
      expect(url.searchParams.get('scope')).toContain(scope);
    }
    expect(url.searchParams.get('scope')).not.toContain(GMAIL_SCOPE_INSERT);

    const withInsert = buildAuthUrl({
      clientId: 'id1',
      redirectUri: 'http://127.0.0.1:5555/oauth2callback',
      scopes: [...GMAIL_SCOPES_BASE, GMAIL_SCOPE_INSERT],
    });
    expect(new URL(withInsert.url).searchParams.get('scope')).toContain(GMAIL_SCOPE_INSERT);
  });
});

function fakeTokenFetch(response: Record<string, unknown>, status = 200): FetchLike {
  return (async () => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => JSON.stringify(response),
  })) as unknown as FetchLike;
}

describe('the full loopback flow (runAuthGmailFlow)', () => {
  it('112. exchangeCode against a fake token endpoint writes the store with mode 0600', async () => {
    const env = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', HOME: tmpHome };
    const fetchImpl = fakeTokenFetch({ refresh_token: 'rt-123', scope: GMAIL_SCOPES_BASE.join(' ') });

    let capturedUrl = '';
    const flow = runAuthGmailFlow({
      env,
      fetchImpl,
      clock: () => 1000,
      port: 0,
      withInsert: false,
      onAuthUrl: (url) => {
        capturedUrl = url;
        const cbUrl = new URL(url);
        const state = cbUrl.searchParams.get('state') as string;
        const redirectUri = new URL(cbUrl.searchParams.get('redirect_uri') as string);
        redirectUri.searchParams.set('code', 'auth-code-abc');
        redirectUri.searchParams.set('state', state);
        httpGet(redirectUri.toString(), (res) => res.resume());
      },
    });

    const { store, path } = await flow;
    expect(capturedUrl).toContain('accounts.google.com');
    expect(store.refreshToken).toBe('rt-123');
    expect(path).toBe(tokenStorePath(env));

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);

    const reread = readTokenStore(path);
    expect(reread?.refreshToken).toBe('rt-123');
  });

  it('113a. a state mismatch writes no file and rejects', async () => {
    const env = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', HOME: tmpHome };
    const fetchImpl = fakeTokenFetch({ refresh_token: 'rt-123' });

    const flow = runAuthGmailFlow({
      env,
      fetchImpl,
      clock: () => 1000,
      port: 0,
      withInsert: false,
      onAuthUrl: (url) => {
        const redirectUri = new URL(new URL(url).searchParams.get('redirect_uri') as string);
        redirectUri.searchParams.set('code', 'auth-code-abc');
        redirectUri.searchParams.set('state', 'totally-wrong-state');
        httpGet(redirectUri.toString(), (res) => res.resume());
      },
    });

    await expect(flow).rejects.toThrow(GmailAuthError);
    expect(readTokenStore(tokenStorePath(env))).toBeNull();
  });

  it('113b. a response with no refresh_token fails with the documented remedy', async () => {
    const env = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', HOME: tmpHome };
    const fetchImpl = fakeTokenFetch({ access_token: 'at-only' });

    const flow = runAuthGmailFlow({
      env,
      fetchImpl,
      clock: () => 1000,
      port: 0,
      withInsert: false,
      onAuthUrl: (url) => {
        const cbUrl = new URL(url);
        const redirectUri = new URL(cbUrl.searchParams.get('redirect_uri') as string);
        redirectUri.searchParams.set('code', 'auth-code-abc');
        redirectUri.searchParams.set('state', cbUrl.searchParams.get('state') as string);
        httpGet(redirectUri.toString(), (res) => res.resume());
      },
    });

    await expect(flow).rejects.toThrow(/refresh token/i);
  });

  it('finding #17: an abandoned flow (no callback ever arrives) times out and rejects instead of hanging forever', async () => {
    const env = { GOOGLE_CLIENT_ID: 'client-id', GOOGLE_CLIENT_SECRET: 'client-secret', HOME: tmpHome };
    const fetchImpl = fakeTokenFetch({ refresh_token: 'rt-never-used' });

    const flow = runAuthGmailFlow({
      env,
      fetchImpl,
      clock: () => 1000,
      port: 0,
      withInsert: false,
      timeoutMs: 20,
      onAuthUrl: () => {
        // Deliberately never hit the callback - simulates the user closing the browser tab.
      },
    });

    await expect(flow).rejects.toThrow(/timed out/i);
    expect(readTokenStore(tokenStorePath(env))).toBeNull();
  });
});

describe('resolveRefreshToken', () => {
  it('114. prefers GOOGLE_REFRESH_TOKEN over the file and reports the source', () => {
    const env = { HOME: tmpHome };
    const config = makeConfig({ googleRefreshToken: 'env-token' });
    const resolved = resolveRefreshToken(config, env);
    expect(resolved?.source).toBe('env');
    expect(resolved?.token).toBe('env-token');

    const configNoEnv = makeConfig({ googleRefreshToken: undefined });
    expect(resolveRefreshToken(configNoEnv, env)).toBeNull();
  });
});

describe('GmailTransport invalid_grant handling', () => {
  it('115. a Gmail invalid_grant is surfaced as GmailAuthError carrying the remedy string', () => {
    const err = Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
    expect(isInvalidGrantError(err)).toBe(true);
    expect(isInvalidGrantError(new Error('some other error'))).toBe(false);
  });

  it('a real send() failure with invalid_grant throws GmailAuthError with the documented remedy', async () => {
    const fakeClient = {
      users: {
        messages: {
          send: async () => {
            throw Object.assign(new Error('invalid_grant'), { response: { data: { error: 'invalid_grant' } } });
          },
        },
      },
    };
    const transport = new GmailTransport(
      { clientId: 'x', clientSecret: 'y', refreshToken: 'z' },
      fakeClient as never,
    );
    await expect(transport.send({ raw: Buffer.from(''), messageId: 'm1' }, { to: ['a@example.com'], subject: 's', html: '' })).rejects.toMatchObject(
      { name: 'GmailAuthError', remedy: expect.stringContaining('auth gmail') },
    );
  });
});

describe('openBrowser (finding #16)', () => {
  beforeEach(() => {
    spawnMock.mockClear();
  });

  it('on win32, invokes cmd.exe\'s argv directly (no shell:true) - a URL with "&" is one literal argument, never re-parsed by a shell', () => {
    const dangerousUrl = 'http://127.0.0.1:5555/oauth2callback?state=abc&x=y';
    openBrowser(dangerousUrl, 'win32');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(cmd).toBe('cmd');
    expect(args).toEqual(['/c', 'start', '""', dangerousUrl]);
    // The whole point: no shell re-interprets this argv, so `shell` must never be requested.
    expect(opts.shell).not.toBe(true);
  });

  it('on darwin/linux, uses open/xdg-open with no shell', () => {
    openBrowser('http://127.0.0.1:5555/x', 'darwin');
    expect(spawnMock.mock.calls[0]?.[0]).toBe('open');
    expect((spawnMock.mock.calls[0]?.[2] as Record<string, unknown>).shell).not.toBe(true);

    spawnMock.mockClear();
    openBrowser('http://127.0.0.1:5555/x', 'linux');
    expect(spawnMock.mock.calls[0]?.[0]).toBe('xdg-open');
    expect((spawnMock.mock.calls[0]?.[2] as Record<string, unknown>).shell).not.toBe(true);
  });
});

