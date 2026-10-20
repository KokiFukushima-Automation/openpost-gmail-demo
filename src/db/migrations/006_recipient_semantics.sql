-- 006_recipient_semantics.sql (schema_version = 6)
--
-- docs/07_recipient_semantics.md §4.1: `is_aggregate` rather than a new `kind` value, so every
-- existing query and display that already switches on `kind` (to/cc/bcc) stays correct unchanged -
-- an aggregate row additionally carries `is_aggregate = 1` on top of whatever `kind` it was given.
--
-- No back-fill: every pre-006 message was one-copy-per-recipient (recipient_mode defaults to
-- 'per-recipient' for old rows). For pre-006 rows, messages.rfc822_msg_id keeps its old meaning -
-- "the first recipient's Message-ID" - since it was only ever computed once, from whichever
-- recipient happened to be sent first; from 006 on, for a per-recipient send with N > 1 recipients,
-- it is instead the synthetic thread root shared by every copy's References header.

ALTER TABLE messages   ADD COLUMN recipient_mode TEXT NOT NULL DEFAULT 'per-recipient';
ALTER TABLE recipients ADD COLUMN is_aggregate   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE recipients ADD COLUMN envelope_to    TEXT;

CREATE INDEX idx_recipients_aggregate ON recipients(message_id, is_aggregate);
