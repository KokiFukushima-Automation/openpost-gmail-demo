-- 009_phase4_1.sql (schema_version = 9)
--
-- Phase 4.1 hardening pass (docs/reports/phase4_review.md findings #2 and #3).
--
-- #2 (HIGH): suppressions.email was compared/written verbatim (BINARY collation, plain TEXT PRIMARY
-- KEY) while every other email-bearing write path (campaign CSV import,
-- findRecipientByMessageAndEmail, forget/erase) normalises to lower(trim(email)). A recipient who
-- unsubscribed via a non-campaign send (suppression row stored as e.g. "Alice@Example.com") was
-- therefore NOT suppressed for a later campaign whose CSV imports the same address lowercased -
-- preflightRow's `suppressions WHERE email = ?` simply never matched. This migration folds every
-- existing row down to its normalised form, keeping the EARLIEST row (by created_at, then rowid) as
-- the survivor when two rows normalise to the same address (case variants of one real opt-out), then
-- rebuilds the table with the email column COLLATE NOCASE as a second line of defence. Application
-- code (src/db/repo.ts's isSuppressed/addSuppression/getSuppressionReason) still normalises
-- explicitly with lower(trim(...)) on every read/write - NOCASE alone folds case but not whitespace.
--
-- #3 (HIGH): campaign_rows redacted an erased address to the literal string '(erased)', which
-- collides with idx_campaign_rows_addr's UNIQUE(campaign_id, email) WHERE status <> 'skipped' the
-- second time two non-skipped rows in the same campaign are erased - `openpost forget` then aborted
-- its entire transaction with a UNIQUE constraint violation, making the GDPR erasure path unusable
-- for any campaign with 2+ erased recipients. Rewrites any already-'(erased)' row (there should be
-- none in a pre-Phase-4.1 install, since forget on a second address never got this far, but this is
-- unconditionally safe either way) to a per-row-unique sentinel; src/db/campaigns.ts's
-- redactCampaignRowsForAddress now writes that same unique form going forward, so the collision
-- cannot recur regardless of what the index says.

-- ---------- #2: suppressions normalisation --------------------------------
CREATE TABLE suppressions_new (
  email       TEXT PRIMARY KEY COLLATE NOCASE,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

INSERT INTO suppressions_new (email, reason, created_at)
SELECT lower(trim(s.email)), s.reason, s.created_at
  FROM suppressions s
 WHERE s.rowid = (
   SELECT s2.rowid FROM suppressions s2
    WHERE lower(trim(s2.email)) = lower(trim(s.email))
    ORDER BY s2.created_at ASC, s2.rowid ASC
    LIMIT 1
 );

DROP TABLE suppressions;
ALTER TABLE suppressions_new RENAME TO suppressions;

-- ---------- #3: campaign_rows erase-sentinel uniqueness --------------------
UPDATE campaign_rows SET email = '(erased):' || id WHERE email = '(erased)';

-- ---------- #5: daily-cap auto-resume --------------------------------------
-- A campaign that hit CAMPAIGN_DAILY_CAP was set to status='paused', which createCampaignsJob's own
-- `WHERE status = 'running'` never selects again - the campaign stayed stuck until an operator ran
-- `campaign resume` by hand, contradicting the spec's "resumes automatically when the trailing
-- window drains". `capped_until` lets a capped campaign stay 'running' (so the drain job keeps
-- re-checking it every tick) while still recording, for the dashboard/CLI, the timestamp its own
-- sentInLastDay window is expected to drain by.
ALTER TABLE campaigns ADD COLUMN capped_until INTEGER;

-- ---------- #16: digest gaps -------------------------------------------------
-- A campaign created, run and completed entirely between two 60s digest ticks never had
-- digest_from set (only ever set by an earlier "still running" digest pass), so the old
-- `digest_from IS NOT NULL` requirement on the "just finished" query meant it NEVER got a final
-- digest at all. And that query's only duplicate guard was `NOT EXISTS (... dedupe_key LIKE
-- 'final:%')` against the notifications table - once retention purged that row, the final digest
-- for the same already-reported campaign could be enqueued again. final_digest_sent_at persists
-- "final digest handled" on the campaign row itself, independent of the notifications queue's own
-- retention.
ALTER TABLE campaigns ADD COLUMN final_digest_sent_at INTEGER;
