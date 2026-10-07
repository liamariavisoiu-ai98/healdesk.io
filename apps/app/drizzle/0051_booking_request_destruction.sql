CREATE TABLE "booking_request_keys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"written_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_requests" DROP CONSTRAINT "booking_requests_contact_id_contacts_id_fk";
--> statement-breakpoint
ALTER TABLE "booking_requests" DROP CONSTRAINT "booking_requests_appointment_id_appointments_id_fk";
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "retention_record_days_previous" integer;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "retention_record_days_shortened_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_request_keys_token_idx" ON "booking_request_keys" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_requests" ADD CONSTRAINT "booking_requests_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_retention_record_days_positive" CHECK ("clinics"."retention_record_days" >= 1);--> statement-breakpoint

-- =============================================================================
-- Destruction, erasure and the purge reach booking requests (adversarial
-- reviews of 6 and 7 October 2026). The statements above were generated from
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
-- has no DELETE on booking_requests (0037) and is given none. A request is
-- evidence of what the practice was told, and the runtime role keeps INSERT
-- on booking_requests while the no-rewrite trigger is BEFORE UPDATE only, so
-- any request it can remove early it could put back, under the same id and
-- the same desk link, with another decision. The two reviews of 7 October
-- found that route open more than once: the functions read state the runtime
-- role can write (a clinic's offboarding dates, the contact and the time of
-- an appointment, the record clock, a new clinic's columns), and the
-- contact's cascade let it delete a person, put them back under the same id,
-- and put their requests back with them, with no function involved at all.
-- So, three rules:
--
--   * A request is written once. booking_request_keys keeps the id and token
--     hash of every request written, after it is deleted too, and a request
--     that reuses either is refused. Whatever route is left open, the most it
--     can do is delete early; it cannot rewrite.
--   * A request leaves only through the three functions. contact_id becomes
--     NO ACTION, as appointment_id does, so a person cannot be deleted while a
--     request names them, nor an appointment while a request holds it. (The
--     clinic's own row still cascades, but audit_log's foreign key refuses
--     the delete of any clinic with an audit trail, and every request written
--     through the application leaves one.)
--   * Each function is bound to state the runtime role cannot write:
--
--   app_erase_contacts(target_contacts)
--       one or more people, whole: their own requests; their appointments;
--       their conversations and the ones that produced their appointments;
--       then the contact rows, in one call. Anything else still referring to
--       them, someone else's request on one of their appointments included,
--       fails the call with nothing removed, so a request leaves only with
--       the person it names.
--   app_destroy_booking_requests(target_clinic)
--       every request of the tenant's own clinic, once offboarding began
--       thirty days ago by the database's clock. The dates it reads are
--       written by app_start_offboarding() and app_mark_clinic_destroyed()
--       alone, on the database's clock: the runtime role loses UPDATE on
--       them, as 0031 took the BAA gate's columns out of its reach, and a new
--       clinic may not carry them.
--   app_purge_booking_requests(record_before)
--       the requests every date of which is past the cutoff: when it was
--       made, the slot it was confirmed for, its appointment's time. The
--       first two are frozen once a request is decided (0041), so moving an
--       appointment reaches nothing. The cutoff may be no later than the
--       record clock in force, by the database's clock and with no grace:
--       the clinic's own setting, but for a day after it is shortened the
--       longer clock it replaced, so the runtime role cannot shorten the
--       clock, purge on it and put it back.
--
-- Each reads its tenant from app.clinic_id, refuses without one and filters
-- on it, and FORCE ROW LEVEL SECURITY binds the definer as it binds everyone
-- (0037: the definer owns the table, and FORCE applies to the owner too), so
-- none of them can reach another clinic's rows whatever it is passed.
--
-- What the runtime role can still do, said plainly: shorten the record clock,
-- which is the practice's own setting, and from a day later purge any request
-- that clock has passed; erase a person, whole; and delete a clinic that has
-- no audit row yet, with whatever requests it wrote without one. None of them
-- can be followed by putting a request back.
--
-- The no-rewrite rule is untouched: the trigger, the CHECKs and the column
-- grant on booking_requests are exactly as 0041 left them. The two foreign
-- keys above become NO ACTION. SET NULL on appointment_id could never succeed
-- on a confirmed request, only fail with a message about re-deciding, and the
-- cascade on contact_id was the one way to delete a request without a
-- function. Deleting an appointment a request holds, or a person a request
-- names, is now refused as what it is, a foreign-key violation, and the
-- request has to go first, through one of the functions below.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), the foreign keys being
-- replaced already guaranteed every value they re-validate, no clinic's record
-- clock has been set below a day (0048 set every one to 90), and no clinic
-- row carries a record-clock history yet.
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

