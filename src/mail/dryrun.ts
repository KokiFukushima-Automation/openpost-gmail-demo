import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from '../core/ids.js';
import { assertNoBccHeader } from './mime.js';
import type { SendResult, Transport, TransportSendMeta, TransportSendMime } from './transport.js';

function prependHeaders(raw: Buffer, headers: Record<string, string | undefined>): Buffer {
  const lines = Object.entries(headers)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  if (lines.length === 0) return raw;
  return Buffer.concat([Buffer.from(`${lines}\n`), raw]);
}

/** Writes `${outDir}/<id>.html` + `.eml` per call and never touches the network. */
export class DryRunTransport implements Transport {
  readonly name = 'dryrun' as const;

  constructor(private readonly outDir: string) {}

  async send(mime: TransportSendMime, meta: TransportSendMeta): Promise<SendResult> {
    // HC-3, even in dryrun: the artefact written here is meant to be exactly what would have gone
    // out over the wire.
    assertNoBccHeader(mime.raw);

    mkdirSync(this.outDir, { recursive: true });

    const base = meta.messageId
      ? meta.recipientId
        ? `${meta.messageId}.${meta.recipientId}`
        : meta.messageId
      : newId();
    const htmlPath = join(this.outDir, `${base}.html`);
    const emlPath = join(this.outDir, `${base}.eml`);

    // docs/07_recipient_semantics.md §6.4: annotation headers prepended to the WRITTEN bytes only -
    // never part of the MIME actually built/sent, so they never affect assertNoBccHeader, the
    // returned `mime.messageId`, or anything a real transport would see.
    const envelopeTo = meta.envelopeTo && meta.envelopeTo.length > 0 ? meta.envelopeTo : meta.to;
    const annotated = prependHeaders(mime.raw, {
      'X-Openpost-Envelope-To': envelopeTo.join(', '),
      'X-Openpost-Recipient-Kind': meta.recipientKind,
      'X-Openpost-Recipient-Mode': meta.recipientMode,
    });

    await writeFile(htmlPath, meta.html, 'utf8');
    await writeFile(emlPath, annotated);

    return {
      providerMessageId: null,
      threadId: null,
      rfc822MessageId: mime.messageId,
      sentAt: Date.now(),
      artifacts: { htmlPath, emlPath },
    };
  }

  /**
   * §6.4/§3.1: dryrun has no real Sent mailbox to insert/append into, so `send.ts` renders the
   * self-copy here instead of running `insertSentCopy`/`appendSentCopy` - `${outDir}/<messageId>.sent.eml`,
   * untracked, never annotated (it is meant to look exactly like what SELF_OPEN_STRATEGY=insert
   * would have written to Sent).
   */
  async writeSentCopy(mime: { raw: Buffer }, messageId: string): Promise<{ path: string }> {
    mkdirSync(this.outDir, { recursive: true });
    const path = join(this.outDir, `${messageId}.sent.eml`);
    await writeFile(path, mime.raw);
    return { path };
  }
}
