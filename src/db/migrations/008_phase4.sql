-- 008_phase4.sql (schema_version = 8)
--
-- docs/08_phase4_spec.md. Numbering deviation from the spec's own text: the spec was written
-- against a tree at schema 6 and calls this migration "007_phase4.sql". A Phase 3.1 hardening pass
-- landed first as 007_phase3_1.sql (schema 7), so this migration is 008 and EXPECTED_SCHEMA becomes
-- 8. Nothing here drops or rewrites an existing table: every statement is an ADD COLUMN, a CREATE,
-- or a bounded UPDATE, so a populated v7 database upgrades with zero row loss.

-- ---------- multi-account -------------------------------------------------
ALTER TABLE accounts ADD COLUMN label              TEXT;
ALTER TABLE accounts ADD COLUMN from_name          TEXT;
ALTER TABLE accounts ADD COLUMN status             TEXT    NOT NULL DEFAULT 'active';  -- active | disabled
ALTER TABLE accounts ADD COLUMN is_default         INTEGER NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN origin             TEXT    NOT NULL DEFAULT 'legacy';  -- legacy | cli | env
ALTER TABLE accounts ADD COLUMN self_open_strategy TEXT;                                -- NULL = inherit env
ALTER TABLE accounts ADD COLUMN recipient_mode     TEXT;                                -- NULL = inherit env
ALTER TABLE accounts ADD COLUMN config_json        TEXT    NOT NULL DEFAULT '{}';       -- non-secret transport bits
ALTER TABLE accounts ADD COLUMN secret_kind        TEXT;                                -- app_password | gmail_oauth
ALTER TABLE accounts ADD COLUMN secret_ciphertext  TEXT;                                -- op.sb.v1.<salt>.<nonce>.<ct||tag>
ALTER TABLE accounts ADD COLUMN secret_scopes      TEXT;
ALTER TABLE accounts ADD COLUMN secret_updated_at  INTEGER;
ALTER TABLE accounts ADD COLUMN last_used_at       INTEGER;

CREATE UNIQUE INDEX idx_accounts_label   ON accounts(label)      WHERE label IS NOT NULL;
CREATE UNIQUE INDEX idx_accounts_default ON accounts(is_default) WHERE is_default = 1;

-- The oldest existing account becomes the default, so a pre-Phase-4 install already resolves one.
UPDATE accounts SET is_default = 1
 WHERE id = (SELECT id FROM accounts ORDER BY created_at ASC, id ASC LIMIT 1);

-- ---------- campaigns ----------------------------------------------------
CREATE TABLE campaigns (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  account_id            TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status                TEXT NOT NULL,          -- draft|running|paused|completed|cancelled|failed
  subject_template      TEXT NOT NULL,
  subject_variants_json TEXT,                   -- [{key,template,weight}, …]; NULL = single variant
  body_html_template    TEXT NOT NULL,
  body_text_template    TEXT,
  allow_raw             INTEGER NOT NULL DEFAULT 0,
  from_email            TEXT NOT NULL,
  from_name             TEXT,
  transport             TEXT NOT NULL,
  track                 INTEGER NOT NULL DEFAULT 1,
  track_clicks          INTEGER NOT NULL DEFAULT 1,
  dry_run               INTEGER NOT NULL DEFAULT 0,
  rate_per_minute       INTEGER NOT NULL,
  jitter_ms             INTEGER NOT NULL,
  daily_cap             INTEGER NOT NULL,
  email_column          TEXT NOT NULL,
  columns_json          TEXT NOT NULL,          -- header order, for preview and export
  csv_path              TEXT,
  csv_sha256            TEXT,
  total_rows            INTEGER NOT NULL DEFAULT 0,
  digest_window_minutes INTEGER NOT NULL DEFAULT 60,
  digest_next_at        INTEGER,
  digest_from           INTEGER,
  created_at            INTEGER NOT NULL,
  started_at            INTEGER,
  paused_at             INTEGER,
  cancelled_at          INTEGER,
  finished_at           INTEGER,
  last_error            TEXT,
  created_by            TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX idx_campaigns_status  ON campaigns(status, created_at DESC);
CREATE INDEX idx_campaigns_account ON campaigns(account_id);
CREATE INDEX idx_campaigns_digest  ON campaigns(status, digest_next_at);

CREATE TABLE campaign_rows (
  id                TEXT PRIMARY KEY,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  row_index         INTEGER NOT NULL,
  email             TEXT NOT NULL,
  vars_json         TEXT NOT NULL,
  variant           TEXT NOT NULL DEFAULT 'A',
  status            TEXT NOT NULL,              -- pending|claimed|sent|skipped|failed
  attempts          INTEGER NOT NULL DEFAULT 0,
  lease_owner       TEXT,
  lease_expires_at  INTEGER,
  claimed_at        INTEGER,
  submit_started_at INTEGER,                    -- journalled BEFORE the transport call
  message_id        TEXT REFERENCES messages(id)   ON DELETE SET NULL,
  recipient_id      TEXT REFERENCES recipients(id) ON DELETE SET NULL,
  skip_reason       TEXT,                       -- suppressed|opted_out|invalid_address|duplicate_in_csv|missing_vars|unsafe_href|erased
  last_error        TEXT,
  sent_at           INTEGER,
  created_at        INTEGER NOT NULL,
  UNIQUE(campaign_id, row_index)
);
CREATE INDEX idx_campaign_rows_claim ON campaign_rows(campaign_id, status, row_index);
CREATE INDEX idx_campaign_rows_lease ON campaign_rows(status, lease_expires_at);
CREATE INDEX idx_campaign_rows_msg   ON campaign_rows(message_id);
-- One live row per address per campaign; skipped duplicates are kept so the operator can see them.
CREATE UNIQUE INDEX idx_campaign_rows_addr ON campaign_rows(campaign_id, email) WHERE status <> 'skipped';

-- ---------- back-references ---------------------------------------------
ALTER TABLE messages      ADD COLUMN campaign_id TEXT REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX idx_messages_campaign ON messages(campaign_id, created_at DESC);
-- No FK: a notification must survive its campaign's deletion long enough to be reported on.
ALTER TABLE notifications ADD COLUMN campaign_id TEXT;
CREATE INDEX idx_notifications_campaign ON notifications(campaign_id, created_at DESC);
