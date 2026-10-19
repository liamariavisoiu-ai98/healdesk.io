CREATE TABLE "patient_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"contact_id" uuid,
	"contact_named" boolean DEFAULT false NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"reply_by" date NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" text,
	CONSTRAINT "patient_requests_kind_check" CHECK ("patient_requests"."kind" in ('access', 'amendment', 'accounting', 'deletion', 'other')),
	CONSTRAINT "patient_requests_recorded_by_check" CHECK (char_length(btrim("patient_requests"."recorded_by")) between 1 and 320),
	CONSTRAINT "patient_requests_received_check" CHECK ("patient_requests"."received_at" <= "patient_requests"."recorded_at"),
	CONSTRAINT "patient_requests_contact_check" CHECK ("patient_requests"."contact_id" is null or "patient_requests"."contact_named"),
	CONSTRAINT "patient_requests_reply_by_check" CHECK ("patient_requests"."reply_by" between ("patient_requests"."received_at" at time zone 'UTC')::date + 4 and ("patient_requests"."received_at" at time zone 'UTC')::date + 8),
	CONSTRAINT "patient_requests_acknowledged_check" CHECK (("patient_requests"."acknowledged_at" is null) = ("patient_requests"."acknowledged_by" is null)
        and ("patient_requests"."acknowledged_by" is null or char_length(btrim("patient_requests"."acknowledged_by")) between 1 and 200))
);
--> statement-breakpoint
ALTER TABLE "patient_requests" ADD CONSTRAINT "patient_requests_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "patient_requests_open_idx" ON "patient_requests" USING btree ("clinic_id","reply_by") WHERE "patient_requests"."acknowledged_at" is null;--> statement-breakpoint
CREATE INDEX "patient_requests_contact_idx" ON "patient_requests" USING btree ("clinic_id","contact_id") WHERE "patient_requests"."contact_id" is not null;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_clinic_id_unique" UNIQUE("clinic_id","id");--> statement-breakpoint

