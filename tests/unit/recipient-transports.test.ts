import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { buildMime } from '../../src/mail/mime.js';
import { GmailTransport } from '../../src/mail/gmail.js';
import { SmtpTransport } from '../../src/mail/smtp.js';
import { resolveTransport } from '../../src/mail/transport.js';
import { GmailAuthError, writeTokenStore } from '../../src/mail/oauth.js';
import type { GmailClient } from '../../src/mail/gmail.js';

// docs/07_recipient_semantics.md §6.5 - test cases 211-213.

describe('SmtpTransport envelope (§1.5 regression, test 211)', () => {
  it('211. passes an explicit one-address envelope, never an empty one', async () => {
    let captured: { raw?: Buffer; envelope?: { from: string; to: string[] } } | null = null;
    const fakeTransporter = {
      sendMail: async (opts: { raw: Buffer; envelope?: { from: string; to: string[] } }) => {
        captured = opts;
        return { messageId: 'smtp-msg-1' };
      },
    } as unknown as Parameters<typeof SmtpTransport>[1];

    const transport = new SmtpTransport({ host: 'smtp.example.com', port: 587, secure: false, user: undefined, pass: undefined }, fakeTransporter);
    const mime = await buildMime({
      from: { email: 'sender@example.com' },
      to: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    });

    await transport.send(mime, {
      to: ['a@example.com'],
      subject: 'hi',
      html: '<p>hi</p>',
      envelopeFrom: 'sender@example.com',
      envelopeTo: ['a@example.com'],
    });

    expect(captured).not.toBeNull();
    const env = (captured as unknown as { envelope: { from: string; to: string[] } }).envelope;
    expect(env).toEqual({ from: 'sender@example.com', to: ['a@example.com'] });
  });
});

describe('GmailTransport fan-out guard (§1.4, test 212)', () => {
  it('212. refuses a per-recipient copy whose headers name more addresses than the envelope, with no network call', async () => {
    let called = false;
    const fakeClient = {
      users: {
        messages: {
          send: async () => {
            called = true;
            return { data: { id: 'x', threadId: 'y' } };
          },
        },
      },
    } as unknown as GmailClient;
    const transport = new GmailTransport({ clientId: 'id', clientSecret: 'secret', refreshToken: 'token' }, fakeClient);

    // Full To/Cc headers (4 addresses) but this copy's envelope names only one - exactly the
    // fan-out hazard §1.4 describes.
    const mime = await buildMime({
      from: { email: 'sender@example.com' },
      to: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      cc: [{ email: 'c@example.com' }, { email: 'd@example.com' }],
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    });

    await expect(
      transport.send(mime, { to: ['a@example.com'], subject: 'hi', html: '<p>hi</p>', envelopeTo: ['a@example.com'] }),
    ).rejects.toThrow(/fan out|envelope/i);
    expect(called).toBe(false);
  });

  it('212b. a single-mode aggregate copy (headers == envelope) is allowed through to the network call', async () => {
    let called = false;
    const fakeClient = {
      users: {
        messages: {
          send: async () => {
            called = true;
            return { data: { id: 'x', threadId: 'y' } };
          },
        },
      },
    } as unknown as GmailClient;
    const transport = new GmailTransport({ clientId: 'id', clientSecret: 'secret', refreshToken: 'token' }, fakeClient);

    const mime = await buildMime({
      from: { email: 'sender@example.com' },
      to: [{ email: 'a@example.com' }, { email: 'b@example.com' }],
      cc: [{ email: 'c@example.com' }],
      subject: 'hi',
      html: '<p>hi</p>',
      text: 'hi',
    });

    await transport.send(mime, {
      to: ['a@example.com', 'b@example.com', 'c@example.com'],
      subject: 'hi',
      html: '<p>hi</p>',
      envelopeTo: ['a@example.com', 'b@example.com', 'c@example.com'],
      isAggregate: true,
    });
    expect(called).toBe(true);
  });
});

describe('gmail-smtp transport (§3.2/§6.2, test 213)', () => {
  it('213a. src/mail/gmail-smtp.ts never imports googleapis (XOAUTH2 is handled entirely by nodemailer)', () => {
    const here = fileURLToPath(import.meta.url);
    const src = join(here, '..', '..', '..', 'src', 'mail', 'gmail-smtp.ts');
    const contents = readFileSync(src, 'utf8');
    expect(contents).not.toMatch(/from\s+['"]googleapis['"]|import\(\s*['"]googleapis['"]\s*\)|require\(\s*['"]googleapis['"]\s*\)/);
  });

  it('213b. resolveTransport(gmail-smtp) throws GmailAuthError naming `auth gmail --with-smtp` when the stored token lacks the full scope', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'openpost-gmailsmtp-'));
    try {
      writeTokenStore(join(configDir, 'gmail-token.json'), {
        version: 1,
        clientIdFingerprint: 'abc',
        refreshToken: 'refresh-token-value',
        scopes: ['https://www.googleapis.com/auth/gmail.send'], // missing https://mail.google.com/
        obtainedAt: Date.now(),
        account: null,
      });
      const env = {
        TRACKING_SECRET: 'x'.repeat(32),
        MAIL_TRANSPORT: 'gmail-smtp',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
        FROM_EMAIL: 'sender@example.com',
        OPENPOST_CONFIG_DIR: configDir,
      };
      const config = loadConfig(env);
      const originalEnv = process.env.OPENPOST_CONFIG_DIR;
      process.env.OPENPOST_CONFIG_DIR = configDir;
      try {
        expect(() => resolveTransport(config)).toThrow(GmailAuthError);
        try {
          resolveTransport(config);
        } catch (err) {
          expect((err as GmailAuthError).remedy).toMatch(/auth gmail --with-smtp/);
        }
      } finally {
        if (originalEnv === undefined) delete process.env.OPENPOST_CONFIG_DIR;
        else process.env.OPENPOST_CONFIG_DIR = originalEnv;
      }
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
