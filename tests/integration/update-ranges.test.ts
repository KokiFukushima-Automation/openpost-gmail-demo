import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/cli/program.js';
import { openDb } from '../../src/db/index.js';
import { getRangeSet } from '../../src/db/repo.js';

let workDir: string;
let dbPath: string;
let outDir: string;
let exitSpy: ReturnType<typeof vi.spyOn>;
let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'openpost-ranges-'));
  dbPath = join(workDir, 'openpost.db');
  outDir = join(workDir, 'ranges');
  exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  exitSpy.mockRestore();
  stdoutSpy.mockRestore();
});

async function run(args: string[]): Promise<void> {
  const program = createProgram();
  await program.parseAsync(args, { from: 'user' });
}

describe('update-ranges (120b)', () => {
  it('--from-file writes a valid .cidr file, upserts ip_range_sets, and audits ranges.update', async () => {
    const fixture = join(process.cwd(), 'tests/fixtures/apple-egress.csv');
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', fixture, '--out-dir', outDir]);

    const written = join(outDir, 'apple-relay.cidr');
    expect(existsSync(written)).toBe(true);
    const text = readFileSync(written, 'utf8');
    expect(text).toContain('# name: apple_relay');
    expect(text).toContain('17.0.0.0/8');

    const db = openDb(dbPath);
    const row = getRangeSet(db, 'apple_relay');
    expect(row).not.toBeNull();
    expect(row?.entry_count).toBeGreaterThan(0);
    const audit = db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ranges.update'`).get() as { n: number };
    expect(audit.n).toBe(1);
    db.close();
  });

  it('--dry-run writes nothing', async () => {
    const fixture = join(process.cwd(), 'tests/fixtures/apple-egress.csv');
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', fixture, '--out-dir', outDir, '--dry-run']);
    expect(existsSync(join(outDir, 'apple-relay.cidr'))).toBe(false);
  });

  it('refuses a >50%% shrink without --force', async () => {
    const fixture = join(process.cwd(), 'tests/fixtures/apple-egress.csv'); // 3 entries
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', fixture, '--out-dir', outDir]);

    const tinyFixture = join(workDir, 'tiny.csv');
    await import('node:fs/promises').then((fs) => fs.writeFile(tinyFixture, 'ip_range,region\n17.0.0.0/8,US\n'));
    // 1 entry vs previous 3 -> more than 50% smaller -> refused without --force
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', tinyFixture, '--out-dir', outDir]);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockClear();
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', tinyFixture, '--out-dir', outDir, '--force']);
    expect(exitSpy).not.toHaveBeenCalled();
    const db = openDb(dbPath);
    const row = getRangeSet(db, 'apple_relay');
    expect(row?.entry_count).toBe(1);
    db.close();
  });

  it('finding #10: the shrink guard compares coalesced sizes, not raw line counts', async () => {
    const fixture = join(process.cwd(), 'tests/fixtures/apple-egress.csv'); // coalesces to 3 entries
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', fixture, '--out-dir', outDir]);
    const before = openDb(dbPath);
    expect(getRangeSet(before, 'apple_relay')?.entry_count).toBe(3);
    before.close();

    // 4 RAW lines (so a raw-count comparison against the previous 3 would look like a *growth*, not
    // a shrink), but they are four adjacent /10 blocks that exactly tile one /8 - mergeRanges
    // coalesces them into a single entry. The coalesced size (1) is more than 50% smaller than the
    // previous 3, so this must still be refused without --force.
    const tilingFixture = join(workDir, 'tiling.csv');
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(
        tilingFixture,
        'ip_range,region\n17.0.0.0/10,US\n17.64.0.0/10,US\n17.128.0.0/10,US\n17.192.0.0/10,US\n',
      ),
    );
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', tilingFixture, '--out-dir', outDir]);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockClear();
    await run(['--db', dbPath, 'update-ranges', '--source', 'apple', '--from-file', tilingFixture, '--out-dir', outDir, '--force']);
    expect(exitSpy).not.toHaveBeenCalled();
    const after = openDb(dbPath);
    expect(getRangeSet(after, 'apple_relay')?.entry_count).toBe(1);
    after.close();
  });
});
