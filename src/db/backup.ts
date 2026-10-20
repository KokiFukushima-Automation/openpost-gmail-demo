/**
 * Backup/restore via SQLite's online backup API (docs/08_phase4_spec.md §4.6). `better-sqlite3`'s
 * `db.backup(dest)` copies a live, WAL-mode database without stopping the process and without a
 * torn WAL - `cp`-ing the `.db` file is exactly the bug this exists to avoid.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { EXPECTED_SCHEMA, migrate, openDb, type DB } from './index.js';
import { VERSION } from '../version.js';

export interface BackupManifest {
  version: 1;
  createdAt: number;
  openpostVersion: string;
  schemaVersion: number;
  sourcePath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  gzip: boolean;
  rowCounts: Record<string, number>;
  trackingSecretFingerprint: string | null;
  masterKeyFingerprint: string | null;
}

export interface RestoreCheck {
  ok: boolean;
  problems: string[];
  manifest: BackupManifest | null;
  schemaVersion: number;
}

const TABLES = [
  'accounts',
  'messages',
  'recipients',
  'links',
  'click_tokens',
  'open_events',
  'click_events',
  'notifications',
  'notification_dead_letters',
  'reminders',
  'suppressions',
  'audit_log',
  'settings',
  'campaigns',
  'campaign_rows',
];

function tableExists(db: DB, name: string): boolean {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
  return row !== undefined;
}

function countRows(db: DB): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of TABLES) {
    if (!tableExists(db, table)) continue;
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    counts[table] = row.n;
  }
  return counts;
}

function integrityOk(db: DB): boolean {
  const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  return rows.length === 1 && rows[0]?.integrity_check === 'ok';
}

function foreignKeysOk(db: DB): boolean {
  const violations = db.pragma('foreign_key_check') as unknown[];
  return violations.length === 0;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function getSetting(db: DB, key: string): string | null {
  if (!tableExists(db, 'settings')) return null;
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export interface BackupOptions {
  outDir: string;
  tag?: string | undefined;
  gzip?: boolean | undefined;
  clock?: (() => number) | undefined;
}

/** Backs up `db` (its own source path is read from `db.name`) into `opts.outDir`, verifying the
 *  copy before returning: integrity_check, foreign_key_check, per-table row counts, sha256. */
