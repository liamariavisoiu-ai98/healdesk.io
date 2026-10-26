ALTER TABLE "support_messages" DROP CONSTRAINT "support_messages_send_check";--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_send_check" CHECK (("support_messages"."kind" = 'reply' or ("support_messages"."reply_subject" is null and "support_messages"."approved_hash" is null and "support_messages"."send_attempts" = 0 and "support_messages"."next_send_at" is null and "support_messages"."send_stopped_at" is null and "support_messages"."text_delete_after" is null)) and "support_messages"."send_attempts" between 0 and 6 and ("support_messages"."approved_hash" is null or "support_messages"."approved_hash" ~ '^[0-9a-f]{64}$') and ("support_messages"."reply_subject" is null or char_length("support_messages"."reply_subject") between 1 and 200) and ("support_messages"."send_stopped_at" is null) = ("support_messages"."send_stopped_reason" is null) and ("support_messages"."send_stopped_reason" is null or "support_messages"."send_stopped_reason" in ('dead', 'case_closed', 'clinic_left')) and not ("support_messages"."send_stopped_at" is not null and "support_messages"."sent_at" is not null) and ("support_messages"."text_delete_after" is null or "support_messages"."sent_at" is not null or "support_messages"."send_stopped_at" is not null));--> statement-breakpoint
-- =============================================================================
-- Forgetting the words of a reply that never went (26 October 2026; ops
-- automation lane P7f). 0126 let `text_delete_after` be set only on a SENT
-- reply, so the approved text of a reply that stopped without going (dead
-- after six tries, its case closed, its clinic left) had no date to be swept
-- by and stayed on its row until the clinic was destroyed. The CHECK above now
-- also allows the date on a stopped reply, and the sending sets it when it
-- stops (lib/support/send.ts stop() and afterFailure()): 12 months from the
-- stop, the rule for a reply that went, counted from when it was stopped.
-- The approval item's copy is already forgotten by app_forget_support_reply_drafts
-- (0127) 365 days after its decision, whatever became of the reply: the stop
-- follows the decision within the retry window, 23 hours.
--
-- Rows stopped before this migration get their date now, counted from their
-- stop. The support_messages guard allows it: a date may be set once, from NULL.
-- Safe to apply in place: a CHECK only widens, one UPDATE on rows that are
-- stopped, unsent and still hold their text.
-- =============================================================================
UPDATE support_messages
   SET text_delete_after = send_stopped_at + interval '365 days'
 WHERE kind = 'reply'
   AND send_stopped_at IS NOT NULL
   AND sent_at IS NULL
   AND text IS NOT NULL
   AND text_delete_after IS NULL;
