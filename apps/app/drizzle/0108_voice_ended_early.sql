CREATE TABLE "voice_redial_contexts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"caller_ref" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sealed" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "voice_redial_contexts_caller_ref_check" CHECK ("voice_redial_contexts"."caller_ref" ~ '^v1:[0-9a-f]{64}$'),
	CONSTRAINT "voice_redial_contexts_expiry_check" CHECK ("voice_redial_contexts"."expires_at" > "voice_redial_contexts"."created_at" and "voice_redial_contexts"."expires_at" <= "voice_redial_contexts"."created_at" + interval '2 hours')
);
--> statement-breakpoint
ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ended_early_reason" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "ended_early_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_redial_contexts" ADD CONSTRAINT "voice_redial_contexts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_redial_contexts" ADD CONSTRAINT "voice_redial_contexts_conversation_fk" FOREIGN KEY ("clinic_id","conversation_id") REFERENCES "public"."conversations"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "voice_redial_contexts_caller_idx" ON "voice_redial_contexts" USING btree ("clinic_id","caller_ref");--> statement-breakpoint
CREATE INDEX "voice_redial_contexts_expiry_idx" ON "voice_redial_contexts" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'ended_early', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed'));--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_ended_early_check" CHECK (("conversations"."ended_early_reason" is null) = ("conversations"."ended_early_at" is null) and ("conversations"."ended_early_reason" is null or "conversations"."ended_early_reason" ~ '^[a-z_]{1,64}$'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'setting_changed', 'channel_ready', 'channel_live', 'booking_request', 'request_still_open', 'request_missed', 'deposit_to_collect', 'handover', 'urgent', 'website_message', 'calendar_check', 'ended_early', 'daily_summary', 'weekly_recap', 'ai_paused', 'outage_started', 'outage_ended', 'guarantee_miss', 'website_changes', 'support_request', 'terms_notice', 'subprocessor_notice', 'incident_report', 'guarantee_claim_received', 'guarantee_finding', 'suspended_for_cause', 'patient_request', 'product_update', 'pass_through_ending', 'export_ready', 'export_reminder', 'assistant_ready', 'practice_questions_failed', 'welcome', 'steps_sent', 'address_change_confirm', 'address_changing', 'agreement_to_sign', 'data_destroyed'));--> statement-breakpoint
-- =============================================================================
-- A call that ended early, and the short-lived record that lets AYA pick it
-- up when the caller rings back (ENDED-EARLY-REDIAL, 21 October 2026). The
-- statements above were generated from schema.ts; everything below is the
-- part drizzle cannot express. Numbered 0107 because a parallel package holds
-- 0106: one of the two renumbers when they merge.
--
-- conversations.ended_early_reason / ended_early_at: set once, by the voice
-- ingest (a call the backstop records), by the Retell webhook or by the
-- backstop (lib/voice/ended-early.ts). 0064 holds the runtime role to a
-- column list for UPDATE on conversations, so the two columns join it. They
-- go with their row: no purge or destruction change.
--
-- voice_redial_contexts: PHI (a caller's last few turns, sealed under the
-- KMS key; the caller only as a keyed reference). A tenant table like every
-- table with a clinic_id (tests/rls-drift.test.ts), behind the BAA gate like
-- the transcript outbox. The database owns both clocks: created_at is its
-- own, expires_at is created_at plus two hours, and a row is never rewritten.
-- The app may insert, read and delete (used once; newest wins by delete then
-- insert), never update. app_sweep_redial_contexts() deletes every expired
-- row at every clinic, on the database's clock, for the worker's minute
-- sweep: idempotent, and it returns only a count.
-- =============================================================================
GRANT UPDATE (ended_early_reason, ended_early_at) ON conversations TO healdesk_app;--> statement-breakpoint
ALTER TABLE voice_redial_contexts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE voice_redial_contexts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY voice_redial_contexts_tenant_isolation ON voice_redial_contexts
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
REVOKE ALL ON voice_redial_contexts FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON voice_redial_contexts TO healdesk_app;--> statement-breakpoint
CREATE TRIGGER voice_redial_contexts_baa_gate
  BEFORE INSERT ON voice_redial_contexts
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_voice_redial_clock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.created_at := clock_timestamp();
  NEW.expires_at := NEW.created_at + interval '2 hours';
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER voice_redial_contexts_clock
  BEFORE INSERT ON voice_redial_contexts
  FOR EACH ROW EXECUTE FUNCTION app_voice_redial_clock();--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_sweep_redial_contexts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  now_ timestamptz := clock_timestamp();
  total integer := 0;
  n integer;
  c record;
BEGIN
  -- FORCEd RLS applies to the owner too, so each clinic's rows are deleted
  -- under its own tenant setting, as app_transcript_email_work reads them.
  FOR c IN SELECT cl.id FROM clinics cl LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    DELETE FROM voice_redial_contexts r WHERE r.clinic_id = c.id AND r.expires_at <= now_;
    GET DIAGNOSTICS n = ROW_COUNT;
    total := total + n;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
  RETURN total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_sweep_redial_contexts() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_sweep_redial_contexts() TO healdesk_app;--> statement-breakpoint
COMMENT ON TABLE voice_redial_contexts IS
  'The last turns (at most six, sealed) of a call that ended unexpectedly, for two hours, so AYA can carry on if the same number calls back (lib/voice/redial.ts). The caller only as an HMAC reference. Deleted on use, on expiry by app_sweep_redial_contexts(), with its conversation, by erasure and at destruction.';--> statement-breakpoint
-- -----------------------------------------------------------------------------
-- Its fate when the clinic leaves, stated from the start (tests/
-- booking-request-destruction.test.ts, tests/retention.test.ts,
-- tests/account-closure.test.ts). A row is a patient's words, so it takes the
-- rule for the clinic's patient rows: destruction deletes it
-- (destroyClinicData) and the stamp below refuses while one is left; a
-- closed account takes no new one; the nightly purge leaves it to its own
-- two-hour clock (lib/retention/purge.ts, PURGE_COVERAGE.notPurged).
--
-- The H0 review's definition (0105 on integ/wave0-reviewed, which carries
-- retell_recording_alerts) with voice_redial_contexts added. Both are named
-- here so this redefinition, which runs after 0105, never drops either.
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
     OR EXISTS (SELECT 1 FROM transcript_emails te WHERE te.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM handovers ho WHERE ho.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM conversation_flags cf WHERE cf.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM patient_requests pq WHERE pq.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM incident_affected_contacts ia WHERE ia.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM retell_recording_alerts rr WHERE rr.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM voice_redial_contexts vr WHERE vr.clinic_id = target_clinic) THEN
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
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092), the flags on conversations (0093), the patient requests passed to it (0094), the list of who an incident affected (0098), the Retell recording alerts (0105) and the redial records of calls that ended early (0107), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';--> statement-breakpoint
CREATE TRIGGER voice_redial_contexts_closed_account
  BEFORE INSERT OR UPDATE ON voice_redial_contexts
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();