export async function backupDatabase(db: DB, opts: BackupOptions): Promise<{ path: string; manifestPath: string; manifest: BackupManifest }> {
  const clock = opts.clock ?? (() => Date.now());
  const now = clock();
  if (!existsSync(opts.outDir)) mkdirSync(opts.outDir, { recursive: true, mode: 0o700 });

  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 17);
  const tagSuffix = opts.tag ? `-${opts.tag}` : '';
  const rawName = `openpost-${stamp}${tagSuffix}.sqlite`;
  const rawPath = join(opts.outDir, rawName);

  await db.backup(rawPath);

  // Verify the copy independently, read-only, before trusting it.
  const copy = new Database(rawPath, { readonly: true });
  try {
    if (!integrityOk(copy)) throw new Error('backup failed integrity_check');
    if (!foreignKeysOk(copy)) throw new Error('backup failed foreign_key_check');
  } finally {
    copy.close();
  }

  const gzip = opts.gzip ?? false;
  let finalPath = rawPath;
  let fileName = rawName;
  if (gzip) {
    const gzPath = `${rawPath}.gz`;
    writeFileSync(gzPath, gzipSync(readFileSync(rawPath)));
    unlinkSync(rawPath);
    finalPath = gzPath;
    fileName = `${rawName}.gz`;
  }
  chmodSync(finalPath, 0o600);

  // For a gzip'd backup, rawPath was already deleted - count from the live source db instead
  // (identical rows, since backup() copied a point-in-time snapshot of it moments ago).
  let rowCounts: Record<string, number>;
  if (gzip) {
    rowCounts = countRows(db);
  } else {
    const verifyDb = new Database(finalPath, { readonly: true });
    rowCounts = countRows(verifyDb);
    verifyDb.close();
  }

  const bytes = statSync(finalPath).size;
  const sha256 = sha256File(finalPath);
  const schemaVersion = db.pragma('user_version', { simple: true }) as number;

  const manifest: BackupManifest = {
    version: 1,
    createdAt: now,
    openpostVersion: VERSION,
    schemaVersion,
    sourcePath: db.name,
    fileName,
    bytes,
    sha256,
    gzip,
    rowCounts,
    trackingSecretFingerprint: getSetting(db, 'tracking_secret_fingerprint'),
    masterKeyFingerprint: getSetting(db, 'master_key_fingerprint'),
  };
  const manifestPath = `${finalPath}.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  chmodSync(manifestPath, 0o600);

  return { path: finalPath, manifestPath, manifest };
}

function readManifestFor(backupPath: string): BackupManifest | null {
  const manifestPath = `${backupPath}.json`;
  if (!existsSync(manifestPath)) return null;
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as BackupManifest;
  } catch {
    return null;
  }
}

/** Checks a backup file (and its manifest, if present) without restoring anything: manifest sha256
 *  matches, integrity_check is ok, schema <= EXPECTED_SCHEMA. */
export function inspectBackup(path: string): RestoreCheck {
  const problems: string[] = [];
  if (!existsSync(path)) {
    return { ok: false, problems: [`backup file not found: ${path}`], manifest: null, schemaVersion: -1 };
  }
  const manifest = readManifestFor(path);
  const gzip = path.endsWith('.gz');
  let tmpDir: string | null = null;
  let tmpRaw: string | null = null;
  let checkPath = path;
  try {
    if (gzip) {
      // Finding #10: this used to write `${path}.check.sqlite` (a decompressed plaintext copy of
      // every recipient address and event) at default umask permissions right next to the real
      // backups, and its name matched pruneBackups' own `openpost-*.sqlite(.gz)?` glob - a kill at
      // the wrong moment could leave it there to be pruned as if it were a real backup, or evict
      // one. A private temp directory outside the backup dir, mode 0600, sidesteps both.
      tmpDir = mkdtempSync(join(tmpdir(), 'openpost-restore-check-'));
      tmpRaw = join(tmpDir, 'check.sqlite');
      writeFileSync(tmpRaw, gunzipSync(readFileSync(path)));
      chmodSync(tmpRaw, 0o600);
      checkPath = tmpRaw;
    }

    if (manifest) {
      const actualSha = sha256File(path);
      if (actualSha !== manifest.sha256) {
        problems.push('manifest sha256 does not match the backup file (it may have been tampered with)');
      }
    }

    let schemaVersion = -1;
    try {
      const db = new Database(checkPath, { readonly: true });
      try {
        schemaVersion = db.pragma('user_version', { simple: true }) as number;
        if (!integrityOk(db)) problems.push('integrity_check failed');
        if (!foreignKeysOk(db)) problems.push('foreign_key_check reported violations');
        if (schemaVersion > EXPECTED_SCHEMA) {
          problems.push(`backup schema v${schemaVersion} is newer than this install's EXPECTED_SCHEMA v${EXPECTED_SCHEMA}`);
        }
      } finally {
        db.close();
      }
    } catch (err) {
      // A corruption severe enough (a mangled schema page, an invalid root page pointer) makes
      // SQLite throw straight out of `open`/`pragma` rather than returning a normal
      // integrity_check row - still "not ok", never an uncaught exception out of inspectBackup.
      const message = err instanceof Error ? err.message : String(err);
      problems.push(`backup file could not be opened/verified: ${message}`);
    }
    return { ok: problems.length === 0, problems, manifest, schemaVersion };
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    else if (tmpRaw && existsSync(tmpRaw)) unlinkSync(tmpRaw);
  }
}

export interface RestoreOptions {
  from: string;
  to: string;
  force?: boolean | undefined;
  dryRun?: boolean | undefined;
}

export interface RestoreResult {
  restored: string;
  schemaBefore: number;
  schemaAfter: number;
  rowCounts: Record<string, number>;
}

/** Finding #1: `cp`-replacing a WAL database's main file while its `-wal` companion still holds
 *  uncheckpointed frames (or while the file is actually open, e.g. a live `openpost serve`) throws
 *  the restored data away the instant anything next opens/checkpoints that WAL against the new
 *  content - and can corrupt the destination outright. Attempts an EXCLUSIVE lock with
 *  `busy_timeout = 0`: any other open connection (even one that has already checkpointed its WAL,
 *  so no `-wal` file remains) makes this fail fast instead of hanging or lying. */
