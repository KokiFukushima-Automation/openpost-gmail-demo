// Finding #30: `googleapis` is imported dynamically (only when a Gmail API call is actually about
// to happen), never at module load - its transitive chain (gaxios -> node-fetch@2 -> whatwg-url@5
// -> tr46) is what prints Node's `punycode` DeprecationWarning on *every* CLI invocation, including
// `list`/`show`/dryrun sends that never touch Gmail at all. `import type` below costs nothing at
// runtime (erased entirely), so the type surface stays exactly as before.
import type { google as GoogleApis } from 'googleapis';
import type { SendResult, Transport, TransportSendMeta, TransportSendMime } from './transport.js';

export interface GmailOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Called whenever googleapis refreshes the access token and receives a *new* refresh token
   *  (rare, but happens on some re-consent flows) - persists it so the on-disk token store never
   *  goes stale (§6). */
  onRefreshToken?: (refreshToken: string) => void;
}

export type GmailClient = ReturnType<typeof GoogleApis.gmail>;

/** Builds a real, connected `GmailClient` (dynamic `import('googleapis')` - never at module load,
 *  finding #30). Shared by `GmailTransport`, `src/jobs/replies.ts`'s reader factory and
 *  `openpost remind --draft`'s draft client, so there is exactly one place that wires up the OAuth2
 *  credentials. */
export async function buildGmailClient(options: GmailOptions): Promise<GmailClient> {
  const { google } = await import('googleapis');
  const auth = new google.auth.OAuth2(options.clientId, options.clientSecret);
  auth.setCredentials({ refresh_token: options.refreshToken });
  auth.on('tokens', (tokens) => {
    if (tokens.refresh_token && options.onRefreshToken) {
      options.onRefreshToken(tokens.refresh_token);
    }
  });
  return google.gmail({ version: 'v1', auth });
}

function headerBlock(raw: Buffer): string {
  const text = raw.toString('utf8');
  const idx = text.search(/\r?\n\r?\n/);
  return idx === -1 ? text : text.slice(0, idx);
}

/** Unfolds RFC 5322 continuation lines (a header value nodemailer wrapped across multiple lines)
 *  back into one logical header line per entry. */
function unfoldHeaderLines(block: string): string[] {
  const raw = block.split(/\r?\n/);
  const lines: string[] = [];
  for (const line of raw) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] = `${lines[lines.length - 1]} ${line.trim()}`;
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Counts the comma-separated addresses named in one header (`to` or `cc`) of a raw MIME message -
 *  good enough for the fan-out guard below, which only ever inspects mail this codebase itself
 *  built via `buildMime` (never arbitrary third-party MIME). */
function countHeaderAddresses(raw: Buffer, name: 'to' | 'cc'): number {
  const lines = unfoldHeaderLines(headerBlock(raw));
  const prefix = `${name}:`;
  const line = lines.find((l) => l.toLowerCase().startsWith(prefix));
  if (!line) return 0;
  const value = line.slice(line.indexOf(':') + 1);
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0).length;
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A Gmail `invalid_grant` error (revoked/expired refresh token) carries this shape from
 *  googleapis; narrowed here rather than importing its internal error types. */
export function isInvalidGrantError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const withResponse = err as Error & { response?: { data?: { error?: string } }; code?: number };
  const bodyError = withResponse.response?.data?.error;
  return bodyError === 'invalid_grant' || /invalid_grant/i.test(err.message);
}

/**
 * Sends via `users.messages.send` (OAuth2 refresh-token flow). Scopes: `gmail.send` (required),
 * `gmail.readonly` (requested now, used in Phase 3). Accepts an injected client for tests, which
 * never triggers the dynamic `googleapis` import at all.
 */
export class GmailTransport implements Transport {
  readonly name = 'gmail' as const;
  private client: GmailClient | undefined;
  private readonly options: GmailOptions | undefined;

  constructor(options: GmailOptions, client?: GmailClient) {
    if (client) {
      this.client = client;
    } else {
      this.options = options;
    }
  }

  private async getClient(): Promise<GmailClient> {
    if (this.client) return this.client;
    const { google } = await import('googleapis');
    const options = this.options as GmailOptions;
    const auth = new google.auth.OAuth2(options.clientId, options.clientSecret);
    auth.setCredentials({ refresh_token: options.refreshToken });
    // Access tokens live only in memory; only a *new* refresh token (rare) is ever persisted.
    auth.on('tokens', (tokens) => {
      if (tokens.refresh_token && options.onRefreshToken) {
        options.onRefreshToken(tokens.refresh_token);
      }
    });
    this.client = google.gmail({ version: 'v1', auth });
    return this.client;
  }

  async send(mime: TransportSendMime, meta: TransportSendMeta): Promise<SendResult> {
    // docs/07_recipient_semantics.md §1.4/§6.2: users.messages.send derives delivery ENTIRELY from
    // the To/Cc/Bcc headers of the submitted raw - there is no envelope override. A per-recipient
    // copy whose headers name more addresses than the envelope this copy is actually meant to reach
    // would silently fan out to every one of those addresses, for every copy sent - defence in
    // depth against exactly that, independent of whatever `send.ts` believes it is doing.
    const envelopeTo = meta.envelopeTo && meta.envelopeTo.length > 0 ? meta.envelopeTo : meta.to;
    const headerAddressCount = countHeaderAddresses(mime.raw, 'to') + countHeaderAddresses(mime.raw, 'cc');
    if (headerAddressCount > envelopeTo.length) {
      throw new Error(
        `refusing to send over MAIL_TRANSPORT=gmail: the message headers name ${headerAddressCount} ` +
          `address(es) but this copy's envelope is only ${envelopeTo.length} - users.messages.send has no ` +
          'envelope override, so sending this would fan out to every header address on every copy ' +
          '(docs/07_recipient_semantics.md §1.4). Use --transport gmail-smtp, or --recipient-mode single.',
      );
    }

    try {
      const client = await this.getClient();
      const res = await client.users.messages.send({
        userId: 'me',
        requestBody: { raw: base64url(mime.raw) },
      });
      return {
        providerMessageId: res.data.id ?? null,
        threadId: res.data.threadId ?? null,
        rfc822MessageId: mime.messageId,
        sentAt: Date.now(),
      };
    } catch (err) {
      if (isInvalidGrantError(err)) {
        const { GmailAuthError } = await import('./oauth.js');
        throw new GmailAuthError(
          'Gmail refused the refresh token (invalid_grant - it was revoked or expired)',
          'run `openpost auth gmail` to re-authorise',
        );
      }
      throw err;
    }
  }
}
