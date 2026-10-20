import nodemailer from 'nodemailer';
import { assertNoBccHeader } from './mime.js';
import type { SendResult, Transport, TransportSendMeta, TransportSendMime } from './transport.js';

export interface GmailSmtpOptions {
  host: string;
  port: number;
  /** `FROM_EMAIL` - the mailbox nodemailer authenticates as via XOAUTH2. */
  user: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

type NodemailerTransporter = ReturnType<typeof nodemailer.createTransport>;

/**
 * docs/07_recipient_semantics.md §3.2/§6.2: SMTP submission to `smtp.gmail.com` authenticated via
 * OAuth2/XOAUTH2, giving per-recipient CC-correct sends an explicit SMTP envelope the Gmail REST
 * API cannot offer. nodemailer's `auth: { type: 'OAuth2', ... }` speaks XOAUTH2 and mints its own
 * access tokens directly against Google's token endpoint - `googleapis` is never imported by this
 * transport (test 213).
 */
export class GmailSmtpTransport implements Transport {
  readonly name = 'gmail-smtp' as const;
  private readonly transporter: NodemailerTransporter;

  constructor(options: GmailSmtpOptions, transporter?: NodemailerTransporter) {
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        // Port 465 is implicit TLS; 587 is STARTTLS (secure: false, nodemailer upgrades itself).
        secure: options.port === 465,
        auth: {
          type: 'OAuth2',
          user: options.user,
          clientId: options.clientId,
          clientSecret: options.clientSecret,
          refreshToken: options.refreshToken,
        },
      });
  }

  async send(mime: TransportSendMime, meta: TransportSendMeta): Promise<SendResult> {
    // HC-3, defence in depth (mirrors SmtpTransport): a delivered copy must never carry a Bcc
    // header, on this transport exactly as on plain SMTP.
    assertNoBccHeader(mime.raw);

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
