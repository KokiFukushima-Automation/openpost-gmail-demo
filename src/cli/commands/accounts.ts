import { chmodSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import type { Command } from 'commander';
import { loadConfig } from '../../config/env.js';
import { migrate, openDb } from '../../db/index.js';
import { generateMasterKey, loadMasterKey, writeKeyFile } from '../../core/secretbox.js';
import {
  addAccount,
  getAccountSummary,
  importEnvAccount,
  listAccounts,
  removeAccount,
  rotateMasterKey,
  setAccountStatus,
  setDefaultAccount,
  type AddAccountInput,
} from '../../mail/accounts.js';
import type { TransportName } from '../../types.js';
import { fail } from '../util.js';
import type { GlobalOpts } from '../util.js';

/** Reads a secret from stdin: the whole stream up to EOF (or the first newline), trimmed. Reading
 *  fd 0 synchronously (rather than an async `readline` interface) avoids a real event-ordering race
 *  between `'line'` and `'close'` that `readline` has for a pipe that closes before Node's event
 *  loop starts pumping it (e.g. `printf 'secret' | openpost accounts add ...` with no trailing
 *  newline) - the exact shape `--app-password-stdin` is documented to accept. */
function readStdinLine(): string {
  let raw: string;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return '';
  }
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? '';
  return firstLine.trim();
}

interface AddOpts {
  email: string;
  label?: string;
  transport?: TransportName;
  fromName?: string;
  selfOpenStrategy?: string;
  recipientMode?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpSecure?: boolean;
  smtpUser?: string;
  appPasswordStdin?: boolean;
  refreshTokenStdin?: boolean;
  noSecret?: boolean;
  default?: boolean;
}

