import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import { loadConfig } from '../../src/config/env.js';
import { openDb } from '../../src/db/index.js';
import { buildServer } from '../../src/server/app.js';
import { signToken, verifyToken } from '../../src/core/token.js';
import {
  addSuppression,
  findRecipientByToken,
  getEventsForRecipient,
  isSuppressed,
} from '../../src/db/repo.js';
import { TEST_SECRET } from '../helpers/setup.js';

const ORIGINAL_ENV = { ...process.env };

function runCli(args: string[]): Promise<void> {
  const program = createProgram();
  return program.parseAsync(['node', 'openpost', ...args]);
}

describe('send --dry-run (CLI)', () => {
  let outDir: string;
  let dbPath: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'openpost-out-'));
    dbPath = join(mkdtempSync(join(tmpdir(), 'openpost-db-')), 'test.db');
    process.env = {
      ...ORIGINAL_ENV,
      TRACKING_SECRET: TEST_SECRET,
      TRACKING_BASE_URL: 'http://127.0.0.1:8787',
      FROM_EMAIL: 'sender@example.com',
      FROM_NAME: 'Sender',
      DB_PATH: dbPath,
      OUT_DIR: outDir,
      MAIL_TRANSPORT: 'dryrun',
    };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(outDir, { recursive: true, force: true });
  });

  it('33/34. writes distinct per-recipient artefacts whose pixel tokens resolve to the right recipient', async () => {
    await runCli([
      'send',
      '--to',
      'alice@example.com,bob@example.com',
      '--subject',
      'hello',
      '--html',
      '<html><body><p>Hi <a href="https://example.com/x?a=1#f">link</a></p></body></html>',
      '--dry-run',
      '--json',
    ]);

    const db = openDb(dbPath);
    try {
      const files = { alice: 0, bob: 0 };
      const dirents = readdirSync(outDir) as string[];
      const htmlFiles = dirents.filter((f) => f.endsWith('.html'));
      expect(htmlFiles.length).toBe(2);
      expect(dirents.filter((f) => f.endsWith('.eml')).length).toBe(2);

      const tokens = new Set<string>();
      for (const file of htmlFiles) {
        const html = readFileSync(join(outDir, file), 'utf8');
        const match = /\/o\/([0-9a-z.]+)\.gif\?v=/i.exec(html);
        expect(match).not.toBeNull();
        const token = match?.[1] as string;
        tokens.add(token);
        const verified = verifyToken('o', token, { current: TEST_SECRET });
        expect(verified.ok).toBe(true);
        if (verified.ok) {
          const recipient = findRecipientByToken(db, verified.rid);
          expect(recipient).not.toBeNull();
          if (recipient?.email === 'alice@example.com') files.alice++;
          if (recipient?.email === 'bob@example.com') files.bob++;
        }
      }
      expect(tokens.size).toBe(2); // distinct tokens
      expect(files.alice).toBe(1);
      expect(files.bob).toBe(1);
    } finally {
      db.close();
    }
  });

  it('35. --no-track produces HTML with no pixel, and no open_events are possible even if the token is probed directly', async () => {
    await runCli([
      'send',
      '--to',
      'carol@example.com',
      '--subject',
      'hello',
      '--html',
      '<html><body><p>Hi</p></body></html>',
      '--no-track',
      '--dry-run',
      '--json',
    ]);

    const dirents = readdirSync(outDir) as string[];
    const htmlFile = dirents.find((f) => f.endsWith('.html'));
    expect(htmlFile).toBeDefined();
    const html = readFileSync(join(outDir, htmlFile as string), 'utf8');
    expect(html).not.toMatch(/\/o\//);
    expect(html).not.toContain('<img');

    // finding #4: --no-track still assigns the recipient a token (used for opt-out/click), but a
    // message with tracking_enabled=0 must never produce an open_events row even if that token is
    // probed directly against the live pixel route - it isn't embedded anywhere, but a real attack
    // would guess/leak it, not read it out of the HTML.
    const db = openDb(dbPath);
    try {
      const row = db
        .prepare('SELECT token FROM recipients WHERE email = ?')
        .get('carol@example.com') as { token: string } | undefined;
      expect(row).toBeDefined();
      const recipient = findRecipientByToken(db, (row as { token: string }).token);
      expect(recipient).not.toBeNull();
      expect(recipient?.trackingEnabled).toBe(false);

      const config = loadConfig(process.env);
      const app = buildServer({ db, config });
      try {
        const token = signToken('o', recipient!.token, TEST_SECRET);
        const res = await app.inject({ method: 'GET', url: `/o/${token}.gif` });
        expect(res.statusCode).toBe(200);
        expect(getEventsForRecipient(db, recipient!.id)).toHaveLength(0);
      } finally {
        await app.close();
      }
    } finally {
      db.close();
    }
  });

  it('36. a suppressed address is sent without a pixel and reported as suppressed', async () => {
    const db = openDb(dbPath);
    const { migrate } = await import('../../src/db/index.js');
    migrate(db);
    addSuppression(db, 'dave@example.com', 'manual');
    expect(isSuppressed(db, 'dave@example.com')).toBe(true);
    db.close();

    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      await runCli([
        'send',
        '--to',
        'dave@example.com',
        '--subject',
        'hello',
        '--html',
        '<html><body><p>Hi</p></body></html>',
        '--dry-run',
        '--json',
      ]);
    } finally {
      process.stdout.write = originalWrite;
    }

    const jsonLine = logs.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const output = JSON.parse(jsonLine as string) as {
      recipients: { email: string; suppressed: boolean; pixelUrl?: string }[];
    };
    const daveResult = output.recipients.find((r) => r.email === 'dave@example.com');
    expect(daveResult?.suppressed).toBe(true);
    expect(daveResult?.pixelUrl).toBeUndefined();

    const dirents = readdirSync(outDir) as string[];
    const htmlFile = dirents.find((f) => f.endsWith('.html'));
    expect(htmlFile).toBeDefined();
    const html = readFileSync(join(outDir, htmlFile as string), 'utf8');
    expect(html).not.toContain('<img');
    expect(existsSync(join(outDir, htmlFile as string))).toBe(true);
  });

  it('phase5.1 finding #7: --json omits selfCopy entirely when it is null (old CLI shape)', async () => {
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      // Default SELF_OPEN_STRATEGY=window, so runSend's selfCopy branch never runs and
      // RunSendResult.selfCopy is null - the pre-extraction CLI's --json omitted the key entirely
      // in exactly this case (JSON.stringify drops `undefined`, and null is not undefined).
      await runCli(['send', '--to', 'frank@example.com', '--subject', 'hello', '--html', '<p>Hi</p>', '--dry-run', '--json']);
    } finally {
      process.stdout.write = originalWrite;
    }

    const jsonLine = logs.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const output = JSON.parse(jsonLine as string) as Record<string, unknown>;
    expect(output).not.toHaveProperty('selfCopy');
    expect(output.messageId).toBeDefined();
  });

  it('phase5.1 finding #7: --json includes selfCopy when a self-copy actually ran', async () => {
    process.env.SELF_OPEN_STRATEGY = 'imap-append';
    process.env.IMAP_USER = 'imapuser@example.com';
    process.env.IMAP_PASS = 'imappass';
    const logs: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      // dryrun's own self-copy path (`transportName === 'dryrun'`) runs whenever
      // SELF_OPEN_STRATEGY !== 'window', regardless of imap-append's own IMAP_USER/IMAP_PASS
      // requirement - it renders `${messageId}.sent.eml` directly instead of calling out.
      await runCli(['send', '--to', 'grace@example.com', '--subject', 'hello', '--html', '<p>Hi</p>', '--dry-run', '--json']);
    } finally {
      process.stdout.write = originalWrite;
    }

    const jsonLine = logs.find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const output = JSON.parse(jsonLine as string) as { selfCopy?: { ok: boolean; strategy: string } };
    expect(output.selfCopy).toBeDefined();
    expect(output.selfCopy?.ok).toBe(true);
    expect(output.selfCopy?.strategy).toBe('dryrun-render');
  });

  it('93. --no-track-clicks produces HTML with no /c/ links; default send rewrites them', async () => {
    await runCli([
      'send',
      '--to',
      'erin@example.com',
      '--subject',
      'hello',
      '--html',
      '<html><body><p><a href="https://example.com/x">link</a></p></body></html>',
      '--dry-run',
      '--no-track-clicks',
    ]);
    const untracked = readdirSync(outDir).find((f) => f.endsWith('.html')) as string;
    const untrackedHtml = readFileSync(join(outDir, untracked), 'utf8');
    expect(untrackedHtml).not.toMatch(/\/c\/[A-Za-z0-9._-]+/);
    expect(untrackedHtml).toContain('https://example.com/x');
    rmSync(join(outDir, untracked));

    await runCli([
      'send',
      '--to',
      'erin@example.com',
      '--subject',
      'hello',
      '--html',
      '<html><body><p><a href="https://example.com/x">link</a></p></body></html>',
      '--dry-run',
    ]);
    const tracked = readdirSync(outDir).find((f) => f.endsWith('.html')) as string;
    const trackedHtml = readFileSync(join(outDir, tracked), 'utf8');
    expect(trackedHtml).toMatch(/\/c\/[A-Za-z0-9._-]+/);
  });
});
