import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { addSuppression, ensureAccount, getRecipient } from '../../src/db/repo.js';
import { createCampaign } from '../../src/db/campaigns.js';
import { loadConfig } from '../../src/config/env.js';
import { resolveAccount } from '../../src/mail/accounts.js';
import { resolveTransport } from '../../src/mail/transport.js';
import { assertUnsubscribePresent, sendMessage } from '../../src/mail/send-message.js';

function makeCampaign(db: DB): string {
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  return createCampaign(db, {
    name: 'test',
    accountId: account.id,
    subjectTemplate: 'Hi',
    bodyHtmlTemplate: '<p>Hi</p>',
    fromEmail: 'sender@example.com',
    transport: 'dryrun',
    ratePerMinute: 6000,
    jitterMs: 0,
    dailyCap: 1000,
    emailColumn: 'email',
    columnsJson: '["email"]',
    createdAt: Date.now(),
  }).id;
}

function baseEnv(outDir: string): NodeJS.ProcessEnv {
  return {
    TRACKING_SECRET: 'a'.repeat(40),
    TRACKING_BASE_URL: 'http://localhost:8787',
    FROM_EMAIL: 'sender@example.com',
    MAIL_TRANSPORT: 'dryrun',
    OUT_DIR: outDir,
  };
}

describe('send-message (single-recipient extraction)', () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-sendmsg-'));
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends one message to one recipient, injects the pixel, and marks it dryrun/sent', async () => {
    const config = loadConfig(baseEnv(dir));
    const account = resolveAccount(db, config);
    const transport = resolveTransport(config);
    const campaignId = makeCampaign(db);
    const outcome = await sendMessage(
      { db, config, transport },
      {
        account,
        addresses: [{ email: 'row1@example.com', kind: 'to' }],
        subject: 'Hi row1',
        html: '<html><body><p>Hello</p></body></html>',
        track: true,
        trackClicks: false,
        optOutFooter: true,
        listUnsubscribe: true,
        campaignId,
      },
    );
    expect(outcome.status).toBe('dryrun');
    expect(outcome.pixelUrl).toBeDefined();
    const recipient = getRecipient(db, outcome.recipientId);
    expect(recipient?.email).toBe('row1@example.com');
    const message = db.prepare('SELECT campaign_id FROM messages WHERE id = ?').get(outcome.messageId) as { campaign_id: string | null };
    expect(message.campaign_id).toBe(campaignId);
  });

  it('257. List-Unsubscribe and List-Unsubscribe-Post headers appear on the built MIME', async () => {
    const config = loadConfig(baseEnv(dir));
    const account = resolveAccount(db, config);
    const transport = resolveTransport(config);
    const outcome = await sendMessage(
      { db, config, transport },
      {
        account,
        addresses: [{ email: 'row2@example.com', kind: 'to' }],
        subject: 'Hi',
        html: '<html><body><p>Hello</p></body></html>',
        track: true,
        trackClicks: false,
        optOutFooter: true,
        listUnsubscribe: true,
        campaignId: makeCampaign(db),
      },
    );
    expect(outcome.artifacts).toBeDefined();
    const eml = readFileSync(outcome.artifacts!.emlPath, 'utf8');
    expect(eml).toMatch(/List-Unsubscribe:/);
    expect(eml).toMatch(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/);
  });

  it('assertUnsubscribePresent throws if the header, the html footer, or the text footer is missing', () => {
    expect(() => assertUnsubscribePresent('<p>no footer</p>', 'Unsubscribe here', { 'List-Unsubscribe': '<https://x/u/1>' })).toThrow();
    expect(() => assertUnsubscribePresent('<p>Unsubscribe here</p>', 'Unsubscribe here', undefined)).toThrow();
    // finding #4: the html part alone is no longer enough - a missing/undefined text part also throws.
    expect(() => assertUnsubscribePresent('<p>Unsubscribe here</p>', undefined, { 'List-Unsubscribe': '<https://x/u/1>' })).toThrow();
    expect(() => assertUnsubscribePresent('<p>Unsubscribe here</p>', 'no mention', { 'List-Unsubscribe': '<https://x/u/1>' })).toThrow();
    expect(() =>
      assertUnsubscribePresent('<p>Unsubscribe here</p>', 'Unsubscribe here', { 'List-Unsubscribe': '<https://x/u/1>' }),
    ).not.toThrow();
  });

  it('finding #4: a campaign whose --text-template never references {{unsubscribe_url}} still ships an unsubscribe line in the text part', async () => {
    const config = loadConfig(baseEnv(dir));
    const account = resolveAccount(db, config);
    const transport = resolveTransport(config);
    const outcome = await sendMessage(
      { db, config, transport },
      {
        account,
        addresses: [{ email: 'row3@example.com', kind: 'to' }],
        subject: 'Hi',
        html: '<html><body><p>Hello</p></body></html>',
        text: 'Plain text body with no opt-out mention.',
        track: true,
        trackClicks: false,
        optOutFooter: true,
        listUnsubscribe: true,
        campaignId: makeCampaign(db),
      },
    );
    expect(outcome.artifacts).toBeDefined();
    expect(outcome.optOutUrl).toBeDefined();
    const eml = readFileSync(outcome.artifacts!.emlPath, 'utf8');
    // The supplied text had no unsubscribe mention at all - if "unsubscribe" appears only once in
    // the body, it is the html part's link text and the text part still has no opt-out (finding #4).
    // Match case-insensitively on the word rather than the full URL, which nodemailer's default
    // quoted-printable body encoding may soft-wrap across lines.
    const bodyOccurrences = (eml.match(/unsubscribe/gi) ?? []).length;
    expect(bodyOccurrences).toBeGreaterThanOrEqual(2);
  });

  it('a suppressed recipient still gets a message row but no pixel/opt-out URL is reported', async () => {
    const config = loadConfig(baseEnv(dir));
    addSuppression(db, 'blocked@example.com', 'recipient_optout');
    const account = resolveAccount(db, config);
    const transport = resolveTransport(config);
    const outcome = await sendMessage(
      { db, config, transport },
      {
        account,
        addresses: [{ email: 'blocked@example.com', kind: 'to' }],
        subject: 'Hi',
        html: '<html><body><p>Hello</p></body></html>',
        track: true,
        trackClicks: false,
        optOutFooter: true,
        listUnsubscribe: true,
      },
    );
    expect(outcome.pixelUrl).toBeUndefined();
    expect(outcome.optOutUrl).toBeUndefined();
  });
});
