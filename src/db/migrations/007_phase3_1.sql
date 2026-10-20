-- 007_phase3_1.sql (schema_version = 7)
--
-- docs/reports/phase3_review.md hardening pass ("Phase 3.1").

-- L10: markSkipped/markFailed both ignored their own `atMs` parameter - there was no column to
-- put it in. A reminder's terminal timestamp for these two outcomes is now recorded the same way
-- fired_at/cancelled_at already are.
ALTER TABLE reminders ADD COLUMN skipped_at INTEGER;
ALTER TABLE reminders ADD COLUMN failed_at  INTEGER;

-- M6: `idx_messages_created` (created_at DESC, from 005) cannot serve an
-- `ORDER BY COALESCE(sent_at, created_at)` - the dashboard message list's default sort and the
-- export's ORDER BY both sort on that expression, not on created_at alone. An expression index
-- lets SQLite use it for both the sort and the `WHERE COALESCE(sent_at, created_at) BETWEEN ...`
-- filters (query.ts's since/until, stats.ts's window).
CREATE INDEX idx_messages_sent_or_created ON messages(COALESCE(sent_at, created_at) DESC);
