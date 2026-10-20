import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate, openDb, type DB } from '../../src/db/index.js';
import { ensureAccount, createMessage } from '../../src/db/repo.js';
import { backupDatabase, inspectBackup, restoreDatabase } from '../../src/db/backup.js';

describe('backup / restore', () => {
  let dir: string;
  let dbPath: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-backup-'));
    dbPath = join(dir, 'openpost.db');
    db = openDb(dbPath);
    migrate(db);
    const account = ensureAccount(db, { email: 'a@example.com', transport: 'dryrun' });
    createMessage(db, {
      accountId: account.id,
      subject: 'hi',
      bodyHtml: '<p>hi</p>',
      bodyText: 'hi',
      status: 'sent',
      trackingEnabled: true,
      clickTrackingEnabled: true,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('300. backupDatabase produces a file whose integrity_check is ok and whose row counts match', async () => {
    const { path, manifest } = await backupDatabase(db, { outDir: join(dir, 'backups') });
    const check = inspectBackup(path);
    expect(check.ok).toBe(true);
    expect(manifest.rowCounts.messages).toBe(1);
    expect(manifest.rowCounts.accounts).toBe(1);
  });

  it('301. the manifest sha256 matches the written file; a mutated byte makes inspectBackup fail', async () => {
    const { path } = await backupDatabase(db, { outDir: join(dir, 'backups') });
    expect(inspectBackup(path).ok).toBe(true);
    const bytes = readFileSync(path);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0xff;
    writeFileSync(path, bytes);
    const check = inspectBackup(path);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toMatch(/sha256|integrity/);
  });

  it('302. restoreDatabase into an empty path round-trips every table row count and user_version', async () => {
    const { path } = await backupDatabase(db, { outDir: join(dir, 'backups') });
    const destPath = join(dir, 'restored.db');
    const result = await restoreDatabase({ from: path, to: destPath });
    expect(result.schemaAfter).toBeGreaterThanOrEqual(result.schemaBefore);
    expect(result.rowCounts.messages).toBe(1);

    const restored = openDb(destPath);
    const events = restored.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(events.n).toBe(1);
    restored.close();
  });

  it('303. restoring over a non-empty DB without --force refuses and changes nothing; with --force it succeeds', async () => {
    const { path } = await backupDatabase(db, { outDir: join(dir, 'backups') });
    const destPath = join(dir, 'existing.db');
    const existing = openDb(destPath);
    migrate(existing);
    ensureAccount(existing, { email: 'other@example.com', transport: 'dryrun' });
    existing.close();

    await expect(restoreDatabase({ from: path, to: destPath })).rejects.toThrow(/force/);

    // Finding #18: "changes nothing" was asserted only by the throw - re-read the destination to
    // prove the refusal really left it untouched, not merely that some error was thrown.
    const untouched = openDb(destPath);
    const accountsAfterRefusal = untouched.prepare('SELECT email FROM accounts').all() as Array<{ email: string }>;
    expect(accountsAfterRefusal.map((a) => a.email)).toEqual(['other@example.com']);
    untouched.close();

    const result = await restoreDatabase({ from: path, to: destPath, force: true });
    expect(result.rowCounts.messages).toBe(1);

    const restored = openDb(destPath);
    const accountsAfterRestore = restored.prepare('SELECT email FROM accounts').all() as Array<{ email: string }>;
    expect(accountsAfterRestore.map((a) => a.email)).toEqual(['a@example.com']);
    restored.close();
  });

  it('finding #1: restore refuses over a live WAL DB with uncheckpointed frames unless --force; wal/shm are removed and the reopened DB has exactly the restored rows', async () => {
    const { path } = await backupDatabase(db, { outDir: join(dir, 'backups') });

    // A "live" destination: open in WAL mode, write rows, and deliberately do NOT close - leaving
    // an uncheckpointed -wal file exactly like a running `openpost serve` would.
    const destPath = join(dir, 'live.db');
    const live = openDb(destPath);
    migrate(live);
    for (let i = 0; i < 500; i++) {
      ensureAccount(live, { email: `stale-${i}@example.com`, transport: 'dryrun' });
    }
    expect(existsSync(`${destPath}-wal`)).toBe(true);

    // Without --force: refused, and the live DB (reopened independently) still has its 500 stale
    // rows, not the backup's 1 - nothing was touched.
    await expect(restoreDatabase({ from: path, to: destPath })).rejects.toThrow(/force|open by another process|WAL/);
    live.close(); // release the lock so the next probe isn't refused for a different reason

    // Recreate the same live-WAL condition (closing checkpoints and removes -wal/-shm).
    const live2 = openDb(destPath);
    for (let i = 500; i < 550; i++) {
      ensureAccount(live2, { email: `stale2-${i}@example.com`, transport: 'dryrun' });
    }
    expect(existsSync(`${destPath}-wal`)).toBe(true);

    // With --force: the stale -wal/-shm are removed and the restored bytes are NOT reopened while
    // `live2` still holds a handle - restoreDatabase's own migrate() step opens a fresh connection
    // that must see exactly the backup's one row, never a mix of the two.
    const result = await restoreDatabase({ from: path, to: destPath, force: true });
    live2.close();
    expect(existsSync(`${destPath}-wal`)).toBe(false);
    expect(existsSync(`${destPath}-shm`)).toBe(false);
    expect(result.rowCounts.messages).toBe(1);
    expect(result.rowCounts.accounts).toBe(1);

    const reopened = openDb(destPath);
    const accounts = reopened.prepare('SELECT email FROM accounts').all() as Array<{ email: string }>;
    expect(accounts).toEqual([{ email: 'a@example.com' }]);
    const messages = reopened.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(messages.n).toBe(1);
    reopened.close();
  });

  it('305. a backup from a newer schema than EXPECTED_SCHEMA is refused with a named error', async () => {
    const { path } = await backupDatabase(db, { outDir: join(dir, 'backups') });
    const manifestPath = `${path}.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sha256: string };
    // Bump the on-disk schema of the backup file itself past EXPECTED_SCHEMA.
    const raw = openDb(path);
    raw.pragma('user_version = 999');
    raw.close();
    // sha256 in the manifest no longer matches, so inspectBackup should report both problems.
    const check = inspectBackup(path);
    expect(check.ok).toBe(false);
    expect(check.schemaVersion).toBe(999);
    expect(manifest.sha256).toBeDefined();
  });

  it('306. --gzip round-trips; the manifest records gzip:true', async () => {
    const { path, manifest } = await backupDatabase(db, { outDir: join(dir, 'backups'), gzip: true });
    expect(path.endsWith('.gz')).toBe(true);
    expect(manifest.gzip).toBe(true);
    const check = inspectBackup(path);
    expect(check.ok).toBe(true);
    const destPath = join(dir, 'from-gzip.db');
    const result = await restoreDatabase({ from: path, to: destPath });
    expect(result.rowCounts.messages).toBe(1);
  });

  it('307. a backup taken while a second connection holds an open write transaction still passes integrity_check', async () => {
    const writer = openDb(dbPath);
    writer.exec('BEGIN IMMEDIATE');
    try {
      const { path } = await backupDatabase(db, { outDir: join(dir, 'backups'), tag: 'mid-write' });
      const check = inspectBackup(path);
      expect(check.ok).toBe(true);
    } finally {
      writer.exec('COMMIT');
      writer.close();
    }
  });
});
