import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = Database.Database;
export type Stmt = Database.Statement;

/** The schema version a fully migrated database must report. Used by `openpost doctor` and
 *  `/healthz`. Deviation note: docs/06_phase3_spec.md's own header says the Phase 3 migration
 *  becomes "004" and `EXPECTED_SCHEMA` becomes 4, written against a pre-hardening tree; this tree
 *  already shipped 004_notify_sending_state.sql (Phase 2.1, finding #6), so Phase 3's migration is
 *  renumbered 005 and `EXPECTED_SCHEMA` becomes 5 (see docs/05_phase2_spec.md's own §7.1 deviation
 *  note for the same renumbering precedent). */
// docs/07_recipient_semantics.md's migration 006 (recipient_mode / is_aggregate / envelope_to)
// bumps this to 6.
// 007_phase3_1.sql (Phase 3.1 hardening pass: reminders.skipped_at/failed_at, an expression index
// for COALESCE(sent_at, created_at)) bumps this to 7.
// 008_phase4.sql (docs/08_phase4_spec.md: campaigns, multi-account secrets at rest, campaign_id
// back-references) bumps this to 8. Deviation from the spec's own numbering: it was written
// against a schema-6 tree and calls this migration "007_phase4.sql" - 007_phase3_1.sql landed
// first, so this is 008 and EXPECTED_SCHEMA is 8, not 7.
// 009_phase4_1.sql (Phase 4.1 hardening pass, docs/reports/phase4_review.md findings #2/#3: folds
// suppressions.email to lower(trim(...)) and makes it COLLATE NOCASE; de-collides the
// campaign_rows erase sentinel) bumps this to 9.
// 010_phase5.sql (docs/09_phase5_spec.md: Web Push subscriptions, a message provenance column, and
// the Gmail add-on's draft back-reference) bumps this to 10.
export const EXPECTED_SCHEMA = 10;

function migrationsDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'migrations');
}

/** Opens (creating parent directories as needed) a SQLite DB in WAL mode with foreign keys on. */
export function openDb(path: string): DB {
  if (path !== ':memory:') {
    const dir = dirname(path);
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (path !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }
  return db;
}

/**
 * Applies pending `.sql` migrations tracked via PRAGMA user_version. Returns the new version.
 * Each migration file's statements plus its `user_version` bump run inside a single transaction
 * (finding #11): a failure partway through a file's SQL leaves that file's changes fully rolled
 * back and `user_version` unchanged, rather than a half-applied schema silently recorded as
 * up-to-date. `opts.dir` overrides the migrations directory (for tests only - production always
 * resolves it relative to this module).
 */
export function migrate(db: DB, opts: { dir?: string } = {}): number {
  const dir = migrationsDir(opts.dir);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const current = db.pragma('user_version', { simple: true }) as number;
  let version = current;
  for (const file of files) {
    const num = parseInt(file.slice(0, 3), 10);
    if (!Number.isFinite(num) || num <= current) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const applyMigration = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${num}`);
    });
    applyMigration();
    version = num;
  }
  return version;
}

export function withTx<T>(db: DB, fn: () => T): T {
  return db.transaction(fn)();
}
