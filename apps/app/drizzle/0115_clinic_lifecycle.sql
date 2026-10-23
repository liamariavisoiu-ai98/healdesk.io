CREATE TABLE "clinic_lifecycle" (
	"clinic_id" uuid PRIMARY KEY NOT NULL,
	"stage" text NOT NULL,
	"stage_since" timestamp with time zone NOT NULL,
	"steps_left" integer DEFAULT 0 NOT NULL,
	"channels_waiting" integer DEFAULT 0 NOT NULL,
	"last_progress_at" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"last_day" date,
	"snoozed_until" timestamp with time zone,
	"snoozed_by" text,
	"decision" text DEFAULT 'none' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_lifecycle_stage_check" CHECK ("clinic_lifecycle"."stage" in ('not_started', 'in_setup', 'waiting_on_us', 'partly_live', 'live', 'closed')),
	CONSTRAINT "clinic_lifecycle_decision_check" CHECK ("clinic_lifecycle"."decision" in ('none', 'extension_offered', 'let_close', 'extended')),
	CONSTRAINT "clinic_lifecycle_counts_check" CHECK ("clinic_lifecycle"."steps_left" >= 0 and "clinic_lifecycle"."channels_waiting" >= 0),
	CONSTRAINT "clinic_lifecycle_labels_check" CHECK (("clinic_lifecycle"."snoozed_by" is null or char_length("clinic_lifecycle"."snoozed_by") between 1 and 200) and ("clinic_lifecycle"."decided_by" is null or char_length("clinic_lifecycle"."decided_by") between 1 and 200))
);
--> statement-breakpoint
CREATE TABLE "lifecycle_waves" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"wave" text NOT NULL,
	"target" text NOT NULL,
	"notice_id" uuid,
	"ops_alert_id" uuid,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"provider_id" text,
	"delivery" text,
	"error" text,
	"manual_by" text,
	"escalated" boolean DEFAULT false NOT NULL,
	CONSTRAINT "lifecycle_waves_stage_check" CHECK ("lifecycle_waves"."stage" in ('not_started', 'in_setup', 'waiting_on_us', 'partly_live', 'live', 'closed')),
	CONSTRAINT "lifecycle_waves_target_check" CHECK ("lifecycle_waves"."target" in ('clinic_email', 'ops_email', 'slack')),
	CONSTRAINT "lifecycle_waves_delivery_check" CHECK ("lifecycle_waves"."delivery" is null or "lifecycle_waves"."delivery" in ('delivered', 'bounced', 'failed', 'skipped')),
	CONSTRAINT "lifecycle_waves_wave_check" CHECK ("lifecycle_waves"."wave" ~ '^[a-z0-9_]+(:[A-Za-z0-9_.:+-]{1,60})?$'),
	CONSTRAINT "lifecycle_waves_text_check" CHECK (("lifecycle_waves"."error" is null or char_length("lifecycle_waves"."error") <= 200) and ("lifecycle_waves"."manual_by" is null or char_length("lifecycle_waves"."manual_by") between 1 and 200) and ("lifecycle_waves"."provider_id" is null or char_length("lifecycle_waves"."provider_id") <= 200)),
	CONSTRAINT "lifecycle_waves_link_check" CHECK (("lifecycle_waves"."target" = 'clinic_email' and "lifecycle_waves"."ops_alert_id" is null) or ("lifecycle_waves"."target" <> 'clinic_email' and "lifecycle_waves"."notice_id" is null))
);
--> statement-breakpoint
ALTER TABLE "clinic_lifecycle" ADD CONSTRAINT "clinic_lifecycle_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_waves" ADD CONSTRAINT "lifecycle_waves_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lifecycle_waves" ADD CONSTRAINT "lifecycle_waves_notice_id_billing_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."billing_notices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_waves_once_idx" ON "lifecycle_waves" USING btree ("clinic_id","stage","wave","target");--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_waves_notice_idx" ON "lifecycle_waves" USING btree ("clinic_id","notice_id") WHERE "lifecycle_waves"."notice_id" is not null;--> statement-breakpoint
CREATE INDEX "lifecycle_waves_queued_idx" ON "lifecycle_waves" USING btree ("queued_at");--> statement-breakpoint
-- =============================================================================
-- The lifecycle watch (23 October 2026; design E2 of the ops automation plan,
-- docs/design/ops-automation-2026-10-23, steps 3 and 4; owner decisions D4 to
-- D7). The statements above were generated from schema.ts; everything below
-- is the part drizzle cannot express.
--
-- Until now nothing knew where a paying clinic stood between its welcome
-- email and its first live channel except the setup reminders, which tell
-- the clinic and nobody else. A clinic could stall for three weeks and close
-- at the end of its 30 days with no person at healdesk having looked.
--
--   clinic_lifecycle  one row per billing clinic: its stage and since when,
--                     the steps and channel actions it still owes, its last
--                     progress, the deadline the watch last saw, the
--                     operator's snooze and the decision about a stalled
--                     setup. Written by the hourly lifecycle-watch job and
--                     the console's snooze and decision.
--   lifecycle_waves   the reminder ledger: each spec reminder the
--                     setup-reminders job queued, recorded (never sent here),
--                     and each ops wave the watch raised, Slack alone or, for
--                     an escalation, Slack and the ops address too.
--
-- Neither holds a patient: ids, counts, dates and closed words. Both are on
-- the read-only role's list (scripts/readonly-tables.ts) and kept for good
-- when an account closes, beside billing_notices and report_deliveries,
-- which they describe (lib/offboarding/account-closure.ts KEPT_FOR_GOOD).
--
-- Safe to apply in place: two new tables, empty until the job, seeded OFF
-- below, is switched on by the owner.
-- =============================================================================

-- The watch and the console write through the runtime role: a stage moves, a
-- snooze or a decision is set; a wave is recorded and later stamped, never
-- deleted or moved to another clinic, stage, wave or target.
REVOKE ALL ON clinic_lifecycle FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON clinic_lifecycle TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (stage, stage_since, steps_left, channels_waiting, last_progress_at, deadline_at, last_day,
              snoozed_until, snoozed_by, decision, decided_by, decided_at, updated_at)
  ON clinic_lifecycle TO healdesk_app;--> statement-breakpoint
REVOKE ALL ON lifecycle_waves FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON lifecycle_waves TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (sent_at, provider_id, delivery, error) ON lifecycle_waves TO healdesk_app;--> statement-breakpoint

ALTER TABLE clinic_lifecycle ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_lifecycle FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_lifecycle_tenant_isolation ON clinic_lifecycle
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE lifecycle_waves ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE lifecycle_waves FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lifecycle_waves_tenant_isolation ON lifecycle_waves
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- One job row, seeded OFF like every job that acts on clinics: the owner
-- switches it on from /admin's job list.
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('lifecycle-watch', 'Hourly; works out where each paying clinic stands in its setup, records each setup reminder it was sent, and raises the timed ops waves: Slack for routine ones, Slack and the ops address for escalations. Sends nothing to a clinic. Off until the owner switches it on', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'lifecycle_waves'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'clinic_lifecycle'::regclass, 'DELETE')
     OR has_column_privilege('healdesk_app'::name, 'lifecycle_waves'::regclass, 'wave', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'lifecycle_waves'::regclass, 'clinic_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite the lifecycle ledger.';
  END IF;
END;
$$;
