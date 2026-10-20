import nodemailer from 'nodemailer';
import { assertNoBccHeader } from './mime.js';
import type { SendResult, Transport, TransportSendMeta, TransportSendMime } from './transport.js';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string | undefined;
  pass: string | undefined;
}

type NodemailerTransporter = ReturnType<typeof nodemailer.createTransport>;

/** SMTP fallback transport (e.g. a Gmail app password). Accepts an injected transporter for tests. */
export class SmtpTransport implements Transport {
  readonly name = 'smtp' as const;
  private readonly transporter: NodemailerTransporter;

  constructor(options: SmtpOptions, transporter?: NodemailerTransporter) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: options.user && options.pass ? { user: options.user, pass: options.pass } : undefined,
      });
  }

  async send(mime: TransportSendMime, meta: TransportSendMeta): Promise<SendResult> {
    // HC-3: a delivered copy must never carry a Bcc header, on this transport in either mode.
    assertNoBccHeader(mime.raw);

    // docs/07_recipient_semantics.md §1.5: `sendMail({ raw })` alone produces an empty envelope
    // (`getEnvelope() === { from: false, to: [] }`) - a real SMTP send had no RCPT TO at all. The
    // envelope is now explicit: exactly the addresses this copy is actually meant to reach, never
    // derived from the MIME headers themselves.
    const envelopeTo = meta.envelopeTo && meta.envelopeTo.length > 0 ? meta.envelopeTo : meta.to;
    const info = await this.transporter.sendMail({
      raw: mime.raw,
      envelope: { from: meta.envelopeFrom ?? '', to: envelopeTo },
    });

    return {
      providerMessageId: info.messageId ?? null,
      threadId: null,
      rfc822MessageId: mime.messageId,
      sentAt: Date.now(),
    };
  }
}
