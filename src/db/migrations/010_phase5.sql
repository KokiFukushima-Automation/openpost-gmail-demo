-- 010_phase5.sql (schema_version = 10)
--
-- docs/09_phase5_spec.md. Mobile: Web Push subscriptions, a provenance column on messages, and the
-- Gmail add-on's draft back-reference. Every statement is a CREATE or an ADD COLUMN with a default,
-- so a populated v9 database upgrades with zero row loss and no table rebuild.

-- ---------- Web Push subscriptions (§4.3) ---------------------------------
-- These rows describe the OPERATOR's own devices, never a recipient: `openpost forget` deliberately
-- does not touch this table (test asserts that, so the omission reads as a decision).
CREATE TABLE push_subscriptions (
  id              TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  label           TEXT,
  ua_family       TEXT,
  device_type     TEXT,
  created_at      INTEGER NOT NULL,
  last_ok_at      INTEGER,
  last_error      TEXT,
  failure_count   INTEGER NOT NULL DEFAULT 0,
  disabled_at     INTEGER,
  disabled_reason TEXT                      -- gone_404 | gone_410 | manual | expired
);
CREATE INDEX idx_push_subs_active ON push_subscriptions(disabled_at) WHERE disabled_at IS NULL;

-- ---------- message provenance (§2, §6) -----------------------------------
-- cli | campaign | dashboard | addon.  Existing rows are 'cli' (or 'campaign' where campaign_id is
-- set), which is exactly what they were.
ALTER TABLE messages ADD COLUMN source         TEXT NOT NULL DEFAULT 'cli';
ALTER TABLE messages ADD COLUMN addon_draft_id TEXT;
UPDATE messages SET source = 'campaign' WHERE campaign_id IS NOT NULL;
CREATE INDEX idx_messages_source ON messages(source, created_at DESC);
