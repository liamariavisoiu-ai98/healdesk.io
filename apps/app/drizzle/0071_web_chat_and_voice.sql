ALTER TABLE "transcript_emails" DROP CONSTRAINT "transcript_emails_status_check";--> statement-breakpoint
ALTER TABLE "transcript_emails" DROP CONSTRAINT "transcript_emails_sent_check";--> statement-breakpoint
DROP INDEX "transcript_emails_due_idx";--> statement-breakpoint
CREATE INDEX "transcript_emails_due_idx" ON "transcript_emails" USING btree ("clinic_id","next_attempt_at") WHERE "transcript_emails"."status" in ('open', 'pending', 'bounced');--> statement-breakpoint
ALTER TABLE "transcript_emails" ADD CONSTRAINT "transcript_emails_status_check" CHECK ("transcript_emails"."status" in ('open', 'pending', 'sent', 'delivered', 'bounced'));--> statement-breakpoint
ALTER TABLE "transcript_emails" ADD CONSTRAINT "transcript_emails_sent_check" CHECK (("transcript_emails"."status" in ('open', 'pending')) or ("transcript_emails"."sent_at" is not null and "transcript_emails"."ses_message_id" is not null));--> statement-breakpoint

-- =============================================================================
-- The web chat and the call, on the transcript outbox (13 October 2026). The
-- statements above were generated from schema.ts; everything below is the part
-- drizzle cannot express.
--
-- A web chat has no process holding it between messages, and healdesk keeps no
-- transcript, so the chat's own state lives in its outbox row while it lasts:
-- status 'open', the turns so far sealed as every other copy, rewritten at each
-- message, and due to be sent once the visitor has been quiet until
-- next_attempt_at (lib/chat/web-chat.ts). The outbox job then sends it like any
-- other, and its seven days start at that send. A tab closed mid-chat loses
-- nothing: the row is already there.
--
-- What the database holds to:
--
--   * a sealed copy changes only while its row is open and stays open; once a
--     chat has gone to the send, its copy is never rewritten again;
--   * the clinic, the conversation and created_at never change, as before;
--   * the seven days are unchanged: set at the insert, moved once, to seven
--     days after the first accepted send.
--
-- And booking requests may now come from the web chat: channel 'web_chat',
-- with no Meta platform or thread, like a call's.
--
-- Safe to apply in place: constraint and function changes, and one new
-- function. apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

GRANT UPDATE (sealed) ON transcript_emails TO healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_transcript_email_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    NEW.destroy_after := NEW.created_at + interval '7 days';
    RETURN NEW;
  END IF;
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'transcript_emails: a queued transcript is never rewritten'
      USING ERRCODE = '42501';
  END IF;
  -- An open web chat's copy grows with the chat; nothing else's ever changes.
  IF NEW.sealed IS DISTINCT FROM OLD.sealed
     AND NOT (OLD.status = 'open' AND NEW.status = 'open') THEN
    RAISE EXCEPTION 'transcript_emails: a queued transcript is never rewritten'
      USING ERRCODE = '42501';
  END IF;
  -- Nothing goes back to open.
  IF NEW.status = 'open' AND OLD.status IS DISTINCT FROM 'open' THEN
    RAISE EXCEPTION 'transcript_emails: a transcript on its way is never reopened'
      USING ERRCODE = '42501';
  END IF;
  -- The first accepted send starts the seven days. A send after a bounce,
  -- or a resend a person asked for, records its own time but never moves
  -- them: the copy is gone seven days after the transcript first went.
  NEW.destroy_after := OLD.destroy_after;
  IF NEW.sent_at IS NULL THEN
    NEW.sent_at := OLD.sent_at;
  ELSIF NEW.sent_at IS DISTINCT FROM OLD.sent_at THEN
    NEW.sent_at := clock_timestamp();
    IF OLD.sent_at IS NULL THEN
      NEW.destroy_after := NEW.sent_at + interval '7 days';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- The outbox job's work list, with open chats whose quiet time is up.
CREATE OR REPLACE FUNCTION app_transcript_email_work(p_limit integer)
RETURNS TABLE (clinic_id uuid, id uuid, due text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT t.clinic_id, t.id,
             CASE WHEN t.destroy_after <= clock_timestamp() THEN 'destroy' ELSE 'send' END
        FROM transcript_emails t
       WHERE t.clinic_id = c.id
         AND (t.destroy_after <= clock_timestamp()
              OR (t.status IN ('open', 'pending', 'bounced') AND t.next_attempt_at <= clock_timestamp()))
       ORDER BY t.next_attempt_at
       LIMIT greatest(least(p_limit, 500), 0);
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_transcript_email_work(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_transcript_email_work(integer) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Booking requests from the web chat
-- -----------------------------------------------------------------------------
ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_channel_known;--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_channel_known CHECK (channel IN ('voice', 'meta', 'web_chat'));--> statement-breakpoint
ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_channel_shape;--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_channel_shape CHECK (
    (channel = 'meta' AND platform IS NOT NULL
      AND ((external_id IS NOT NULL AND sender_id IS NOT NULL)
           OR (external_id IS NULL AND sender_id IS NULL)))
    OR (channel = 'voice' AND platform IS NULL)
    OR (channel = 'web_chat' AND platform IS NULL AND external_id IS NULL AND sender_id IS NULL)
  );--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_web_chat_clinic: the clinic a widget names, before any tenant is known.
-- -----------------------------------------------------------------------------
-- The widget on a clinic's own website names the clinic by its slug, which
-- is public (portal URLs carry it). clinics enables RLS without forcing it,
-- so a definer SELECT sees every clinic. Business data only: the id, the
-- name and the website the clinic gave, which the chat API checks a
-- browser's Origin against. Nothing for a clinic that has left.
CREATE OR REPLACE FUNCTION app_web_chat_clinic(p_slug text)
RETURNS TABLE (clinic_id uuid, name text, website text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.name, c.website
    FROM clinics c
   WHERE p_slug IS NOT NULL
     AND char_length(p_slug) BETWEEN 1 AND 100
     AND c.slug = p_slug
     AND c.offboarding_started_at IS NULL
     AND c.destroyed_at IS NULL
   LIMIT 1
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_web_chat_clinic(text) IS
  'The clinic a web chat widget names by its public slug: id, name and website, for a clinic that has not left. For the chat API, which has no tenant until this answers. No patient data.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_web_chat_clinic(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_web_chat_clinic(text) TO healdesk_app;
