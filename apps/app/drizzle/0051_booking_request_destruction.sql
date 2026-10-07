ALTER TABLE "booking_requests" DROP CONSTRAINT "booking_requests_appointment_id_appointments_id_fk";
--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_retention_record_days_positive" CHECK ("clinics"."retention_record_days" >= 1);--> statement-breakpoint

-- =============================================================================
-- Destruction, erasure and the purge reach booking requests (adversarial
-- reviews of 6 and 7 October 2026). The three statements above were generated
-- from schema.ts; everything below is the part drizzle cannot express.
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
-- has no DELETE on booking_requests (0037) and is given none. Each is bound to
-- its purpose by state the runtime role cannot write. That matters beyond the
-- delete itself: healdesk_app keeps INSERT on booking_requests and the
-- no-rewrite trigger is BEFORE UPDATE only, so any request the runtime role
-- could delete at will it could also put back, under the same id and token,
-- with another decision. The first version of this migration bound erasure to
-- nothing but a tenant, and destruction and the purge to clinic columns the
-- runtime role could write; the review of 7 October showed each of the three
-- deleting a confirmed request in live use. Now:
--
--   app_erase_contacts(target_contacts)
--       one or more people, whole: their requests, and any pointing at their
--       appointments; their appointments; their conversations and the ones
--       that produced their appointments; then the contact rows. One call,
--       so a request still leaves only with its person, as the cascade
--       always let it (0037), and the call fails with nothing removed if
--       anything else still refers to them.
--   app_destroy_booking_requests(target_clinic)
--       every request of the tenant's own clinic, once offboarding began
--       thirty days ago by the database's clock. The dates it reads are
--       written by app_start_offboarding() and app_mark_clinic_destroyed()
--       alone, on the database's clock: the runtime role loses UPDATE on
--       them, as 0031 took the BAA gate's columns out of its reach.
--   app_purge_booking_requests(record_before)
--       the requests past the clinic's own record clock: on their
--       appointment's date when they produced one, on their own created_at
--       otherwise. The clock is the practice's setting and stays writable,
--       but never below a day (clinics_retention_record_days_positive), and
--       the function refuses any cutoff later than now(), so it cannot reach
--       a booking still ahead, whatever the clock says.
--
-- Each reads its tenant from app.clinic_id, refuses without one and filters
-- on it, and FORCE ROW LEVEL SECURITY binds the definer as it binds everyone
-- (0037: the definer owns the table, and FORCE applies to the owner too), so
-- none of them can reach another clinic's rows whatever it is passed.
--
-- The no-rewrite rule is untouched: the trigger, the CHECKs and the column
-- grant on booking_requests are exactly as 0041 left them. The foreign key
-- above becomes NO ACTION. SET NULL could never succeed on a confirmed
-- request, only fail with a message about re-deciding, and it was the one way
-- to ask for an UPDATE of a decided request without writing one. Deleting an
-- appointment a request points at is now refused as what it is, a
-- foreign-key violation, and the request has to go first, through one of the
-- functions below.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), the foreign key being
-- replaced already guaranteed every appointment_id it re-validates, and no
-- clinic's record clock has been set below a day (0048 set every one to 90).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The offboarding dates leave the runtime role's reach
-- -----------------------------------------------------------------------------
-- app_destroy_booking_requests() reads offboarding_started_at and
-- destroy_after as its floor, and 0034 granted the runtime role UPDATE on
-- both: in one transaction it could stamp a live clinic as due, empty its
-- requests and put the dates back. destroyed_at goes with them, so the record
-- that destruction ran is the database's too. export_delivered_at stays
-- writable; it only chooses between the job's thirty and ninety days
-- (dueForDestruction in lib/offboarding/offboarding.ts), never the floor.
REVOKE UPDATE (offboarding_started_at, destroy_after, destroyed_at) ON clinics FROM healdesk_app;--> statement-breakpoint

