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
  'The last turns (at most six, sealed) of a call that ended unexpectedly, for two hours, so AYA can carry on if the same number calls back (lib/voice/redial.ts). The caller only as an HMAC reference. Deleted on use, on expiry by app_sweep_redial_contexts(), with its conversation, by erasure and at destruction.';
