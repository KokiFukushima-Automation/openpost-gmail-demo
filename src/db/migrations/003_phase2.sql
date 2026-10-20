-- 003_phase2.sql (schema_version = 3)
--
-- Deviation from docs/05_phase2_spec.md §7.1: the spec's SQL below is written as "migration 002",
-- against a pre-hardening tree where 002 did not yet exist. This tree already shipped
-- 002_recipient_cache_buster.sql (schema_version = 2, Phase 1.1 finding #16), so this file is
-- renumbered 003 (schema_version = 3) and does NOT re-add `recipients.cache_buster` (already
-- present). Every other statement is unchanged from the spec's intent.

-- click events reach parity with open events (explainability + privacy redaction)
ALTER TABLE click_events ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;
ALTER TABLE click_events ADD COLUMN reason TEXT;
ALTER TABLE click_events ADD COLUMN region TEXT;
ALTER TABLE click_events ADD COLUMN city TEXT;

-- manual reclassification
ALTER TABLE open_events  ADD COLUMN original_classification TEXT;
ALTER TABLE open_events  ADD COLUMN overridden_at INTEGER;
ALTER TABLE click_events ADD COLUMN original_classification TEXT;
ALTER TABLE click_events ADD COLUMN overridden_at INTEGER;

-- per-recipient send bookkeeping (Phase 1 sent per recipient but stored only the first ids)
ALTER TABLE recipients ADD COLUMN provider_msg_id TEXT;
ALTER TABLE recipients ADD COLUMN thread_id       TEXT;
ALTER TABLE recipients ADD COLUMN rfc822_msg_id   TEXT;
ALTER TABLE recipients ADD COLUMN sent_at         INTEGER;
ALTER TABLE recipients ADD COLUMN state           TEXT NOT NULL DEFAULT 'not_opened';
ALTER TABLE recipients ADD COLUMN notify_muted    INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_recipients_state ON recipients(state);

-- self-copy + mute bookkeeping
ALTER TABLE messages ADD COLUMN self_copy_strategy TEXT;
ALTER TABLE messages ADD COLUMN self_copy_msg_id   TEXT;
ALTER TABLE messages ADD COLUMN notify_muted       INTEGER NOT NULL DEFAULT 0;

-- back-fill the materialised state for existing rows
UPDATE recipients SET state = CASE
  WHEN open_count = 0 AND machine_open_count = 0 THEN 'not_opened'
  WHEN open_count = 0                            THEN 'prefetched'
  WHEN click_count > 0                           THEN 'read_confirmed'
  WHEN open_count >= 2 AND COALESCE(last_open_at,0) - COALESCE(first_open_at,0) > 60000
                                                 THEN 'read_confirmed'
  ELSE 'opened' END;
UPDATE recipients SET sent_at = (SELECT m.sent_at FROM messages m WHERE m.id = recipients.message_id);

-- notification queue (the 001 stub was never read or written by any Phase 1 code, so dropping it
-- loses nothing - verified by grep before this migration was written)
DROP TABLE notifications;
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  trigger         TEXT NOT NULL,       -- first_open | read_confirmed | click | prefetched
  channel         TEXT NOT NULL,       -- slack | discord | webhook | ntfy
  message_id      TEXT REFERENCES messages(id)   ON DELETE CASCADE,
  recipient_id    TEXT REFERENCES recipients(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,       -- open | click
  event_id        TEXT,
  dedupe_key      TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  status          TEXT NOT NULL,       -- pending | sent | failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  sent_at         INTEGER
);
CREATE UNIQUE INDEX idx_notifications_dedupe ON notifications(dedupe_key);
CREATE INDEX idx_notifications_due   ON notifications(status, next_attempt_at);
CREATE INDEX idx_notifications_recip ON notifications(recipient_id);

-- notification_dead_letters.recipient_id carries no FK on purpose (it must survive the
-- notification row's own ON DELETE CASCADE) - `forget` deletes by it explicitly.
CREATE TABLE notification_dead_letters (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL,
  recipient_id    TEXT,
  channel         TEXT NOT NULL,
  trigger         TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  attempts        INTEGER NOT NULL,
  last_error      TEXT,
  failed_at       INTEGER NOT NULL
);
CREATE INDEX idx_dead_letters_failed ON notification_dead_letters(failed_at DESC);

CREATE TABLE ip_range_sets (
  name        TEXT PRIMARY KEY,        -- apple_relay | google_proxy | datacenter
  source_url  TEXT,
  generated_at INTEGER,
  updated_at  INTEGER NOT NULL,
  entry_count INTEGER NOT NULL,
  sha256      TEXT NOT NULL
);