-- Called by startOffboarding (lib/offboarding/offboarding.ts) when Stripe
-- deletes the subscription or an operator ends it. Stamps the start and
-- destroy_after thirty days later (DESTROY_AFTER_DAYS), both from the
-- database's clock, and only once: starting again moves neither. Returns
-- destroy_after.
CREATE OR REPLACE FUNCTION app_start_offboarding(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  due timestamptz;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_start_offboarding: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  UPDATE clinics c
     SET offboarding_started_at = coalesce(c.offboarding_started_at, now()),
         destroy_after = coalesce(c.destroy_after, now() + interval '30 days'),
         updated_at = now()
   WHERE c.id = target_clinic
  RETURNING c.destroy_after INTO due;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN due;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_start_offboarding(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_start_offboarding(uuid) TO healdesk_app;--> statement-breakpoint

-- Called by destroyClinicData once the clinic's patient rows are gone, in the
-- same transaction. Refuses a clinic that is not due, by the same rule as
-- app_destroy_booking_requests(), so a live customer cannot be recorded as
-- destroyed. Keeps the first stamp. Returns destroyed_at.
CREATE OR REPLACE FUNCTION app_mark_clinic_destroyed(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  started timestamptz;
  due timestamptz;
  done timestamptz;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_mark_clinic_destroyed: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  SELECT c.offboarding_started_at, c.destroy_after INTO started, due
    FROM clinics c
   WHERE c.id = target_clinic;
  IF started IS NULL OR due IS NULL OR started > now() - interval '30 days' OR due > now() THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to mark it destroyed.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction runs thirty days after offboarding started (app_start_offboarding), by the database''s clock.';
  END IF;

  UPDATE clinics c
     SET destroyed_at = coalesce(c.destroyed_at, now()),
         updated_at = now()
   WHERE c.id = target_clinic
  RETURNING c.destroyed_at INTO done;
  RETURN done;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_mark_clinic_destroyed(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_mark_clinic_destroyed(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction: every request of one clinic, once it is due
-- -----------------------------------------------------------------------------
-- Called by destroyClinicData (lib/offboarding/offboarding.ts) before it
-- deletes the clinic's appointments; the contacts go after it in the same
-- transaction. The clinic passed must be the tenant of the transaction, its
-- offboarding must have started thirty days ago, and its destroy_after must
-- have passed, all by the database's clock and on dates only
-- app_start_offboarding() writes: the floor under the rule dueForDestruction()
-- applies before the daily job calls it. So the function cannot empty a
-- customer's requests, nor an offboarding clinic's before its thirty days are
-- up, and the runtime role cannot make either look otherwise.
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
  IF started IS NULL OR due IS NULL OR started > now() - interval '30 days' OR due > now() THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to delete its booking requests.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction runs thirty days after offboarding started (app_start_offboarding), by the database''s clock.';
  END IF;

  DELETE FROM booking_requests r WHERE r.clinic_id = target_clinic;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destroy_booking_requests(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destroy_booking_requests(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Erasure: one or more people, whole
-- -----------------------------------------------------------------------------
-- Called by eraseContact (lib/retention/purge.ts) with every contact it
-- matched, once their transactions are gone. This is the cascade 0037 relied
-- on, with the appointments it could not get past brought inside it: the
-- people's requests, whatever the desk decided, and any pointing at one of
-- their appointments (a booking is about the person who booked, which is how
-- eraseContact already treats the call that produced it); their appointments;
-- their conversations and the ones that produced their appointments; then the
-- contacts. All of it or none of it: anything else still referring to them (a
-- transaction left behind, another person's appointment on one of their
-- calls) fails the call with nothing removed. Contacts outside the tenant
-- match nothing, so nothing goes. One call for every contact matched, not one
-- each, because one matched contact's appointment can sit on another's call.
CREATE OR REPLACE FUNCTION app_erase_contacts(
  target_contacts uuid[],
  OUT requests_deleted integer,
  OUT appointments_deleted integer,
  OUT conversations_deleted integer,
  OUT contacts_deleted integer
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

  DELETE FROM booking_requests r
   WHERE r.clinic_id = tenant
     AND (r.contact_id = ANY (people) OR r.appointment_id = ANY (bookings));
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
-- The purge: requests past the clinic's own record clock
-- -----------------------------------------------------------------------------
-- Called by purgeClinic (lib/retention/purge.ts) before it deletes the
-- appointments past the clock. A request that produced an appointment goes
-- with it, on the appointment's date: that is the purge's own rule for
-- appointments, so every appointment it deletes has lost its requests first,
-- and a booking made long ago for a slot still ahead keeps the request it
-- came from. Any other request goes on its created_at. record_before is the
-- purge's cutoff. It may not be later than retention_record_days back from
-- the database's clock, with a day's grace for the job's clock against the
-- database's, and never later than now(): with the clock at least a day
-- (clinics_retention_record_days_positive) the grace cannot carry it past
-- now() either. So the function cannot reach a request the clinic's own
-- clock says to keep, nor a booking still ahead.
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
     OR record_before > now()
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
COMMENT ON FUNCTION app_start_offboarding(uuid) IS
  'Stamps clinics.offboarding_started_at and destroy_after thirty days later from the database''s clock, once; starting again moves neither. The tenant''s own clinic only. The runtime role cannot UPDATE either column, because app_destroy_booking_requests reads them as its floor. Returns destroy_after.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Refuses unless the clinic passed is app.clinic_id and is due for destruction by the rule app_destroy_booking_requests applies. Returns destroyed_at.';--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_booking_requests(uuid) IS
  'Deletes every booking request of the tenant''s own clinic, for destroyClinicData, before its appointments go. Refuses unless the clinic passed is app.clinic_id, its offboarding started thirty days ago and destroy_after has passed, by the database''s clock, on dates only app_start_offboarding writes. Returns the count.';--> statement-breakpoint
COMMENT ON FUNCTION app_erase_contacts(uuid[]) IS
  'Erases people inside the tenant (app.clinic_id), for eraseContact: their booking requests and any pointing at their appointments, their appointments, their conversations and the ones that produced their appointments, then the contact rows, in one call, so a request leaves only with its person. Fails with nothing removed if anything else still refers to them; their transactions go first. Returns the four counts; contacts outside the tenant match nothing.';--> statement-breakpoint
COMMENT ON FUNCTION app_purge_booking_requests(timestamptz) IS
  'Deletes the tenant''s booking requests past record_before: by their appointment''s scheduled_for when they produced one, by created_at otherwise. Refuses a cutoff later than now(), or than the clinic''s retention_record_days back from now() plus a day. For purgeClinic, before the appointments past the same cutoff go. Returns the count.';--> statement-breakpoint
COMMENT ON COLUMN booking_requests.appointment_id IS
  'The appointment a confirmed request produced (booking_requests_confirmed_shape). ON DELETE NO ACTION, not SET NULL: the appointment cannot be deleted while a request points at it, and a decided request cannot be rewritten to let it go, so the request is deleted first, by destruction, erasure or the purge (app_destroy_booking_requests, app_erase_contacts, app_purge_booking_requests).';--> statement-breakpoint
COMMENT ON COLUMN clinics.retention_record_days IS
  'Days after which conversation, appointment, booking request and transaction rows are deleted. 90 by default, the period the BAA states (TRANSCRIPT_RETENTION_DAYS in @healdesk/catalog); the practice may shorten it, never below a day (clinics_retention_record_days_positive). A booking request goes on its appointment''s date when it produced one, on its own created_at otherwise. Consent records, suppressions and contact attempts are never on this clock: they are evidence.';--> statement-breakpoint
COMMENT ON COLUMN clinics.offboarding_started_at IS
  'When the clinic left (subscription deleted, or an operator ended it). Written only by app_start_offboarding(), from the database''s clock.';--> statement-breakpoint
COMMENT ON COLUMN clinics.destroy_after IS
  'Hard-delete of patient data is permitted from this instant, thirty days after offboarding_started_at, and only if export_delivered_at is set or 90 days have passed since offboarding_started_at. Written only by app_start_offboarding(), from the database''s clock. See lib/offboarding.';--> statement-breakpoint
COMMENT ON COLUMN clinics.destroyed_at IS
  'When destruction ran. Written only by app_mark_clinic_destroyed(), from the database''s clock.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from booking_requests; a request is evidence of what the practice was told, and only app_destroy_booking_requests, app_erase_contacts and app_purge_booking_requests may remove one ahead of its contact''s cascade.';
  END IF;
  IF (SELECT con.confdeltype
        FROM pg_constraint con
       WHERE con.conrelid = 'booking_requests'::regclass
         AND con.conname = 'booking_requests_appointment_id_appointments_id_fk') IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'booking_requests.appointment_id is not ON DELETE NO ACTION; any other action collides with booking_requests_confirmed_shape and app_booking_request_no_rewrite.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'offboarding_started_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'destroy_after', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'destroyed_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE an offboarding date on clinics; app_destroy_booking_requests reads them as its floor, so only app_start_offboarding and app_mark_clinic_destroyed may write them.';
  END IF;
  IF NOT EXISTS (SELECT 1
                   FROM pg_constraint con
                  WHERE con.conrelid = 'clinics'::regclass
                    AND con.conname = 'clinics_retention_record_days_positive'
                    AND con.contype = 'c'
                    AND con.convalidated) THEN
    RAISE EXCEPTION 'clinics.retention_record_days has no validated floor of a day; app_purge_booking_requests bounds its cutoff by it.';
  END IF;
  IF has_function_privilege('public', 'app_start_offboarding(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_mark_clinic_destroyed(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_destroy_booking_requests(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_erase_contacts(uuid[])', 'EXECUTE')
     OR has_function_privilege('public', 'app_purge_booking_requests(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'An offboarding or booking-request delete function (app_start_offboarding, app_mark_clinic_destroyed, app_destroy_booking_requests, app_erase_contacts or app_purge_booking_requests) is executable by PUBLIC.';
  END IF;
END;
$$;
