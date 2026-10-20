/**
 * Multi-account resolution and secrets at rest (docs/08_phase4_spec.md §3). `resolveAccount`'s
 * order - explicit ref -> the `is_default` row -> a synthetic env-fallback account - is what makes
 * multi-account a pure addition: a tree with zero CLI-added `accounts` rows behaves identically to
 * the pre-Phase-4 tree (test 293).
 */
import { newId } from '../core/ids.js';
import {
  envelopeFingerprint,
  keyFingerprint,
  loadMasterKey,
  open as openSecret,
  seal,
  secretAad,
  type MasterKey,
} from '../core/secretbox.js';
import type { AppConfig, SelfOpenStrategy } from '../config/env.js';
import type { DB } from '../db/index.js';
import { audit, getSetting, setSetting } from '../db/repo.js';
import { resolveRefreshToken } from './oauth.js';
import { resolveTransport, type Transport } from './transport.js';
import type { RecipientModeOption, TransportName } from '../types.js';

export type AccountRef = string;

export interface AccountTransportConfig {
  smtpHost?: string | undefined;
  smtpPort?: number | undefined;
  smtpSecure?: boolean | undefined;
  smtpUser?: string | undefined;
  gmailSmtpHost?: string | undefined;
  gmailSmtpPort?: number | undefined;
  imapHost?: string | undefined;
  imapSentMailbox?: string | undefined;
  googleClientId?: string | undefined;
}

export interface AccountSecret {
  kind: 'app_password' | 'gmail_oauth' | 'none';
  appPassword?: string | undefined;
  refreshToken?: string | undefined;
  googleClientSecret?: string | undefined;
}

export interface ResolvedAccount {
  id: string;
  email: string;
  fromName: string | null;
  transport: TransportName;
  selfOpenStrategy: SelfOpenStrategy;
  recipientMode: RecipientModeOption;
  config: AccountTransportConfig;
  isEnvFallback: boolean;
  label: string | null;
  status: 'active' | 'disabled';
  secret(): AccountSecret;
}

export interface AccountSummary {
  id: string;
  email: string;
  label: string | null;
  fromName: string | null;
  transport: string;
  status: string;
  isDefault: boolean;
  origin: string;
  secretKind: string | null;
  secretFingerprint: string | null;
  lastUsedAt: number | null;
  createdAt: number;
}

/** Raw shape of a full `accounts` row after migration 008 (a superset of `db/repo.ts`'s
 *  `AccountRow`, which predates the Phase 4 columns). */
export interface FullAccountRow {
  id: string;
  email: string;
  display_name: string | null;
  transport: string;
  created_at: number;
  label: string | null;
  from_name: string | null;
  status: 'active' | 'disabled';
  is_default: number;
  origin: string;
  self_open_strategy: string | null;
  recipient_mode: string | null;
  config_json: string;
  secret_kind: string | null;
  secret_ciphertext: string | null;
  secret_scopes: string | null;
  secret_updated_at: number | null;
  last_used_at: number | null;
}

export class AccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccountError';
  }
}

function getRowById(db: DB, id: string): FullAccountRow | null {
  const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as FullAccountRow | undefined;
  return row ?? null;
}

function getRowByRef(db: DB, ref: AccountRef): FullAccountRow | null {
  const row = db
    .prepare('SELECT * FROM accounts WHERE id = ? OR label = ? OR email = ? LIMIT 1')
    .get(ref, ref, ref) as FullAccountRow | undefined;
  return row ?? null;
}

function getDefaultRow(db: DB): FullAccountRow | null {
  const row = db.prepare('SELECT * FROM accounts WHERE is_default = 1 LIMIT 1').get() as FullAccountRow | undefined;
  return row ?? null;
}

function decryptSecret(row: FullAccountRow, masterKey: () => MasterKey): AccountSecret {
  if (!row.secret_ciphertext || !row.secret_kind) return { kind: 'none' };
  const key = masterKey().key;
  if (row.secret_kind === 'app_password') {
    const plaintext = openSecret(row.secret_ciphertext, key, secretAad(row.id, 'app_password'));
    return { kind: 'app_password', appPassword: plaintext };
  }
  if (row.secret_kind === 'gmail_oauth') {
    const plaintext = openSecret(row.secret_ciphertext, key, secretAad(row.id, 'gmail_oauth'));
    const parsed = JSON.parse(plaintext) as { refreshToken: string; googleClientSecret?: string };
    return { kind: 'gmail_oauth', refreshToken: parsed.refreshToken, googleClientSecret: parsed.googleClientSecret };
  }
  return { kind: 'none' };
}