-- Nor may a new clinic carry them. The runtime role holds INSERT on clinics
-- (0003), which provisioning needs, and a column-level REVOKE INSERT does
-- nothing under a table-level grant, so a clinic it created could be born
-- four hundred days into offboarding, due for destruction by both functions
-- below. The grant cannot become a column list either: drizzle names every
-- column of an INSERT and sends DEFAULT for the ones it was not given, and
-- Postgres then wants INSERT on each. So a trigger refuses a new row that
-- carries any of the three, or the record clock's history (further down).
-- Provisioning and every fixture set none of them.
CREATE OR REPLACE FUNCTION app_clinic_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.offboarding_started_at IS NOT NULL
     OR NEW.destroy_after IS NOT NULL
     OR NEW.destroyed_at IS NOT NULL
     OR NEW.retention_record_days_previous IS NOT NULL
     OR NEW.retention_record_days_shortened_at IS NOT NULL THEN
    RAISE EXCEPTION 'clinics: a new clinic carries no offboarding date and no record-clock history; app_start_offboarding, app_mark_clinic_destroyed and the clinics_record_clock trigger write them'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER clinics_insert_guard
  BEFORE INSERT ON clinics
  FOR EACH ROW EXECUTE FUNCTION app_clinic_insert_guard();--> statement-breakpoint

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
-- destroyed; and refuses while any row destroyClinicData deletes is still
-- there, because the stamp is what makes the daily job (dueForDestruction)
-- and the ops console treat the clinic as destroyed for good, and a stamp
-- ahead of the deletes would leave its patients held with nothing left to
-- remove them. Keeps the first stamp. Returns destroyed_at.
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

  IF EXISTS (SELECT 1 FROM booking_requests r WHERE r.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM appointments a WHERE a.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM conversations v WHERE v.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM contacts p WHERE p.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM transactions t WHERE t.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM reconciliation_exceptions x WHERE x.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM meta_booking_drafts d WHERE d.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM webhook_events w WHERE w.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM provider_connections k WHERE k.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM clinic_closures z WHERE z.clinic_id = target_clinic) THEN
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
-- on, made explicit and brought ahead of the appointments it could not get
-- past: the people's own requests, whatever the desk decided; their
-- appointments; their conversations and the ones that produced their
-- appointments (a booking is about the person who booked, which is how
-- eraseContact already treats the call that produced it); then the contacts.
-- All of it or none of it: anything else still referring to them (a
-- transaction left behind, another person's appointment on one of their
-- calls, another person's request on one of their appointments) fails the
-- call with nothing removed.
--
-- Only the people's own requests. Live code gives a request and the
-- appointment it produced the same person (lib/voice/tools.ts,
-- lib/meta/booking-requests.ts) and never moves an appointment to another,
-- but the runtime role may write appointments.contact_id. The first version
-- of this function also took any request pointing at the people's
-- appointments, so pointing someone's confirmed booking at a throwaway
-- contact and erasing the throwaway took that someone's request while they
-- stayed. Now that request holds the booking, and the booking's delete fails
-- the call.
--
-- Contacts outside the tenant match nothing, so nothing goes. One call for
-- every contact matched, not one each, because one matched contact's
-- appointment can sit on another's call.
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
-- The record clock in force
-- -----------------------------------------------------------------------------
-- retention_record_days is the practice's setting, and the runtime role
-- writes it (0032). The purge of booking requests below is bounded by it, so
-- the first version of this migration let the runtime role set it to a day,
-- purge every decided request older than that and set it back, in one
-- transaction; with that version's day of grace, every request whose booking
-- was not still ahead. Now a shortened clock binds the purge of booking
-- requests only from a day after it was set, and until then the longer clock
-- it replaced stays in force. The trigger records that clock, and when it was
-- replaced, in two columns the runtime role cannot update (column grants do
-- not reach a column added after 0031) and a new clinic cannot carry
-- (clinics_insert_guard). A lengthened clock applies at once. The rest of the
-- purge, rows the runtime role may delete by hand anyway, follows the setting
-- as before.
CREATE OR REPLACE FUNCTION app_record_days_in_force(record_days integer, previous_days integer, shortened_at timestamptz)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN previous_days IS NOT NULL
                AND shortened_at IS NOT NULL
                AND shortened_at > now() - interval '1 day'
           THEN greatest(record_days, previous_days)
           ELSE record_days
         END
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_record_clock_shortened()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  in_force integer;
BEGIN
  in_force := app_record_days_in_force(OLD.retention_record_days, OLD.retention_record_days_previous,
                                       OLD.retention_record_days_shortened_at);
  IF NEW.retention_record_days < in_force THEN
    NEW.retention_record_days_previous := in_force;
    NEW.retention_record_days_shortened_at := now();
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER clinics_record_clock
  BEFORE UPDATE OF retention_record_days ON clinics
  FOR EACH ROW EXECUTE FUNCTION app_record_clock_shortened();--> statement-breakpoint

-- The latest cutoff the record clock in force allows the tenant, by the
-- database's clock. purgeClinic passes the earlier of this and its own cutoff,
-- in one statement, so a job whose clock runs ahead of the database's is
-- never refused for it.
CREATE OR REPLACE FUNCTION app_record_cutoff()
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  in_force integer;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_record_cutoff: no tenant; the record clock is one clinic''s own'
      USING ERRCODE = '42501';
  END IF;

  SELECT app_record_days_in_force(c.retention_record_days, c.retention_record_days_previous,
                                  c.retention_record_days_shortened_at)
    INTO in_force
    FROM clinics c
   WHERE c.id = tenant;
  IF in_force IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', tenant
      USING ERRCODE = 'no_data_found';
  END IF;
  RETURN now() - make_interval(days => in_force);
END
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The purge: requests past the record clock in force
-- -----------------------------------------------------------------------------
-- Called by purgeClinic (lib/retention/purge.ts) before it deletes the
-- appointments past the clock. A request goes once every date it carries is
-- past the cutoff: created_at, confirmed_for, and the time of the appointment
-- it produced. The first two are frozen once it is decided (0041, and the
-- runtime role holds no UPDATE on either); the third the runtime role can
-- write, and so can a sync from the clinic's own system (lib/sync/upsert.ts),
-- which is why it can only hold a request back, never send one early. The
-- first version of this function judged a request with an appointment by the
-- appointment's time alone, so moving a booking four hundred days back took
-- the request it came from while the booking stood a week ahead. A booking
-- made long ago for a slot still ahead keeps the request it came from, and
-- purgeClinic leaves any appointment a remaining request still holds for the
-- night the request goes.
--
-- record_before may be no later than app_record_cutoff(), with no grace. So
-- the function cannot reach a request the clock in force says to keep, nor
-- one behind a slot still ahead, and a clock shortened in the transaction
-- that calls it moves nothing for a day.
CREATE OR REPLACE FUNCTION app_purge_booking_requests(record_before timestamptz)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  allowed timestamptz;
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

  DELETE FROM booking_requests r
   WHERE r.clinic_id = tenant
     AND r.created_at < record_before
     AND (r.confirmed_for IS NULL OR r.confirmed_for < record_before)
     AND (r.appointment_id IS NULL
          OR EXISTS (SELECT 1
                       FROM appointments a
                      WHERE a.id = r.appointment_id
                        AND a.clinic_id = tenant
                        AND a.scheduled_for < record_before));
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_booking_requests(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_booking_requests(timestamptz) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- A request is written once
-- -----------------------------------------------------------------------------
-- booking_request_keys (generated above) keeps the id and token hash of every
-- booking request written, and keeps them after the request is deleted, by
-- any path: the three functions, a clinic's cascade, or the owner by hand. A
-- BEFORE INSERT trigger writes both there and refuses a request whose id or
-- token hash is there already. The runtime role holds INSERT on every column
-- of booking_requests (0037), id and token_hash included, and that cannot
-- become a column list for the reason given at clinics_insert_guard. Without
-- this, an early delete by any route the reviews found (or one not yet found)
-- could be followed by the same request under the same id and the same desk
-- link with another decision; with it, the worst such a route can do is
-- delete early.
--
-- Written at insert rather than at delete, on purpose. A record made by an
-- AFTER DELETE trigger is invisible to a second transaction until the delete
-- commits, and that transaction's re-insert of the same id waits on the
-- primary key for the delete and then goes through: the race puts the
-- request back. Here the id has been taken since the request was first
-- written, so the re-insert is refused at once, whatever else is in flight.
-- An insert that fails or rolls back takes its keys with it.
--
-- A random id and a digest of a random token identify nobody. 0003's default
-- privileges gave the runtime role DML on the new table; it keeps none. The
-- trigger function is SECURITY DEFINER so it writes the table whoever
-- inserts; it cannot be called except as a trigger, so EXECUTE on it gives
-- the runtime role nothing.
REVOKE ALL ON booking_request_keys FROM healdesk_app;--> statement-breakpoint
REVOKE ALL ON booking_request_keys FROM PUBLIC;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_booking_request_keys_once()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  written integer;
BEGIN
  INSERT INTO booking_request_keys (id, token_hash)
  VALUES (NEW.id, NEW.token_hash)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS written = ROW_COUNT;
  IF written = 0 THEN
    RAISE EXCEPTION 'booking_requests: id % or its token hash was written before; a booking request is written once, and one deleted never comes back under either', NEW.id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_booking_request_keys_once() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_booking_request_keys_once() TO healdesk_app;--> statement-breakpoint
CREATE TRIGGER booking_requests_keys_once
  BEFORE INSERT ON booking_requests
  FOR EACH ROW EXECUTE FUNCTION app_booking_request_keys_once();--> statement-breakpoint

-- The requests already written. booking_requests is FORCEd (0037), and FORCE
-- applies the tenant policy to its owner too, so a bare INSERT ... SELECT from
-- this migration would see no rows and report success; each clinic is visited
-- inside its own tenant context, as 0042 does, and the count is checked.
DO $$
DECLARE
  c record;
  requests integer := 0;
  recorded integer := 0;
  n integer;
BEGIN
  FOR c IN SELECT id FROM clinics LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    SELECT count(*) INTO n FROM booking_requests r WHERE r.clinic_id = c.id;
    requests := requests + n;
    INSERT INTO booking_request_keys (id, token_hash, written_at)
    SELECT r.id, r.token_hash, r.created_at
      FROM booking_requests r
     WHERE r.clinic_id = c.id
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    recorded := recorded + n;
  END LOOP;
  PERFORM set_config('app.clinic_id', '', true);
  IF recorded <> requests THEN
    RAISE EXCEPTION 'booking_request_keys: recorded % keys for % existing booking requests.', recorded, requests;
  END IF;
END
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON FUNCTION app_start_offboarding(uuid) IS
  'Stamps clinics.offboarding_started_at and destroy_after thirty days later from the database''s clock, once; starting again moves neither. The tenant''s own clinic only. The runtime role cannot UPDATE either column and a new clinic cannot carry them, because app_destroy_booking_requests reads them as its floor. Returns destroy_after.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Refuses unless the clinic passed is app.clinic_id, is due for destruction by the rule app_destroy_booking_requests applies, and holds none of the rows destroyClinicData deletes. Returns destroyed_at.';--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_booking_requests(uuid) IS
  'Deletes every booking request of the tenant''s own clinic, for destroyClinicData, before its appointments go. Refuses unless the clinic passed is app.clinic_id, its offboarding started thirty days ago and destroy_after has passed, by the database''s clock, on dates only app_start_offboarding writes. Returns the count.';--> statement-breakpoint
COMMENT ON FUNCTION app_erase_contacts(uuid[]) IS
  'Erases people inside the tenant (app.clinic_id), for eraseContact: their own booking requests, their appointments, their conversations and the ones that produced their appointments, then the contact rows, in one call, so a request leaves only with the person it names. Fails with nothing removed if anything else still refers to them, another person''s request on one of their appointments included; their transactions go first. Returns the four counts; contacts outside the tenant match nothing.';--> statement-breakpoint
COMMENT ON FUNCTION app_record_days_in_force(integer, integer, timestamptz) IS
  'The record clock in force: the clinic''s retention_record_days, or for a day after it was shortened the longer clock it replaced (retention_record_days_previous, recorded by the clinics_record_clock trigger).';--> statement-breakpoint
COMMENT ON FUNCTION app_record_cutoff() IS
  'now() less the tenant''s record clock in force (app_record_days_in_force): the latest cutoff app_purge_booking_requests accepts. Refuses without a tenant.';--> statement-breakpoint
COMMENT ON FUNCTION app_purge_booking_requests(timestamptz) IS
  'Deletes the tenant''s booking requests every date of which is before record_before: created_at, confirmed_for, and its appointment''s scheduled_for when it produced one. Refuses a cutoff later than app_record_cutoff(), the record clock in force by the database''s clock, with no grace. For purgeClinic, before the appointments past the same cutoff go. Returns the count.';--> statement-breakpoint
COMMENT ON TABLE booking_request_keys IS
  'The id and token hash of every booking request ever written, kept after it is deleted. Written by the BEFORE INSERT trigger booking_requests_keys_once, which refuses a request that reuses either, so a deleted request never comes back with another decision. The runtime role holds no privilege here. No clinic and no person: a random id and a digest of a random token.';--> statement-breakpoint
COMMENT ON COLUMN booking_requests.contact_id IS
  'The person the request is about. ON DELETE NO ACTION, not the cascade it had until the booking_request_destruction migration: a person cannot be deleted while a request names them. The request goes first, by destruction, erasure or the purge (app_destroy_booking_requests, app_erase_contacts, app_purge_booking_requests), and its id and token hash are never written again (booking_request_keys).';--> statement-breakpoint
COMMENT ON COLUMN booking_requests.appointment_id IS
  'The appointment a confirmed request produced (booking_requests_confirmed_shape). ON DELETE NO ACTION, not SET NULL: the appointment cannot be deleted while a request points at it, and a decided request cannot be rewritten to let it go, so the request is deleted first, by destruction, erasure or the purge (app_destroy_booking_requests, app_erase_contacts, app_purge_booking_requests).';--> statement-breakpoint
COMMENT ON COLUMN clinics.retention_record_days IS
  'Days after which conversation, appointment, booking request and transaction rows are deleted. 90 by default, the period the BAA states (TRANSCRIPT_RETENTION_DAYS in @healdesk/catalog); the practice may shorten it, never below a day (clinics_retention_record_days_positive), and a shortened clock reaches booking requests a day after it is set (app_record_days_in_force). A booking request goes once its created_at, its confirmed_for and its appointment''s time are all past the clock. Consent records, suppressions and contact attempts are never on this clock: they are evidence.';--> statement-breakpoint
COMMENT ON COLUMN clinics.retention_record_days_previous IS
  'The record clock in force just before its last shortening, which stays in force for booking requests for a day (app_record_days_in_force). Written only by the clinics_record_clock trigger.';--> statement-breakpoint
COMMENT ON COLUMN clinics.retention_record_days_shortened_at IS
  'When the record clock was last shortened. Written only by the clinics_record_clock trigger.';--> statement-breakpoint
COMMENT ON COLUMN clinics.offboarding_started_at IS
  'When the clinic left (subscription deleted, or an operator ended it). Written only by app_start_offboarding(), from the database''s clock; a new clinic cannot carry it (clinics_insert_guard).';--> statement-breakpoint
COMMENT ON COLUMN clinics.destroy_after IS
  'Hard-delete of patient data is permitted from this instant, thirty days after offboarding_started_at, and only if export_delivered_at is set or 90 days have passed since offboarding_started_at. Written only by app_start_offboarding(), from the database''s clock; a new clinic cannot carry it (clinics_insert_guard). See lib/offboarding.';--> statement-breakpoint
COMMENT ON COLUMN clinics.destroyed_at IS
  'When destruction ran. Written only by app_mark_clinic_destroyed(), from the database''s clock, once every row destroyClinicData deletes is gone; a new clinic cannot carry it (clinics_insert_guard).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE from booking_requests; a request is evidence of what the practice was told, and only app_destroy_booking_requests, app_erase_contacts and app_purge_booking_requests may remove one.';
  END IF;
  IF (SELECT con.confdeltype
        FROM pg_constraint con
       WHERE con.conrelid = 'booking_requests'::regclass
         AND con.conname = 'booking_requests_appointment_id_appointments_id_fk') IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'booking_requests.appointment_id is not ON DELETE NO ACTION; any other action collides with booking_requests_confirmed_shape and app_booking_request_no_rewrite.';
  END IF;
  IF (SELECT con.confdeltype
        FROM pg_constraint con
       WHERE con.conrelid = 'booking_requests'::regclass
         AND con.conname = 'booking_requests_contact_id_contacts_id_fk') IS DISTINCT FROM 'a' THEN
    RAISE EXCEPTION 'booking_requests.contact_id is not ON DELETE NO ACTION; with a cascade the runtime role can delete a person and with them their requests, outside the three functions.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'offboarding_started_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'destroy_after', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'destroyed_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE an offboarding date on clinics; app_destroy_booking_requests reads them as its floor, so only app_start_offboarding and app_mark_clinic_destroyed may write them.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'retention_record_days_previous', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'retention_record_days_shortened_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE the record clock''s history on clinics; app_purge_booking_requests reads it as its floor, so only the clinics_record_clock trigger may write it.';
  END IF;
  IF has_table_privilege('healdesk_app'::name, 'booking_request_keys'::regclass,
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'healdesk_app holds a privilege on booking_request_keys; the record of every request written is what keeps a deleted one from coming back.';
  END IF;
  IF (SELECT count(*)
        FROM pg_trigger t
       WHERE NOT t.tgisinternal
         AND t.tgenabled = 'O'
         AND ((t.tgrelid = 'booking_requests'::regclass AND t.tgname = 'booking_requests_keys_once')
           OR (t.tgrelid = 'clinics'::regclass
               AND t.tgname IN ('clinics_insert_guard', 'clinics_record_clock')))) <> 3 THEN
    RAISE EXCEPTION 'booking_requests_keys_once, clinics_insert_guard or clinics_record_clock is missing or not enabled.';
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
     OR has_function_privilege('public', 'app_purge_booking_requests(timestamptz)', 'EXECUTE')
     OR has_function_privilege('public', 'app_booking_request_keys_once()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A SECURITY DEFINER function of this migration (app_start_offboarding, app_mark_clinic_destroyed, app_destroy_booking_requests, app_erase_contacts, app_purge_booking_requests or app_booking_request_keys_once) is executable by PUBLIC.';
  END IF;
END;
$$;
