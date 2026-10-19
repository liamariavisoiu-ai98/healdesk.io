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
ALTER TABLE "incidents" ADD COLUMN "affected_recorded" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_clinic_id_unique" UNIQUE("clinic_id","id");--> statement-breakpoint
ALTER TABLE "incident_affected_contacts" ADD CONSTRAINT "incident_affected_contacts_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_affected_contacts" ADD CONSTRAINT "incident_affected_contacts_incident_fk" FOREIGN KEY ("clinic_id","incident_id") REFERENCES "public"."incidents"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_affected_contacts" ADD CONSTRAINT "incident_affected_contacts_contact_fk" FOREIGN KEY ("clinic_id","contact_id") REFERENCES "public"."contacts"("clinic_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_affected_contacts_clinic_idx" ON "incident_affected_contacts" USING btree ("clinic_id","incident_id");--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_baa_version_unpaused_check" CHECK ("agreement_resigns"."reason" <> 'baa_version' or "agreement_resigns"."paused_at" is null);--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_reason_check" CHECK ("agreement_resigns"."reason" in ('now_covered', 'not_sure', 'baa_version'));--> statement-breakpoint
ALTER TABLE "agreement_resigns" ADD CONSTRAINT "agreement_resigns_source_check" CHECK ("agreement_resigns"."source" in ('operator', 'portal', 'release'));--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_affected_recorded_check" CHECK ("incidents"."affected_recorded" >= 0);--> statement-breakpoint
ALTER TABLE "site_rereads" ADD CONSTRAINT "site_rereads_reason_check" CHECK ("site_rereads"."reason" in ('missing', 'corrected', 'drift', 'ops', 'insurance'));--> statement-breakpoint

-- =============================================================================
-- Agreements (wave 2, package R11; plan Part L, Annex X5 L22 and L29). The
-- statements above were generated from schema.ts, with incidents' unique
-- key moved ahead of the foreign key that references it (contacts' is
-- 0094's); everything below is the part drizzle cannot express.
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
--      replacing anything, so it is unchanged. A BAA-version re-sign never
--      pauses AYA (owner, 19 October 2026): the version signed governs until
--      the newer one is, so its paused_at is NULL by CHECK, and 0088's guard,
--      which fixes paused_at once written, is unchanged. The DPA→BAA re-sign
--      still pauses AYA, now at every location of the organisation, which
--      two definers below let a location read and the job reach.
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
--      through its foreign keys' cascade from contacts. Those cascades take
--      a person off the list with their contact, so the incident keeps the
--      count the operator recorded (incidents.affected_recorded, written
--      with each change to the list): the record of how many a breach
--      reached does not fall when one of them is erased.
--
-- Safe to apply in place: three CHECKs widened and two added that every row
-- passes, a column with a default, a unique key on columns already unique, a
-- new empty table, three new functions and the destruction check redefined.
-- apps/app has only ever held
-- synthetic and seed data (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The organisation's re-sign, for every location of it
-- -----------------------------------------------------------------------------
-- The agreement is the organisation's: one re-sign covers every location,
-- and a DPA→BAA re-sign pauses each of them, whose answer gate reads its own
-- clinic_settings. A location cannot see the account's re-sign
-- or its sibling clinics under the tenant policies, so these two definers
-- answer for the caller's own tenant only (app.clinic_id must be the clinic
-- asked about), in ids and contract facts, never a patient.
--
-- app_organisation_clinics: the clinic and every other clinic of its
-- organisation not yet destroyed, the clinic first. clinics is not forced, so
-- the definer, its owner, reads every row.
CREATE OR REPLACE FUNCTION app_organisation_clinics(target_clinic uuid)
RETURNS TABLE (clinic_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id
    FROM clinics c
    JOIN clinics t ON t.id = target_clinic AND t.organization_id = c.organization_id
   WHERE app_current_clinic_id() IS NOT DISTINCT FROM target_clinic
     AND c.destroyed_at IS NULL
   ORDER BY (c.id = target_clinic) DESC, c.created_at, c.id
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_organisation_clinics(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_organisation_clinics(uuid) TO healdesk_app;--> statement-breakpoint

-- app_organisation_open_resigns: the open re-signs of the organisation's
-- clinics, with the version of the agreement each replaces and whether
-- go-live still accepts it. agreement_resigns forces row-level security,
-- which binds the definer too, so it walks the clinics setting the tenant
-- for each, as 0088's app_open_agreement_resigns does, and gives the
-- caller's setting back.
CREATE OR REPLACE FUNCTION app_organisation_open_resigns(target_clinic uuid)
RETURNS TABLE (
  resign_id uuid,
  clinic_id uuid,
  reason text,
  paused_at timestamptz,
  started_at timestamptz,
  from_version text,
  from_version_acceptable boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  IF app_current_clinic_id() IS DISTINCT FROM target_clinic THEN
    RAISE EXCEPTION 'app_organisation_open_resigns: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;
  FOR c IN SELECT o.clinic_id AS id FROM app_organisation_clinics(target_clinic) o LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT r.id, r.clinic_id, r.reason, r.paused_at, r.started_at, b.document_version,
             coalesce(app_baa_version_acceptable(b.document_version), false)
        FROM agreement_resigns r
        LEFT JOIN baa_acceptances b ON b.id = r.from_agreement_id
       WHERE r.clinic_id = c.id
         AND r.status = 'open';
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_organisation_open_resigns(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_organisation_open_resigns(uuid) TO healdesk_app;--> statement-breakpoint

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

-- Destruction empties it, so a closed account takes no new row of it either
-- (0096's rule for every table destruction empties: an operator's script
-- cannot rebuild part of a closed account).
CREATE TRIGGER incident_affected_contacts_closed_account
  BEFORE INSERT OR UPDATE ON incident_affected_contacts
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint

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
-- 0094's definition (patient_requests) with incident_affected_contacts added
-- to the rows destruction must have deleted before the clinic is stamped
-- destroyed. destroyClinicData deletes the list before the contacts it names
-- (lib/offboarding/offboarding.ts); the foreign key's cascade would take it
-- with them anyway, and this check is what says so to a destruction that
-- reached neither.
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
     OR EXISTS (SELECT 1 FROM incident_affected_contacts ia WHERE ia.clinic_id = target_clinic) THEN
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

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE incident_affected_contacts IS
  'Who an incident affected: one row per contact the operator named from the app''s shell (ops:incident-affected), by id. Read by the practice on the incident''s page behind the passkey step-up, never emailed (L29). PHI by what it says: tenant RLS, forced, and the BAA gate. Nothing but ids and who recorded it; the person is the contact named, whose own clock, erasure and destruction take this row with them (both foreign keys cascade).';--> statement-breakpoint
COMMENT ON COLUMN agreement_resigns.reason IS
  'now_covered or not_sure: a DPA practice''s answer stopped the DPA covering it. baa_version (0098): the BAA in force is older than the current version.';--> statement-breakpoint
COMMENT ON COLUMN agreement_resigns.paused_at IS
  'The header pause a DPA→BAA re-sign put on AYA, or NULL when it put none (she was already paused). Always NULL for baa_version (0098): a newer BAA over an older one never pauses AYA (owner, 19 October 2026). Fixed once written (0088).';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092), the flags on conversations (0093), the patient requests passed to it (0094) and the list of who an incident affected (0098), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';--> statement-breakpoint

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
     OR has_column_privilege('healdesk_app', 'agreement_resigns', 'paused_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app never rewrites why a re-sign opened, what it replaces, or the pause it recorded.';
  END IF;
END;
$$;
