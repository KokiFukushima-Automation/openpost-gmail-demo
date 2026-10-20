-- 002_recipient_cache_buster.sql (schema_version = 2)
-- Persists each recipient's pixel cache-buster instead of minting a fresh one on every read
-- (Phase 1 review finding #16), so the pixel URL reported by `show`/`/api` is stable.

ALTER TABLE recipients ADD COLUMN cache_buster TEXT;
