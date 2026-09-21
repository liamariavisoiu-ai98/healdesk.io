ALTER TABLE "booking_requests" ALTER COLUMN "platform" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ALTER COLUMN "external_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ALTER COLUMN "sender_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "channel" text DEFAULT 'meta' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "treatment" text;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "confirmed_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD COLUMN "appointment_id" uuid;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint

-- =============================================================================
-- Every channel semi-confirms (decision of 21 September 2026).
--
-- The voice agent no longer produces an appointment row: a call that "booked"
-- now produces a booking request, exactly like a Meta thread, and the
-- practice's desk has the final say — confirm a slot (which creates the
-- appointment), call back, or decline. So the table takes a channel, a
-- conversation, a treatment (voice only: the phone is inside the boundary),
-- a confirmed time and the appointment it produced; the Meta-only columns
-- become nullable.
-- =============================================================================
ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_status_known;--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_status_known CHECK (status IN ('requested', 'accepted', 'confirmed', 'declined', 'expired'));--> statement-breakpoint
ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_platform_known;--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_platform_known CHECK (platform IS NULL OR platform IN ('messenger', 'instagram', 'whatsapp'));--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_channel_known CHECK (channel IN ('voice', 'meta'));--> statement-breakpoint
-- A Meta request has a thread to answer on; a voice request has a call.
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_channel_shape CHECK (
    (channel = 'meta' AND platform IS NOT NULL AND external_id IS NOT NULL AND sender_id IS NOT NULL)
    OR (channel = 'voice' AND platform IS NULL)
  );--> statement-breakpoint
-- Confirmed means a slot and an appointment row, never one without the other.
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_confirmed_shape CHECK (
    (status = 'confirmed') = (confirmed_for IS NOT NULL AND appointment_id IS NOT NULL)
  );--> statement-breakpoint

-- The decision is final, with one permitted second step: a request the desk
-- accepted with "we'll call back" may later be confirmed to a slot from the
-- same page. Everything else about a decided row is frozen.
CREATE OR REPLACE FUNCTION app_booking_request_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'requested' AND NEW.status IN ('accepted', 'confirmed', 'declined', 'expired'))
      OR (OLD.status = 'accepted' AND NEW.status = 'confirmed')
    ) THEN
      RAISE EXCEPTION 'booking_requests: % -> % is not a permitted transition; a decided request is already decided', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status IN ('confirmed', 'declined', 'expired')
        AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at
             OR NEW.decided_by_label IS DISTINCT FROM OLD.decided_by_label
             OR NEW.desk_note IS DISTINCT FROM OLD.desk_note
             OR NEW.confirmed_for IS DISTINCT FROM OLD.confirmed_for
             OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id) THEN
    RAISE EXCEPTION 'booking_requests row is already decided and cannot be re-decided'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id AND NEW.conversation_id IS NOT NULL
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.preferred_window IS DISTINCT FROM OLD.preferred_window
     OR NEW.treatment IS DISTINCT FROM OLD.treatment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
  THEN
    RAISE EXCEPTION 'booking_requests: only the decision columns may change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

REVOKE UPDATE ON booking_requests FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE ("status", "desk_notified_at", "decided_at", "decided_by_label", "desk_note", "confirmed_for", "appointment_id") ON booking_requests TO healdesk_app;--> statement-breakpoint

COMMENT ON TABLE booking_requests IS
  'A booking request taken by any agent (phone or Meta) and handed to the practice to confirm, call back or decline through a single-use link. Every channel semi-confirms only: the appointment row exists when the desk confirms a slot, never before. Stores SHA-256(token), never the token.';
