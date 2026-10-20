import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb } from '../../src/db/index.js';
import { addAccount } from '../../src/mail/accounts.js';
import { runSend } from '../../src/mail/send-run.js';
import { makeConfig } from '../helpers/setup.js';

describe('runSend transport resolution (docs/09_phase5_spec.md §2.3, phase5.1 findings #1/#15)', () => {
  let outDir: string;
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'op-runsend-'));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("finding #15: throws when input.transport conflicts with the account's own transport", async () => {
    const db = openDb(':memory:');
    migrate(db);
    const config = makeConfig({ outDir, mailTransport: 'dryrun' });
    const account = addAccount(db, config, { email: 'acct@example.com', transport: 'smtp', origin: 'cli' });

    await expect(
      runSend(
        { db, config },
        {
          to: ['x@example.com'],
          cc: [],
          bcc: [],
          subject: 'hi',
          html: '<p>hi</p>',
          fromAccountRef: account.id,
          transport: 'dryrun', // conflicts with the account's own 'smtp'
          track: true,
          trackClicks: undefined,
          optOutLink: false,
          mute: false,
        },
      ),
    ).rejects.toThrow(/does not match account/);
    db.close();
  });

  it('finding #15: an explicit transport that agrees with the account is accepted', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const config = makeConfig({ outDir, mailTransport: 'smtp' });
    const account = addAccount(db, config, { email: 'acct2@example.com', transport: 'dryrun', origin: 'cli' });

    const result = await runSend(
      { db, config },
      {
        to: ['x@example.com'],
        cc: [],
        bcc: [],
        subject: 'hi',
        html: '<p>hi</p>',
        fromAccountRef: account.id,
        transport: 'dryrun', // agrees with the account's own transport
        track: true,
        trackClicks: undefined,
        optOutLink: false,
        mute: false,
      },
    );
    expect(result.transport).toBe('dryrun');
    db.close();
  });

  it("finding #1: with no explicit transport, the account row's own transport wins over MAIL_TRANSPORT (unchanged, documented)", async () => {
    const db = openDb(':memory:');
    migrate(db);
    // MAIL_TRANSPORT=dryrun, but the account row says smtp - this is the exact drift the compose
    // page must display accurately (finding #1), not a bug in runSend itself: runSend already
    // correctly uses the account's transport, it's the compose page that used to lie about it.
    const config = makeConfig({ outDir, mailTransport: 'dryrun' });
    const account = addAccount(db, config, { email: 'acct3@example.com', transport: 'smtp', origin: 'cli' });

    const result = await runSend(
      { db, config },
      {
        to: ['x@example.com'],
        cc: [],
        bcc: [],
        subject: 'hi',
        html: '<p>hi</p>',
        fromAccountRef: account.id,
        track: true,
        trackClicks: undefined,
        optOutLink: false,
        mute: false,
      },
    );
    // It really tried smtp (and failed, with no real server configured) - it did NOT silently fall
    // back to writing a dryrun artefact just because MAIL_TRANSPORT says dryrun.
    expect(result.transport).toBe('smtp');
    expect(result.recipients.some((r) => r.sent)).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    db.close();
  });
});
