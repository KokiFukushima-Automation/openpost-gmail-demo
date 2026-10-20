import { describe, expect, it } from 'vitest';
import { buildMime } from '../../src/mail/mime.js';

describe('mime', () => {
  it('30. builds a multipart/alternative message with both parts, a Message-ID, correct headers, no X-Mailer', async () => {
    const { raw, messageId } = await buildMime({
      from: { email: 'sender@example.com', name: 'Sender' },
      to: [{ email: 'recipient@example.com', name: 'Récipient Ünïcode' }],
      subject: 'Héllo wörld',
      html: '<p>Hi</p>',
      text: 'Hi',
    });

    const source = raw.toString('utf8');

    expect(source).toMatch(/Content-Type:\s*multipart\/alternative/i);
    expect(source).toMatch(/Content-Type:\s*text\/plain/i);
    expect(source).toMatch(/Content-Type:\s*text\/html/i);

    // text part precedes the html part.
    const textIdx = source.search(/Content-Type:\s*text\/plain/i);
    const htmlIdx = source.search(/Content-Type:\s*text\/html/i);
    expect(textIdx).toBeGreaterThan(-1);
    expect(htmlIdx).toBeGreaterThan(textIdx);

    expect(messageId).toMatch(/^<.+>$/);
    expect(source).toContain(`Message-ID: ${messageId}`);

    expect(source).toMatch(/^To: .*recipient@example\.com/im);
    // Non-ASCII subject is RFC 2047 encoded.
    expect(source).toMatch(/^Subject: =\?UTF-8\?/im);

    expect(source).not.toMatch(/X-Mailer/i);
  });
});
