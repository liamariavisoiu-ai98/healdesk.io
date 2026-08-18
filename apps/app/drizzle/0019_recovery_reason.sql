-- =============================================================================
-- Recovery becomes a reason, not a boolean.
--
-- `is_recovered_missed_call` recorded exactly one way a contact can be
-- recovered: the number rang out and we called it back. The monthly report
-- counted that and nothing else, which understated the product in the most
-- visible way possible — a 9pm call the agent answered live scored zero, even
-- though "nobody was ever going to answer that" is the clearest version of what
-- customers buy this for.
--
-- The type in attribution/estimate.ts had described the broader definition all
-- along ("after-hours, simultaneous calls, or an automatic callback"). This
-- migration makes the schema able to express it.
--
-- Null still means NOT recovered, and remains the default. The protection
-- against overstating moves to ingestion, where the facts are: a reason is
-- recorded only when the clinic genuinely would not have handled the contact.
-- A call that was answered and simply didn't book is not recovery.
-- =============================================================================

CREATE TYPE "public"."recovery_reason" AS ENUM(
  'after_hours',
  'line_busy',
  'rang_unanswered',
  'missed_call_callback'
);--> statement-breakpoint

ALTER TABLE "conversations" ADD COLUMN "recovery_reason" "recovery_reason";--> statement-breakpoint

-- Backfill before dropping the source column, so no history changes meaning.
-- Every existing true was, by the old definition, a callback — the other three
-- reasons had no way to be recorded, so none can be inferred retroactively and
-- none is invented here.
UPDATE conversations
   SET recovery_reason = 'missed_call_callback'
 WHERE is_recovered_missed_call = true;--> statement-breakpoint

ALTER TABLE "conversations" DROP COLUMN "is_recovered_missed_call";--> statement-breakpoint

COMMENT ON COLUMN conversations.recovery_reason IS
  'Why this contact would have been lost without us; null means the clinic would have handled it anyway and we make no claim. Counted as recovered by the monthly report when non-null. Set at ingestion, never inferred later.';
