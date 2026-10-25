CREATE TABLE "incident_checklist_ticks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"step" text NOT NULL,
	"affected_count" integer,
	"batch_key" text,
	"ticked_by" text NOT NULL,
	"ticked_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "incident_checklist_ticks_step_key" UNIQUE("incident_id","step"),
	CONSTRAINT "incident_checklist_ticks_step_check" CHECK ("incident_checklist_ticks"."step" in ('contain', 'open', 'preserve_ids', 'investigate', 'notify_email', 'notify_phone', 'affected_list_recorded', 'help_clinic', 'resolve')),
	CONSTRAINT "incident_checklist_ticks_count_check" CHECK (("incident_checklist_ticks"."step" = 'affected_list_recorded') = ("incident_checklist_ticks"."affected_count" is not null) and ("incident_checklist_ticks"."affected_count" is null or "incident_checklist_ticks"."affected_count" >= 0)),
	CONSTRAINT "incident_checklist_ticks_batch_check" CHECK ("incident_checklist_ticks"."batch_key" is null or ("incident_checklist_ticks"."step" = 'open' and "incident_checklist_ticks"."batch_key" ~ '^(vendor|channel):[a-z_]{1,40}:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z:[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z:[a-z_]{1,40}$')),
	CONSTRAINT "incident_checklist_ticks_by_check" CHECK (char_length("incident_checklist_ticks"."ticked_by") between 3 and 200 and "incident_checklist_ticks"."ticked_by" ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$')
);
--> statement-breakpoint
ALTER TABLE "ops_approvals" DROP CONSTRAINT "ops_approvals_kind_check";--> statement-breakpoint
ALTER TABLE "incident_checklist_ticks" ADD CONSTRAINT "incident_checklist_ticks_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_checklist_ticks" ADD CONSTRAINT "incident_checklist_ticks_incident_fk" FOREIGN KEY ("clinic_id","incident_id") REFERENCES "public"."incidents"("clinic_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incident_checklist_ticks_batch_key" ON "incident_checklist_ticks" USING btree ("clinic_id","batch_key") WHERE "incident_checklist_ticks"."batch_key" is not null;--> statement-breakpoint
CREATE INDEX "incident_checklist_ticks_clinic_idx" ON "incident_checklist_ticks" USING btree ("clinic_id","incident_id");--> statement-breakpoint
ALTER TABLE "ops_approvals" ADD CONSTRAINT "ops_approvals_kind_check" CHECK ("ops_approvals"."kind" in ('billing_request_retry', 'overage_invoice_retry', 'billing_event_replay', 'incident_open_batch', 'incident_report_send'));--> statement-breakpoint
-- =============================================================================
-- The incident assistant (25 October 2026; ops automation Phase 6, lane P6i;
-- design E6 §3 item 17; owner decision D18). The statements above were
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- When a vendor tells us about an incident, the owner has to work out which
-- clinics it reached, open an incident at each, tell each within its
-- agreement's clock by email and by phone, and keep a record of every step.
-- Until now that was done from memory and the audit log. Two things change
-- here:
--
--   incident_checklist_ticks  one row per step of docs/incident-response.md's
--                             procedure ticked on an incident (contain, open,
--                             preserve the ids, investigate, notify by email,
--                             notify by phone, the affected list recorded,
--                             help the clinic, resolve), with when and the
--                             operator account that ticked it. Add-only: the
--                             runtime role holds SELECT and INSERT, and a
--                             trigger refuses UPDATE and DELETE for every
--                             role, the migrator included (ENABLE ALWAYS).
--                             TRUNCATE is not refused by trigger, unlike
--                             ops_approval_events, because the table hangs off
--                             incidents and clinics: the test harness empties
--                             them with TRUNCATE ... CASCADE, and the runtime
--                             role holds no TRUNCATE. No free text: a step
--                             code, the operator's address (checked to be one
--                             address and nothing else), the count of people
--                             the incident's list named when that step was
--                             ticked, and for an `open` tick written by an
--                             approved batch, the scope's key, which a partial
--                             unique index makes open each clinic's incident
--                             once per scope, ever. A tenant table under
--                             FORCE RLS like incidents, and kept for good
--                             with them (lib/offboarding/account-closure.ts).
--   ops_approvals_kind_check  two new kinds, incident_open_batch (one item
--                             that opens an incident at each clinic of an
--                             approved scope) and incident_report_send (the
--                             L29 report, pre-filled from fixed lists, sent
--                             only on the owner's yes with a fresh code).
--                             0119's triggers are untouched: a proposal stays
--                             fixed once made and only its status moves.
--
-- Nothing here sends, opens, marks or closes anything by itself.
--
-- Safe to apply in place: one new, empty table and a wider CHECK.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_incident_checklist_ticks_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The database's clock, never the caller's.
    NEW.ticked_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incident_checklist_ticks is add-only: % is refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_incident_checklist_ticks_guard() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER incident_checklist_ticks_guard
  BEFORE INSERT OR UPDATE OR DELETE ON incident_checklist_ticks
  FOR EACH ROW EXECUTE FUNCTION app_incident_checklist_ticks_guard();--> statement-breakpoint
ALTER TABLE incident_checklist_ticks ENABLE ALWAYS TRIGGER incident_checklist_ticks_guard;--> statement-breakpoint

REVOKE ALL ON incident_checklist_ticks FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON incident_checklist_ticks TO healdesk_app;--> statement-breakpoint

ALTER TABLE incident_checklist_ticks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE incident_checklist_ticks FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY incident_checklist_ticks_tenant_isolation ON incident_checklist_ticks
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

COMMENT ON TABLE incident_checklist_ticks IS
  'Add-only checklist of an incident''s procedure (docs/incident-response.md): a step code, when it was ticked by the database''s clock, and the operator account that ticked it; the count of people the incident''s list named when the affected-list step was ticked; and, for an open tick from an approved batch, the vendor or channel scope''s key, unique per clinic. UPDATE and DELETE refused for every role by an ENABLE ALWAYS trigger; the runtime role may only read and add. No patient and no free text. Kept for good with the incidents (drizzle/0124).';--> statement-breakpoint

DO $$
DECLARE
  trig record;
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'incident_checklist_ticks'::regclass, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR has_any_column_privilege('healdesk_app'::name, 'incident_checklist_ticks'::regclass, 'UPDATE')
     OR NOT has_table_privilege('healdesk_app'::name, 'incident_checklist_ticks'::regclass, 'SELECT, INSERT') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite or erase an incident''s checklist, or cannot read and add to it.';
  END IF;
  SELECT t.tgenabled INTO trig FROM pg_trigger t WHERE t.tgname = 'incident_checklist_ticks_guard';
  IF NOT FOUND OR trig.tgenabled <> 'A' THEN
    RAISE EXCEPTION 'the incident checklist guard trigger is missing or not ENABLE ALWAYS';
  END IF;
END;
$$;
