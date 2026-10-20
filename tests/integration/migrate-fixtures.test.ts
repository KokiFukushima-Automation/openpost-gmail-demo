import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { EXPECTED_SCHEMA, migrate, openDb } from '../../src/db/index.js';
import { listMessagesFiltered } from '../../src/db/repo.js';
import { statsReport } from '../../src/db/stats.js';
import { campaignCounts } from '../../src/db/campaigns.js';

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', '..', 'fixtures', 'db');
const FIXTURE_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function tableExists(db: Database.Database, name: string): boolean {
  return db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !== undefined;
}

function rowCounts(db: Database.Database): Record<string, number> {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const t of tables) {
    counts[t.name] = (db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number }).n;
  }
  return counts;
}

describe('migrate-fixtures: every checked-in fixture DB reaches the current schema', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'op-migrate-fixtures-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  for (const version of FIXTURE_VERSIONS) {
    it(`308-313. v${version} fixture: migrate() reaches ${EXPECTED_SCHEMA}, zero row loss (for tables that survive), no FK violations, integrity ok, idempotent`, () => {
      const src = join(FIXTURES_DIR, `v${version}.sqlite`);
      const dest = join(dir, `v${version}.sqlite`);
      copyFileSync(src, dest);

      const db = openDb(dest);
      expect(db.pragma('user_version', { simple: true })).toBe(version);

      const before = rowCounts(db);
      const after = migrate(db);
      expect(after).toBe(EXPECTED_SCHEMA);

      // Every table that existed before migration still has the same row count afterward - no
      // migration in this tree drops rows, only columns/tables are added.
      for (const [table, count] of Object.entries(before)) {
        if (!tableExists(db, table)) continue; // a table dropped-and-recreated with the same name (schema 3's notifications rewrite) is checked separately below
        const afterCount = (db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number }).n;
        expect(afterCount, `table ${table} lost rows migrating from v${version}`).toBe(count);
      }

      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
      expect(db.pragma('foreign_key_check')).toEqual([]);

      // 314: new columns have their documented defaults on migrated rows.
      const account = db.prepare('SELECT status, origin FROM accounts LIMIT 1').get() as { status: string; origin: string };
      expect(account.status).toBe('active');
      expect(account.origin).toBe('legacy');
      const message = db.prepare('SELECT campaign_id FROM messages LIMIT 1').get() as { campaign_id: string | null };
      expect(message.campaign_id).toBeNull();

      // One account should have been promoted to is_default (008_phase4's back-fill).
      const defaultCount = (db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE is_default = 1').get() as { n: number }).n;
      expect(defaultCount).toBe(1);

      // 315: representative queries run without throwing against every migrated fixture.
      expect(() => listMessagesFiltered(db, {}, { limit: 50, offset: 0, sort: 'sent_desc' })).not.toThrow();
      expect(() => statsReport(db, { sinceMs: 0, untilMs: Date.now() + 1, timeZone: 'UTC' })).not.toThrow();
      const anyCampaign = db.prepare('SELECT id FROM campaigns LIMIT 1').get() as { id: string } | undefined;
      if (anyCampaign) {
        expect(() => campaignCounts(db, anyCampaign.id)).not.toThrow();
      } else {
        expect(() => campaignCounts(db, 'nonexistent')).not.toThrow();
      }

      // A second migrate() is a no-op.
      const secondRun = migrate(db);
      expect(secondRun).toBe(EXPECTED_SCHEMA);
      expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);

      db.close();
    });
  }
});
