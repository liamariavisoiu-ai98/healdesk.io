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