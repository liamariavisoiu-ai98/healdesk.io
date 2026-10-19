CREATE TABLE "incident_affected_contacts" (
	"clinic_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_affected_contacts_incident_id_contact_id_pk" PRIMARY KEY("incident_id","contact_id"),
	CONSTRAINT "incident_affected_contacts_recorded_by_check" CHECK (char_length(btrim("incident_affected_contacts"."recorded_by")) between 1 and 320)
);
--> statement-breakpoint
ALTER TABLE "agreement_resigns" DROP CONSTRAINT "agreement_resigns_reason_check";--> statement-breakpoint
ALTER TABLE "agreement_resigns" DROP CONSTRAINT "agreement_resigns_source_check";--> statement-breakpoint
ALTER TABLE "site_rereads" DROP CONSTRAINT "site_rereads_reason_check";--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_clinic_id_unique" UNIQUE("clinic_id","id");--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_clinic_id_unique" UNIQUE("clinic_id","id");--> statement-breakpoint
ALTER TABLE "incident_affected_contacts" ADD CONSTRAINT "incident_affected_contacts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_affected_contacts" ADD CONSTRAINT "incident_affected_contacts_incident_fk" FOREIGN KEY ("clinic_id","incident_id") REFERENCES "public"."incidents"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_affected_contacts" ADD CONSTRAINT "incident_affected_contacts_contact_fk" FOREIGN KEY ("clinic_id","contact_id") REFERENCES "public"."contacts"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_affected_contacts_clinic_idx" ON "incident_affected_contacts" USING btree ("clinic_id","incident_id");--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_reason_check" CHECK ("agreement_resigns"."reason" in ('now_covered', 'not_sure', 'baa_version'));--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_source_check" CHECK ("agreement_resigns"."source" in ('operator', 'portal', 'release'));--> statement-breakpoint
ALTER TABLE "site_rereads" ADD CONSTRAINT "site_rereads_reason_check" CHECK ("site_rereads"."reason" in ('missing', 'corrected', 'drift', 'ops', 'insurance'));--> statement-breakpoint

