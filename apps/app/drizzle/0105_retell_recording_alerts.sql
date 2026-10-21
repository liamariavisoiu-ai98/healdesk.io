CREATE TABLE "retell_recording_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"retell_call_id" text NOT NULL,
	"detected_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_error" text,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "retell_recording_alerts_call_id_check" CHECK ("retell_recording_alerts"."retell_call_id" ~ '^[A-Za-z0-9_-]{1,128}$'),
	CONSTRAINT "retell_recording_alerts_attempts_check" CHECK ("retell_recording_alerts"."attempts" >= 0),
	CONSTRAINT "retell_recording_alerts_error_check" CHECK ("retell_recording_alerts"."last_error" is null or char_length("retell_recording_alerts"."last_error") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "retell_recording_alerts" ADD CONSTRAINT "retell_recording_alerts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retell_recording_alerts_call_idx" ON "retell_recording_alerts" USING btree ("clinic_id","retell_call_id");--> statement-breakpoint
CREATE INDEX "retell_recording_alerts_open_idx" ON "retell_recording_alerts" USING btree ("clinic_id","detected_at") WHERE "retell_recording_alerts"."resolved_at" is null;--> statement-breakpoint
-- =============================================================================
-- Retell recordings found (NOAUDIO-01, 21 October 2026). The statements above
-- were generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- CLAUDE.md promises no call audio is kept. Each clinic's Retell agent is set
-- to keep none (lib/voice/retell-agent.ts), but nothing checked that Retell
-- obeyed: a recording URL on a call's webhook or read-back is a recording
-- Retell kept. One row per such call (lib/voice/recording-alerts.ts): the
-- clinic, Retell's call id and times, never the URL, a transcript or a
-- number. /admin/recordings lists them through the ops API and its button
-- has apps/app delete the call at Retell, which resolves the row.
--
-- A tenant row like every table with a clinic_id (tests/rls-drift.test.ts).
-- No BAA gate trigger: the row carries nothing about a patient, and a demo or
-- synthetic clinic's recording must be caught too. The app may insert a row,
-- and update only the delete bookkeeping; the call id and the clinic are
-- fixed once written. DELETE stays for a clinic's destruction.
-- =============================================================================
ALTER TABLE retell_recording_alerts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE retell_recording_alerts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY retell_recording_alerts_tenant_isolation ON retell_recording_alerts
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
REVOKE ALL ON retell_recording_alerts FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON retell_recording_alerts TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (attempts, last_attempt_at, last_error, resolved_at) ON retell_recording_alerts TO healdesk_app;--> statement-breakpoint
COMMENT ON TABLE retell_recording_alerts IS
  'A call Retell kept a recording of though the agent is set to keep none (NOAUDIO-01): clinic, Retell call id, when found, and the operator''s delete at Retell (attempts, last_error in our words, resolved_at). Never the recording URL, a transcript or a number.';
--> statement-breakpoint
-- -----------------------------------------------------------------------------
-- Its fate when the clinic leaves (review of 21 October 2026)
-- -----------------------------------------------------------------------------
-- Every table with a clinic_id has one stated fate (tests/
-- booking-request-destruction.test.ts, tests/retention.test.ts,
-- tests/account-closure.test.ts). A row names one of the clinic's calls by
-- Retell's id and when it happened: no words, but metadata about a patient's
-- call, so the more conservative rule applies, the one for the clinic's
-- patient rows. Destruction deletes it (destroyClinicData) and the stamp
-- below refuses while one is left; a closed account takes no new one; and
-- the nightly purge deletes a resolved one on the record clock
-- (lib/retention/purge.ts). An open alert is not purged: it is the only
-- trace of a recording Retell still holds.
--
-- 0098's definition with retell_recording_alerts added.
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
     OR EXISTS (SELECT 1 FROM transcript_emails te WHERE te.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM handovers ho WHERE ho.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM conversation_flags cf WHERE cf.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM patient_requests pq WHERE pq.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM incident_affected_contacts ia WHERE ia.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM retell_recording_alerts rr WHERE rr.clinic_id = target_clinic) THEN
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
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092), the flags on conversations (0093), the patient requests passed to it (0094), the list of who an incident affected (0098) and the Retell recording alerts (0105), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';--> statement-breakpoint
CREATE TRIGGER retell_recording_alerts_closed_account
  BEFORE INSERT OR UPDATE ON retell_recording_alerts
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();