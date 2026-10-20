import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { ConfigError, loadConfig } from '../../config/env.js';
import { executeForget, planForget } from '../../db/erase.js';
import { migrate, openDb } from '../../db/index.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface ForgetOpts {
  dryRun?: boolean;
  yes?: boolean;
  purgeBodies?: boolean;
  full?: boolean;
}

function confirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export function registerForgetCommand(program: Command): void {
  program
    .command('forget')
    .description('Erase every tracked event/recipient/token for an email address')
    .argument('<email>', 'recipient email address to erase')
    .option('--dry-run', 'print counts and change nothing')
    .option('--yes', 'do not prompt for confirmation')
    .option('--purge-bodies', 'also null out the HTML/text body of surviving messages')
    .option('--full', 'also drop the suppression row (future sends to this address WILL be tracked again)')
    .action(async (email: string, opts: ForgetOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      const yes = opts.yes || !!g.json;
      // Finding #21: --json implying --yes is documented behaviour (a JSON caller can't answer an
      // interactive prompt), but it was happening silently - print a warning to stderr (never
      // stdout, which --json callers parse as the result) so it's visible without being mistaken
      // for the command's actual output.
      if (g.json && !opts.yes && !opts.dryRun) {
        process.stderr.write('warning: --json implies --yes (skipping the confirmation prompt)\n');
      }
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        // Finding #14: the audit-log subject hash `executeForget` computes for this erasure must be
        // keyed by something only this install knows - refuse rather than silently hash with the
        // hard-coded fallback salt (a public constant in this source tree) that `forget` alone
        // among all commands would otherwise be able to reach via `requireSecret: false`.
        if (config.ipSaltIsDefault) {
          throw new ConfigError([
            'refusing to erase without a real IP_SALT or TRACKING_SECRET configured - the audit ' +
              'log would otherwise hash this email with a salt that is a public constant in the ' +
              'openpost source, defeating the point of hashing it at all. Set IP_SALT (or ' +
              'TRACKING_SECRET) and try again.',
          ]);
        }
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        const plan = planForget(db, email);

        if (opts.dryRun) {
          db.close();
          const output = { dryRun: true, email, counts: plan.counts };
          if (g.json) process.stdout.write(`${JSON.stringify(output)}\n`);
          else process.stdout.write(`would erase for ${email}:\n${JSON.stringify(plan.counts, null, 2)}\n`);
          return;
        }

        if (!yes) {
          process.stdout.write(`about to erase for ${email}:\n${JSON.stringify(plan.counts, null, 2)}\n`);
          const proceed = await confirm('Proceed?');
          if (!proceed) {
            db.close();
            process.stdout.write('aborted, nothing changed\n');
            return;
          }
        }

        const counts = executeForget(db, plan, {
          purgeBodies: !!opts.purgeBodies,
          keepSuppression: !opts.full,
          ipSalt: config.ipSalt,
          atMs: Date.now(),
        });
        db.close();

        if (g.json) {
          process.stdout.write(`${JSON.stringify({ email, counts })}\n`);
        } else {
          process.stdout.write(`erased for ${email}:\n${JSON.stringify(counts, null, 2)}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