export function registerAccountsCommand(program: Command): void {
  const accounts = program.command('accounts').description('Manage multiple sending accounts (encrypted secrets at rest)');

  accounts
    .command('init-key')
    .description('Generate the master key used to encrypt account secrets')
    .option('--path <p>', 'keyfile path (default: OPENPOST_CONFIG_DIR/master.key)')
    .option('--force', 'overwrite an existing keyfile')
    .action((opts: { path?: string; force?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const configDir = process.env.OPENPOST_CONFIG_DIR ?? `${process.env.HOME ?? '.'}/.config/openpost`;
        const path = opts.path ?? process.env.OPENPOST_MASTER_KEY_FILE ?? `${configDir}/master.key`;
        if (existsSync(path) && !opts.force) {
          throw new Error(`${path} already exists - pass --force to overwrite (this invalidates every secret encrypted under the old key)`);
        }
        if (existsSync(path)) {
          unlinkSync(path);
        }
        const key = generateMasterKey();
        writeKeyFile(path, key);
        chmodSync(path, 0o600);
        process.stdout.write(g.json ? `${JSON.stringify({ path })}\n` : `wrote master key to ${path} (mode 600)\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('add')
    .description('Add a sending account')
    .requiredOption('--email <addr>', 'account email address')
    .option('--label <l>', 'short label to refer to this account')
    .option('--transport <name>', 'dryrun | smtp | gmail | gmail-smtp', 'smtp')
    .option('--from-name <n>', 'display name')
    .option('--self-open-strategy <s>', 'window | insert | imap-append')
    .option('--recipient-mode <m>', 'auto | per-recipient | single')
    .option('--smtp-host <h>', 'SMTP host')
    .option('--smtp-port <n>', 'SMTP port')
    .option('--smtp-secure', 'use implicit TLS')
    .option('--smtp-user <u>', 'SMTP username')
    .option('--app-password-stdin', 'read an app password from stdin')
    .option('--refresh-token-stdin', 'read a Gmail OAuth refresh token from stdin')
    .option('--no-secret', 'add the account with no secret (transport config only)')
    .option('--default', 'make this the default account')
    .action((opts: AddOpts, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);

        let secret: AddAccountInput['secret'] = null;
        if (opts.appPasswordStdin) {
          const value = readStdinLine();
          if (!value) throw new Error('no app password read from stdin');
          secret = { kind: 'app_password', appPassword: value };
        } else if (opts.refreshTokenStdin) {
          const value = readStdinLine();
          if (!value) throw new Error('no refresh token read from stdin');
          secret = { kind: 'gmail_oauth', refreshToken: value };
        }

        const account = addAccount(db, config, {
          email: opts.email,
          label: opts.label ?? null,
          transport: (opts.transport ?? 'smtp') as TransportName,
          fromName: opts.fromName ?? null,
          selfOpenStrategy: opts.selfOpenStrategy as AddAccountInput['selfOpenStrategy'],
          recipientMode: opts.recipientMode as AddAccountInput['recipientMode'],
          config: {
            smtpHost: opts.smtpHost,
            smtpPort: opts.smtpPort ? Number(opts.smtpPort) : undefined,
            smtpSecure: opts.smtpSecure,
            smtpUser: opts.smtpUser,
          },
          secret,
          makeDefault: opts.default,
        });
        db.close();
        const output = { id: account.id, email: account.email, transport: account.transport, label: account.label };
        process.stdout.write(g.json ? `${JSON.stringify(output)}\n` : `added account ${account.id} (${account.email})\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('list')
    .description('List accounts (never prints a secret)')
    .action((_opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const rows = listAccounts(db);
        db.close();
        if (g.json) {
          process.stdout.write(`${JSON.stringify({ accounts: rows })}\n`);
        } else if (rows.length === 0) {
          process.stdout.write('no accounts (sending from FROM_EMAIL/env)\n');
        } else {
          for (const a of rows) {
            process.stdout.write(
              `${a.isDefault ? '*' : ' '} ${a.id}  ${a.email}${a.label ? ` (${a.label})` : ''}  ${a.transport}  ${a.status}${a.secretFingerprint ? `  secret:${a.secretFingerprint}` : ''}\n`,
            );
          }
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('show <ref>')
    .description('Show one account (never prints a secret; prints kind + fingerprint + age)')
    .action((ref: string, _opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const summary = getAccountSummary(db, ref);
        db.close();
        if (!summary) throw new Error(`no account matches "${ref}"`);
        process.stdout.write(`${JSON.stringify(summary, null, g.json ? 0 : 2)}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('default <ref>')
    .description('Set the default account')
    .action((ref: string, _opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        setDefaultAccount(db, ref);
        db.close();
        process.stdout.write(g.json ? `${JSON.stringify({ ok: true })}\n` : `default account set to ${ref}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('enable <ref>')
    .description('Re-enable a disabled account')
    .action((ref: string, _opts: unknown, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        setAccountStatus(db, ref, 'active');
        db.close();
        process.stdout.write(g.json ? `${JSON.stringify({ ok: true })}\n` : `enabled ${ref}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('remove <ref>')
    .description('Disable an account (or permanently delete it with --purge --yes)')
    .option('--purge', 'permanently delete the account and every message it ever sent')
    .option('--yes', 'confirm --purge')
    .option('--reassign <ref>', 'account to make default instead')
    .action((ref: string, opts: { purge?: boolean; yes?: boolean; reassign?: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const result = removeAccount(db, ref, { purge: opts.purge, yes: opts.yes, reassign: opts.reassign });
        db.close();
        if (g.json) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } else if (result.purged) {
          process.stdout.write(`purged: deleted ${result.counts?.messages} messages, ${result.counts?.recipients} recipients, ${result.counts?.events} events\n`);
        } else {
          process.stdout.write(`disabled ${ref}\n`);
        }
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('import-env')
    .description('Materialise the current env config into an encrypted account row')
    .option('--label <l>', 'label for the new account')
    .option('--default', 'make this the default account')
    .action((opts: { label?: string; default?: boolean }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const account = importEnvAccount(db, config, { label: opts.label, makeDefault: opts.default });
        db.close();
        process.stdout.write(g.json ? `${JSON.stringify({ id: account.id, email: account.email })}\n` : `imported ${account.email} as ${account.id}\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });

  accounts
    .command('rotate-key')
    .description('Re-encrypt every account secret under a new master key')
    .requiredOption('--new-key-file <p>', 'path to the new keyfile')
    .action((opts: { newKeyFile: string }, command: Command) => {
      const g = command.optsWithGlobals() as GlobalOpts;
      try {
        const config = loadConfig(process.env, { requireSecret: false });
        const db = openDb(g.db ?? config.dbPath);
        migrate(db);
        const oldKey = loadMasterKey(process.env, { required: true });
        const newKey = loadMasterKey({ OPENPOST_MASTER_KEY_FILE: opts.newKeyFile }, { required: true });
        if (!oldKey || !newKey) throw new Error('could not load both the old and the new master key');
        const result = rotateMasterKey(db, oldKey, newKey);
        db.close();
        process.stdout.write(g.json ? `${JSON.stringify(result)}\n` : `re-encrypted ${result.reEncrypted} secret(s)\n`);
      } catch (err) {
        fail(err, g.json);
      }
    });
}
