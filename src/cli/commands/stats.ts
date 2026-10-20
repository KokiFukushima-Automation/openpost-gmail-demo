import Table from 'cli-table3';
import type { Command } from 'commander';
import { ConfigError, loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { statsReport } from '../../db/stats.js';
import { isValidTimeZone, parseDuration } from '../../core/time.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface StatsOpts {
  since?: string;
  until?: string;
  tz?: string;
}

function parseSince(v: string | undefined, nowMs: number): number {
  if (v === undefined) return 0;
  if (/^\d+$/.test(v)) return Number(v);
  const dur = parseDuration(v);
  if (dur !== null) return nowMs - dur;
  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return parsed;
  throw new ConfigError([`invalid --since value: "${v}"`]);
}

function parseUntil(v: string | undefined, nowMs: number): number {
  if (v === undefined) return nowMs;
  if (/^\d+$/.test(v)) return Number(v);
  const parsed = Date.parse(v);
  if (!Number.isNaN(parsed)) return parsed;
  throw new ConfigError([`invalid --until value: "${v}"`]);
}

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .description('Aggregate stats: open/click/reply rates, time-to-open, best-hour histogram')
    .option('--since <iso|dur>', 'default: all time', undefined)
    .option('--until <iso>', 'default: now')
    .option('--tz <zone>', 'IANA time zone (default: REPORT_TIMEZONE)')
    .action((opts: StatsOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const tz = opts.tz ?? config.reportTimezone;
        if (!isValidTimeZone(tz)) {
          throw new ConfigError([`--tz is not a recognised IANA time zone: ${tz}`]);
        }
        const nowMs = Date.now();
        const sinceMs = parseSince(opts.since, nowMs);
        const untilMs = parseUntil(opts.until, nowMs);

        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const report = statsReport(db, { sinceMs, untilMs, timeZone: tz });
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify(report)}\n`);
          return;
        }

        process.stdout.write(
          `stats for ${new Date(report.since).toISOString()} .. ${new Date(report.until).toISOString()} (${report.timeZone})\n\n`,
        );
        const totals = new Table({ head: ['metric', 'value'] });
        totals.push(
          ['messages', String(report.totals.messages)],
          ['recipients', String(report.totals.recipients)],
          ['open rate', `${(report.rates.openRate * 100).toFixed(1)}%`],
          ['click rate', `${(report.rates.clickRate * 100).toFixed(1)}%`],
          ['click-to-open rate', `${(report.rates.clickToOpenRate * 100).toFixed(1)}%`],
          ['reply rate', `${(report.rates.replyRate * 100).toFixed(1)}%`],
          ['prefetch suppression rate', `${(report.rates.prefetchSuppressionRate * 100).toFixed(1)}%`],
          ['median time-to-open', report.timeToOpen.medianMs !== null ? `${Math.round(report.timeToOpen.medianMs / 1000)}s` : 'n/a'],
          ['best hour', report.bestHour.peakHour !== null ? `${report.bestHour.peakHour}:00` : 'n/a'],
        );
        process.stdout.write(`${totals.toString()}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
