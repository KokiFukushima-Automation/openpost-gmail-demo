import Table from 'cli-table3';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { accuracyReport } from '../../db/report.js';
import { migrate, openDb } from '../../db/index.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface AccuracyOpts {
  since?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses `30d` / `7d` / a bare number of days. Defaults to 30 days. */
function parseSince(value: string | undefined, nowMs: number): number {
  if (!value) return nowMs - 30 * DAY_MS;
  const match = /^(\d+)d?$/.exec(value.trim());
  if (!match) throw new Error('--since must look like "30d" or a bare number of days');
  return nowMs - Number(match[1]) * DAY_MS;
}

export function registerAccuracyCommand(program: Command): void {
  program
    .command('accuracy')
    .description('Report classification/rule/notification accuracy statistics')
    .option('--since <window>', 'e.g. 30d (default), 7d', '30d')
    .action((opts: AccuracyOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const sinceMs = parseSince(opts.since, Date.now());
        const report = accuracyReport(db, sinceMs);
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify(report)}\n`);
          return;
        }

        process.stdout.write(`since: ${new Date(report.since).toISOString()}\n\n`);

        const classTable = new Table({ head: ['classification', 'count'] });
        for (const [k, v] of Object.entries(report.opens.byClassification)) classTable.push([`open:${k}`, String(v)]);
        for (const [k, v] of Object.entries(report.clicks.byClassification)) classTable.push([`click:${k}`, String(v)]);
        process.stdout.write(`${classTable.toString()}\n\n`);

        const ruleTable = new Table({ head: ['rule', 'count'] });
        for (const [k, v] of Object.entries(report.rules).sort((a, b) => b[1] - a[1])) ruleTable.push([k, String(v)]);
        process.stdout.write(`${ruleTable.toString()}\n\n`);

        const stateTable = new Table({ head: ['state', 'count'] });
        for (const [k, v] of Object.entries(report.recipients.byState)) stateTable.push([k, String(v)]);
        process.stdout.write(`${stateTable.toString()}\n\n`);

        process.stdout.write(
          `countedOpenRate: ${(report.derived.countedOpenRate * 100).toFixed(1)}%  ` +
            `prefetchSuppressionRate: ${(report.derived.prefetchSuppressionRate * 100).toFixed(1)}%  ` +
            `backfilledOpens: ${report.derived.backfilledOpens}  overrides: ${report.derived.overrides}  ` +
            `medianTimeToOpenMs: ${report.derived.medianTimeToOpenMs ?? 'n/a'}\n`,
        );
        process.stdout.write(
          `notifications: sent=${report.notifications.sent} pending=${report.notifications.pending} ` +
            `failed=${report.notifications.failed} deadLettered=${report.notifications.deadLettered}\n`,
        );
      } catch (err) {
        fail(err, g.json);
      }
    });
}
