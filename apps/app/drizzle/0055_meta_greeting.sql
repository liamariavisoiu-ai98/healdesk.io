-- =============================================================================
-- The first reply of each Meta conversation opens with the greeting (BAA
-- 1.3.0, "What healdesk is not authorised to do": "Its first reply in each
-- conversation says that it is an AI assistant and that the channel is not
-- secure"; docs/counsel/agreement-changes.md §12.14, release gate 4, PT-13).
--
-- Nothing stored told a first reply from a later one on a thread that never
-- reached a booking draft or request. chat_threads (0043) already is the
-- per-thread record of a conversation: one row per person per channel, keyed
-- by an HMAC of the sender id, with a conversation id that is regenerated
-- when a message arrives more than 24 hours after the newest one before it
-- (the owner's definition of a conversation, 5 October 2026, and Meta's own
-- window). The column below records the conversation whose first reply has
-- carried the greeting, so a reply in any other conversation opens with it.
--
-- A conversation, not a flag: the mark is written only once the reply that
-- carries the greeting has been sent, so a first message withheld, a reply
-- dropped outside Meta's 24-hour window, or one whose send failed, leaves the
-- greeting owed to the next reply in that conversation instead of marking it
-- given. No grant changes: the runtime role's table-level SELECT, INSERT and
-- UPDATE on chat_threads (0043) reach the new column, and the table's tenant
-- policy covers it.
-- =============================================================================
ALTER TABLE "chat_threads" ADD COLUMN "greeted_conversation_id" uuid;--> statement-breakpoint
COMMENT ON COLUMN chat_threads.greeted_conversation_id IS
  'The conversation whose first reply has carried the channel''s opening line (metaChannelGreeting on Meta). A reply in any other conversation opens with it; null means none has gone out. Written once the reply has been sent, in the transaction it was sent in (lib/meta/greeting.ts).';