-- =============================================================================
-- L32, a request from a patient (Annex X5 of the funnel and portal plan; BAA
-- 1.5.1 clause 14, last paragraph). The statements above were generated from
-- schema.ts; everything below is the part drizzle cannot express.
--
-- The failure. The BAA says that when a patient asks healdesk itself, rather
-- than the practice, to see, correct, account for or delete their
-- information, "healdesk will not act on it. It will pass the request to
-- Practice within five business days". Nothing held such a request: L32 was
-- a kind in the outbox's CHECK with no table, no template and no way to
-- queue it, the duty was met by hand with nothing to show it had been, and
-- Gate B's live set held every go-live for it (gate_b_not_built).
--
-- What changes:
--
--   * patient_requests holds each one: what was asked (a closed kind), the
--     contact it is about when the operator can name one (and whether one
--     was named, which outlasts the contact), when it reached
--     healdesk, the day it must be passed on by (reply_by, the fifth business
--     day), who recorded it and when, and the practice's mark that it has
--     it (acknowledged_at and the device it was marked from). No name, no
--     number, no address and nothing typed: the person is the contact it
--     names. It is PHI while it names one, so it is tenant-scoped, FORCEd,
--     and behind the BAA gate.
--   * The contact is named by (clinic_id, contact_id), against the new
--     (clinic_id, id) key on contacts, so a request can name only a contact
--     of its own clinic, whatever the writer sends. When the contact goes,
--     by the practice's deletion (app_erase_contacts) or the purge's clock,
--     the foreign key sets contact_id alone to NULL: the request stays as a
--     record without the person, and erasure needs no change to find it.
--   * The runtime role may SELECT, INSERT and DELETE (the purge and
--     destruction), and UPDATE only the two acknowledgement columns. A guard
--     makes recorded_at and acknowledged_at the database's clock, refuses any
--     other change to a row from any role, save the foreign key's own
--     clearing of contact_id, and lets the acknowledgement be added once.
--     Like the erasure and amendment guards, a data-only restore turns it
--     off by name for the load (docs/handover.md, "Restoring"), or it would
--     restamp recorded_at and refuse every request already marked received.
--   * app_open_patient_requests() lists the requests no one has marked
--     received, ids only, across clinics, for the hourly sweep's reminders
--     and ops alerts (lib/patient-rights/patient-requests.ts).
--   * app_mark_clinic_destroyed() is 0093's definition (which added
--     conversation_flags) with patient_requests added to the tables it
--     requires empty; destroyClinicData deletes them.
--
-- Safe to apply in place: a new, empty table with its key, policy, grants,
-- triggers and one function; a unique key on contacts over columns already
-- unique (its id); and one redefinition keeping every check it had, its UTC
-- pin and its pinned search_path. apps/app has only ever held synthetic and
-- seed data (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The table: tenant-scoped, forced, behind the BAA gate
-- -----------------------------------------------------------------------------
ALTER TABLE patient_requests
  ADD CONSTRAINT patient_requests_contact_fk FOREIGN KEY (clinic_id, contact_id)
  REFERENCES contacts (clinic_id, id) ON DELETE SET NULL (contact_id);--> statement-breakpoint

ALTER TABLE patient_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE patient_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY patient_requests_tenant_isolation ON patient_requests
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- 0003's default privileges handed the runtime role all four verbs. It keeps
-- reading, recording and deleting (the purge, destruction), and of updates
-- only the practice's mark.
REVOKE ALL ON patient_requests FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON patient_requests TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (acknowledged_at, acknowledged_by) ON patient_requests TO healdesk_app;--> statement-breakpoint

CREATE TRIGGER patient_requests_baa_gate
  BEFORE INSERT OR UPDATE ON patient_requests
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- recorded_at and acknowledged_at are the database's clock, whatever the
-- writer sent, and contact_named says whether a contact was named at the
-- insert, so a page can still tell, once the contact has gone, that one was. A request is never rewritten: the only changes a row takes
-- are its acknowledgement, once, and the foreign key's clearing of
-- contact_id when the contact goes (an UPDATE that runs as the table's owner,
-- so the guard, not a grant, is what allows it).
CREATE OR REPLACE FUNCTION app_patient_request_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.recorded_at := clock_timestamp();
    NEW.contact_named := NEW.contact_id IS NOT NULL;
    IF NEW.received_at > NEW.recorded_at THEN
      NEW.received_at := NEW.recorded_at;
    END IF;
    IF NEW.acknowledged_at IS NOT NULL OR NEW.acknowledged_by IS NOT NULL THEN
      RAISE EXCEPTION 'patient_requests: a request is recorded unacknowledged; the practice marks it received'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.contact_named IS DISTINCT FROM OLD.contact_named
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.reply_by IS DISTINCT FROM OLD.reply_by
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR (NEW.contact_id IS DISTINCT FROM OLD.contact_id AND NEW.contact_id IS NOT NULL) THEN
    RAISE EXCEPTION 'patient_requests: a request is never rewritten; only its acknowledgement is added, once'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.acknowledged_at IS NOT NULL THEN
    IF NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at
       OR NEW.acknowledged_by IS DISTINCT FROM OLD.acknowledged_by THEN
      RAISE EXCEPTION 'patient_requests: a request is marked received once'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.acknowledged_by IS NOT NULL THEN
    NEW.acknowledged_at := clock_timestamp();
  ELSIF NEW.acknowledged_at IS NOT NULL THEN
    RAISE EXCEPTION 'patient_requests: a mark names the device it was made from'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER patient_requests_guard
  BEFORE INSERT OR UPDATE ON patient_requests
  FOR EACH ROW EXECUTE FUNCTION app_patient_request_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The open requests, across clinics, ids only
-- -----------------------------------------------------------------------------
-- For the hourly sweep: its reminders to the practice and its ops alerts as
-- the five business days run out. FORCE row-level security binds the owner
-- too, so it walks the clinics with the tenant set per clinic, as
-- app_open_agreement_resigns() does (0088), and restores the setting. A
-- clinic still offboarding owes the pass-on as long as it holds the request;
-- a destroyed one holds none.
CREATE OR REPLACE FUNCTION app_open_patient_requests()
RETURNS TABLE (clinic_id uuid, id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT cl.id FROM clinics cl WHERE cl.destroyed_at IS NULL ORDER BY cl.created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT r.clinic_id, r.id
        FROM patient_requests r
       WHERE r.clinic_id = c.id
         AND r.acknowledged_at IS NULL
       ORDER BY r.reply_by, r.id;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_open_patient_requests() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_open_patient_requests() TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction: the clinic's requests go with its data
-- -----------------------------------------------------------------------------
-- 0093's definition, the last before this one, with patient_requests added
-- to the tables it requires empty beside 0093's conversation_flags. Every
-- other check, the row lock, the UTC pin and the pinned search_path are as
-- they were.
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
     OR EXISTS (SELECT 1 FROM patient_requests pq WHERE pq.clinic_id = target_clinic) THEN
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

COMMENT ON TABLE patient_requests IS
  'A request a patient made to healdesk itself about their information at a practice (L32; BAA 1.5.1 clause 14): its kind, the contact it names (set to NULL when the contact goes), when it arrived, the day it must be passed on by, who recorded it, and the practice''s mark that it has it. No name, number, address or typed text. PHI while it names a contact: FORCE RLS and the BAA gate (0094).';--> statement-breakpoint
COMMENT ON FUNCTION app_open_patient_requests() IS
  'The patient requests no practice has marked received, as (clinic_id, id), across clinics not destroyed: for the hourly sweep''s reminders and ops alerts (lib/patient-rights/patient-requests.ts). Ids only (0094).';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092), the flags on conversations (0093) and the patient requests passed to it (0094), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';
