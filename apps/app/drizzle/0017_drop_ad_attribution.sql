-- =============================================================================
-- Remove the ad-click stage entirely.
--
-- `ad_interactions` held gclid/fbclid click ids, and `conversations` joined to
-- it, so a patient's phone call could be traced back to the ad that produced it
-- and the conversion pushed to Meta or Google.
--
-- That capability is out of scope — removed, not deferred, and not a paid
-- add-on. The reasoning, in short:
--
--   · A row linking a patient conversation to a Meta click id is person-level
--     health data. That is the GoodRx ($1.5M) and BetterHelp ($7.8M) fact
--     pattern precisely, and neither company was hacked.
--   · The 2024 HBNR amendment makes the unauthorised disclosure ITSELF the
--     reportable breach, so holding the join was the exposure.
--   · Hashing does not help: a hashed email is one of HIPAA's 18 identifiers,
--     hashed so it can be matched.
--   · Meta's Business Tools Terms §1.h bans health data outright, so even a
--     lawful transmission could break the clinic's own Meta contract and
--     disable their ad account.
--
-- Revenue reporting survives this and is unaffected: it reconciles the POS
-- money event and reports back to the clinic itself. Nothing leaves for a third
-- party. See src/lib/attribution.
--
-- Dropping the table also drops its RLS policy (0002), its indexes (0000), and
-- the grants in 0003 — Postgres removes dependent objects with the table, so
-- those migrations need no amendment. The BAA gate in 0004 never applied here.
-- =============================================================================

-- The join first, so the FK is gone before its target. Dropping the column also
-- drops conversations_ad_idx, which was built on it.
DROP INDEX IF EXISTS "conversations_ad_idx";--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN IF EXISTS "ad_interaction_id";--> statement-breakpoint

DROP TABLE IF EXISTS "ad_interactions";--> statement-breakpoint

COMMENT ON TABLE conversations IS
  'Patient conversations. Deliberately carries NO advertising identifier: the ad_interaction_id join was dropped in 0017 because linking a patient conversation to a click id is person-level health data. Do not reintroduce one without counsel.';