function rowToResolvedAccount(db: DB, row: FullAccountRow, config: AppConfig): ResolvedAccount {
  const transportConfig = JSON.parse(row.config_json || '{}') as AccountTransportConfig;
  return {
    id: row.id,
    email: row.email,
    fromName: row.from_name ?? row.display_name,
    transport: row.transport as TransportName,
    selfOpenStrategy: (row.self_open_strategy as SelfOpenStrategy | null) ?? config.selfOpenStrategy,
    recipientMode: (row.recipient_mode as RecipientModeOption | null) ?? config.recipientMode,
    config: transportConfig,
    isEnvFallback: false,
    label: row.label,
    status: row.status,
    secret: () => decryptSecret(row, () => loadMasterKey(process.env, { required: true }) as MasterKey),
  };
}

function envFallbackAccount(db: DB, config: AppConfig): ResolvedAccount {
  return {
    id: 'env',
    email: config.fromEmail ?? '',
    fromName: config.fromName ?? null,
    transport: config.mailTransport,
    selfOpenStrategy: config.selfOpenStrategy,
    recipientMode: config.recipientMode,
    config: {
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      smtpUser: config.smtpUser,
      gmailSmtpHost: config.gmailSmtpHost,
      gmailSmtpPort: config.gmailSmtpPort,
      imapHost: config.imapHost,
      imapSentMailbox: config.imapSentMailbox,
      googleClientId: config.googleClientId,
    },
    isEnvFallback: true,
    label: null,
    status: 'active',
    secret: () => {
      if (config.mailTransport === 'smtp') return { kind: 'app_password', appPassword: config.smtpPass };
      if (config.mailTransport === 'gmail' || config.mailTransport === 'gmail-smtp') {
        const resolved = resolveRefreshToken(config, process.env);
        return { kind: 'gmail_oauth', refreshToken: resolved?.token ?? config.googleRefreshToken, googleClientSecret: config.googleClientSecret };
      }
      return { kind: 'none' };
    },
  };
}

/** Resolution order (§3.3): explicit `ref` -> the `is_default` row -> the env fallback. */
export function resolveAccount(db: DB, config: AppConfig, ref?: AccountRef): ResolvedAccount {
  if (ref !== undefined) {
    const row = getRowByRef(db, ref);
    if (!row) throw new AccountError(`no account matches "${ref}" (by id, label or email)`);
    if (row.status === 'disabled') {
      throw new AccountError(`account "${ref}" is disabled - run \`openpost accounts enable ${ref}\``);
    }
    return rowToResolvedAccount(db, row, config);
  }
  const defaultRow = getDefaultRow(db);
  if (defaultRow) {
    if (defaultRow.status === 'disabled') {
      // Falls back to env (with a doctor warning, per §3.5) rather than throwing - a disabled
      // default must never break every send outright.
      return envFallbackAccount(db, config);
    }
    return rowToResolvedAccount(db, defaultRow, config);
  }
  return envFallbackAccount(db, config);
}

export function listAccounts(db: DB): AccountSummary[] {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all() as FullAccountRow[];
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    label: row.label,
    fromName: row.from_name ?? row.display_name,
    transport: row.transport,
    status: row.status,
    isDefault: row.is_default === 1,
    origin: row.origin,
    secretKind: row.secret_kind,
    secretFingerprint: row.secret_ciphertext ? envelopeFingerprint(row.secret_ciphertext) : null,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
  }));
}

export function getAccountSummary(db: DB, ref: AccountRef): AccountSummary | null {
  const row = getRowByRef(db, ref);
  if (!row) return null;
  return listAccounts(db).find((a) => a.id === row.id) ?? null;
}

