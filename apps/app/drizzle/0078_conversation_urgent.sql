ALTER TABLE "conversations" ADD COLUMN "urgent" boolean DEFAULT false NOT NULL;--> statement-breakpoint

-- =============================================================================
-- Urgent, told apart from a handover (package G, 14 October 2026). The
-- statement above was generated from schema.ts; everything below is the part
-- drizzle cannot express.
--
-- The Conversations screen shows each conversation's outcome: answered,
-- booked, request, handover or urgent (spec, "Portal map"; plan Part F4). The
-- voice ingest and web chat both record an urgent hit and a request for a
-- person as the one outcome `escalated_to_human`, and nothing else keeps
-- which it was: the urgent alert (lib/notices/booking-alerts.ts) records
-- nothing yet, and the audit rows name no conversation. So the narrowest
-- record is this flag, written by the same writers in the same statement as
-- the outcome. A handover is `escalated_to_human` without it. Rows written
-- before today read false: on them an urgent hit shows as a handover, which
-- still sends staff to the conversation.
--
-- 0064 holds the runtime role to a column list for UPDATE on conversations
-- (every column but started_at), and web chat sets the flag on the row it
-- updates at each message, so the new column joins that list. INSERT is
-- table-wide already. No new table, so no policy, grant on a table, BAA gate,
-- destruction or purge change: the column goes with its row.
--
-- Safe to apply in place: one column with a constant default, which Postgres
-- adds without rewriting the table, and one column grant. apps/app has only
-- ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

GRANT UPDATE (urgent) ON conversations TO healdesk_app;
