// Minimal ambient surface for the optional `imapflow` dependency (§4.2). `imapflow` is declared
// as an `optionalDependency` and imported only via a dynamic `import('imapflow')` inside
// `src/mail/imap.ts`'s `connectImap`, which real `SELF_OPEN_STRATEGY=imap-append` runs use and
// tests never do (they inject a fake `ImapLike`). This ambient declaration means `tsc` can type-
// check that dynamic import even when `imapflow` was not actually installed (an optional
// dependency's install can be skipped by npm on some platforms) - real installed types, if
// present in node_modules, take precedence over this one.
declare module 'imapflow' {
  export interface ImapFlowOptions {
    host: string;
    port: number;
    secure?: boolean;
    auth: { user: string; pass: string };
    logger?: false | Record<string, unknown>;
  }

  export class ImapFlow {
    constructor(options: ImapFlowOptions);
    connect(): Promise<void>;
    append(mailbox: string, content: Buffer, flags?: string[], date?: Date): Promise<unknown>;
    logout(): Promise<void>;
    mailboxOpen(mailbox: string): Promise<unknown>;
    search(query: Record<string, unknown>): Promise<number[]>;
    fetch(
      range: number[] | string,
      opts: { envelope?: boolean; headers?: string[] },
    ): AsyncIterable<{
      uid: number;
      envelope?: { date?: Date | string | null; from?: Array<{ address?: string; name?: string }> };
      internalDate?: Date;
      headers?: Buffer | string;
    }>;
  }
}
