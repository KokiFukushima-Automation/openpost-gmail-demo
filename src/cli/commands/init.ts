import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { setSetting } from '../../db/repo.js';
import { generateMasterKey, writeKeyFile } from '../../core/secretbox.js';
import { generateVapidKeys } from '../../core/webpush.js';
import { renderEnvFile, runWizard, type WizardAnswers } from '../wizard.js';
import type { TransportName } from '../../types.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

interface InitOpts {
  yes?: boolean;
  force?: boolean;
  printEnv?: boolean;
  baseUrl?: string;
  from?: string;
  fromName?: string;
  transport?: string;
  dashboardPassword?: string;
  masterKey?: boolean; // --no-master-key flips this to false
  enablePush?: boolean; // docs/09_phase5_spec.md §7.4
}

function generateTrackingSecret(): string {
  return randomBytes(36).toString('base64');
}

/** Parses a `.env`-shaped file's `KEY=value` lines into a plain object - just enough to build a
 *  `loadConfig`-compatible env without touching `process.env` (the wizard's `.env` was just written
 *  to disk; `dotenv/config` already ran once, at process start, against whatever `.env` existed
 *  then). */
function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Create the database and apply migrations (idempotent); wizard mode writes a .env too')
    .option('--yes', 'non-interactive: use flags and defaults, write .env')
    .option('--force', 'overwrite an existing .env (backed up first) and re-run the wizard')
    .option('--print-env', 'print the .env that would be written and exit; writes nothing')
    .option('--base-url <url>', 'TRACKING_BASE_URL')
    .option('--from <email>', 'FROM_EMAIL')
    .option('--from-name <name>', 'FROM_NAME (display name)')
    .option('--transport <name>', 'dryrun | smtp | gmail | gmail-smtp')
    .option('--dashboard-password <password>', 'DASHBOARD_PASSWORD')
    .option('--no-master-key', 'skip generating an account-secrets master key')
    .option('--enable-push', 'generate a VAPID key pair and set NOTIFY_CHANNELS=webpush')
    .action(async (opts: InitOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const cwd = process.cwd();
        const envPath = join(cwd, '.env');
        const isTty = process.stdin.isTTY === true && process.stdout.isTTY === true;
        const wizardMode = opts.printEnv === true || opts.yes === true || (isTty && !opts.printEnv);

        if (!wizardMode) {
          // Back-compat fallback (documented deviation from the spec's literal three modes): a
          // bare `openpost init` with no flags and no TTY (e.g. a CI script, or the historical
          // `scripts/curl-smoke.sh` usage) keeps today's behaviour exactly - create the DB, apply
          // migrations, record the tracking-secret fingerprint - rather than guessing at wizard
          // answers no one is there to provide.
          const config = loadConfig(process.env, { requireSecret: false });
          const dbPath = g.db ?? config.dbPath;
          const db = openDb(dbPath);
          const schema = migrate(db);
          if (config.trackingSecret) {
            const fingerprint = createHash('sha256').update(config.trackingSecret).digest('hex').slice(0, 16);
            setSetting(db, 'tracking_secret_fingerprint', fingerprint);
          } else {
            const suggestion = generateTrackingSecret().slice(0, 48);
            process.stderr.write(`No TRACKING_SECRET is set. Suggested value for your .env:\n  TRACKING_SECRET=${suggestion}\n`);
          }
          setSetting(db, 'schema_note', `openpost schema v${schema}`);
          db.close();
          const result = { dbPath, schema };
          if (g.json) process.stdout.write(`${JSON.stringify(result)}\n`);
          else process.stdout.write(`Initialised ${dbPath} at schema v${schema}\n`);
          return;
        }

        // Idempotency (test 318): a second `init` on an already-configured tree does nothing,
        // unless --force or --print-env.
        if (!opts.printEnv && existsSync(envPath) && !opts.force) {
          const result = { alreadyInitialised: true, envPath };
          process.stdout.write(g.json ? `${JSON.stringify(result)}\n` : `already initialised - ${envPath} exists (pass --force to reconfigure)\n`);
          return;
        }

        const defaults: Partial<WizardAnswers> = {
          dataDir: './data',
          ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
          ...(opts.from !== undefined ? { fromEmail: opts.from } : {}),
          ...(opts.fromName !== undefined ? { fromName: opts.fromName } : {}),
          ...(opts.transport !== undefined ? { transport: opts.transport as TransportName } : {}),
          dashboardPassword: opts.dashboardPassword ?? null,
          generateMasterKey: opts.masterKey !== false,
          enableTunnelHint: true,
          enablePush: opts.enablePush === true,
        };

        let answers: WizardAnswers;
        if (opts.yes || opts.printEnv) {
          answers = {
            dataDir: defaults.dataDir ?? './data',
            baseUrl: defaults.baseUrl ?? 'http://127.0.0.1:8787',
            fromEmail: defaults.fromEmail ?? '',
            fromName: defaults.fromName ?? null,
            transport: defaults.transport ?? 'dryrun',
            dashboardPassword: defaults.dashboardPassword ?? null,
            generateMasterKey: defaults.generateMasterKey ?? true,
            enableTunnelHint: defaults.enableTunnelHint ?? true,
            enablePush: defaults.enablePush ?? false,
          };
        } else {
          answers = await runWizard({ input: process.stdin, output: process.stdout, isTty }, defaults);
        }

        const trackingSecret = generateTrackingSecret();
        // docs/09_phase5_spec.md §7.4: generated once here (never inside renderEnvFile itself, so
        // --print-env stays a pure function of `answers` for everything else) and handed in
        // alongside the tracking secret - the same "generate a real secret, write it once" pattern.
        const vapidKeys = answers.enablePush ? generateVapidKeys() : undefined;
        const envContent = renderEnvFile(answers, { trackingSecret, ...(vapidKeys ? { vapidKeys } : {}) });

        if (opts.printEnv) {
          process.stdout.write(envContent);
          return;
        }

        if (existsSync(envPath) && opts.force) {
          copyFileSync(envPath, `${envPath}.bak.${Date.now()}`);
        }
        writeFileSync(envPath, envContent, { mode: 0o600 });
        chmodSync(envPath, 0o600);

        const dataDirAbs = resolve(cwd, answers.dataDir);
        mkdirSync(dataDirAbs, { recursive: true });

        let masterKeyPath: string | null = null;
        if (answers.generateMasterKey) {
          masterKeyPath = resolve(cwd, answers.dataDir, 'config', 'master.key');
          if (!existsSync(masterKeyPath)) {
            writeKeyFile(masterKeyPath, generateMasterKey());
          }
        }

        // Build config from the just-written .env WITHOUT mutating process.env (the current
        // process already loaded whatever .env existed at start-up via `dotenv/config`).
        const envVars = { ...process.env, ...parseEnvFile(readFileSync(envPath, 'utf8')) };
        const config = loadConfig(envVars);
        const dbPath = g.db ?? config.dbPath;
        const db = openDb(dbPath);
        const schema = migrate(db);
        const fingerprint = createHash('sha256').update(trackingSecret).digest('hex').slice(0, 16);
        setSetting(db, 'tracking_secret_fingerprint', fingerprint);
        setSetting(db, 'schema_note', `openpost schema v${schema}`);
        db.close();

        const result = {
          envPath,
          dbPath,
          schema,
          masterKeyPath,
          baseUrl: answers.baseUrl,
        };
        if (g.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else {
          process.stdout.write(`Wrote ${envPath} (mode 600)\n`);
          process.stdout.write(`Initialised ${dbPath} at schema v${schema}\n`);
          if (masterKeyPath) process.stdout.write(`Master key: ${masterKeyPath} (mode 600)\n`);
          process.stdout.write('\nNext steps:\n');
          process.stdout.write('  openpost serve\n');
          if (answers.enableTunnelHint) {
            process.stdout.write(`  openpost tunnel   # exposes ${answers.baseUrl} if it is not already reachable\n`);
          }
          if (answers.transport === 'gmail' || answers.transport === 'gmail-smtp') {
            process.stdout.write('  openpost auth gmail\n');
          }
          process.stdout.write('  openpost doctor --offline\n');
        }
      } catch (err) {
        fail(err, g.json);
      }
    });
}
