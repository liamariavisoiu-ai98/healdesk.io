CREATE TABLE "clinic_settings_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"field" text NOT NULL,
	"before_value" text,
	"after_value" text,
	"actor_label" text NOT NULL,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_settings_history_field_check" CHECK ("clinic_settings_history"."field" in ('direct_line_e164', 'transfer_e164', 'urgent_help_e164', 'vet_referral_e164', 'transcript_retention_days', 'auto_confirm_bookings')),
	CONSTRAINT "clinic_settings_history_values_check" CHECK (("clinic_settings_history"."before_value" is null or char_length("clinic_settings_history"."before_value") <= 64) and ("clinic_settings_history"."after_value" is null or char_length("clinic_settings_history"."after_value") <= 64)),
	CONSTRAINT "clinic_settings_history_actor_check" CHECK (char_length("clinic_settings_history"."actor_label") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "clinic_setup_screens" (
	"clinic_id" uuid NOT NULL,
	"screen" text NOT NULL,
	"outcome" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_label" text NOT NULL,
	CONSTRAINT "clinic_setup_screens_clinic_id_screen_pk" PRIMARY KEY("clinic_id","screen"),
	CONSTRAINT "clinic_setup_screens_screen_check" CHECK ("clinic_setup_screens"."screen" in ('basics', 'hours', 'services', 'question', 'insurance', 'tone', 'coverage', 'direct_line', 'deposits', 'urgent', 'calendar', 'providers', 'channels', 'backup')),
	CONSTRAINT "clinic_setup_screens_outcome_check" CHECK ("clinic_setup_screens"."outcome" in ('done', 'skipped')),
	CONSTRAINT "clinic_setup_screens_actor_check" CHECK (char_length("clinic_setup_screens"."actor_label") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "billing_notices" DROP CONSTRAINT "billing_notices_kind_check";--> statement-breakpoint
ALTER TABLE "report_deliveries" DROP CONSTRAINT "report_deliveries_kind_check";--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "promotions" text;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "quick_answers" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "never_say" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "most_asked" jsonb;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "policies" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "tone" text DEFAULT 'warm' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "phone_greeting" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "chat_greeting" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "languages" text[] DEFAULT '{en}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "suggest_add_ons" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "mention_promotions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "auto_confirm_bookings" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "booking_detail" text DEFAULT 'generic' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "booking_system" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "calendar_account" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "urgent_help_e164" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "vet_referral_e164" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "transfer_live_calls" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "transfer_e164" text;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "daily_summary" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "coverage_mode" text DEFAULT 'overflow_after_hours' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD COLUMN "transcript_retention_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "website" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "site_profile" jsonb;--> statement-breakpoint
ALTER TABLE "clinic_settings_history" ADD CONSTRAINT "clinic_settings_history_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_setup_screens" ADD CONSTRAINT "clinic_setup_screens_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_settings_history_clinic_idx" ON "clinic_settings_history" USING btree ("clinic_id","changed_at");--> statement-breakpoint
ALTER TABLE "billing_notices" ADD CONSTRAINT "billing_notices_kind_check" CHECK ("billing_notices"."kind" in ('payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected'));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_tone_check" CHECK ("clinic_settings"."tone" in ('warm', 'clinical'));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_greetings_check" CHECK (("clinic_settings"."phone_greeting" is null or char_length("clinic_settings"."phone_greeting") between 1 and 300) and ("clinic_settings"."chat_greeting" is null or char_length("clinic_settings"."chat_greeting") between 1 and 300));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_languages_check" CHECK (cardinality("clinic_settings"."languages") between 1 and 8 and "clinic_settings"."languages" <@ array['en', 'es', 'fr', 'pt', 'zh', 'vi', 'ko', 'ru']::text[]);--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_booking_detail_check" CHECK ("clinic_settings"."booking_detail" in ('generic', 'named_provider'));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_booking_system_check" CHECK ("clinic_settings"."booking_system" is null or "clinic_settings"."booking_system" in ('google_calendar', 'calendly', 'calcom', 'gohighlevel', 'mindbody', 'boulevard', 'other', 'none'));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_calendar_account_check" CHECK ("clinic_settings"."calendar_account" is null or "clinic_settings"."calendar_account" in ('workspace_baa', 'workspace_no_baa', 'personal'));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_numbers_check" CHECK (("clinic_settings"."urgent_help_e164" is null or "clinic_settings"."urgent_help_e164" ~ '^\+[1-9][0-9]{6,14}$') and ("clinic_settings"."vet_referral_e164" is null or "clinic_settings"."vet_referral_e164" ~ '^\+[1-9][0-9]{6,14}$') and ("clinic_settings"."transfer_e164" is null or "clinic_settings"."transfer_e164" ~ '^\+[1-9][0-9]{6,14}$'));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_coverage_mode_check" CHECK ("clinic_settings"."coverage_mode" in ('all_calls', 'overflow_after_hours', 'after_hours_only'));--> statement-breakpoint
ALTER TABLE "clinic_settings" ADD CONSTRAINT "clinic_settings_retention_check" CHECK ("clinic_settings"."transcript_retention_days" in (90, 30, 7));--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_address_check" CHECK ("clinics"."address" is null or (char_length("clinics"."address") between 1 and 300 and "clinics"."address" !~ '[[:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_website_check" CHECK ("clinics"."website" is null or (char_length("clinics"."website") between 4 and 200 and "clinics"."website" !~ '[[:space:][:cntrl:]]'));--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_kind_check" CHECK ("report_deliveries"."kind" in ('monthly', 'weekly', 'alert', 'renewal', 'payment_failed', 'payment_action_required', 'grace_ending', 'suspended', 'restored', 'cancel_scheduled', 'cancel_reversed', 'canceled', 'renewal_upcoming', 'usage_80', 'usage_100', 'overage_invoiced', 'plan_changed', 'location_added', 'connect_disconnected', 'plan_started', 'price_stepped_up', 'step_up_reminder', 'allowance_fallback', 'receipt', 'refund_issued', 'card_expiring', 'connect_connected', 'setup_reminder', 'setup_closed', 'calendar_stopped', 'calendar_reconnected', 'welcome'));--> statement-breakpoint

-- =============================================================================
-- The setup wizard (plan Part E, J and C2; milestone M3). Everything above
-- this line was generated from schema.ts; everything below is the part drizzle
-- cannot express: row-level security, grants, the one-time copy of the call
-- routing, the job seed, the comments and the audit at the end.
--
-- What this migration adds, in one paragraph. clinic_settings gains every
-- switch the wizard and Settings own (tone, greetings, languages, add-ons,
-- promotions, Auto-confirm, booking detail, the funnel's booking system and
-- Google account answers, the urgent-help and vet referral numbers, the
-- transfer, the daily summary, the coverage mode as the single source, and
-- the transcript retention), each with the spec's default. agent_configs,
-- the clinic's knowledge, gains the promotions box, quick answers, never-say,
-- the most-asked question and policies. clinics gains the practice's address
-- and website and the website read kept as the drift baseline.
-- clinic_setup_screens is the wizard's progress per screen, and
-- clinic_settings_history the before and after of every change to where calls
-- go, how long records are kept and whether AYA books on its own. The outbox
-- and its ledger take the plan's own email kinds (O7, the setup closure, O13)
-- and the welcome email (B1), which keeps its once-per-clinic state on the
-- ledger because its single-use link can never be stored.
--
-- Grants. 0003 sets ALTER DEFAULT PRIVILEGES giving healdesk_app SELECT,
-- INSERT, UPDATE and DELETE on every table the migrator creates, so all four
-- have ALREADY landed on each new table by the time these statements run.
-- Every REVOKE below is therefore required, not defensive, and each GRANT
-- restates the intended set so it can be read in one place.
--
-- Safe to run: the new tables are empty, every new column is nullable or has
-- its default, and the two widened CHECKs only add kinds.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tenant tables: ENABLE + FORCE row-level security, one isolation policy each,
-- exactly as 0044. tests/rls-drift.test.ts asks the catalogue for every table
-- with a clinic_id and fails on any that is not both.
-- -----------------------------------------------------------------------------
ALTER TABLE clinic_setup_screens ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_setup_screens FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_setup_screens_tenant_isolation ON clinic_setup_screens
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE clinic_settings_history ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_settings_history FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_settings_history_tenant_isolation ON clinic_settings_history
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Grants, table by table.
-- -----------------------------------------------------------------------------

-- clinic_setup_screens: a screen's outcome moves (skipped, then answered), its
-- key never does. DELETE stays, because the runtime role runs destruction and
-- the wizard's progress goes with the clinic's data (lib/offboarding).
REVOKE UPDATE ON clinic_setup_screens FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (outcome, at, actor_label) ON clinic_setup_screens TO healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON clinic_setup_screens TO healdesk_app;--> statement-breakpoint

-- clinic_settings_history: append-only. "Who sent calls to which number, and
-- when" must survive the next change, so the runtime role can neither rewrite
-- nor erase a row. Kept at destruction with the audit log (lib/offboarding).
REVOKE UPDATE ON clinic_settings_history FROM healdesk_app;--> statement-breakpoint
REVOKE DELETE ON clinic_settings_history FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON clinic_settings_history TO healdesk_app;--> statement-breakpoint

-- clinics: UPDATE is a column list since 0031, and column grants do not reach
-- a column added later. The wizard writes the address and the website, and
-- the drift check (M7) moves the baseline once a change is confirmed.
GRANT UPDATE (address, website, site_profile) ON clinics TO healdesk_app;--> statement-breakpoint

-- clinic_settings and agent_configs need no GRANT: both give healdesk_app
-- table-level UPDATE (0043; 0003's default privileges for 0033), which covers
-- a column added later. The audit below pins that they stay writable.

-- -----------------------------------------------------------------------------
-- Which calls reach AYA: coverage_mode becomes the single source. A clinic
-- whose routing was set to send every call ('always') starts on All calls;
-- every other clinic keeps the column default, Overflow and after hours,
-- which is what 'conditional' meant. clinic_settings FORCEs row-level
-- security, which binds the table's owner too, so the copy walks the clinics
-- with the tenant set per clinic, exactly as withTenant() does, and restores
-- the setting afterwards. Run once; afterwards the wizard and Settings write
-- coverage_mode and keep call_routing in step for its remaining readers.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl WHERE cl.call_routing = 'always' LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    INSERT INTO clinic_settings (clinic_id, coverage_mode) VALUES (c.id, 'all_calls')
      ON CONFLICT (clinic_id) DO UPDATE SET coverage_mode = 'all_calls';
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The setup reminder (O7), seeded OFF like every job: the owner switches it
-- on with the email launch set (Annex X9), once the notices sender's own
-- switch is on.
-- -----------------------------------------------------------------------------
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('setup-reminders', 'Hourly; while none of a clinic''s channels is live, queues the setup reminder due on day 5, 10, 15, 20, 25 or 30 of its setup window, in the clinic''s daytime, and resends a welcome email whose send failed', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE clinic_setup_screens IS
  'The setup wizard''s progress: one row per screen a clinic has left, answered (done) or skipped, when, and from which device. The wizard resumes on the first of the clinic''s screens with no row. Setup answers about the practice, no patient data; deleted with the clinic''s data at destruction.';--> statement-breakpoint
COMMENT ON TABLE clinic_settings_history IS
  'Append-only before and after of every change to the direct line, the transfer and urgent-help numbers, the vet referral number, the transcript retention and Auto-confirm. The clinic''s own numbers, a day count or a flag; never patient data. Kept at destruction, with the audit log.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.coverage_mode IS
  'Which calls reach AYA: all_calls, overflow_after_hours (the default) or after_hours_only. The single source; clinics.call_routing is kept in step for its remaining readers.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.auto_confirm_bookings IS
  'Auto-confirm: on, a booking AYA takes is booked; off, every booking is a request staff approve. Set at provisioning from the booking system, off where it does not read Google Calendar. Direct booking also needs a healthy calendar, terms that allow writing and the owner''s kill switch.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.booking_system IS
  'Where bookings live, as the funnel asked and the wizard corrects. What the clinic told us; its calendar terms come only from the signed agreement and its elections.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.urgent_help_e164 IS
  'The number AYA gives someone reporting a complication or an urgent symptom, after 911. E.164.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.vet_referral_e164 IS
  'A veterinary practice''s emergency referral number, which its urgent reply gives. E.164.';--> statement-breakpoint
COMMENT ON COLUMN clinic_settings.transcript_retention_days IS
  'How long transcripts and conversation records are kept: 90 days, shortened to 30 or 7 by the clinic. The purge moves to it with Conversations'' retention control (M5).';--> statement-breakpoint
COMMENT ON COLUMN agent_configs.never_say IS
  'Phrases AYA must never use: the clinical defaults at provisioning, then the clinic''s own. Clinical on purpose, so never screened by findClinicalContent.';--> statement-breakpoint
COMMENT ON COLUMN clinics.site_profile IS
  'The clinic''s website as read at checkout, screened again under the specialty bought: the setup wizard''s starting point and the drift check''s baseline. Business data, never patient information.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'clinic_settings_history'::regclass, 'DELETE')
     OR has_any_column_privilege('healdesk_app'::name, 'clinic_settings_history'::regclass, 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite clinic_settings_history, which 0052 made append-only.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'clinic_setup_screens'::regclass, 'clinic_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinic_setup_screens'::regclass, 'screen', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can move a clinic_setup_screens row, which 0052 froze.';
  END IF;
  IF NOT (has_table_privilege('healdesk_app'::name, 'clinic_setup_screens'::regclass, 'DELETE')
          AND has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'address', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'website', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'site_profile', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'clinic_settings'::regclass, 'coverage_mode', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'clinic_settings'::regclass, 'auto_confirm_bookings', 'UPDATE')
          AND has_column_privilege('healdesk_app'::name, 'agent_configs'::regclass, 'never_say', 'UPDATE')) THEN
    RAISE EXCEPTION 'healdesk_app cannot write a column or row 0052 added for a runtime writer.';
  END IF;
END;
$$;
