-- 001_init.sql (schema_version = 1)

CREATE TABLE accounts (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  transport     TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE messages (
  id                      TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject                 TEXT NOT NULL,
  body_html               TEXT,
  body_text               TEXT,
  thread_id               TEXT,
  provider_msg_id         TEXT,
  rfc822_msg_id           TEXT,
  status                  TEXT NOT NULL,
  tracking_enabled        INTEGER NOT NULL DEFAULT 1,
  click_tracking_enabled  INTEGER NOT NULL DEFAULT 0,
  sent_at                 INTEGER,
  created_at              INTEGER NOT NULL,
  error                   TEXT
);
CREATE INDEX idx_messages_account_sent ON messages(account_id, sent_at DESC);

CREATE TABLE recipients (
  id                  TEXT PRIMARY KEY,
  message_id          TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  name                TEXT,
  kind                TEXT NOT NULL DEFAULT 'to',
  token               TEXT NOT NULL UNIQUE,
  open_count          INTEGER NOT NULL DEFAULT 0,
  machine_open_count  INTEGER NOT NULL DEFAULT 0,
  first_open_at       INTEGER,
  last_open_at        INTEGER,
  click_count         INTEGER NOT NULL DEFAULT 0,
  first_click_at      INTEGER,
  replied_at          INTEGER,
  opted_out_at        INTEGER,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_recipients_message ON recipients(message_id);
CREATE INDEX idx_recipients_email ON recipients(email);

CREATE TABLE open_events (
  id              TEXT PRIMARY KEY,
  recipient_id    TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  occurred_at     INTEGER NOT NULL,
  classification  TEXT NOT NULL,
  confidence      REAL NOT NULL,
  counted         INTEGER NOT NULL,
  reason          TEXT,
  ip_hash         TEXT,
  ip_net_hash     TEXT,
  ua              TEXT,
  ua_family       TEXT,
  device_type     TEXT,
  os              TEXT,
  country         TEXT,
  region          TEXT,
  city            TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_open_events_recipient_time ON open_events(recipient_id, occurred_at DESC);
CREATE INDEX idx_open_events_time ON open_events(occurred_at DESC);

CREATE TABLE links (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  label       TEXT,
  position    INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_links_message ON links(message_id);

CREATE TABLE click_tokens (
  id            TEXT PRIMARY KEY,
  link_id       TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  recipient_id  TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  UNIQUE(link_id, recipient_id)
);
CREATE INDEX idx_click_tokens_recipient ON click_tokens(recipient_id);

CREATE TABLE click_events (
  id              TEXT PRIMARY KEY,
  link_id         TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  recipient_id    TEXT NOT NULL REFERENCES recipients(id) ON DELETE CASCADE,
  occurred_at     INTEGER NOT NULL,
  classification  TEXT NOT NULL,
  counted         INTEGER NOT NULL,
  ip_hash         TEXT,
  ip_net_hash     TEXT,
  ua              TEXT,
  ua_family       TEXT,
  device_type     TEXT,
  os              TEXT,
  country         TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_click_events_recipient ON click_events(recipient_id, occurred_at DESC);

CREATE TABLE suppressions (
  email       TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  event_type  TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  channel     TEXT NOT NULL,
  status      TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  created_at  INTEGER NOT NULL,
  sent_at     INTEGER
);

CREATE TABLE reminders (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient_id  TEXT REFERENCES recipients(id) ON DELETE CASCADE,
  condition     TEXT NOT NULL,
  due_at        INTEGER NOT NULL,
  state         TEXT NOT NULL,
  fired_at      INTEGER,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_reminders_due ON reminders(state, due_at);

CREATE TABLE jobs (
  name          TEXT PRIMARY KEY,
  last_run_at   INTEGER,
  last_status   TEXT,
  last_error    TEXT
);

CREATE TABLE audit_log (
  id            TEXT PRIMARY KEY,
  at            INTEGER NOT NULL,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  subject_type  TEXT,
  subject_id    TEXT,
  detail_json   TEXT
);
CREATE INDEX idx_audit_at ON audit_log(at DESC);

CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);
