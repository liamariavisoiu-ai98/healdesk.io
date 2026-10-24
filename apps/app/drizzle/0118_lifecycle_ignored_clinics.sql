CREATE TABLE "lifecycle_ignored_clinics" (
	"clinic_id" uuid PRIMARY KEY NOT NULL,
	"ignored" boolean NOT NULL,
	"note" text,
	"set_by" text NOT NULL,
	"set_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lifecycle_ignored_clinics_note_check" CHECK ("lifecycle_ignored_clinics"."note" is null or "lifecycle_ignored_clinics"."note" in ('internal_test_account', 'healdesk_staff_account', 'sales_demo_account')),
	CONSTRAINT "lifecycle_ignored_clinics_set_by_check" CHECK (char_length("lifecycle_ignored_clinics"."set_by") between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "lifecycle_ignored_clinics" ADD CONSTRAINT "lifecycle_ignored_clinics_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- =============================================================================
-- The lifecycle watch's ignore list (24 October 2026; ops automation lane
-- P5d, the owner's decision that internal test accounts are left out of the
-- lifecycle watch). The statements above were generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
-- healdesk's own test accounts are paying clinics as far as the watch can
-- tell (a Stripe customer, a subscription, a setup window), so the watch
-- chased them like a real practice: a setup-window wave in Slack, a
-- "decision owed" row on Home and a count in the morning digest for an
-- account nobody will ever finish. An operator now marks such a clinic, by
-- id, with a reason from a closed list; the watch, its waves, Home's
-- decision row and the digest's Lifecycle block leave it out. Nothing else
-- does: its calendar, voice and billing alerts still arrive, and it stays on
-- the Clinics table.
--
--   lifecycle_ignored_clinics  one row per billing clinic an operator has
--                              set: ignored or not, the closed reason, who
--                              and when. Flipped, never deleted, so the
--                              runtime role has no DELETE.
--
-- No patient: an id, a boolean, a closed word, the operator's label and a
-- date. On the read-only role's list (scripts/readonly-tables.ts) and kept
-- for good when an account closes, beside clinic_lifecycle, whose silence
-- it explains (lib/offboarding/account-closure.ts KEPT_FOR_GOOD).
--
-- Safe to apply in place: one new, empty table.
-- =============================================================================

REVOKE ALL ON lifecycle_ignored_clinics FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON lifecycle_ignored_clinics TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (ignored, note, set_by, set_at) ON lifecycle_ignored_clinics TO healdesk_app;--> statement-breakpoint

ALTER TABLE lifecycle_ignored_clinics ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE lifecycle_ignored_clinics FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY lifecycle_ignored_clinics_tenant_isolation ON lifecycle_ignored_clinics
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'lifecycle_ignored_clinics'::regclass, 'DELETE')
     OR has_column_privilege('healdesk_app'::name, 'lifecycle_ignored_clinics'::regclass, 'clinic_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can delete or move an ignore-list row.';
  END IF;
END;
$$;
