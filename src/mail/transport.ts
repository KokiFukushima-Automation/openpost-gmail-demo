import type { AppConfig } from '../config/env.js';
import type { RecipientMode, TransportName } from '../types.js';
import { DryRunTransport } from './dryrun.js';
import { GmailSmtpTransport } from './gmail-smtp.js';
import { GmailTransport } from './gmail.js';
import { GMAIL_SCOPE_FULL, GmailAuthError, resolveRefreshToken, tokenStorePath, writeTokenStore, type GmailTokenStore } from './oauth.js';
import { SmtpTransport } from './smtp.js';

export interface TransportSendMime {
  raw: Buffer;
  messageId: string;
}

export interface TransportSendMeta {
  to: string[];
  subject: string;
  html: string;
  /** Used only to name dry-run artefacts predictably; ignored by real transports. */
  messageId?: string;
  recipientId?: string;
  /** docs/07_recipient_semantics.md §6.2: the SMTP `MAIL FROM` address - `smtp.ts`/`gmail-smtp.ts`
   *  pass this (and `envelopeTo`) as an explicit envelope, fixing the empty-envelope bug (§1.5). */
  envelopeFrom?: string;
  /** The SMTP `RCPT TO` list actually used for this copy: one address in per-recipient mode, every
   *  address in single mode. */
  envelopeTo?: string[];
  recipientMode?: RecipientMode;
  recipientKind?: 'to' | 'cc' | 'bcc';
  /** True for the single-mode aggregate copy (§4.2) - lets a transport apply the §3.2(c) fan-out
   *  guard (`gmail.ts`) without re-deriving it from `envelopeTo`/`to` shapes. */
  isAggregate?: boolean;
}

export interface SendResult {
  providerMessageId: string | null;
  threadId: string | null;
  rfc822MessageId: string;
  sentAt: number;
  artifacts?: { htmlPath: string; emlPath: string };
}

export interface Transport {
  readonly name: TransportName;
  send(mime: TransportSendMime, meta: TransportSendMeta): Promise<SendResult>;
}

export function resolveTransport(config: AppConfig): Transport {
  switch (config.mailTransport) {
    case 'dryrun':
      return new DryRunTransport(config.outDir);
    case 'smtp':
      return new SmtpTransport({
        host: config.smtpHost ?? '',
        port: config.smtpPort,
        secure: config.smtpSecure,
        user: config.smtpUser,
        pass: config.smtpPass,
      });
    case 'gmail': {
      // §6: env (GOOGLE_REFRESH_TOKEN) beats the on-disk token store from `openpost auth gmail`.
      const resolved = resolveRefreshToken(config, process.env);
      return new GmailTransport({
        clientId: config.googleClientId ?? '',
        clientSecret: config.googleClientSecret ?? '',
        refreshToken: resolved?.token ?? config.googleRefreshToken ?? '',
        onRefreshToken: (refreshToken) => {
          // Only ever persist a *new* refresh token back to the file it came from - never invent a
          // file when the token came from the environment.
          if (resolved?.source !== 'file') return;
          const path = tokenStorePath(process.env);
          const previous = resolved;
          const store: GmailTokenStore = {
            version: 1,
            clientIdFingerprint: '',
            refreshToken,
            scopes: previous.scopes,
            obtainedAt: Date.now(),
            account: null,
          };
          try {
            writeTokenStore(path, store);
          } catch {
            // Best-effort: a failure here must never break sending mail.
          }
        },
      });
    }
    case 'gmail-smtp': {
      // docs/07_recipient_semantics.md §3.2/§6.2: SMTP submission to smtp.gmail.com via OAuth2/
      // XOAUTH2 - reuses the same refresh-token resolution as `gmail`, but requires the broader
      // https://mail.google.com/ scope (gmail.send is refused by Gmail's SMTP front end). A
      // file-sourced token missing that scope fails loudly, naming the remedy (test 213); an
      // env-sourced token's scopes are unknowable here, so it is trusted (mirrors reply-setup.ts).
      const resolved = resolveRefreshToken(config, process.env);
      const refreshToken = resolved?.token ?? config.googleRefreshToken;
      if (!refreshToken) {
        throw new GmailAuthError(
          'no Gmail refresh token available for gmail-smtp',
          'run `openpost auth gmail --with-smtp` to authorise',
        );
      }
      if (resolved && resolved.source === 'file' && !resolved.scopes.includes(GMAIL_SCOPE_FULL)) {
        throw new GmailAuthError(
          'the stored Gmail credential lacks the https://mail.google.com/ scope required for SMTP submission',
          'run `openpost auth gmail --with-smtp` to re-authorise with the full-mail scope',
        );
      }
      if (!config.fromEmail) {
        throw new GmailAuthError(
          'gmail-smtp requires FROM_EMAIL (used as the XOAUTH2 identity)',
          'set FROM_EMAIL in .env',
        );
      }
      return new GmailSmtpTransport({
        host: config.gmailSmtpHost,
        port: config.gmailSmtpPort,
        user: config.fromEmail,
        clientId: config.googleClientId ?? '',
        clientSecret: config.googleClientSecret ?? '',
        refreshToken,
      });
    }
    default: {
      const exhaustive: never = config.mailTransport;
      throw new Error(`unknown transport: ${String(exhaustive)}`);
    }
  }
}