function isDatabaseBusy(path: string): boolean {
  let probe: DB | null = null;
  try {
    probe = new Database(path);
    probe.pragma('busy_timeout = 0');
    probe.pragma('locking_mode = EXCLUSIVE');
    // locking_mode=EXCLUSIVE only takes effect once SQLite next needs the lock - force that now.
    probe.exec('BEGIN IMMEDIATE; COMMIT;');
    return false;
  } catch {
    return true;
  } finally {
    try {
      probe?.close();
    } catch {
      /* already unusable */
    }
  }
}

/** Restores `opts.from` (optionally gzip'd) to `opts.to`, refusing unless every `inspectBackup`
 *  check passes and the destination is absent/empty (or `force` is set). Finding #1: also refuses
 *  (absent `force`) when `${to}-wal`/`${to}-shm` exist or `to` cannot be locked EXCLUSIVE - either
 *  is evidence the destination is a live WAL database still in use, and stop the server first is the
 *  only safe remedy, not a bigger hammer. `${to}-wal`/`${to}-shm` are always removed alongside `to`
 *  once the restore actually proceeds, so a stale WAL never gets replayed over the restored bytes.
 *  On success, runs `migrate()` on the restored copy and reports before/after schema. */
export async function restoreDatabase(opts: RestoreOptions): Promise<RestoreResult> {
  const check = inspectBackup(opts.from);
  if (!check.ok) {
    throw new Error(`refusing to restore: ${check.problems.join('; ')}`);
  }
  const walPath = `${opts.to}-wal`;
  const shmPath = `${opts.to}-shm`;
  const destExists = existsSync(opts.to);
  if (destExists) {
    const size = statSync(opts.to).size;
    if (size > 0 && !opts.force) {
      throw new Error(`destination ${opts.to} already exists and is not empty - pass --force to overwrite`);
    }
  }
  const walOrShmPresent = existsSync(walPath) || existsSync(shmPath);
  const busy = destExists && isDatabaseBusy(opts.to);
  if ((walOrShmPresent || busy) && !opts.force) {
    throw new Error(
      `refusing to restore over ${opts.to}: ${walOrShmPresent ? 'a WAL/SHM file is present' : 'the database appears to be open by another process'} - stop the server first (openpost serve/dashboard), then retry, or pass --force to override`,
    );
  }
  if (opts.dryRun) {
    return { restored: opts.to, schemaBefore: check.schemaVersion, schemaAfter: check.schemaVersion, rowCounts: check.manifest?.rowCounts ?? {} };
  }

  const gzip = opts.from.endsWith('.gz');
  const bytes = gzip ? gunzipSync(readFileSync(opts.from)) : readFileSync(opts.from);
  if (destExists) unlinkSync(opts.to);
  for (const stale of [walPath, shmPath]) {
    if (existsSync(stale)) unlinkSync(stale);
  }
  writeFileSync(opts.to, bytes);
  chmodSync(opts.to, 0o600);

  const db = openDb(opts.to);
  const schemaBefore = db.pragma('user_version', { simple: true }) as number;
  const schemaAfter = migrate(db);
  const rowCounts = countRows(db);
  db.close();

  return { restored: opts.to, schemaBefore, schemaAfter, rowCounts };
}

/** Deletes the oldest backups in `dir` beyond `keep`, matched by the `openpost-*.sqlite[.gz]`
 *  naming convention; their `.json` manifests are removed alongside. Returns the deleted paths. */
export function pruneBackups(dir: string, keep: number): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^openpost-.*\.sqlite(\.gz)?$/.test(f))
    .map((f) => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const toDelete = files.slice(keep);
  const deleted: string[] = [];
  for (const f of toDelete) {
    unlinkSync(f.path);
    const manifestPath = `${f.path}.json`;
    if (existsSync(manifestPath)) unlinkSync(manifestPath);
    deleted.push(f.path);
  }
  return deleted;
}
