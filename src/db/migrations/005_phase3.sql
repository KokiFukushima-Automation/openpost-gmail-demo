-- 005_phase3.sql (schema_version = 5)
--
-- Deviation from docs/06_phase3_spec.md §6.2: the spec's own header notes it was written against a
-- pre-hardening tree where this would have been migration "004" (EXPECTED_SCHEMA 4). This tree
-- already shipped 004_notify_sending_state.sql (Phase 2.1, finding #6), so this file is renumbered
-- 005 and `EXPECTED_SCHEMA` becomes 5; every other statement is unchanged from the spec's intent.
--
-- The `reminders` table created by 001_init.sql was never read or written by any Phase 1/2/2.1 code
-- (grep-verified before this migration was written), exactly like the `notifications` stub that 003
-- replaced, so dropping and rebuilding it cannot lose data.

DROP TABLE reminders;
CREATE TABLE reminders (
  id                 TEXT PRIMARY KEY,
  message_id         TEXT NOT NULL REFERENCES messages(id)   ON DELETE CASCADE,
  recipient_id       TEXT          REFERENCES recipients(id) ON DELETE CASCADE,
  condition          TEXT NOT NULL,          -- no_reply | no_open | always
  due_at             INTEGER NOT NULL,
  status             TEXT NOT NULL,          -- pending | claimed | fired | skipped | cancelled | failed
  attempts           INTEGER NOT NULL DEFAULT 0,
  lease_owner        TEXT,
  lease_expires_at   INTEGER,
  claimed_at         INTEGER,
  fired_at           INTEGER,
  cancelled_at       INTEGER,
  cancel_reason      TEXT,                   -- replied | opened | manual | message_deleted
  last_error         TEXT,
  note               TEXT,
  draft              INTEGER NOT NULL DEFAULT 0,
  draft_subject      TEXT,
  draft_body_html    TEXT,
  draft_attempted_at INTEGER,                -- written BEFORE the Gmail call (at-most-once, §3.4)
  draft_id           TEXT,
  draft_thread_id    TEXT,
  draft_status       TEXT,                   -- created | uncertain | failed | skipped
  created_at         INTEGER NOT NULL,
  created_by         TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX idx_reminders_due       ON reminders(status, due_at);
CREATE INDEX idx_reminders_recipient ON reminders(recipient_id, status);
CREATE INDEX idx_reminders_message   ON reminders(message_id);

-- reply detection bookkeeping (per recipient; thread_id/rfc822_msg_id already exist from 003)
ALTER TABLE recipients ADD COLUMN reply_checked_at  INTEGER;
ALTER TABLE recipients ADD COLUMN reply_check_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipients ADD COLUMN reply_msg_id      TEXT;
CREATE INDEX idx_recipients_reply_watch ON recipients(replied_at, sent_at);

-- `replied` becomes a first-class state; keep any hand-set replied_at consistent
UPDATE recipients SET state = 'replied' WHERE replied_at IS NOT NULL;

-- dashboard/report query support
CREATE INDEX idx_messages_created   ON messages(created_at DESC);
CREATE INDEX idx_audit_action_at    ON audit_log(action, at DESC);
