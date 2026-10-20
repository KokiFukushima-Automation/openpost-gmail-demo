export interface ImapFetchMessage {
  uid: number;
  envelope?: { date?: Date | string | null; from?: Array<{ address?: string; name?: string }> };
  internalDate?: Date;
  headers?: Buffer | string;
}

export interface ImapLike {
  append(mailbox: string, raw: Buffer, flags: string[], date: Date): Promise<unknown>;
  logout(): Promise<void>;
  /** Phase 3 (§4.2): the reply-detection search surface. Present on every real `ImapFlow`
   *  instance; the self-copy append path never calls these. */
  mailboxOpen(mailbox: string): Promise<unknown>;
  search(query: Record<string, unknown>): Promise<number[]>;
  fetch(range: number[] | string, opts: { envelope?: boolean; headers?: string[] }): AsyncIterable<ImapFetchMessage>;
}

export interface ImapConnectOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
}

/**
 * Dynamically imports the optional `imapflow` dependency and returns a connected `ImapLike` client
 * (§4.2's `imap-append` alternative to the Gmail API). Only ever called for a real
 * `SELF_OPEN_STRATEGY=imap-append` send; tests inject a fake `ImapLike` directly into
 * `appendSentCopy` and never exercise this function, so `imapflow` staying uninstalled never
 * breaks the test suite or the build (see `src/types/imapflow.d.ts`).
 */
export async function connectImap(opts: ImapConnectOptions): Promise<ImapLike> {
  const { ImapFlow } = await import('imapflow');
  const client = new ImapFlow({
    host: opts.host,
    port: opts.port,
    secure: opts.secure ?? true,
    auth: { user: opts.user, pass: opts.pass },
    logger: false,
  });
  await client.connect();
  return {
    append: (mailbox, raw, flags, date) => client.append(mailbox, raw, flags, date),
    logout: () => client.logout(),
    mailboxOpen: (mailbox) => client.mailboxOpen(mailbox),
    search: (query) => client.search(query),
    fetch: (range, opts) => client.fetch(range, opts),
  };
}