export interface AddAccountInput {
  email: string;
  label?: string | null;
  transport: TransportName;
  fromName?: string | null;
  selfOpenStrategy?: SelfOpenStrategy | null | undefined;
  recipientMode?: RecipientModeOption | null | undefined;
  config?: AccountTransportConfig;
  secret?: { kind: 'app_password'; appPassword: string } | { kind: 'gmail_oauth'; refreshToken: string; googleClientSecret?: string | undefined } | null;
  makeDefault?: boolean | undefined;
  origin?: string | undefined;
}

function sealSecret(accountId: string, input: NonNullable<AddAccountInput['secret']>, masterKey: MasterKey): { kind: string; ciphertext: string } {
  if (input.kind === 'app_password') {
    return { kind: 'app_password', ciphertext: seal(input.appPassword, masterKey.key, secretAad(accountId, 'app_password')) };
  }
  const payload = JSON.stringify({ refreshToken: input.refreshToken, googleClientSecret: input.googleClientSecret });
  return { kind: 'gmail_oauth', ciphertext: seal(payload, masterKey.key, secretAad(accountId, 'gmail_oauth')) };
}

export function addAccount(db: DB, config: AppConfig, input: AddAccountInput): ResolvedAccount {
  const id = newId();
  const now = Date.now();
  let secretKind: string | null = null;
  let secretCiphertext: string | null = null;
  if (input.secret) {
    const masterKey = loadMasterKey(process.env, { required: true });
    if (!masterKey) throw new AccountError('no master key configured - run `openpost accounts init-key`');
    const sealed = sealSecret(id, input.secret, masterKey);
    secretKind = sealed.kind;
    secretCiphertext = sealed.ciphertext;
    // Finding #11: nothing ever wrote this setting before - every backup manifest's
    // masterKeyFingerprint was permanently null, the weakest link in the restore/rotation story
    // (docs/deploy.md promises the manifest carries it). Recorded on the FIRST secret ever sealed;
    // `rotateMasterKey` below is the only thing that ever changes it after that.
    if (getSetting(db, 'master_key_fingerprint') === null) {
      setSetting(db, 'master_key_fingerprint', keyFingerprint(masterKey.key));
    }
  }

  const tx = db.transaction(() => {
    if (input.makeDefault) {
      db.prepare('UPDATE accounts SET is_default = 0 WHERE is_default = 1').run();
    }
    db.prepare(
      `INSERT INTO accounts
        (id, email, display_name, transport, created_at, label, from_name, status, is_default,
         origin, self_open_strategy, recipient_mode, config_json, secret_kind, secret_ciphertext,
         secret_scopes, secret_updated_at, last_used_at)
       VALUES
        (@id, @email, @from_name, @transport, @created_at, @label, @from_name, 'active', @is_default,
         @origin, @self_open_strategy, @recipient_mode, @config_json, @secret_kind, @secret_ciphertext,
         NULL, @secret_updated_at, NULL)`,
    ).run({
      id,
      email: input.email,
      from_name: input.fromName ?? null,
      transport: input.transport,
      created_at: now,
      label: input.label ?? null,
      is_default: input.makeDefault ? 1 : 0,
      origin: input.origin ?? 'cli',
      self_open_strategy: input.selfOpenStrategy ?? null,
      recipient_mode: input.recipientMode ?? null,
      config_json: JSON.stringify(input.config ?? {}),
      secret_kind: secretKind,
      secret_ciphertext: secretCiphertext,
      secret_updated_at: secretCiphertext ? now : null,
    });
  });
  tx();

  audit(db, { actor: 'cli', action: 'account.add', subjectType: 'account', subjectId: id, detail: { email: input.email, transport: input.transport } });

  const row = getRowById(db, id);
  if (!row) throw new AccountError('account insert failed');
  return rowToResolvedAccount(db, row, config);
}

export function setDefaultAccount(db: DB, ref: AccountRef): void {
  const row = getRowByRef(db, ref);
  if (!row) throw new AccountError(`no account matches "${ref}"`);
  const tx = db.transaction(() => {
    db.prepare('UPDATE accounts SET is_default = 0 WHERE is_default = 1').run();
    db.prepare('UPDATE accounts SET is_default = 1 WHERE id = ?').run(row.id);
  });
  tx();
}