-- =============================================================================
-- Agreements (wave 2, package R11; plan Part L, Annex X5 L22 and L29). The
-- statements above were generated from schema.ts, with the two unique keys
-- moved ahead of the foreign keys that reference them; everything below is
-- the part drizzle cannot express.
--
-- Three things, each its own section:
--
--   1. agreement_resigns takes a second kind of re-sign, `baa_version`: a
--      practice whose Business Associate Agreement in force is an older
--      version than the current one signs the current one through WP9's
--      row, link, screen and L22 reminders (lib/agreements/resign.ts), and
--      the hourly job opens one by itself (`release`) when a release has
--      left the version in force below the floor go-live accepts
--      (app_baa_version_acceptable). app_supersede_agreement() (0051)
--      already takes a BAA replacing an older BAA, and still refuses a DPA
--      replacing anything, so it is unchanged. The one change to the row's
--      rules: `paused_at` may be set once, from NULL, while the re-sign is
--      still open. A re-sign the broadcast opened on a version still
--      acceptable pauses nothing; if a later release moves the floor past
--      that version before it is signed, the hourly job pauses AYA then, and
--      records that pause on the row so signing lifts it and nothing else.
--   2. site_rereads takes the misclassification check (`insurance`,
--      lib/website/types.ts): a read for one purpose only, which the CHECK
--      above now admits. Nothing else about the table changes.
--   3. incident_affected_contacts: who an incident affected, recorded by the
--      operator from the app's own shell by contact id (ops:incident-
--      affected), and read by the practice on the incident's page behind the
--      passkey step-up (L29: "The list of individuals is never emailed. It
--      sits on a page behind step-up."). PHI by what it says, so tenant RLS,
--      FORCEd, and the BAA gate; append-only but for removing a contact
--      named in error; covered by destruction, and by erasure and the purge
--      through its foreign keys' cascade from contacts.
--
-- Safe to apply in place: two CHECKs widened, two unique keys on columns
-- already unique, a new empty table, a trigger function and the destruction
-- check redefined, one more column grant. apps/app has only ever held
-- synthetic and seed data (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. agreement_resigns: a pause gained once, while open
-- -----------------------------------------------------------------------------
-- 0088's guard, with paused_at allowed to go from NULL to a value on a row
-- that is open and stays open. Never from one value to another, never back
-- to NULL, and never on a closed row (the second rule below, unchanged).
CREATE OR REPLACE FUNCTION app_agreement_resign_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.from_agreement_id IS DISTINCT FROM OLD.from_agreement_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'agreement_resigns: which clinic, which agreement, why, who asked and when are fixed once opened.';
  END IF;
  IF NEW.paused_at IS DISTINCT FROM OLD.paused_at
     AND NOT (OLD.paused_at IS NULL AND NEW.paused_at IS NOT NULL
              AND OLD.status = 'open' AND NEW.status = 'open') THEN
    RAISE EXCEPTION 'agreement_resigns: the pause is recorded once, while the re-sign is open, and never moved.';
  END IF;
  IF OLD.status <> 'open' AND ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    RAISE EXCEPTION 'agreement_resigns: a % re-sign is final.', OLD.status;
  END IF;
  IF OLD.status = 'open' AND NEW.status NOT IN ('open', 'signed', 'withdrawn') THEN
    RAISE EXCEPTION 'agreement_resigns: open cannot become %.', NEW.status;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

GRANT UPDATE (paused_at) ON agreement_resigns TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. incident_affected_contacts: tenant-scoped, forced, behind the BAA gate
-- -----------------------------------------------------------------------------
ALTER TABLE incident_affected_contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE incident_affected_contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY incident_affected_contacts_tenant_isolation ON incident_affected_contacts
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- 0003's default privileges handed the runtime role all four verbs. It keeps
-- three: a list is read, added to, and has a contact named in error taken
-- off it; a row is never rewritten.
REVOKE ALL ON incident_affected_contacts FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON incident_affected_contacts TO healdesk_app;--> statement-breakpoint

CREATE TRIGGER incident_affected_contacts_baa_gate
  BEFORE INSERT OR UPDATE ON incident_affected_contacts
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- recorded_at is the database's clock, whatever the writer sent; a service
-- complaint is no agreement's to report, so it affects no one on this list;
-- and no role rewrites a row. Invoker rights: the incident is read under the
-- caller's tenant, which the composite foreign key has already tied the row
-- to.
CREATE OR REPLACE FUNCTION app_incident_affected_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.recorded_at := clock_timestamp();
    IF EXISTS (SELECT 1 FROM incidents i
                WHERE i.id = NEW.incident_id
                  AND i.clinic_id = NEW.clinic_id
                  AND i.class = 'service_complaint') THEN
      RAISE EXCEPTION 'incident_affected_contacts: a service complaint affects no one an agreement reports'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'incident_affected_contacts: a row is never changed; remove a contact named in error and add the right one'
    USING ERRCODE = '42501';
END
$$;--> statement-breakpoint
CREATE TRIGGER incident_affected_contacts_guard
  BEFORE INSERT OR UPDATE ON incident_affected_contacts
  FOR EACH ROW EXECUTE FUNCTION app_incident_affected_guard();--> statement-breakpoint
REVOKE ALL ON FUNCTION app_incident_affected_guard() FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction: the list goes with the clinic's data
-- -----------------------------------------------------------------------------
-- 0092's definition (handovers) with incident_affected_contacts added to the
-- rows destruction must have deleted before the clinic is stamped destroyed.
-- destroyClinicData deletes the list before the contacts it names
-- (lib/offboarding/offboarding.ts); the foreign key's cascade would take it
-- with them anyway, and this check is what says so to a destruction that
-- reached neither.
--
-- Written through EXECUTE so that it carries, as literal checks, the two
-- tables wave 2's batch C adds when they exist (conversation_flags,
-- patient_requests; their own migrations redefine this function and land
-- before this one), and leaves them out where they do not: a plpgsql body
-- naming a table that does not exist fails on its first call. Whichever
-- lands, the function stored is plain text the destruction-coverage test
-- (tests/booking-request-destruction.test.ts) reads, one EXISTS per table.
DO $migration$
DECLARE
  extra text := '';
BEGIN
  IF to_regclass('public.conversation_flags') IS NOT NULL THEN
    extra := extra || E'\n     OR EXISTS (SELECT 1 FROM conversation_flags cf WHERE cf.clinic_id = target_clinic)';
  END IF;
  IF to_regclass('public.patient_requests') IS NOT NULL THEN
    extra := extra || E'\n     OR EXISTS (SELECT 1 FROM patient_requests pq WHERE pq.clinic_id = target_clinic)';
  END IF;
  EXECUTE format($fn$
CREATE OR REPLACE FUNCTION app_mark_clinic_destroyed(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $body$
DECLARE
  tenant uuid := app_current_clinic_id();
  done timestamptz;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_mark_clinic_destroyed: clinic %% is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  -- The clinic's row first, FOR UPDATE, so a deletion request recorded
  -- concurrently (erasure_requests_guard reads the row FOR SHARE) either
  -- commits before the checks below, which then see it and refuse, or waits
  -- for the stamp and is refused itself. Review of 12 October 2026.
  PERFORM 1 FROM clinics c WHERE c.id = target_clinic FOR UPDATE;

  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic %% is not due for destruction; refusing to mark it destroyed.', target_clinic
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
     OR EXISTS (SELECT 1 FROM incident_affected_contacts ia WHERE ia.clinic_id = target_clinic)%s THEN
    RAISE EXCEPTION 'Clinic %% still holds rows that destruction deletes; refusing to mark it destroyed.', target_clinic
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
$body$
$fn$, extra);
END
$migration$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE incident_affected_contacts IS
  'Who an incident affected: one row per contact the operator named from the app''s shell (ops:incident-affected), by id. Read by the practice on the incident''s page behind the passkey step-up, never emailed (L29). PHI by what it says: tenant RLS, forced, and the BAA gate. Nothing but ids and who recorded it; the person is the contact named, whose own clock, erasure and destruction take this row with them (both foreign keys cascade).';--> statement-breakpoint
COMMENT ON COLUMN agreement_resigns.reason IS
  'now_covered or not_sure: a DPA practice''s answer stopped the DPA covering it. baa_version (0097): the BAA in force is older than the current version.';--> statement-breakpoint
COMMENT ON COLUMN agreement_resigns.paused_at IS
  'The header pause this re-sign put on AYA, or NULL when it put none (she was already paused, or a baa_version re-sign whose version go-live still accepts). Set once from NULL while open, when a release moves the floor past a version a re-sign is waiting on (0097); never moved.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092) and the list of who an incident affected (0097), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c
           WHERE c.oid = 'incident_affected_contacts'::regclass) THEN
    RAISE EXCEPTION 'incident_affected_contacts must force row-level security.';
  END IF;
  IF has_table_privilege('healdesk_app', 'incident_affected_contacts', 'UPDATE')
     OR NOT has_table_privilege('healdesk_app', 'incident_affected_contacts', 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app adds to and removes from incident_affected_contacts, and never rewrites a row.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE t.tgrelid = 'incident_affected_contacts'::regclass
                    AND t.tgname = 'incident_affected_contacts_baa_gate') THEN
    RAISE EXCEPTION 'incident_affected_contacts must sit behind the BAA gate.';
  END IF;
  IF has_column_privilege('healdesk_app', 'agreement_resigns', 'reason', 'UPDATE')
     OR has_column_privilege('healdesk_app', 'agreement_resigns', 'from_agreement_id', 'UPDATE')
     OR NOT has_column_privilege('healdesk_app', 'agreement_resigns', 'paused_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app may record a re-sign''s pause, and never rewrite why it opened or what it replaces.';
  END IF;
END;
$$;
