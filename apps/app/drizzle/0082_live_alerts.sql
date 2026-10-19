ALTER TABLE "booking_requests" ADD COLUMN "source" text DEFAULT 'assistant' NOT NULL;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_source_known" CHECK ("booking_requests"."source" in ('assistant', 'contact_form'));--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_source_shape" CHECK ("booking_requests"."source" = 'assistant' or ("booking_requests"."channel" = 'web_chat' and "booking_requests"."conversation_id" is null and "booking_requests"."vendor_call_id" is null));--> statement-breakpoint
-- =============================================================================
-- The live alerts (package F, 14 October 2026). Everything above this line
-- was generated from schema.ts; everything below is the part drizzle cannot
-- express. The alerts' kinds are already in both kinds CHECKs (0076, S0), and
-- they are queued in billing_notices and recorded in report_deliveries like
-- every other notice.
--
-- booking_requests.source: how the request was taken. 'assistant' is every
-- request so far (AYA in a call, a web chat or a Meta thread); 'contact_form'
-- is a message left on the website's contact form while website chat was not
-- answering (L20): a first name, a number and one of a fixed set of times
-- (app/api/widget/v1/[slug]/contact). Patient data under the agreement, like
-- the rest of the row: the BAA gate on booking_requests already covers the
-- insert, destruction and the purge already delete the whole row, and the
-- runtime role's table-level INSERT and SELECT cover the column. It has no
-- UPDATE (UPDATE on booking_requests is per column, 0057), and the no-rewrite
-- trigger below refuses a change to it from the owner as well, as it does
-- for every other fact of the request.
--
-- requests-still-open: L8's switch, seeded OFF like every job that mails
-- customers (lib/scheduler/jobs.ts). Hourly from the tick: at each clinic's
-- opening hour, only while its daily summary is off, one email counting the
-- booking requests still waiting for the desk
-- (lib/scheduler/requests-still-open.ts).
-- =============================================================================
CREATE OR REPLACE FUNCTION app_booking_request_no_rewrite()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  token_reissued boolean;
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'requested'    AND NEW.status IN ('accepted', 'rescheduling', 'confirmed', 'declined', 'expired'))
      OR (OLD.status = 'accepted'     AND NEW.status IN ('rescheduling', 'confirmed', 'expired'))
      OR (OLD.status = 'rescheduling' AND NEW.status IN ('confirmed', 'declined', 'expired'))
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

  IF NEW.status IN ('confirmed', 'declined', 'expired')
     AND (NEW.proposed_slots IS DISTINCT FROM OLD.proposed_slots
          OR NEW.reschedule_expires_at IS DISTINCT FROM OLD.reschedule_expires_at
          OR NEW.collected_fields IS DISTINCT FROM OLD.collected_fields
          OR NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at) THEN
    RAISE EXCEPTION 'booking_requests: the request is % and its slots, fields and thread state are frozen', NEW.status
      USING ERRCODE = '42501';
  END IF;

  -- Never NULL: current_setting(..., true) is NULL in a session that never
  -- defined the switch, and a NULL here would make the freeze below NULL,
  -- which an IF reads as false, letting any token through.
  token_reissued := coalesce(current_setting('app.booking_token_reissue', true), '') = 'on'
                    AND OLD.status = 'requested' AND NEW.status = 'requested'
                    AND OLD.desk_notified_at IS NULL AND NEW.desk_notified_at IS NULL;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR (OLD.conversation_id IS NOT NULL
         AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
         AND NEW.conversation_id IS NOT NULL)
     OR (NEW.token_hash IS DISTINCT FROM OLD.token_hash AND NOT token_reissued)
     OR NEW.preferred_window IS DISTINCT FROM OLD.preferred_window
     OR NEW.alternative_windows IS DISTINCT FROM OLD.alternative_windows
     OR NEW.treatment IS DISTINCT FROM OLD.treatment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.booked_via IS DISTINCT FROM OLD.booked_via
     OR NEW.vendor_call_id IS DISTINCT FROM OLD.vendor_call_id
     OR NEW.source IS DISTINCT FROM OLD.source
  THEN
    RAISE EXCEPTION 'booking_requests: only the decision columns may change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$function$;--> statement-breakpoint
COMMENT ON COLUMN booking_requests.source IS
  'How the request was taken: assistant (AYA in a conversation) or contact_form (the website''s contact form while chat was not answering: a first name, a number and a fixed time choice, nothing else). Frozen after insert.';--> statement-breakpoint
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('requests-still-open', 'Hourly; at each clinic''s opening hour, only while its daily summary is off, queues one email counting the booking requests taken before that opening that are still waiting for the desk', false)
ON CONFLICT (name) DO NOTHING;
