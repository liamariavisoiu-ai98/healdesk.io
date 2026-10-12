CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"requested_by" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"due_by" timestamp with time zone NOT NULL,
	"erased_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"deleted" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"restore_refs" text[] DEFAULT '{}'::text[] NOT NULL,
	"vendor_steps" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "erasure_requests_requested_by_check" CHECK (char_length(btrim("erasure_requests"."requested_by")) between 2 and 200),
	CONSTRAINT "erasure_requests_received_check" CHECK ("erasure_requests"."received_at" <= "erasure_requests"."erased_at"),
	CONSTRAINT "erasure_requests_due_check" CHECK ("erasure_requests"."due_by" > "erasure_requests"."received_at"),
	CONSTRAINT "erasure_requests_refs_check" CHECK (array_position("erasure_requests"."restore_refs", null) is null),
	CONSTRAINT "erasure_requests_vendor_steps_check" CHECK (jsonb_typeof("erasure_requests"."vendor_steps") = 'object' and ("erasure_requests"."vendor_steps" - 'retell') = '{}'::jsonb)
);
--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasure_requests_clinic_idx" ON "erasure_requests" USING btree ("clinic_id","erased_at");--> statement-breakpoint

-- =============================================================================
-- Deletion on request, recorded without the person (BAA 1.3.0 release gate 6;
-- SL-06, PT-18). The statements above were generated from schema.ts;
-- everything below is the part drizzle cannot express.
--
-- The failure, in one paragraph. Clause 4(c) of BAA 1.3.0, and item c of the
-- DPA's state-law clause, promise that a person's information is deleted
-- within ten business days of the request, "including the raw copies it
-- keeps of what other services sent it about that person", that each
-- subcontractor deletes its copy in time, and that healdesk keeps "only a
-- record of the request, for no longer than it needs one to make sure the
-- information stays deleted". Nothing an operator could reach deleted
-- anyone: eraseContact had no caller but its tests. It deleted the person's
-- contacts, calls, appointments and own booking requests, but not their raw
-- call payloads (webhook_events) or the keyed reference to their messaging
-- thread (chat_threads). And it wrote their telephone number into suppressions "so
-- the request itself is honoured forever": a copy of the number, kept with
-- no end, as the record of a request whose whole point was that nothing of
-- them be kept.
--
-- What changes:
--
--   * erasure_requests is the record: who asked by role or ticket, when, the
--     deadline, when the deletion ran, the counts, and the operator's stamp
--     for each subcontractor step. No number, address or name. Its only
--     reference to the person is restore_refs, keyed references
--     (lib/identifier-ref.ts) kept so a database restored to a point before
--     the deletion can be cleaned again; the hourly expiry empties them
--     BACKUP_RETENTION_DAYS (35) after the deletion, when the last backup
--     that held the person has expired, and deletes the row then unless a
--     subcontractor step is still outstanding. Nothing reads the table for a
--     contact decision.
--   * The erasure no longer writes suppressions. The person's own
--     suppressions, consent records and contact attempts go with them,
--     through app_erase_contact_evidence(), since the runtime role has no
--     DELETE on the three (0010), and is given none.
--   * A booking request goes only with the person it names, through
--     app_erase_contacts() (0054), as before. A messaging thread is the
--     person's own, and goes with its drafts and its chat_threads row, only
--     when everything it sent named them; a thread that also booked for
--     someone else (a parent booking for a child, and for themselves) keeps
--     what it sent for others, and the erasure says so by count
--     (lib/patient-rights/erasure.ts). The first version of this migration
--     had app_erase_thread_requests(), which deleted every request a thread
--     the person had touched ever sent, whoever each named: erasing a child
--     deleted the parent's own requests and the sibling's. It is gone, and
--     the only definers that delete a booking request are 0054's three again.
--   * app_mark_clinic_destroyed() requires erasure_requests empty too, since
--     destruction deletes them with the rest (the references in them are
--     derived from the clinic's patients).
--
-- What the runtime role can do with the new function, said plainly. With
-- app_erase_contact_evidence() it can delete a number's suppressions,
-- consent records and contact attempts, but only under the record of a
-- deletion request: one it writes in the same transaction, which then stands
-- as the request with its deadline and its subcontractor steps, or one whose
-- restore references have not expired, and then only what was recorded
-- before that deletion ran. 0058 kept the delete from it because a "stop" it
-- could delete would be one it could quietly undo; v1 contacts no one first,
-- and canContact() refuses every request before it reads a row, so nothing
-- that runs reads a "stop" to undo.
--
-- The record is written before the deletes, so the counts it keeps are
-- written last: `deleted` may change in the transaction that wrote the row,
-- and in no other (the guard below).
--
-- Safe to apply in place: a new table and one new function; the one
-- redefinition adds a table to a list. apps/app has only ever held synthetic
-- and seed data (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The table: tenant-scoped, forced, and append-only but for two columns
-- -----------------------------------------------------------------------------
ALTER TABLE erasure_requests ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE erasure_requests FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY erasure_requests_tenant_isolation ON erasure_requests
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- 0003's default privileges handed the runtime role all four verbs. It keeps
-- SELECT and INSERT (the erase path, the console), DELETE (the hourly expiry
-- and destruction), and UPDATE of the three columns the record changes after
-- it is written: the counts, set once in the transaction that wrote it, the
-- references, which are only ever emptied, and the subcontractor stamps,
-- which are only ever added (the trigger below says so to every role).
REVOKE ALL ON erasure_requests FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON erasure_requests TO healdesk_app;--> statement-breakpoint
GRANT UPDATE (deleted, restore_refs, vendor_steps) ON erasure_requests TO healdesk_app;--> statement-breakpoint

-- erased_at is the database's clock at the insert, whatever the writer sent:
-- the references' expiry runs from it, so a writer that could choose it could
-- keep them as long as it liked. After the insert: the counts written in the
-- same transaction (erasePerson records the request before it deletes, and
-- the counts once it has), references only ever emptied, stamps only ever
-- added, and nothing else moved.
CREATE OR REPLACE FUNCTION app_erasure_request_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.erased_at := clock_timestamp();
    RETURN NEW;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.received_at IS DISTINCT FROM OLD.received_at
     OR NEW.due_by IS DISTINCT FROM OLD.due_by
     OR NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
    RAISE EXCEPTION 'erasure_requests: the record of a request never changes; only its references are emptied and its subcontractor steps stamped'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.deleted IS DISTINCT FROM OLD.deleted AND OLD.erased_at < now() THEN
    RAISE EXCEPTION 'erasure_requests: the counts are written in the transaction that recorded the request, and never after'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.restore_refs IS DISTINCT FROM OLD.restore_refs AND cardinality(NEW.restore_refs) > 0 THEN
    RAISE EXCEPTION 'erasure_requests: restore references are only ever emptied'
      USING ERRCODE = '42501';
  END IF;
  IF NOT (NEW.vendor_steps @> OLD.vendor_steps) THEN
    RAISE EXCEPTION 'erasure_requests: a subcontractor step, once stamped, stays stamped'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER erasure_requests_guard
  BEFORE INSERT OR UPDATE ON erasure_requests
  FOR EACH ROW EXECUTE FUNCTION app_erasure_request_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- A person's suppressions, consent records and contact attempts
-- -----------------------------------------------------------------------------
-- The three carry nothing but a telephone number and what was done about it,
-- and the runtime role has no DELETE on them (0010), so an erasure deletes the
-- person's here. Only under the record of a deletion request: the call names
-- one, and the function refuses unless that record was written in this same
-- transaction (its erased_at is no earlier than the transaction's start), as
-- erasePerson writes it before it deletes anything, or still holds its
-- restore references, as reapplyErasures finds it after a restore. What goes
-- is what was recorded no later than the record's erased_at, so nothing the
-- person gave after asking for deletion is taken with the old. The first
-- version took a bare cutoff no later than the call, which passing now()
-- satisfied: with no deletion request at all, the runtime role deleted any
-- number's "stop", which 0058 had kept from it.
CREATE OR REPLACE FUNCTION app_erase_contact_evidence(
  erasure uuid,
  target_phones text[],
  OUT suppressions_deleted integer,
  OUT consent_records_deleted integer,
  OUT contact_attempts_deleted integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  phones text[] := coalesce(target_phones, '{}');
  recorded_before timestamptz;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_erase_contact_evidence: no tenant; an erasure runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT er.erased_at
    INTO recorded_before
    FROM erasure_requests er
   WHERE er.clinic_id = tenant
     AND er.id = erasure
     AND (er.erased_at >= now() OR cardinality(er.restore_refs) > 0);
  IF recorded_before IS NULL THEN
    RAISE EXCEPTION 'app_erase_contact_evidence: no deletion request % written in this transaction, or holding its restore references, at clinic %', erasure, tenant
      USING ERRCODE = '42501',
            HINT = 'erasePerson records the request before it deletes; reapplyErasures uses a record whose references have not expired.';
  END IF;

  DELETE FROM suppressions s
   WHERE s.clinic_id = tenant AND s.phone = ANY (phones) AND s.requested_at <= recorded_before;
  GET DIAGNOSTICS suppressions_deleted = ROW_COUNT;
  DELETE FROM consent_records c
   WHERE c.clinic_id = tenant AND c.phone = ANY (phones) AND c.granted_at <= recorded_before;
  GET DIAGNOSTICS consent_records_deleted = ROW_COUNT;
  DELETE FROM contact_attempts a
   WHERE a.clinic_id = tenant AND a.phone = ANY (phones) AND a.attempted_at <= recorded_before;
  GET DIAGNOSTICS contact_attempts_deleted = ROW_COUNT;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_erase_contact_evidence(uuid, text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_erase_contact_evidence(uuid, text[]) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction takes the records of deletion requests too
-- -----------------------------------------------------------------------------
-- 0058's definition, the last before this one, with erasure_requests added to
-- the tables it requires empty. Every table it checked before, it still
-- checks. tests/booking-request-destruction.test.ts reads the list from this
-- source and pins destroyClinicData's deletes to it.
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
     OR EXISTS (SELECT 1 FROM erasure_requests er WHERE er.clinic_id = target_clinic) THEN
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
COMMENT ON TABLE erasure_requests IS
  'One person''s deletion request, recorded without the person: who asked (a role or ticket), when it arrived, the ten-business-day deadline, when the deletion ran, the counts, and the operator''s stamp for each subcontractor step. restore_refs are keyed references to what the deletion found, used only to delete the person again after a restore and emptied 35 days (BACKUP_RETENTION_DAYS) after the deletion, when the row goes too unless a subcontractor step is still outstanding. Never read for a contact decision. erased_at is stamped by the database at the insert.';--> statement-breakpoint
COMMENT ON COLUMN erasure_requests.restore_refs IS
  'identifierRef values (erasure kind for "phone:"/"email:" values, chat_party for messaging threads) naming what the deletion found, so reapplyErasures can find the person again in a database restored to a point before it. Only ever emptied: by the hourly expiry, BACKUP_RETENTION_DAYS after erased_at.';--> statement-breakpoint
COMMENT ON FUNCTION app_erase_contact_evidence(uuid, text[]) IS
  'Deletes the tenant''s suppressions, consent records and contact attempts for the given numbers, recorded no later than the erased_at of the named deletion request, which must have been written in this transaction or still hold its restore references. For the erase path in lib/patient-rights/erasure.ts; the runtime role has no DELETE on the three. Returns the three counts.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: suppressions, consent records and contact attempts included, the setup screens, slot holds, providers and provider services 0056 and 0057 added, and the records of deletion requests (0059). Returns destroyed_at.';--> statement-breakpoint
COMMENT ON TABLE suppressions IS
  'Do-not-contact list: a NULL channel means every channel, and it outranks any consent record. The runtime role cannot delete a row; the person''s own erasure (app_erase_contact_evidence) and destruction (app_destroy_contact_evidence) do. An erasure writes nothing here: it is recorded in erasure_requests, without the number.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'erasure_requests'::regclass) THEN
    RAISE EXCEPTION 'Row-level security is not ENABLEd and FORCEd on erasure_requests.';
  END IF;

  SELECT string_agg(a.attname, ', ') INTO offending
    FROM pg_attribute a
   WHERE a.attrelid = 'erasure_requests'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname NOT IN ('deleted', 'restore_refs', 'vendor_steps')
     AND has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE an erasure_requests column other than deleted, restore_refs and vendor_steps: %', offending;
  END IF;
  IF has_table_privilege('healdesk_app'::name, 'erasure_requests'::regclass, 'TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'healdesk_app holds TRUNCATE, REFERENCES or TRIGGER on erasure_requests.';
  END IF;

  IF has_table_privilege('healdesk_app'::name, 'suppressions'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'consent_records'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'contact_attempts'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE suppressions, consent records, contact attempts or booking requests directly; only the definers may.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t
                  WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
                    AND t.tgrelid = 'erasure_requests'::regclass AND t.tgname = 'erasure_requests_guard') THEN
    RAISE EXCEPTION 'erasure_requests_guard is missing or disabled.';
  END IF;

  IF has_function_privilege('public', 'app_erase_contact_evidence(uuid, text[])', 'EXECUTE')
     OR has_function_privilege('public', 'app_mark_clinic_destroyed(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A SECURITY DEFINER function of this migration is executable by PUBLIC.';
  END IF;

  SELECT string_agg(p.proname, ', ') INTO offending
    FROM pg_proc p
   WHERE p.oid IN ('app_erase_contact_evidence(uuid, text[])'::regprocedure,
                   'app_mark_clinic_destroyed(uuid)'::regprocedure,
                   'app_erasure_request_guard()'::regprocedure)
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Function(s) without a pinned search_path: %', offending;
  END IF;
  IF NOT ('TimeZone=UTC' = ANY (coalesce((SELECT p.proconfig FROM pg_proc p WHERE p.oid = 'app_mark_clinic_destroyed(uuid)'::regprocedure), ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'app_mark_clinic_destroyed lost its TimeZone pin (drizzle/0058).';
  END IF;
END;
$$;
