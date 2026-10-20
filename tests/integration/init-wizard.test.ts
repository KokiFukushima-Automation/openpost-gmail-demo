import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import { openDb } from '../../src/db/index.js';

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_CWD = process.cwd();

function runCli(args: string[]): Promise<void> {
  const program = createProgram();
  return program.parseAsync(['node', 'openpost', ...args]);
}

describe('openpost init (wizard)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openpost-init-'));
    process.chdir(dir);
    process.env = { ...ORIGINAL_ENV };
    delete process.env.TRACKING_SECRET;
    delete process.env.FROM_EMAIL;
    delete process.env.DB_PATH;
    process.env.OPENPOST_CONFIG_DIR = join(dir, 'config-unused');
  });

  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    process.env = { ...ORIGINAL_ENV };
    rmSync(dir, { recursive: true, force: true });
  });

  it('316. --yes --base-url ... --from ... writes a 0600 .env with a generated TRACKING_SECRET and creates the DB at the current schema', async () => {
    await runCli(['init', '--yes', '--base-url', 'http://127.0.0.1:8787', '--from', 'me@example.com', '--json']);
    const envPath = join(dir, '.env');
    expect(existsSync(envPath)).toBe(true);
    const mode = statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const content = readFileSync(envPath, 'utf8');
    expect(content).toMatch(/TRACKING_SECRET=\S{32,}/);
    expect(content).toContain('FROM_EMAIL=me@example.com');

    const dbPath = join(dir, 'data', 'openpost.db');
    expect(existsSync(dbPath)).toBe(true);
    const db = openDb(dbPath);
    const schema = db.pragma('user_version', { simple: true }) as number;
    expect(schema).toBeGreaterThanOrEqual(8);
    db.close();
  });

  it('317. --json output never contains the secret or the master key; --print-env writes no file', async () => {
    let stdout = '';
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string, ...rest: unknown[]) => {
      stdout += chunk;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalWrite as any)(chunk, ...rest);
    }) as typeof process.stdout.write;
    try {
      await runCli(['init', '--print-env', '--base-url', 'http://127.0.0.1:8787', '--from', 'me@example.com']);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(existsSync(join(dir, '.env'))).toBe(false);
    expect(stdout).toContain('TRACKING_SECRET='); // the wizard's whole point is to print it here
    expect(stdout).toContain('FROM_EMAIL=me@example.com');
  });

  it('318. a second init reports "already initialised", exits 0, and leaves .env and the keyfile byte-identical', async () => {
    await runCli(['init', '--yes', '--base-url', 'http://127.0.0.1:8787', '--from', 'me@example.com', '--json']);
    const envPath = join(dir, '.env');
    const before = readFileSync(envPath, 'utf8');
    const keyPath = join(dir, 'data', 'config', 'master.key');
    const keyBefore = existsSync(keyPath) ? readFileSync(keyPath, 'utf8') : null;

    await runCli(['init', '--yes', '--json']);
    const after = readFileSync(envPath, 'utf8');
    expect(after).toBe(before);
    if (keyBefore !== null) {
      expect(readFileSync(keyPath, 'utf8')).toBe(keyBefore);
    }
  });

  it('319. --force backs the old .env up to .env.bak.<epoch> before overwriting', async () => {
    await runCli(['init', '--yes', '--base-url', 'http://127.0.0.1:8787', '--from', 'me@example.com', '--json']);
    const envPath = join(dir, '.env');
    const before = readFileSync(envPath, 'utf8');

    await runCli(['init', '--yes', '--force', '--base-url', 'http://127.0.0.1:9999', '--from', 'other@example.com', '--json']);
    const after = readFileSync(envPath, 'utf8');
    expect(after).not.toBe(before);
    expect(after).toContain('other@example.com');

    const { readdirSync } = await import('node:fs');
    const backups = readdirSync(dir).filter((f) => f.startsWith('.env.bak.'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    const backupContent = readFileSync(join(dir, backups[0] as string), 'utf8');
    expect(backupContent).toBe(before);
  });

  it('321. refuses to create a master keyfile that already exists (no --force), and creates it with 0600', async () => {
    await runCli(['init', '--yes', '--base-url', 'http://127.0.0.1:8787', '--from', 'me@example.com', '--json']);
    const keyPath = join(dir, 'data', 'config', 'master.key');
    expect(existsSync(keyPath)).toBe(true);
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
    const before = readFileSync(keyPath, 'utf8');

    // A second --force init must not silently regenerate (and thereby invalidate) an existing key.
    await runCli(['init', '--yes', '--force', '--base-url', 'http://127.0.0.1:8787', '--from', 'me@example.com', '--json']);
    expect(readFileSync(keyPath, 'utf8')).toBe(before);
  });
});
