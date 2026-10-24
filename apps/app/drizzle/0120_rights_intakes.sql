CREATE TABLE "rights_intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"request_key" uuid NOT NULL,
	"kind" text NOT NULL,
	"asked_for" text,
	"received_on" date NOT NULL,
	"verified_via" text NOT NULL,
	"due_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"linked_record_id" uuid,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "rights_intakes_request_key" UNIQUE("clinic_id","request_key"),
	CONSTRAINT "rights_intakes_kind_check" CHECK ("rights_intakes"."kind" in ('erasure', 'amendment', 'correction', 'export', 'patient_request')),
	CONSTRAINT "rights_intakes_verified_via_check" CHECK ("rights_intakes"."verified_via" in ('notice_address', 'phone_confirmed', 'unverified')),
	CONSTRAINT "rights_intakes_status_check" CHECK ("rights_intakes"."status" in ('open', 'done', 'not_applicable')),
	CONSTRAINT "rights_intakes_asked_for_check" CHECK (("rights_intakes"."kind" = 'patient_request') = ("rights_intakes"."asked_for" is not null)
        and ("rights_intakes"."asked_for" is null or "rights_intakes"."asked_for" in ('access', 'amendment', 'accounting', 'deletion', 'other'))),
	CONSTRAINT "rights_intakes_closed_check" CHECK (("rights_intakes"."status" = 'open') = ("rights_intakes"."closed_at" is null)),
	CONSTRAINT "rights_intakes_due_check" CHECK ("rights_intakes"."due_on" between "rights_intakes"."received_on" + 5 and "rights_intakes"."received_on" + 14),
	CONSTRAINT "rights_intakes_text_check" CHECK (char_length("rights_intakes"."recorded_by") between 1 and 64
        and ("rights_intakes"."kind" || ' ' || coalesce("rights_intakes"."asked_for", '') || ' ' || "rights_intakes"."verified_via" || ' ' || "rights_intakes"."status" || ' ' || "rights_intakes"."recorded_by") !~ '[@]|[0-9]{3,}')
);
--> statement-breakpoint
ALTER TABLE "rights_intakes" ADD CONSTRAINT "rights_intakes_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rights_intakes_linked_key" ON "rights_intakes" USING btree ("clinic_id","kind","linked_record_id") WHERE "rights_intakes"."linked_record_id" is not null;--> statement-breakpoint
CREATE INDEX "rights_intakes_open_idx" ON "rights_intakes" USING btree ("clinic_id","due_on") WHERE "rights_intakes"."status" = 'open';
--> statement-breakpoint
-- =============================================================================
-- The patient-rights tracker (24 October 2026; ops automation Phase 6, lane
-- P6c, design E6 item 16). The statements above were generated from
-- schema.ts; everything below is the part drizzle cannot express.
--
-- A patient may ask a practice (and so us, its business associate) to erase,
-- amend or export their record, or ask us directly and be passed on. The
-- agreement gives ten business days for an erasure, an amendment and an
-- export, and five for passing a request on (lib/rights/clocks.ts). Until
-- now each clinic's requests were on its own Care tab and nothing listed the
-- open ones across clinics with their clocks; worse, a request that arrives
-- as words has no route on the AWS host that turns the person into a
-- contact id (docs/handover.md, "Deletion requests"), so it was tracked
-- nowhere until it could run.
--
--   rights_intakes  one row per request as it reached us, under the key the
--                   console's form generated once when it opened (a retried
--                   submit is the same key; two people's same-day requests
--                   of one kind are two keys): the clinic, the
--                   kind, what a patient asked for (a patient_request only),
--                   the day received, how it was verified, the due day the
--                   kind's clock gives, the status, the record it became
--                   when it was recorded after it, the operator's label and
--                   the dates. Opened by recordRightsIntake, closed once by
--                   closeRightsIntake; never deleted, so the runtime role
--                   has no DELETE and may update only the status.
--
-- No patient: ids, closed words and dates, and the text check refuses `@`
-- and any run of three digits in every text column, so no address or number
-- can be written into one. Withheld from the read-only role beside
-- erasure_requests and patient_requests (scripts/readonly-tables.ts): it
-- says that a patient of the clinic exercised a right, and when. Kept for
-- good when an account closes, beside incidents (lib/offboarding/
-- account-closure.ts KEPT_FOR_GOOD): it is the record that the agreement's
-- clocks were kept.
--
-- The tracker's daily job, rights-watch, is seeded OFF like every job the
-- owner switches on: it only tells ops, never a clinic or a patient.
--
-- Safe to apply in place: one new, empty table and one job row.
-- =============================================================================

CREATE OR REPLACE FUNCTION rights_intakes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- The database's clock, and every intake born open.
    NEW.recorded_at := clock_timestamp();
    NEW.status := 'open';
    NEW.closed_at := NULL;
    IF NEW.received_on > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1 THEN
      RAISE EXCEPTION 'rights_intakes: a request cannot be received after today';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'rights_intakes: intake % is already closed', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.asked_for IS DISTINCT FROM OLD.asked_for
     OR NEW.received_on IS DISTINCT FROM OLD.received_on
     OR NEW.verified_via IS DISTINCT FROM OLD.verified_via
     OR NEW.due_on IS DISTINCT FROM OLD.due_on
     OR NEW.linked_record_id IS DISTINCT FROM OLD.linked_record_id
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'rights_intakes: only the status of an intake changes';
  END IF;
  IF NEW.status = 'open' THEN
    NEW.closed_at := NULL;
  ELSE
    NEW.closed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER rights_intakes_guard
  BEFORE INSERT OR UPDATE ON rights_intakes
  FOR EACH ROW EXECUTE FUNCTION rights_intakes_guard();--> statement-breakpoint

REVOKE ALL ON rights_intakes FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON rights_intakes TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (status, closed_at) ON rights_intakes TO healdesk_app;--> statement-breakpoint

ALTER TABLE rights_intakes ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE rights_intakes FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY rights_intakes_tenant_isolation ON rights_intakes
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('rights-watch', 'Daily; tells ops, once each, about every patient-rights request that cannot run on the host yet, that is due within two business days, or that is past its day. Sends nothing to a clinic or a patient. Off until the owner switches it on', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'rights_intakes'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'rights_intakes'::regclass, 'TRUNCATE')
     OR has_column_privilege('healdesk_app'::name, 'rights_intakes'::regclass, 'clinic_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'rights_intakes'::regclass, 'request_key', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'rights_intakes'::regclass, 'kind', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'rights_intakes'::regclass, 'linked_record_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'rights_intakes'::regclass, 'due_on', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can delete an intake or change more than its status.';
  END IF;
END;
$$;
