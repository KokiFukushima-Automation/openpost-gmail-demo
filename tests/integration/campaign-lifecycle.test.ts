// Finding #6 (docs/reports/phase4_review.md): `campaign resume`/`campaign cancel` used to call
// setCampaignStatus unconditionally, so a *cancelled* (terminal) campaign could be resumed straight
// back to 'running', and `resume` on an unknown id silently printed "resumed" anyway. This file
// exercises the CLI surface directly (createProgram, mirroring tests/integration/forget.test.ts's
// own pattern) rather than only the underlying db/campaigns.ts helper, since the bug was in how the
// CLI action wired that helper up.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import { migrate, openDb } from '../../src/db/index.js';
import { ensureAccount } from '../../src/db/repo.js';
import { createCampaign } from '../../src/db/campaigns.js';

const ORIGINAL_ENV = { ...process.env };

function seedCampaign(dbPath: string, status: 'draft' | 'running' | 'paused' | 'cancelled' | 'completed' = 'running'): string {
  const db = openDb(dbPath);
  migrate(db);
  const account = ensureAccount(db, { email: 'sender@example.com', transport: 'dryrun' });
  const campaign = createCampaign(db, {
    name: 'lifecycle test',
    accountId: account.id,
    subjectTemplate: 'Hi',
    bodyHtmlTemplate: '<p>Hi</p>',
    fromEmail: 'sender@example.com',
    transport: 'dryrun',
    ratePerMinute: 60,
    jitterMs: 0,
    dailyCap: 1000,
    emailColumn: 'email',
    columnsJson: '["email"]',
    createdAt: Date.now(),
  });
  db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, campaign.id);
  db.close();
  return campaign.id;
}

describe('campaign CLI lifecycle guard (finding #6)', () => {
  let workDir: string;
  let dbPath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'openpost-campaign-lifecycle-'));
    dbPath = join(workDir, 'openpost.db');
    process.env = {
      ...ORIGINAL_ENV,
      DB_PATH: dbPath,
      TRACKING_SECRET: 'a'.repeat(40),
      TRACKING_BASE_URL: 'http://localhost:8787',
      FROM_EMAIL: 'sender@example.com',
      MAIL_TRANSPORT: 'dryrun',
    };
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(workDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('`campaign resume` on a cancelled campaign errors (exit 1) and leaves it cancelled', async () => {
    const id = seedCampaign(dbPath, 'cancelled');
    const program = createProgram();
    await program.parseAsync(['campaign', 'resume', id], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("'cancelled'"));

    const db = openDb(dbPath);
    const status = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status;
    db.close();
    expect(status).toBe('cancelled');
  });

  it('`campaign resume` on an unknown id errors rather than printing "resumed"', async () => {
    seedCampaign(dbPath, 'running'); // ensure the db file/schema exist
    const program = createProgram();
    await program.parseAsync(['campaign', 'resume', 'no-such-campaign'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stdoutSpy).not.toHaveBeenCalledWith(expect.stringContaining('resumed'));
  });

  it('`campaign resume` on a paused campaign succeeds', async () => {
    const id = seedCampaign(dbPath, 'paused');
    const program = createProgram();
    await program.parseAsync(['campaign', 'resume', id], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const db = openDb(dbPath);
    const status = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status;
    db.close();
    expect(status).toBe('running');
  });

  it('`campaign pause` on an already-cancelled campaign errors and leaves it cancelled', async () => {
    const id = seedCampaign(dbPath, 'cancelled');
    const program = createProgram();
    await program.parseAsync(['campaign', 'pause', id], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const db = openDb(dbPath);
    const status = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status;
    db.close();
    expect(status).toBe('cancelled');
  });

  it('`campaign cancel --yes` skips the confirmation prompt and cancels immediately', async () => {
    const id = seedCampaign(dbPath, 'running');
    const program = createProgram();
    await program.parseAsync(['campaign', 'cancel', id, '--yes'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('cancelled'));
    const db = openDb(dbPath);
    const status = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status;
    db.close();
    expect(status).toBe('cancelled');
  });

  it('`campaign cancel --json` implies --yes (no prompt, still cancels)', async () => {
    const id = seedCampaign(dbPath, 'running');
    const program = createProgram();
    await program.parseAsync(['campaign', 'cancel', id, '--json'], { from: 'user' });

    expect(exitSpy).not.toHaveBeenCalled();
    const db = openDb(dbPath);
    const status = (db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as { status: string }).status;
    db.close();
    expect(status).toBe('cancelled');
  });

  it('`campaign cancel` on an already-cancelled campaign errors rather than re-cancelling', async () => {
    const id = seedCampaign(dbPath, 'cancelled');
    const program = createProgram();
    await program.parseAsync(['campaign', 'cancel', id, '--yes'], { from: 'user' });

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe('campaign create numeric validation (finding #9)', () => {
  let workDir: string;
  let dbPath: string;
  let csvPath: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'openpost-campaign-numeric-'));
    dbPath = join(workDir, 'openpost.db');
    csvPath = join(workDir, 'rows.csv');
    writeFileSync(csvPath, 'email\nrow1@example.com\nrow2@example.com\n');
    process.env = {
      ...ORIGINAL_ENV,
      DB_PATH: dbPath,
      TRACKING_SECRET: 'a'.repeat(40),
      TRACKING_BASE_URL: 'http://localhost:8787',
      FROM_EMAIL: 'sender@example.com',
      MAIL_TRANSPORT: 'dryrun',
    };
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    rmSync(workDir, { recursive: true, force: true });
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  const baseArgs = ['campaign', 'create', '--name', 'N', '--csv', '', '--subject', 'Hi', '--html', '<p>Hi</p>'];

  async function runCreate(extra: string[]): Promise<void> {
    const program = createProgram();
    const args = [...baseArgs];
    args[args.indexOf('--csv') + 1] = csvPath;
    await program.parseAsync([...args, ...extra], { from: 'user' });
  }

  it('--rate-per-minute 0 is rejected rather than disabling pacing', async () => {
    await runCreate(['--rate-per-minute', '0']);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--rate-per-minute'));
  });

  it('--rate-per-minute -5 (negative) is rejected', async () => {
    await runCreate(['--rate-per-minute', '-5']);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--rate-per-minute'));
  });

  it('--daily-cap 0 is rejected rather than making the cap fire immediately', async () => {
    await runCreate(['--daily-cap', '0']);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--daily-cap'));
  });

  it('--jitter-ms 0 is ACCEPTED (zero jitter is a legitimate request, unlike the other three)', async () => {
    await runCreate(['--jitter-ms', '0']);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('--jitter-ms -1 is rejected', async () => {
    await runCreate(['--jitter-ms', '-1']);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--jitter-ms'));
  });

  it('--digest-minutes 0 is rejected', async () => {
    await runCreate(['--digest-minutes', '0']);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--digest-minutes'));
  });

  it('--rate-per-minute abc (non-numeric) is rejected with a named error', async () => {
    await runCreate(['--rate-per-minute', 'abc']);
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--rate-per-minute'));
  });

  it('valid positive integers for every flag succeed', async () => {
    await runCreate(['--rate-per-minute', '30', '--jitter-ms', '500', '--daily-cap', '200', '--digest-minutes', '15']);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
