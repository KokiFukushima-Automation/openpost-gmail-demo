import type { AppConfig } from '../config/env.js';
import { buildGmailClient } from './gmail.js';
import {
  GMAIL_SCOPE_READONLY,
  resolveRefreshToken,
  tokenStorePath,
  writeTokenStore,
  type GmailTokenStore,
} from './oauth.js';
import { connectImap } from './imap.js';
import { gmailThreadReader, imapThreadReader, type ThreadReader } from './threads.js';
import { gmailDraftClient, type DraftClient } from './draft.js';

export type ResolvedReplyMode = 'gmail' | 'imap' | 'off';

/** `REPLY_DETECTION=auto` resolution (§4.2): Gmail wins when a refresh token is available with the
 *  `gmail.readonly` scope (env-sourced tokens are trusted at face value - the scope list is only
 *  ever known for a token-file-sourced token), else IMAP when `IMAP_USER`/`IMAP_PASS` are set, else
 *  off. */
export function resolveReplyMode(config: AppConfig, env: NodeJS.ProcessEnv = process.env): ResolvedReplyMode {
  if (config.replyDetection === 'off') return 'off';
  if (config.replyDetection === 'gmail') return 'gmail';
  if (config.replyDetection === 'imap') return 'imap';

  const resolved = resolveRefreshToken(config, env);
  if (resolved && (resolved.source === 'env' || resolved.scopes.includes(GMAIL_SCOPE_READONLY))) {
    return 'gmail';
  }
  if (config.imapUser !== undefined && config.imapPass !== undefined) return 'imap';
  return 'off';
}

/** Builds the real `ThreadReader` for whichever mode `resolveReplyMode` picked, or `null` when the
 *  mode is `off` or the required credentials are missing. Never called by a test - every test
 *  injects a fake `ThreadReader` directly. */
export async function buildReplyReader(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ThreadReader | null> {
  const mode = resolveReplyMode(config, env);
  if (mode === 'gmail') {
    const resolved = resolveRefreshToken(config, env);
    if (!resolved || config.googleClientId === undefined || config.googleClientSecret === undefined) return null;
    const client = await buildGmailClient({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      refreshToken: resolved.token,
      onRefreshToken: (refreshToken) => {
        if (resolved.source !== 'file') return;
        try {
          const store: GmailTokenStore = {
            version: 1,
            clientIdFingerprint: '',
            refreshToken,
            scopes: resolved.scopes,
            obtainedAt: Date.now(),
            account: null,
          };
          writeTokenStore(tokenStorePath(env), store);
        } catch {
          // best-effort only.
        }
      },
    });
    return gmailThreadReader(client);
  }
  if (mode === 'imap') {
    if (config.imapUser === undefined || config.imapPass === undefined) return null;
    const client = await connectImap({
      host: config.imapHost,
      port: config.imapPort,
      user: config.imapUser,
      pass: config.imapPass,
    });
    return imapThreadReader(client, config.imapAllMailMailbox);
  }
  return null;
}

/** Builds a `DraftClient` for `openpost remind --draft` / the reminders job, or `null` when no
 *  Gmail refresh token is available (the reminder is still created; the notification still fires -
 *  only the draft is skipped, `draft_status='skipped'`). */
export async function buildDraftClient(
  config: AppConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<DraftClient | null> {
  const resolved = resolveRefreshToken(config, env);
  if (!resolved || config.googleClientId === undefined || config.googleClientSecret === undefined) return null;
  const client = await buildGmailClient({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    refreshToken: resolved.token,
  });
  return gmailDraftClient(client);
}
