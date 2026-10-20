import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { parseRangeFile } from '../../core/cidr.js';
import { migrate, openDb } from '../../db/index.js';
import { audit, getRangeSet, upsertRangeSet } from '../../db/repo.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

type SourceName = 'apple' | 'google';

const RANGE_NAME: Record<SourceName, string> = { apple: 'apple_relay', google: 'google_proxy' };
const FILE_NAME: Record<SourceName, string> = { apple: 'apple-relay.cidr', google: 'google-proxy.cidr' };
const REMOTE_URL: Record<SourceName, string> = {
  apple: 'https://mask-api.icloud.com/egress-ip-ranges.csv',
  google: 'https://www.gstatic.com/ipranges/goog.json',
};

function parseAppleCsv(text: string): string[] {
  const cidrs: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const field1 = line.split(',')[0]?.trim() ?? '';
    if (/^[0-9a-fA-F:.]+\/\d+$/.test(field1)) cidrs.push(field1);
  }
  return cidrs;
}

function parseGoogJson(text: string): string[] {
  const parsed = JSON.parse(text) as { prefixes?: Array<{ ipv4Prefix?: string; ipv6Prefix?: string }> };
  const cidrs: string[] = [];
  for (const p of parsed.prefixes ?? []) {
    if (p.ipv4Prefix) cidrs.push(p.ipv4Prefix);
    if (p.ipv6Prefix) cidrs.push(p.ipv6Prefix);
  }
  return cidrs;
}

function buildCidrFile(name: string, sourceUrl: string, generatedAtIso: string, entries: string[]): string {
  const sorted = [...new Set(entries)].sort();
  return [
    '# openpost-range-list: 1',
    `# name: ${name}`,
    `# source: ${sourceUrl}`,
    `# generated_at: ${generatedAtIso}`,
    `# entries: ${sorted.length}`,
    ...sorted,
    '',
  ].join('\n');
}

interface UpdateRangesOpts {
  source?: string;
  fromFile?: string;
  outDir?: string;
  force?: boolean;
  dryRun?: boolean;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

export function registerUpdateRangesCommand(program: Command): void {
  program
    .command('update-ranges')
    .description('Refresh the shipped Apple relay / Google proxy CIDR data files')
    .option('--source <name>', 'apple | google | all', 'all')
    .option('--from-file <path>', 'parse a previously downloaded CSV/JSON instead of fetching it')
    .option('--out-dir <dir>', 'override RANGES_DIR')
    .option('--force', 'allow a set to shrink by more than 50%%')
    .option('--dry-run', 'compute and print, write nothing')
    .action(async (opts: UpdateRangesOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const outDir = opts.outDir ?? config.rangesDir;
        const sourceOpt = opts.source ?? 'all';
        const sources: SourceName[] =
          sourceOpt === 'all' ? ['apple', 'google'] : sourceOpt === 'apple' || sourceOpt === 'google' ? [sourceOpt] : [];
        if (sources.length === 0) {
          throw new Error('--source must be apple, google or all');
        }
        if (opts.fromFile && sources.length > 1) {
          throw new Error('--from-file requires a single --source (apple or google), not "all"');
        }

        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const results: Array<{ name: string; entries: number; sha256: string; written: boolean; source: string }> = [];

        for (const source of sources) {
          const rawText = opts.fromFile ? readFileSync(opts.fromFile, 'utf8') : await fetchText(REMOTE_URL[source]);
          const entries = source === 'apple' ? parseAppleCsv(rawText) : parseGoogJson(rawText);
          const name = RANGE_NAME[source];
          const fileText = buildCidrFile(name, opts.fromFile ? `file:${opts.fromFile}` : REMOTE_URL[source], new Date().toISOString(), entries);
          const sha256 = createHash('sha256').update(fileText).digest('hex');

          // Finding #10: compare like with like - `existing.entry_count` is the *coalesced* size
          // recorded by the last successful update (see `upsertRangeSet` below, `entryCount:
          // parsedSet.size`), so the new set's raw, pre-coalescing line count is not a fair
          // comparison against it (adjacent/overlapping CIDRs can coalesce very differently between
          // two otherwise similarly-sized inputs). Parse-and-coalesce first, then compare sizes.
          const parsedSet = parseRangeFile(name, fileText);
          const existing = getRangeSet(db, name);
          if (existing && !opts.force && parsedSet.size < existing.entry_count * 0.5) {
            throw new Error(
              `${name}: new set has ${parsedSet.size} entries (coalesced), more than 50% smaller than the current ${existing.entry_count} - pass --force to accept this anyway`,
            );
          }

          const path = join(outDir, FILE_NAME[source]);

          if (!opts.dryRun) {
            mkdirSync(outDir, { recursive: true });
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, fileText, 'utf8');
            renameSync(tmp, path);
            upsertRangeSet(db, {
              name,
              sourceUrl: parsedSet.sourceUrl,
              generatedAt: parsedSet.generatedAt,
              entryCount: parsedSet.size,
              sha256,
              updatedAt: Date.now(),
            });
            audit(db, {
              actor: 'operator',
              action: 'ranges.update',
              detail: { name, entries: parsedSet.size, sha256, source: opts.fromFile ? 'file' : 'remote' },
            });
          }

          results.push({ name, entries: parsedSet.size, sha256, written: !opts.dryRun, source: REMOTE_URL[source] });
        }

        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify({ dryRun: !!opts.dryRun, results })}\n`);
        } else {
          for (const r of results) {
            process.stdout.write(`${r.name}: ${r.entries} entries, sha256:${r.sha256.slice(0, 12)}... ${r.written ? 'written' : '(dry-run)'}\n`);
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
