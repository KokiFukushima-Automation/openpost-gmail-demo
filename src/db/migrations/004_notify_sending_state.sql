-- 004_notify_sending_state.sql (schema_version = 4)
--
-- Phase 2.1 hardening, finding #6: a claimed-but-not-yet-resolved notification is now visibly
-- `status = 'sending'` (rather than staying `pending` with only its `next_attempt_at` lease pushed
-- forward), and records when it was claimed. This does not change delivery semantics on its own
-- (claimDue already leased rows so two workers could never double-send one), but it makes an
-- abandoned lease - a worker that crashed mid-delivery - visible to `notifications list`/`doctor`
-- instead of being indistinguishable from a row that simply hasn't been picked up yet.
ALTER TABLE notifications ADD COLUMN claimed_at INTEGER;
