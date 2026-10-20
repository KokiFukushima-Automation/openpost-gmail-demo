import nodemailer from 'nodemailer';

export interface MimeAddress {
  email: string;
  name?: string | undefined;
}

export interface BuildMimeInput {
  from: MimeAddress;
  to: MimeAddress[];
  cc?: MimeAddress[];
  /** docs/07_recipient_semantics.md HC-3: a delivered copy must never carry a `Bcc:` header (the
   *  BCC list is never passed to `buildMime` for a copy that will actually leave this process,
   *  except the one documented Gmail-API single-mode exception - §3.2/§5.3, where the caller
   *  accepts that Gmail itself strips the header). Only `buildUntrackedMime` (the self-copy, which
   *  never touches the network) is meant to pass a real `bcc` list routinely. */
  bcc?: MimeAddress[];
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  inReplyTo?: string;
  references?: string[];
  /** Overrides nodemailer's auto-generated Message-ID - used by the self-copy back-fill (§4.2) so
   *  the untracked Sent copy threads under the exact same Message-ID as the delivered copy. */
  messageId?: string;
  /** Overrides the Date header - used by the self-copy back-fill so the untracked copy's Date
   *  header matches the original send time rather than "now". */
  date?: Date;
}

export interface BuiltMime {
  raw: Buffer;
  messageId: string;
}

function toNodemailerAddress(a: MimeAddress): string | { name: string; address: string } {
  return a.name ? { name: a.name, address: a.email } : a.email;
}

/**
 * Builds an RFC-5322 multipart/alternative message (text part first) via nodemailer's stream
 * transport, without touching the network. No X-Mailer header is added.
 */
export async function buildMime(input: BuildMimeInput): Promise<BuiltMime> {
  const transporter = nodemailer.createTransport({
    streamTransport: true,
    newline: 'unix',
    buffer: true,
  });

  const info = await transporter.sendMail({
    from: toNodemailerAddress(input.from),
    to: input.to.map(toNodemailerAddress),
    cc: input.cc?.map(toNodemailerAddress),
    bcc: input.bcc?.map(toNodemailerAddress),
    subject: input.subject,
    text: input.text,
    html: input.html,
    headers: input.headers,
    inReplyTo: input.inReplyTo,
    references: input.references,
    ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    ...(input.date !== undefined ? { date: input.date } : {}),
  });

  const raw = info.message as Buffer;
  const messageId = info.messageId ?? '';
  return { raw, messageId };
}

/**
 * HC-3 enforcement: scans the raw MIME's header block (everything before the first blank line) for
 * a `Bcc:` header and throws if one is present. Called on every copy about to be handed to
 * dryrun/smtp/gmail-smtp (§6.2) - a programming error that slips a real `bcc` list into a delivered
 * copy's `buildMime` call is caught here rather than shipped.
 */
export function assertNoBccHeader(raw: Buffer): void {
  const text = raw.toString('utf8');
  const blankLineIdx = text.search(/\r?\n\r?\n/);
  const headerBlock = blankLineIdx === -1 ? text : text.slice(0, blankLineIdx);
  if (/^bcc\s*:/im.test(headerBlock)) {
    throw new Error(
      'invariant violation (HC-3): a delivered copy carries a Bcc header - refusing to send it',
    );
  }
}