export function setAccountStatus(db: DB, ref: AccountRef, status: 'active' | 'disabled'): void {
  const row = getRowByRef(db, ref);
  if (!row) throw new AccountError(`no account matches "${ref}"`);
  db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(status, row.id);
}

export interface RemoveAccountOptions {
  purge?: boolean | undefined;
  yes?: boolean | undefined;
  reassign?: AccountRef | undefined;
}

export interface RemoveAccountResult {
  disabled: boolean;
  purged: boolean;
  counts?: { messages: number; recipients: number; events: number };
}

/** Disables by default (secrets zeroed, `is_default` cleared); only `--purge --yes` actually
 *  deletes the row (and, via `ON DELETE CASCADE`, every message/recipient/event it ever sent) -
 *  §3.5's dangerous path. */
export function removeAccount(db: DB, ref: AccountRef, opts: RemoveAccountOptions = {}): RemoveAccountResult {
  const row = getRowByRef(db, ref);
  if (!row) throw new AccountError(`no account matches "${ref}"`);

  if (!opts.purge) {
    const tx = db.transaction(() => {
      db.prepare(`UPDATE accounts SET status = 'disabled', secret_ciphertext = NULL, secret_kind = NULL, is_default = 0 WHERE id = ?`).run(row.id);
      if (opts.reassign) {
        const target = getRowByRef(db, opts.reassign);
        if (target) {
          db.prepare('UPDATE accounts SET is_default = 0 WHERE is_default = 1').run();
          db.prepare('UPDATE accounts SET is_default = 1 WHERE id = ?').run(target.id);
        }
      }
    });
    tx();
    audit(db, { actor: 'cli', action: 'account.disable', subjectType: 'account', subjectId: row.id });
    return { disabled: true, purged: false };
  }

  if (!opts.yes) {
    throw new AccountError('--purge requires --yes to confirm permanent deletion');
  }
  const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE account_id = ?').get(row.id) as { n: number }).n;
  const recipients = (
    db
      .prepare('SELECT COUNT(*) AS n FROM recipients WHERE message_id IN (SELECT id FROM messages WHERE account_id = ?)')
      .get(row.id) as { n: number }
  ).n;
  const events = (
    db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM open_events WHERE recipient_id IN (SELECT id FROM recipients WHERE message_id IN (SELECT id FROM messages WHERE account_id = @id)))
         + (SELECT COUNT(*) FROM click_events WHERE recipient_id IN (SELECT id FROM recipients WHERE message_id IN (SELECT id FROM messages WHERE account_id = @id))) AS n`,
      )
      .get({ id: row.id }) as { n: number }
  ).n;

  audit(db, {
    actor: 'cli',
    action: 'account.purge',
    subjectType: 'account',
    subjectId: row.id,
    detail: { messages, recipients, events },
  });
  db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id);
  return { disabled: false, purged: true, counts: { messages, recipients, events } };
}

/** `openpost accounts import-env`: materialises the current env-derived transport config into an
 *  encrypted `accounts` row. Never edits `.env` and never deletes the on-disk Gmail token store -
 *  the operator does that after verifying (§3.6). */
export function importEnvAccount(db: DB, config: AppConfig, opts: { label?: string | undefined; makeDefault?: boolean | undefined } = {}): ResolvedAccount {
  if (!config.fromEmail) throw new AccountError('FROM_EMAIL is not set - nothing to import');
  const secret: AddAccountInput['secret'] =
    config.mailTransport === 'smtp' && config.smtpPass
      ? { kind: 'app_password', appPassword: config.smtpPass }
      : (config.mailTransport === 'gmail' || config.mailTransport === 'gmail-smtp') && (config.googleRefreshToken || resolveRefreshToken(config, process.env))
        ? {
            kind: 'gmail_oauth',
            refreshToken: resolveRefreshToken(config, process.env)?.token ?? (config.googleRefreshToken as string),
            googleClientSecret: config.googleClientSecret,
          }
        : null;

  return addAccount(db, config, {
    email: config.fromEmail,
    label: opts.label ?? null,
    transport: config.mailTransport,
    fromName: config.fromName ?? null,
    selfOpenStrategy: config.selfOpenStrategy,
    recipientMode: config.recipientMode,
    config: {
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpSecure: config.smtpSecure,
      smtpUser: config.smtpUser,
      gmailSmtpHost: config.gmailSmtpHost,
      gmailSmtpPort: config.gmailSmtpPort,
      imapHost: config.imapHost,
      imapSentMailbox: config.imapSentMailbox,
      googleClientId: config.googleClientId,
    },
    secret,
    makeDefault: opts.makeDefault,
    origin: 'env',
  });
}

/** Re-encrypts every account secret under `newKey`, in one transaction, verifying each round-trip
 *  before commit - a single failure rolls the whole thing back and leaves `oldKey` valid. */
export function rotateMasterKey(db: DB, oldKey: MasterKey, newKey: MasterKey): { reEncrypted: number } {
  const rows = db.prepare('SELECT id, secret_kind, secret_ciphertext FROM accounts WHERE secret_ciphertext IS NOT NULL').all() as Array<{
    id: string;
    secret_kind: string;
    secret_ciphertext: string;
  }>;
  let count = 0;
  const tx = db.transaction(() => {
    for (const row of rows) {
      const aad = secretAad(row.id, row.secret_kind);
      const plaintext = openSecret(row.secret_ciphertext, oldKey.key, aad);
      const resealed = seal(plaintext, newKey.key, aad);
      // Verify the round-trip before trusting it.
      const verify = openSecret(resealed, newKey.key, aad);
      if (verify !== plaintext) throw new Error(`round-trip verification failed for account ${row.id}`);
      db.prepare('UPDATE accounts SET secret_ciphertext = ? WHERE id = ?').run(resealed, row.id);
      count += 1;
    }
    // Finding #11: keep the recorded fingerprint in step with reality - after this transaction
    // commits, every secret is sealed under `newKey`, so the setting must say so. Written inside
    // the same transaction as the re-encryption itself: a rollback (the round-trip check above
    // throwing) must never leave the fingerprint pointing at a key that isn't actually in use.
    setSetting(db, 'master_key_fingerprint', keyFingerprint(newKey.key));
    audit(db, {
      actor: 'cli',
      action: 'account.rotate-key',
      detail: { reEncrypted: count, oldKeyFingerprint: keyFingerprint(oldKey.key), newKeyFingerprint: keyFingerprint(newKey.key) },
    });
  });
  tx();
  return { reEncrypted: count };
}

/** Kept for the pre-Phase-4 call signature: identical to `resolveTransportForAccount(envAccount)`. */
export function resolveTransportForAccount(account: ResolvedAccount, config: AppConfig): Transport {
  if (account.isEnvFallback) {
    return resolveTransport(config);
  }
  const secret = account.secret();
  const effective: AppConfig = {
    ...config,
    mailTransport: account.transport,
    fromEmail: account.email,
    fromName: account.fromName ?? undefined,
    smtpHost: account.config.smtpHost ?? config.smtpHost,
    smtpPort: account.config.smtpPort ?? config.smtpPort,
    smtpSecure: account.config.smtpSecure ?? config.smtpSecure,
    smtpUser: account.config.smtpUser ?? config.smtpUser,
    smtpPass: secret.kind === 'app_password' ? secret.appPassword : config.smtpPass,
    gmailSmtpHost: account.config.gmailSmtpHost ?? config.gmailSmtpHost,
    gmailSmtpPort: account.config.gmailSmtpPort ?? config.gmailSmtpPort,
    googleClientId: account.config.googleClientId ?? config.googleClientId,
    googleClientSecret: secret.kind === 'gmail_oauth' ? (secret.googleClientSecret ?? config.googleClientSecret) : config.googleClientSecret,
    googleRefreshToken: secret.kind === 'gmail_oauth' ? secret.refreshToken : config.googleRefreshToken,
    imapHost: account.config.imapHost ?? config.imapHost,
    imapSentMailbox: account.config.imapSentMailbox ?? config.imapSentMailbox,
  };
  return resolveTransport(effective);
}

export function touchLastUsed(db: DB, accountId: string, nowMs: number): void {
  try {
    db.prepare('UPDATE accounts SET last_used_at = ? WHERE id = ?').run(nowMs, accountId);
  } catch {
    // Never fail a send over bookkeeping (§3.4).
  }
}
