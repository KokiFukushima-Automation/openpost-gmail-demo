# Multiple sending accounts

An install with **zero** CLI-added accounts behaves byte-identically to the pre-Phase-4 tree,
sending from `FROM_EMAIL`/`MAIL_TRANSPORT`/env exactly as before. Adding accounts is a pure
addition, never a migration you're required to perform.

## Adding an account

```bash
openpost accounts init-key                       # generates the master key that encrypts secrets
printf 'app-password-here' | openpost accounts add \
  --email work@example.com --label work --transport smtp \
  --smtp-host smtp.example.com --smtp-port 587 --app-password-stdin --default
openpost accounts list
openpost accounts show work           # never prints the secret - kind + fingerprint + age only
```

Secrets are read from **stdin only** (`--app-password-stdin` / `--refresh-token-stdin`) - never
from an argv flag, which would be visible to anyone who can run `ps` on the host.

## Secrets at rest

Every secret is stored as `op.sb.v1.<salt>.<nonce>.<ciphertext+tag>`: scrypt (`N=2^15, r=8, p=1`)
derives a per-secret key from the master key and a random 16-byte salt, then AES-256-GCM (random
12-byte nonce) seals the plaintext, with the AEAD's associated data bound to
`(accountId, field)` - a ciphertext copied from one account row (or field) into another fails to
authenticate instead of silently decrypting. All of this is Node's `node:crypto` standard library;
no new dependency.

The master key comes from `OPENPOST_MASTER_KEY` (base64/hex, ≥ 32 bytes decoded) or a keyfile at
`OPENPOST_MASTER_KEY_FILE` (default `${OPENPOST_CONFIG_DIR}/master.key`), which **must** be mode
`0600` - a looser mode is refused with a named error and a `chmod 600` remedy, not a silent security
hole. `openpost accounts init-key` generates and writes it correctly the first time. Its own
fingerprint (never the key itself) is recorded in `settings.master_key_fingerprint` the first time
it seals an account secret, and checked by `openpost doctor` on every run afterward - a fingerprint
mismatch fails loudly, naming both fingerprints, instead of surfacing later as an opaque per-account
decrypt failure.

> **Phase 4.1 migration note (finding #14):** the key decoder used to try base64 first for
> *every* input - since every hex digit is also a valid base64 character, a 64-character hex key
> silently decoded as base64 into 48 different bytes (truncated to 32), so the documented hex form
> never actually worked as intended. Phase 4.1 fixed this: a key is now decoded as hex only when it
> is exactly 64 hex characters, and as base64 otherwise (and only when it actually has base64's own
> shape). **This is a breaking change for any key that was previously supplied in hex form** - the
> bytes it decodes to are now different (and correct) rather than the old, wrong ones. No accounts
> shipped with real secrets before this fix landed, so there is nothing to migrate in practice; if
> you supplied `OPENPOST_MASTER_KEY`/a keyfile as hex before upgrading, regenerate it with
> `openpost accounts init-key --force` and re-add any accounts rather than assuming the old value
> still decodes to the same key.

```bash
openpost accounts rotate-key --new-key-file ./new-master.key
```

re-encrypts every stored secret under the new key inside one transaction, verifying each
round-trip before committing - a single failure rolls the whole rotation back and leaves the old
key working.

## Using an account

```bash
openpost send --to a@example.com --subject hi --html '<p>hi</p>' --from-account work
openpost campaign create ... --from-account work
```

`--from-account <ref>` matches by id, label, or email. `--transport` on the command line still
overrides the account's own stored transport for that one call. Without `--from-account`, the
`is_default` account (if any) is used; without any accounts at all, the env fallback is used - this
is what makes multi-account additive.

## Removing an account

`messages.account_id` cascades on delete, so removing an account is deliberately conservative:

```bash
openpost accounts remove work                     # disables: secret zeroed, message history kept
openpost accounts enable work                      # re-enables it
openpost accounts remove work --purge --yes        # the ONLY destructive path - prints exact counts first
```

`--purge` without `--yes` refuses. With both, it prints `"this will delete N messages, M
recipients, K events"`, writes an address-free audit row with those counts, and only then deletes.

## Migrating from the single-account env config

```bash
openpost accounts import-env --label primary --default
```

Materialises `FROM_EMAIL`/`FROM_NAME`/`MAIL_TRANSPORT`/`SELF_OPEN_STRATEGY`/`RECIPIENT_MODE` and
the SMTP/Gmail credentials your `.env` already has into an encrypted `accounts` row. It never edits
`.env` and never deletes the on-disk Gmail token store - verify the new account works, then clean
those up yourself if you want to.

## Why accounts are CLI-only

There is no accounts page in the web dashboard, on purpose. Adding one means a web form that
accepts a password or refresh token, over a session whose threat model was written for a
read-mostly UI, on a port operators do sometimes bind off loopback. `openpost doctor` reports
account health (default set, secrets decryptable, keyfile mode); the CLI manages them; the
dashboard never sees a secret, not even to write one.

## CLI reference

```
openpost accounts add --email <addr> [--label <l>] [--transport <name>] [--from-name <n>]
        [--self-open-strategy window|insert|imap-append] [--recipient-mode auto|per-recipient|single]
        [--smtp-host <h>] [--smtp-port <n>] [--smtp-secure] [--smtp-user <u>]
        [--app-password-stdin | --refresh-token-stdin | --no-secret] [--default] [--json]
openpost accounts list [--json]
openpost accounts show <ref> [--json]
openpost accounts default <ref>
openpost accounts enable  <ref>
openpost accounts remove  <ref> [--purge --yes] [--reassign <ref>]
openpost accounts import-env [--label <l>] [--default] [--json]
openpost accounts init-key [--path <p>] [--force]
openpost accounts rotate-key --new-key-file <p> [--json]
```
