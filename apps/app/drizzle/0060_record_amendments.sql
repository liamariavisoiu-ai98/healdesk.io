CREATE TABLE "record_amendments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"target_kind" text NOT NULL,
	"booking_request_id" uuid,
	"conversation_id" uuid,
	"appointment_id" uuid,
	"amendment" text NOT NULL,
	"requested_by" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"recorded_by" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "record_amendments_target_kind_check" CHECK ("record_amendments"."target_kind" in ('booking_request', 'conversation', 'appointment')),
	CONSTRAINT "record_amendments_target_check" CHECK (("record_amendments"."target_kind" = 'booking_request' and "record_amendments"."booking_request_id" is not null and "record_amendments"."conversation_id" is null and "record_amendments"."appointment_id" is null)
        or ("record_amendments"."target_kind" = 'conversation' and "record_amendments"."conversation_id" is not null and "record_amendments"."booking_request_id" is null and "record_amendments"."appointment_id" is null)
        or ("record_amendments"."target_kind" = 'appointment' and "record_amendments"."appointment_id" is not null and "record_amendments"."booking_request_id" is null and "record_amendments"."conversation_id" is null)),
	CONSTRAINT "record_amendments_amendment_check" CHECK (char_length(btrim("record_amendments"."amendment")) between 1 and 4000),
	CONSTRAINT "record_amendments_identifier_check" CHECK (regexp_replace(regexp_replace("record_amendments"."amendment", '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '', 'g'), '[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2}([.][0-9]+)?)?)?', '', 'g') !~ '[0-9]([ ().-]{0,2}[0-9]){9,}'
        and "record_amendments"."amendment" !~ '[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]{2,}'),
	CONSTRAINT "record_amendments_requested_by_check" CHECK (char_length(btrim("record_amendments"."requested_by")) between 2 and 200),
	CONSTRAINT "record_amendments_recorded_by_check" CHECK (char_length(btrim("record_amendments"."recorded_by")) between 1 and 320),
	CONSTRAINT "record_amendments_requested_check" CHECK ("record_amendments"."requested_at" <= "record_amendments"."recorded_at")
);
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_clinic_id_unique" UNIQUE("clinic_id","id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_clinic_id_unique" UNIQUE("clinic_id","id");--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_id_unique" UNIQUE("clinic_id","id");--> statement-breakpoint
ALTER TABLE "record_amendments" ADD CONSTRAINT "record_amendments_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_amendments" ADD CONSTRAINT "record_amendments_booking_request_fk" FOREIGN KEY ("clinic_id","booking_request_id") REFERENCES "public"."booking_requests"("clinic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_amendments" ADD CONSTRAINT "record_amendments_conversation_fk" FOREIGN KEY ("clinic_id","conversation_id") REFERENCES "public"."conversations"("clinic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "record_amendments" ADD CONSTRAINT "record_amendments_appointment_fk" FOREIGN KEY ("clinic_id","appointment_id") REFERENCES "public"."appointments"("clinic_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "record_amendments_request_idx" ON "record_amendments" USING btree ("clinic_id","booking_request_id") WHERE "record_amendments"."booking_request_id" is not null;--> statement-breakpoint
CREATE INDEX "record_amendments_conversation_idx" ON "record_amendments" USING btree ("clinic_id","conversation_id") WHERE "record_amendments"."conversation_id" is not null;--> statement-breakpoint
CREATE INDEX "record_amendments_appointment_idx" ON "record_amendments" USING btree ("clinic_id","appointment_id") WHERE "record_amendments"."appointment_id" is not null;--> statement-breakpoint

-- =============================================================================
-- The amendment record (BAA 1.3.0 release gate 8; PT-17). The statements
-- above were generated from schema.ts; everything below is the part drizzle
-- cannot express.
--
-- The failure, in one paragraph. BAA 1.3.0's clause 14(b), and the DPA's
-- Clients' requests clause in its own words, promise that where a record must
-- stay as it was made, "such as a booking request or the record of a
-- conversation, healdesk appends the amendment to it and links the two ...
-- Every later use and export of that record then carries the amendment."
-- Nothing could hold one: a booking request's facts are frozen by the
-- no-rewrite trigger (0039, 0041), a conversation has nowhere to put
-- Practice's words, `amendContact` corrected a contact but had no caller, and
-- neither export carried anything beside a record. The clause promised an
-- append the database had no place for.
--
-- What changes:
--
--   * record_amendments holds each amendment: the record it amends (a booking
--     request, a conversation or an appointment, by target_kind and exactly
--     one of three foreign keys), Practice's words, who asked by role or ticket, when
--     Practice directed it, who appended it, and when, by the database's
--     clock. Each foreign key carries clinic_id with the record's id, against
--     a (clinic_id, id) key on the record's table, so an amendment can point
--     only at a record of its own clinic, whatever the writer sends.
--   * Append-only. The runtime role may INSERT and SELECT, nothing else; no
--     role may UPDATE a row (the guard below); and the foreign keys have no
--     delete action, so a record cannot be deleted while an amendment of it
--     remains, and an amendment cannot be dropped by deleting its record
--     around it. It is PHI, so it is tenant-scoped, FORCEd, and behind the
--     BAA gate.
--   * An amendment leaves only with the record it amends, inside the function
--     that deletes that record, so it is never left pointing at nothing and
--     never deleted on its own:
--       - erasure: app_erase_contacts() takes the amendments of the people's
--         own requests and conversations before them;
--       - the purge: app_purge_booking_requests() takes those of the requests
--         it deletes, and app_purge_amended_appointments() and
--         app_purge_amended_conversations() take each amended appointment
--         and conversation past the record clock together with its
--         amendments;
--       - destruction: app_destroy_record_amendments() takes every one of the
--         clinic's, once it is due, and app_mark_clinic_destroyed() requires
--         the table empty.
--
-- What the runtime role can do that it could not, said plainly: delete an
-- amended appointment or conversation past the clinic's record clock in
-- force (the floor app_purge_booking_requests() already applies, by the
-- database's clock), with its amendments, and every amendment of a clinic
-- due for destruction.
-- Nothing else. And it can no longer write a conversation's started_at.
--
-- Each function keeps every guarantee it had. app_erase_contacts() still
-- takes only the people's own requests and fails with nothing removed if
-- anything else still refers to them; it now also returns the amendments it
-- deleted, which changes its result, so it is dropped and recreated with its
-- app_purge_booking_requests() keeps its result, its floor and the UTC pin
-- 0058 gave it. app_mark_clinic_destroyed() is 0059's definition with the
-- table added, keeping every table it checked, its UTC pin and its pinned
-- search_path.
--
-- drizzle-kit wrote the three unique keys after the foreign keys that need them;
-- they are moved ahead of them above, unchanged, or the foreign keys would
-- find no key to reference.
--
-- Safe to apply in place: a new table, three unique keys on columns that are
-- already unique (each table's id), three new functions, three redefinitions
-- and a narrower UPDATE grant on conversations (no started_at), which nothing
-- in the application used. apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The table: tenant-scoped, forced, behind the BAA gate, and append-only
-- -----------------------------------------------------------------------------
ALTER TABLE record_amendments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE record_amendments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY record_amendments_tenant_isolation ON record_amendments
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

-- 0003's default privileges handed the runtime role all four verbs. It keeps
-- the two an append-only record needs.
REVOKE ALL ON record_amendments FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON record_amendments TO healdesk_app;--> statement-breakpoint

CREATE TRIGGER record_amendments_baa_gate
  BEFORE INSERT OR UPDATE ON record_amendments
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- recorded_at is the database's clock at the insert, whatever the writer
-- sent, and no role changes a row once written: an amendment is the record of
-- what Practice directed, and a later one is appended beside it.
CREATE OR REPLACE FUNCTION app_record_amendment_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.recorded_at := clock_timestamp();
    IF NEW.requested_at > NEW.recorded_at THEN
      NEW.requested_at := NEW.recorded_at;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'record_amendments: an amendment is never changed; append another beside it'
    USING ERRCODE = '42501';
END
$$;--> statement-breakpoint
CREATE TRIGGER record_amendments_guard
  BEFORE INSERT OR UPDATE ON record_amendments
  FOR EACH ROW EXECUTE FUNCTION app_record_amendment_guard();--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Erasure: the people's amendments go with them
-- -----------------------------------------------------------------------------
-- 0054's definition, the last before this one, with the amendments of the
-- people's own requests, of their appointments and of the conversations it
-- deletes (theirs, and the ones that produced their appointments) deleted
-- first, and counted. Only the
-- people's own requests still: an amendment of someone else's request stays
-- with it. And all of it or none of it still: anything else referring to
-- them fails the call, and the amendments it deleted come back with the rest.
DROP FUNCTION app_erase_contacts(uuid[]);--> statement-breakpoint
CREATE FUNCTION app_erase_contacts(
  target_contacts uuid[],
  OUT requests_deleted integer,
  OUT appointments_deleted integer,
  OUT conversations_deleted integer,
  OUT contacts_deleted integer,
  OUT amendments_deleted integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  people uuid[];
  bookings uuid[];
  calls uuid[];
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_erase_contacts: no tenant; an erasure runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(array_agg(c.id), '{}')
    INTO people
    FROM contacts c
   WHERE c.clinic_id = tenant
     AND c.id = ANY (target_contacts);

  SELECT coalesce(array_agg(a.id), '{}'),
         coalesce(array_agg(a.conversation_id) FILTER (WHERE a.conversation_id IS NOT NULL), '{}')
    INTO bookings, calls
    FROM appointments a
   WHERE a.clinic_id = tenant
     AND a.contact_id = ANY (people);

  DELETE FROM record_amendments ra
   WHERE ra.clinic_id = tenant
     AND (ra.booking_request_id IN (SELECT r.id
                                      FROM booking_requests r
                                     WHERE r.clinic_id = tenant
                                       AND r.contact_id = ANY (people))
          OR ra.appointment_id = ANY (bookings)
          OR ra.conversation_id IN (SELECT v.id
                                      FROM conversations v
                                     WHERE v.clinic_id = tenant
                                       AND (v.contact_id = ANY (people) OR v.id = ANY (calls))));
  GET DIAGNOSTICS amendments_deleted = ROW_COUNT;

  DELETE FROM booking_requests r
   WHERE r.clinic_id = tenant
     AND r.contact_id = ANY (people);
  GET DIAGNOSTICS requests_deleted = ROW_COUNT;

  DELETE FROM appointments a
   WHERE a.clinic_id = tenant
     AND a.id = ANY (bookings);
  GET DIAGNOSTICS appointments_deleted = ROW_COUNT;

  DELETE FROM conversations v
   WHERE v.clinic_id = tenant
     AND (v.contact_id = ANY (people) OR v.id = ANY (calls));
  GET DIAGNOSTICS conversations_deleted = ROW_COUNT;

  DELETE FROM contacts c
   WHERE c.clinic_id = tenant
     AND c.id = ANY (people);
  GET DIAGNOSTICS contacts_deleted = ROW_COUNT;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_erase_contacts(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_erase_contacts(uuid[]) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The purge: an amendment goes the night its record does
-- -----------------------------------------------------------------------------
-- 0054's definition, with 0058's UTC pin written into it, and the amendments
-- of the requests it deletes deleted first. The requests are read once, by
-- the same predicate as before, so the two deletes take the same ones.
CREATE OR REPLACE FUNCTION app_purge_booking_requests(record_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  allowed timestamptz;
  doomed uuid[];
  gone integer;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_purge_booking_requests: no tenant; a purge runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  allowed := app_record_cutoff();
  IF record_before IS NULL OR record_before > allowed THEN
    RAISE EXCEPTION 'app_purge_booking_requests: % is later than clinic %''s record clock allows (%); refusing.',
      record_before, tenant, allowed
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(array_agg(r.id), '{}')
    INTO doomed
    FROM booking_requests r
   WHERE r.clinic_id = tenant
     AND r.created_at < record_before
     AND (r.confirmed_for IS NULL OR r.confirmed_for < record_before)
     AND (r.appointment_id IS NULL
          OR EXISTS (SELECT 1
                       FROM appointments a
                      WHERE a.id = r.appointment_id
                        AND a.clinic_id = tenant
                        AND a.scheduled_for < record_before));

  DELETE FROM record_amendments ra
   WHERE ra.clinic_id = tenant
     AND ra.booking_request_id = ANY (doomed);

  DELETE FROM booking_requests r
   WHERE r.clinic_id = tenant
     AND r.id = ANY (doomed);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint

-- An amended appointment goes only here, with its amendments, in one call,
-- as an amended conversation does below and for the same reason: the runtime
-- role may delete an appointment (purgeClinic) but not an amendment, and it
-- can write an appointment's scheduled_for (a sync and a reschedule move
-- it), so an amendment purged on its own, floored on that time, could be
-- stripped from a booking still ahead. Here the two leave together, under
-- app_purge_booking_requests()'s floor, and never an appointment a booking
-- request still holds (it waits for the night the request goes). A payment
-- matched to one loses the link, and its reconciliation exceptions go, as
-- purgeClinic does for the rest; a slot hold or a deposit link loses it by
-- its own foreign key (SET NULL).
CREATE OR REPLACE FUNCTION app_purge_amended_appointments(record_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  allowed timestamptz;
  doomed uuid[];
  gone integer;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_purge_amended_appointments: no tenant; a purge runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  allowed := app_record_cutoff();
  IF record_before IS NULL OR record_before > allowed THEN
    RAISE EXCEPTION 'app_purge_amended_appointments: % is later than clinic %''s record clock allows (%); refusing.',
      record_before, tenant, allowed
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(array_agg(a.id), '{}')
    INTO doomed
    FROM appointments a
   WHERE a.clinic_id = tenant
     AND a.scheduled_for < record_before
     AND EXISTS (SELECT 1 FROM record_amendments ra
                  WHERE ra.clinic_id = tenant AND ra.appointment_id = a.id)
     AND NOT EXISTS (SELECT 1 FROM booking_requests r
                      WHERE r.clinic_id = tenant AND r.appointment_id = a.id);

  DELETE FROM record_amendments ra
   WHERE ra.clinic_id = tenant
     AND ra.appointment_id = ANY (doomed);

  DELETE FROM reconciliation_exceptions x
   WHERE x.clinic_id = tenant
     AND x.appointment_id = ANY (doomed);
  UPDATE transactions t
     SET appointment_id = NULL
   WHERE t.clinic_id = tenant
     AND t.appointment_id = ANY (doomed);

  DELETE FROM appointments a
   WHERE a.clinic_id = tenant
     AND a.id = ANY (doomed);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_amended_appointments(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_amended_appointments(timestamptz) TO healdesk_app;--> statement-breakpoint

-- An amended conversation goes only here, with its amendments, in one call.
-- The runtime role may delete a conversation (purgeClinic,
-- lib/retention/purge.ts) but not an amendment, and the foreign key keeps it
-- from deleting an amended one. The first version of this migration had
-- app_purge_conversation_amendments(), which deleted the amendments of the
-- conversations that started before the cutoff and left the conversations
-- for the runtime role to delete. It was floored on started_at, which the
-- runtime role could then write: it could move a live conversation's
-- started_at back a year, call it, put the date back, and keep the
-- conversation without its amendment. Now the amendments and the
-- conversation leave together, so an amendment is never deleted while what
-- it amends stays, whatever date the conversation carries, and the runtime
-- role cannot write started_at at all (below). The floor is
-- app_purge_booking_requests()'s: no later than app_record_cutoff(), the
-- record clock in force by the database's clock, so a clock shortened in the
-- same transaction reaches nothing for a day. An appointment that names one
-- of the conversations keeps itself and loses the link, as purgeClinic does
-- for the rest; a booking request's link goes by its own foreign key (SET
-- NULL).
CREATE OR REPLACE FUNCTION app_purge_amended_conversations(record_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  allowed timestamptz;
  doomed uuid[];
  gone integer;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_purge_amended_conversations: no tenant; a purge runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  allowed := app_record_cutoff();
  IF record_before IS NULL OR record_before > allowed THEN
    RAISE EXCEPTION 'app_purge_amended_conversations: % is later than clinic %''s record clock allows (%); refusing.',
      record_before, tenant, allowed
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(array_agg(v.id), '{}')
    INTO doomed
    FROM conversations v
   WHERE v.clinic_id = tenant
     AND v.started_at < record_before
     AND EXISTS (SELECT 1 FROM record_amendments ra
                  WHERE ra.clinic_id = tenant AND ra.conversation_id = v.id);

  DELETE FROM record_amendments ra
   WHERE ra.clinic_id = tenant
     AND ra.conversation_id = ANY (doomed);

  UPDATE appointments a
     SET conversation_id = NULL
   WHERE a.clinic_id = tenant
     AND a.conversation_id = ANY (doomed);

  DELETE FROM conversations v
   WHERE v.clinic_id = tenant
     AND v.id = ANY (doomed);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_amended_conversations(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_amended_conversations(timestamptz) TO healdesk_app;--> statement-breakpoint

-- What the purge's floor reads, the runtime role cannot write. A
-- conversation's started_at is written once, at ingestion
-- (lib/voice/ingest.ts), and nothing in the application changes it, so the
-- runtime role keeps UPDATE on every other column and loses it on this one.
-- A booking request's created_at, the first of the dates
-- app_purge_booking_requests() reads, was already out of its reach (0040's
-- column grant), and its amendments go inside that function with it. An
-- appointment's scheduled_for stays writable (a sync and a reschedule move
-- it), which is why an amendment never goes on its own: only with what it
-- amends.
REVOKE UPDATE ON conversations FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE (id, clinic_id, contact_id, channel, recovery_reason, outcome, treatment_interest, transcript_uri,
              disclosure_played_at, recording_opt_out, response_latency_seconds, ended_at, external_call_id)
  ON conversations TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction: every amendment of the clinic, once it is due
-- -----------------------------------------------------------------------------
-- The guard of app_destroy_booking_requests() and app_destroy_contact_evidence()
-- (0058): the tenant's own clinic, and only once app_destruction_due() says
-- the rule of the agreement its service ended under allows it, by the
-- database's clock. destroyClinicData calls it before the requests and the
-- conversations go.
CREATE OR REPLACE FUNCTION app_destroy_record_amendments(target_clinic uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  gone integer;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_destroy_record_amendments: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to delete its amendments.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction is due by the rule of the agreement the service ended under (app_destruction_due), by the database''s clock.';
  END IF;

  DELETE FROM record_amendments ra WHERE ra.clinic_id = target_clinic;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destroy_record_amendments(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destroy_record_amendments(uuid) TO healdesk_app;--> statement-breakpoint

-- 0059's definition, the last before this one, with record_amendments added to
-- the tables it requires empty, and the clinic's row locked before the
-- checks. Every table it checked before, it still checks. tests/booking-request-destruction.test.ts reads the list from this
-- source and holds it to every table with a clinic_id.
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
     OR EXISTS (SELECT 1 FROM record_amendments ra WHERE ra.clinic_id = target_clinic) THEN
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
COMMENT ON TABLE record_amendments IS
  'An amendment Practice directed to a record healdesk does not rewrite on its word (BAA 1.3.0 clause 14(b)): a booking request, a conversation or an appointment, by target_kind and exactly one foreign key, which carries clinic_id so the record is the same clinic''s. Practice''s words (PHI), who asked by role or ticket, when Practice directed it, who appended it, and recorded_at by the database''s clock. Append-only: the runtime role may INSERT and SELECT; no role may UPDATE. Leaves only with the record it amends, through app_erase_contacts, app_purge_booking_requests, app_purge_amended_appointments, app_purge_amended_conversations and app_destroy_record_amendments. Every export carries it beside the record.';--> statement-breakpoint
COMMENT ON FUNCTION app_erase_contacts(uuid[]) IS
  'Erases people inside the tenant (app.clinic_id), for eraseContact: the amendments of their own booking requests, of their appointments and of the conversations it deletes, their own booking requests, their appointments, their conversations and the ones that produced their appointments, then the contact rows, in one call, so a request leaves only with the person it names. Fails with nothing removed if anything else still refers to them, another person''s request on one of their appointments included; their transactions go first. Returns the five counts; contacts outside the tenant match nothing.';--> statement-breakpoint
COMMENT ON FUNCTION app_purge_booking_requests(timestamptz) IS
  'Deletes the tenant''s booking requests every date of which is before record_before: created_at, confirmed_for, and its appointment''s scheduled_for when it produced one, with their amendments. Refuses a cutoff later than app_record_cutoff(), the record clock in force by the database''s clock, with no grace. For purgeClinic, before the appointments past the same cutoff go. Returns the count of requests.';--> statement-breakpoint
COMMENT ON FUNCTION app_purge_amended_appointments(timestamptz) IS
  'Deletes the tenant''s amended appointments scheduled before record_before, and held by no booking request, together with their amendments, for purgeClinic, which deletes the rest itself; an amendment never goes while its appointment stays. Refuses a cutoff later than app_record_cutoff(). Returns the count of appointments.';--> statement-breakpoint
COMMENT ON FUNCTION app_purge_amended_conversations(timestamptz) IS
  'Deletes the tenant''s amended conversations that started before record_before together with their amendments, for purgeClinic, which deletes the rest itself; an amendment never goes while its conversation stays. Refuses a cutoff later than app_record_cutoff(). Returns the count of conversations.';--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_record_amendments(uuid) IS
  'Deletes every amendment of the tenant''s own clinic, for destroyClinicData, before its booking requests and conversations go. Refuses unless the clinic passed is app.clinic_id and app_destruction_due() says it is due. Returns the count.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: suppressions, consent records and contact attempts included, the setup screens, slot holds, providers and provider services 0056 and 0057 added, the records of deletion requests (0059) and the amendments (0060). Returns destroyed_at.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'record_amendments'::regclass) THEN
    RAISE EXCEPTION 'Row-level security is not ENABLEd and FORCEd on record_amendments.';
  END IF;

  IF has_table_privilege('healdesk_app'::name, 'record_amendments'::regclass, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')
     OR NOT has_table_privilege('healdesk_app'::name, 'record_amendments'::regclass, 'SELECT')
     OR NOT has_table_privilege('healdesk_app'::name, 'record_amendments'::regclass, 'INSERT') THEN
    RAISE EXCEPTION 'healdesk_app must hold exactly SELECT and INSERT on record_amendments.';
  END IF;
  SELECT string_agg(a.attname, ', ') INTO offending
    FROM pg_attribute a
   WHERE a.attrelid = 'record_amendments'::regclass AND a.attnum > 0 AND NOT a.attisdropped
     AND has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'UPDATE');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE record_amendments: %', offending;
  END IF;

  IF has_column_privilege('healdesk_app'::name, 'conversations'::regclass, 'started_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'created_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE conversations.started_at or booking_requests.created_at, the dates the purge''s floor reads.';
  END IF;

  SELECT string_agg(v.tg, ', ') INTO offending
    FROM (VALUES ('record_amendments_guard'), ('record_amendments_baa_gate')) AS v(tg)
   WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t
                      WHERE NOT t.tgisinternal AND t.tgenabled <> 'D'
                        AND t.tgrelid = 'record_amendments'::regclass AND t.tgname = v.tg);
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Missing or disabled trigger(s) on record_amendments: %', offending;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_constraint k
              WHERE k.conrelid = 'record_amendments'::regclass AND k.contype = 'f'
                AND k.confrelid IN ('booking_requests'::regclass, 'conversations'::regclass, 'appointments'::regclass)
                AND (k.confdeltype <> 'a' OR cardinality(k.conkey) <> 2)) THEN
    RAISE EXCEPTION 'record_amendments'' foreign keys to its records must carry clinic_id and have no delete action.';
  END IF;

  SELECT string_agg(p.proname, ', ') INTO offending
    FROM pg_proc p
   WHERE p.oid IN ('app_erase_contacts(uuid[])'::regprocedure,
                   'app_purge_booking_requests(timestamptz)'::regprocedure,
                   'app_purge_amended_appointments(timestamptz)'::regprocedure,
                   'app_purge_amended_conversations(timestamptz)'::regprocedure,
                   'app_destroy_record_amendments(uuid)'::regprocedure,
                   'app_mark_clinic_destroyed(uuid)'::regprocedure)
     AND (has_function_privilege('public', p.oid, 'EXECUTE')
          OR NOT has_function_privilege('healdesk_app', p.oid, 'EXECUTE'));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER function(s) executable by PUBLIC, or not by healdesk_app: %', offending;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO offending
    FROM pg_proc p
   WHERE p.oid IN ('app_erase_contacts(uuid[])'::regprocedure,
                   'app_purge_booking_requests(timestamptz)'::regprocedure,
                   'app_purge_amended_appointments(timestamptz)'::regprocedure,
                   'app_purge_amended_conversations(timestamptz)'::regprocedure,
                   'app_destroy_record_amendments(uuid)'::regprocedure,
                   'app_mark_clinic_destroyed(uuid)'::regprocedure,
                   'app_record_amendment_guard()'::regprocedure)
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Function(s) without a pinned search_path: %', offending;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO offending
    FROM pg_proc p
   WHERE p.oid IN ('app_purge_booking_requests(timestamptz)'::regprocedure,
                   'app_purge_amended_appointments(timestamptz)'::regprocedure,
                   'app_purge_amended_conversations(timestamptz)'::regprocedure,
                   'app_destroy_record_amendments(uuid)'::regprocedure,
                   'app_mark_clinic_destroyed(uuid)'::regprocedure)
     AND NOT ('TimeZone=UTC' = ANY (coalesce(p.proconfig, ARRAY[]::text[])));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Function(s) that lost or lack the UTC pin (drizzle/0058): %', offending;
  END IF;
END;
$$;
