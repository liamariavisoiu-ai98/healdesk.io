ALTER TABLE "support_messages" ADD COLUMN "inbound_object_key" text;--> statement-breakpoint
CREATE INDEX "support_messages_object_pending_idx" ON "support_messages" USING btree ("case_id") WHERE "support_messages"."inbound_object_key" is not null;--> statement-breakpoint
ALTER TABLE "support_messages" ADD CONSTRAINT "support_messages_object_key_check" CHECK ("support_messages"."inbound_object_key" is null or ("support_messages"."kind" = 'email' and "support_messages"."inbound_object_key" = 'mail/' || "support_messages"."inbound_mail_id"));-- =============================================================================
-- The support drafter reads a clinic's email (26 October 2026; ops automation
-- Phase 7, lane P7h; the owner's instruction of that day: "it shouldn't keep
-- anything, it should just be the drafter reading it"). The statements above
-- were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- While the support-draft job is on and the case is new after the email,
-- the inbound handler no longer deletes a clinic's raw message in the same
-- request: it records the case from facts as before (0130's CHECKs still
-- hold: no word of the email in any column) and leaves the object in the
-- KMS-encrypted inbound bucket for the support-draft job, which reads it in
-- memory, keeps nothing of it, gives its text to the model (healdesk's key,
-- the Anthropic organisation the BAA covers; owner-confirmed 26 October
-- 2026) inside the untrusted-data block, and deletes it in a finally. The
-- hourly sweep deletes any object older than six hours, and the bucket's
-- one-day lifecycle rule is the backstop.
--
--   support_messages.inbound_object_key
--                        the object's key while it waits, always
--                        'mail/' || inbound_mail_id
--                        (support_messages_object_key_check), set only on
--                        an inbound email's INSERT and only ever cleared
--                        (app_support_messages_object_key_guard): a key
--                        cannot be pointed at another message.
--
-- The runtime role gains UPDATE on that one column (to clear it). Safe to
-- apply in place: one empty column, a partial index, a CHECK every row
-- passes, a trigger.
-- =============================================================================

GRANT UPDATE (inbound_object_key) ON support_messages TO healdesk_app;--> statement-breakpoint

-- The owner reads this line at System > Jobs before he switches the job on:
-- it must say that it sends a clinic's email to Anthropic.
UPDATE scheduled_jobs SET cadence = 'Every minute, from the support-draft queue: drafts up to three new support cases that name a practice, each from the case''s fields, the practice''s account and, for a case that came by email, the email''s subject and body as the clinic wrote them, unmasked, sent to Anthropic under the business associate agreement and then deleted from the inbound bucket. Checked by the reply rules, for the owner to edit and send; a draft from an email that fails a rule is not kept. While it is off, a clinic''s email is deleted when it arrives and is not drafted. Sends nothing. Off until the owner switches it on, with ANTHROPIC_API_KEY set'
 WHERE name = 'support-draft';--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_support_messages_object_key_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.inbound_object_key IS NOT NULL AND NEW.inbound_object_key IS DISTINCT FROM OLD.inbound_object_key THEN
    RAISE EXCEPTION 'an inbound email''s object key is only ever cleared'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_support_messages_object_key_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER support_messages_object_key_guard
  BEFORE UPDATE OF inbound_object_key ON support_messages
  FOR EACH ROW EXECUTE FUNCTION app_support_messages_object_key_guard();--> statement-breakpoint
ALTER TABLE support_messages ENABLE ALWAYS TRIGGER support_messages_object_key_guard;--> statement-breakpoint

DO $$
BEGIN
  IF NOT has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'inbound_object_key', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app cannot clear an inbound email''s object key.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'support_messages'::regclass, 'inbound_mail_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can update an inbound email''s SES id.';
  END IF;
END
$$;
