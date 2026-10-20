import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { reclassify } from '../../server/services/reclassify.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface ReclassifyOpts {
  kind?: string;
  to?: string;
  counted?: boolean;
  notCounted?: boolean;
  note?: string;
}

export function registerReclassifyCommand(program: Command): void {
  program
    .command('reclassify')
    .description('Manually override a single event\'s classification')
    .argument('<eventId>', 'open or click event id')
    .requiredOption('--kind <open|click>', 'which event table to look in')
    .requiredOption('--to <classification>', 'the new classification')
    .option('--counted', 'force counted=true')
    .option('--not-counted', 'force counted=false')
    .option('--note <text>', 'free-text audit note')
    .action((eventId: string, opts: ReclassifyOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        if (opts.kind !== 'open' && opts.kind !== 'click') {
          throw new Error('--kind must be open or click');
        }
        if (opts.counted && opts.notCounted) {
          throw new Error('--counted and --not-counted are mutually exclusive');
        }

        const input: Parameters<typeof reclassify>[1] = {
          kind: opts.kind,
          eventId,
          classification: opts.to as string,
          actor: 'cli',
          atMs: Date.now(),
          ...(opts.counted ? { counted: true } : {}),
          ...(opts.notCounted ? { counted: false } : {}),
          ...(opts.note !== undefined ? { note: opts.note } : {}),
        };
        const result = reclassify(db, input);
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          process.stdout.write(
            `${result.kind} ${result.eventId}: ${result.before.classification} -> ${result.after.classification}\n` +
              `recipient ${result.recipient.id}: state=${result.recipient.state} openCount=${result.recipient.openCount} clickCount=${result.recipient.clickCount}\n`,
          );
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
