CREATE TABLE "transcript_emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sealed" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"last_error" text,
	"ses_message_id" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"destroy_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "transcript_emails_status_check" CHECK ("transcript_emails"."status" in ('pending', 'sent', 'delivered', 'bounced')),
	CONSTRAINT "transcript_emails_attempts_check" CHECK ("transcript_emails"."attempts" >= 0),
	CONSTRAINT "transcript_emails_last_error_check" CHECK ("transcript_emails"."last_error" is null or char_length("transcript_emails"."last_error") <= 500),
	CONSTRAINT "transcript_emails_destroy_check" CHECK ("transcript_emails"."destroy_after" > "transcript_emails"."created_at"),
	CONSTRAINT "transcript_emails_sent_check" CHECK (("transcript_emails"."status" = 'pending') or ("transcript_emails"."sent_at" is not null and "transcript_emails"."ses_message_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "transcript_emails" ADD CONSTRAINT "transcript_emails_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_emails" ADD CONSTRAINT "transcript_emails_conversation_fk" FOREIGN KEY ("clinic_id","conversation_id") REFERENCES "public"."conversations"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_emails_conversation_idx" ON "transcript_emails" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "transcript_emails_due_idx" ON "transcript_emails" USING btree ("clinic_id","next_attempt_at") WHERE "transcript_emails"."status" in ('pending', 'bounced');--> statement-breakpoint
CREATE INDEX "transcript_emails_destroy_idx" ON "transcript_emails" USING btree ("clinic_id","destroy_after");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_emails_ses_message_idx" ON "transcript_emails" USING btree ("ses_message_id") WHERE "transcript_emails"."ses_message_id" is not null;--> statement-breakpoint

-- =============================================================================
-- The transcript outbox (the owner's decisions of 13 October 2026). The
-- statements above were generated from schema.ts; everything below is the part
-- drizzle cannot express.
--
-- A transcript is emailed to the clinic when its conversation ends, through
-- SES with TLS required, and healdesk keeps no transcript. A send can fail,
-- though, and an accepted one can bounce, and with nothing kept a failure
-- would lose the transcript for good. So each one waits here, sealed under the
-- KMS key, until it has gone, and for seven days after so a clinic that lost
-- the email can be sent it again, and no longer.
--
-- What the database holds to, whatever the writer sends:
--
--   * the seven days. created_at is the database's clock at the insert, and
--     destroy_after is created_at plus seven days; when the first send is
--     recorded, sent_at is the database's clock and destroy_after moves to
--     sent_at plus seven days; nothing else moves it, a later send included. The outbox job deletes each row once
--     its destroy_after has passed (lib/conversations/transcript-outbox.ts),
--     and the row also goes with its conversation through the foreign key;
--   * the copy is never rewritten: the runtime role has no UPDATE on sealed,
--     conversation_id, clinic_id or the clock columns, and may DELETE (the
--     job's purge);
--   * tenant isolation, forced, and the BAA gate on INSERT: no transcript is
--     queued for a production clinic without an agreement in effect. Not on
--     UPDATE, unlike the other PHI tables: an update here writes no patient
--     data (sealed cannot change), and a clinic whose agreement has just ended
--     must still have its pending transcripts sent or deleted, never stuck.
--
-- Safe to apply in place: a new table, two functions and a job row, on.
-- apps/app has only ever held synthetic and seed data (CLAUDE.md).
-- =============================================================================

ALTER TABLE transcript_emails ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE transcript_emails FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY transcript_emails_tenant_isolation ON transcript_emails
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

REVOKE ALL ON transcript_emails FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON transcript_emails TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, attempts, next_attempt_at, last_error, ses_message_id, sent_at, delivered_at) ON transcript_emails TO healdesk_app;--> statement-breakpoint

CREATE TRIGGER transcript_emails_baa_gate
  BEFORE INSERT ON transcript_emails
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

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
  IF NEW.sealed IS DISTINCT FROM OLD.sealed
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'transcript_emails: a queued transcript is never rewritten'
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
CREATE TRIGGER transcript_emails_clock
  BEFORE INSERT OR UPDATE ON transcript_emails
  FOR EACH ROW EXECUTE FUNCTION app_transcript_email_clock();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_transcript_email_work: what the outbox job has to do, across clinics.
-- -----------------------------------------------------------------------------
-- The tenant walk of 0046 (app_pending_notices): the table forces row-level
-- security, which binds the definer too, so the walk sets the tenant per
-- clinic and restores the caller's setting. Ids only, and what is due: a send
-- (pending, or bounced and due again) or a deletion (past destroy_after,
-- whatever its status). Never the sealed copy, which the job reads inside
-- withTenant() when it claims the row.
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
              OR (t.status IN ('pending', 'bounced') AND t.next_attempt_at <= clock_timestamp()))
       ORDER BY t.next_attempt_at
       LIMIT greatest(least(p_limit, 500), 0);
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_transcript_email_work(integer) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_transcript_email_work(integer) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- app_transcript_email_by_message: the row an SES event names.
-- -----------------------------------------------------------------------------
-- SES's delivery and bounce events (api/webhooks/ses) carry its message id
-- and nothing of ours, so the webhook has no tenant until this finds one. The
-- same walk; one row at most, by the unique index.
CREATE OR REPLACE FUNCTION app_transcript_email_by_message(p_message_id text)
RETURNS TABLE (clinic_id uuid, id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  IF p_message_id IS NULL OR char_length(p_message_id) NOT BETWEEN 1 AND 200 THEN
    RETURN;
  END IF;
  FOR c IN SELECT cl.id FROM clinics cl ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT t.clinic_id, t.id FROM transcript_emails t
       WHERE t.clinic_id = c.id AND t.ses_message_id = p_message_id
       LIMIT 1;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_transcript_email_by_message(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_transcript_email_by_message(text) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction: 0065's app_mark_clinic_destroyed, with transcript_emails added
-- to the tables it requires empty. Every table it checked before, it still
-- checks, and the clinic's row is still locked first. destroyClinicData
-- (lib/offboarding/offboarding.ts) deletes the clinic's queued transcripts
-- before its conversations; the foreign key's cascade would take them anyway,
-- and this makes it a checked fact. tests/booking-request-destruction.test.ts
-- reads the list from the function and holds it to every table with a
-- clinic_id.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_mark_clinic_destroyed(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  done timestamptz;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_mark_clinic_destroyed: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  -- The clinic's row first, FOR UPDATE, so a deletion request recorded
  -- concurrently (erasure_requests_guard reads the row FOR SHARE) either
  -- commits before the checks below, which then see it and refuse, or waits
  -- for the stamp and is refused itself. Review of 12 October 2026.
  PERFORM 1 FROM clinics c WHERE c.id = target_clinic FOR UPDATE;

  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to mark it destroyed.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction is due by the rule of the agreement the service ended under (app_destruction_due), by the database''s clock.';
  END IF;

  IF EXISTS (SELECT 1 FROM booking_requests r WHERE r.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM appointments a WHERE a.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM conversations v WHERE v.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM contacts p WHERE p.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM transactions t WHERE t.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM reconciliation_exceptions x WHERE x.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM meta_booking_drafts d WHERE d.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM webhook_events w WHERE w.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM provider_connections k WHERE k.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_closures z WHERE z.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM chat_threads h WHERE h.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM meta_inbound_messages m WHERE m.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_setup_screens s WHERE s.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM slot_holds sh WHERE sh.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_provider_services ps WHERE ps.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_providers pr WHERE pr.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM suppressions u WHERE u.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM consent_records g WHERE g.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM contact_attempts n WHERE n.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM erasure_requests er WHERE er.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM record_amendments ra WHERE ra.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM deposit_payments dp WHERE dp.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM transcript_emails te WHERE te.clinic_id = target_clinic) THEN
    RAISE EXCEPTION 'Clinic % still holds rows that destruction deletes; refusing to mark it destroyed.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'destroyClinicData deletes them first, in the same transaction, and then stamps it.';
  END IF;

  UPDATE clinics c
     SET destroyed_at = coalesce(c.destroyed_at, now()),
         updated_at = now()
   WHERE c.id = target_clinic
  RETURNING c.destroyed_at INTO done;
  RETURN done;
END
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065) and the transcript outbox (0069), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';--> statement-breakpoint

-- The outbox job's switch, seeded ON, like incident-deadlines (0066) and
-- unlike the other jobs: it carries the agreements' promise that the sealed
-- copy is gone seven days after it was sent, which a job left off would
-- break, and it sends only what a clinic's own conversations queued.
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('transcript-emails', 'Every minute, from the billing-minute queue: sends each queued transcript to its clinic through SES, retries a failed or bounced one with back-off, and deletes each sealed copy seven days after SES accepted it, or seven days after it was queued if it never was', true)
ON CONFLICT (name) DO NOTHING;
