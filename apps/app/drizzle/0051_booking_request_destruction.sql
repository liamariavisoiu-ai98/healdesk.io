ALTER TABLE "booking_requests" DROP CONSTRAINT "booking_requests_appointment_id_appointments_id_fk";
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- =============================================================================
-- Destruction, erasure and the purge reach booking requests (adversarial
-- review of 6 October 2026). The two statements above were generated from
-- schema.ts; everything below is the part drizzle cannot express.
--
-- The failure, in one paragraph. destroyClinicData, eraseContact and the
-- purge deleted appointments before contacts and left booking requests to the
-- contact's cascade (0037). But booking_requests.appointment_id was ON DELETE
-- SET NULL (0039), the CHECK booking_requests_confirmed_shape requires a
-- confirmed request to keep its appointment (0039), and the BEFORE UPDATE
-- trigger app_booking_request_no_rewrite (0037, redefined in 0041) refuses to
-- change a decided request. Postgres runs SET NULL as an UPDATE of the
-- referencing row, so deleting the appointment of a confirmed request raised
-- "already decided and cannot be re-decided". Destruction aborted for any
-- practice whose desk had ever confirmed a request, and erasure for any person
-- it had confirmed one for. The purge aborted once the first confirmed
-- booking passed the record clock, and because each clinic's purge is one
-- transaction, nothing at all was purged for that clinic from that night on,
-- transcript references included. The BAA's destruction on the clock and the
-- draft DPA's deletion on request had no working code behind them for exactly
-- the clinics that used the product.
--
-- The fix. The requests go first, before the appointments they hold, through
-- three SECURITY DEFINER functions, one per path, because the runtime role
-- has no DELETE on booking_requests (0037) and is given none:
--
--   app_destroy_booking_requests(target_clinic)
--       every request of the tenant's own clinic, once its destroy_after has
--       passed;
--   app_erase_booking_requests(target_contact)
--       one person's requests, and any that point at that person's
--       appointments;
--   app_purge_booking_requests(record_before)
--       the requests past the clinic's own record clock: on their
--       appointment's date when they produced one, on their own created_at
--       otherwise.
--
-- Each reads its tenant from app.clinic_id, refuses without one and filters
-- on it, and FORCE ROW LEVEL SECURITY binds the definer as it binds everyone
-- (0037: the definer owns the table, and FORCE applies to the owner too), so
-- none of them can reach another clinic's rows whatever it is passed.
--
-- The no-rewrite rule is untouched: the trigger, the CHECKs and the column
-- grant are exactly as 0041 left them, so a decided request still cannot be
-- re-decided or rewritten in live use. The foreign key above becomes NO
-- ACTION. SET NULL could never succeed on a confirmed request, only fail with
-- a message about re-deciding, and it was the one way to ask for an UPDATE of
-- a decided request without writing one. Deleting an appointment a request
-- points at is now refused as what it is, a foreign-key violation, and the
-- request has to go first, through one of the functions below.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and the foreign key being
-- replaced already guaranteed every appointment_id it re-validates.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Destruction: every request of one clinic, once it is due
-- -----------------------------------------------------------------------------
-- Called by destroyClinicData (lib/offboarding/offboarding.ts) before it
-- deletes the clinic's appointments; the contacts go after it in the same
-- transaction. The clinic passed must be the tenant of the transaction, and
-- it must be offboarding with its destroy_after passed by the database's
-- clock, the floor under the rule dueForDestruction() applies before the
-- daily job calls it. So the function cannot empty a customer's requests, nor
-- an offboarding clinic's before its thirty days are up.
CREATE OR REPLACE FUNCTION app_destroy_booking_requests(target_clinic uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  started timestamptz;
  due timestamptz;
  gone integer;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_destroy_booking_requests: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  SELECT c.offboarding_started_at, c.destroy_after INTO started, due
    FROM clinics c
   WHERE c.id = target_clinic;
  IF started IS NULL OR due IS NULL OR due > now() THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to delete its booking requests.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction runs once offboarding has started and destroy_after has passed (lib/offboarding/offboarding.ts).';
  END IF;

  DELETE FROM booking_requests r WHERE r.clinic_id = target_clinic;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destroy_booking_requests(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destroy_booking_requests(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Erasure: one person's requests
-- -----------------------------------------------------------------------------
-- Called by eraseContact (lib/retention/purge.ts) for each contact it
-- matched, before it deletes their appointments; the contact goes later in
-- the same transaction. This is the cascade 0037 relied on, moved ahead of
-- the appointments it could not get past. It takes the person's own requests
-- and any request pointing at one of the person's appointments: a booking is
-- about the person who booked, which is how eraseContact already treats the
-- call that produced it. A contact outside the tenant matches nothing, so
-- nothing goes.
CREATE OR REPLACE FUNCTION app_erase_booking_requests(target_contact uuid)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  gone integer;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_erase_booking_requests: no tenant; an erasure runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  DELETE FROM booking_requests r
   WHERE r.clinic_id = tenant
     AND (r.contact_id = target_contact
          OR r.appointment_id IN (SELECT a.id
                                    FROM appointments a
                                   WHERE a.clinic_id = tenant
                                     AND a.contact_id = target_contact));
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_erase_booking_requests(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_erase_booking_requests(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The purge: requests past the clinic's own record clock
-- -----------------------------------------------------------------------------
-- Called by purgeClinic (lib/retention/purge.ts) before it deletes the
-- appointments past the clock. A request that produced an appointment goes
-- with it, on the appointment's date: that is the purge's own rule for
-- appointments, so every appointment it deletes has lost its requests first,
-- and a booking made long ago for a slot still ahead keeps the request it
-- came from. Any other request goes on its created_at. record_before is the
-- purge's cutoff, and it may not be later than retention_record_days back
-- from the database's clock, with a day's grace for the job's clock against
-- the database's, so the function cannot reach a request the clinic's own
-- clock says to keep.
CREATE OR REPLACE FUNCTION app_purge_booking_requests(record_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  record_days integer;
  gone integer;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_purge_booking_requests: no tenant; a purge runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  SELECT c.retention_record_days INTO record_days
    FROM clinics c
   WHERE c.id = tenant;
  IF record_days IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', tenant
      USING ERRCODE = 'no_data_found';
  END IF;
  IF record_before IS NULL
     OR record_before > now() - make_interval(days => record_days) + interval '1 day' THEN
    RAISE EXCEPTION 'app_purge_booking_requests: % is later than clinic %''s record clock of % days; refusing.',
      record_before, tenant, record_days
      USING ERRCODE = 'check_violation';
  END IF;

  DELETE FROM booking_requests r
   WHERE r.clinic_id = tenant
     AND CASE
           WHEN r.appointment_id IS NULL THEN r.created_at < record_before
           ELSE EXISTS (SELECT 1
                          FROM appointments a
                         WHERE a.id = r.appointment_id
                           AND a.clinic_id = tenant
                           AND a.scheduled_for < record_before)
         END;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_booking_requests(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_booking_requests(timestamptz) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON FUNCTION app_destroy_booking_requests(uuid) IS
  'Deletes every booking request of the tenant''s own clinic, for destroyClinicData, before its appointments go. Refuses unless the clinic passed is app.clinic_id and is offboarding with destroy_after passed. Returns the count. The runtime role has no DELETE on booking_requests (0037); this is one of the three ways a request leaves before its contact does, beside app_erase_booking_requests and app_purge_booking_requests.';--> statement-breakpoint
COMMENT ON FUNCTION app_erase_booking_requests(uuid) IS
  'Deletes one contact''s booking requests, and any pointing at that contact''s appointments, inside the tenant (app.clinic_id), for eraseContact, which deletes the contact in the same transaction. Returns the count; a contact outside the tenant matches nothing.';--> statement-breakpoint
COMMENT ON FUNCTION app_purge_booking_requests(timestamptz) IS
  'Deletes the tenant''s booking requests past record_before: by their appointment''s scheduled_for when they produced one, by created_at otherwise. Refuses a cutoff later than the clinic''s retention_record_days back from now() plus a day. For purgeClinic, before the appointments past the same cutoff go. Returns the count.';--> statement-breakpoint
COMMENT ON COLUMN booking_requests.appointment_id IS
  'The appointment a confirmed request produced (booking_requests_confirmed_shape). ON DELETE NO ACTION, not SET NULL: the appointment cannot be deleted while a request points at it, and a decided request cannot be rewritten to let it go, so the request is deleted first, by destruction, erasure or the purge (app_destroy_booking_requests, app_erase_booking_requests, app_purge_booking_requests).';--> statement-breakpoint
COMMENT ON COLUMN clinics.retention_record_days IS
  'Days after which conversation, appointment, booking request and transaction rows are deleted. 90 by default, the period the BAA states (TRANSCRIPT_RETENTION_DAYS in @healdesk/catalog). A booking request goes on its appointment''s date when it produced one, on its own created_at otherwise. Consent records, suppressions and contact attempts are never on this clock: they are evidence.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from booking_requests; a request is evidence of what the practice was told, and only app_destroy_booking_requests, app_erase_booking_requests and app_purge_booking_requests may remove one ahead of its contact.';
  END IF;
  IF (SELECT con.confdeltype
        FROM pg_constraint con
       WHERE con.conrelid = 'booking_requests'::regclass
         AND con.conname = 'booking_requests_appointment_id_appointments_id_fk') IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'booking_requests.appointment_id is not ON DELETE NO ACTION; any other action collides with booking_requests_confirmed_shape and app_booking_request_no_rewrite.';
  END IF;
  IF has_function_privilege('public', 'app_destroy_booking_requests(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_erase_booking_requests(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_purge_booking_requests(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A booking-request delete function (app_destroy_, app_erase_ or app_purge_booking_requests) is executable by PUBLIC.';
  END IF;
END;
$$;
