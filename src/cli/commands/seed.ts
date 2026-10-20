import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { seedDemo } from '../../db/seed.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface SeedOpts {
  demo?: boolean;
  seed?: string;
  now?: string;
  messages?: string;
  reset?: boolean;
  force?: boolean;
  yes?: boolean;
}

const DEFAULT_NOW_MS = 1_789_000_000_000;

export function registerSeedCommand(program: Command): void {
  program
    .command('seed')
    .description('Populate the database with deterministic demo fixtures')
    .option('--demo', 'the only supported fixture set today')
    .option('--seed <n>', 'PRNG/id seed', '1')
    .option('--now <iso>', 'anchor timestamp (default: a fixed epoch so runs are reproducible)')
    .option('--messages <n>', 'number of demo messages', '12')
    .option('--reset', 'wipe the database first (never touches suppressions or settings)')
    .option('--force', 'seed even if the database has non-seeded rows')
    .option('--yes', 'confirm --reset against a database containing data `seed --demo` did not itself produce')
    .action((opts: SeedOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        if (!opts.demo) {
          throw new Error('pass --demo (the only supported fixture set)');
        }
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const nowMs = opts.now ? Date.parse(opts.now) : DEFAULT_NOW_MS;
        if (Number.isNaN(nowMs)) throw new Error(`invalid --now: "${opts.now}"`);

        const result = seedDemo(db, {
          seed: Number(opts.seed ?? 1),
          nowMs,
          messages: Number(opts.messages ?? 12),
          reset: !!opts.reset,
          force: !!opts.force,
          yes: !!opts.yes,
        });
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          if (result.wiped) {
            const wipedSummary = Object.entries(result.wiped)
              .filter(([, n]) => n > 0)
              .map(([table, n]) => `${table}=${n}`)
              .join(', ');
            process.stdout.write(
              `--reset wiped: ${wipedSummary || '(nothing - database was already empty)'} ` +
                `(suppressions preserved: ${result.suppressionsPreserved})\n`,
            );
          }
          process.stdout.write(
            `seeded ${result.messages} messages, ${result.recipients} recipients, ` +
              `${result.openEvents} open events, ${result.clickEvents} click events, ` +
              `${result.reminders} reminders, ${result.replies} replies, ${result.overrides} override(s)\n`,
          );
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
