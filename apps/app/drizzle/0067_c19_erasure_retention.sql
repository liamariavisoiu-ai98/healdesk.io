-- =============================================================================
-- What a person's deletion and the retention purge still left behind (the
-- calendar session's pre-release re-audit of BAA 1.3.0, C19, 12 October
-- 2026). This migration changes no table drizzle describes, so drizzle
-- generated it empty (--custom); everything below is hand-written.
--
--   * A person's deposits survived their deletion. No erase path touched
--     deposit_payments: the runtime role has no DELETE on it (0043), and the
--     appointment's foreign key is ON DELETE SET NULL, so once
--     app_erase_contacts deleted the appointments the deposits could no
--     longer be found, and kept their amount, paid_at and Checkout session
--     id, which leads to the payer in the clinic's own Stripe account.
--     app_erase_contacts now deletes the deposits of the people's
--     appointments, and the Connect webhook rows that last touched them
--     (deposit_payments.last_event_id = stripe_connect_events.stripe_event_id,
--     the only link the ledger has), before the appointments go. There is
--     no money record the law needs kept here: the deposit is the clinic's
--     charge in its own Connect account, which stays the record, and the
--     row is a copy (healdesk-io-58, who owns deposits).
--     NOT erased: earlier Connect events for the same Checkout session. The
--     ledger has no column linking them to a deposit or a person; each holds
--     an event id, its type, the account, timestamps and the outcome, with
--     no session id and no amount. They go at the clinic's destruction
--     (app_destroy_deposit_payments, 0065), with every other row resolved to
--     the clinic.
--   * A household thread kept the person's own identifier. When a thread
--     also booked for someone else, the requests and the draft it sent for
--     them stay as theirs; on WhatsApp the thread's sender id is the erased
--     person's own telephone number, written on every one of those rows.
--     app_unthread_requests() takes the thread off the kept requests
--     (sender_id and external_id to NULL; the desk calls the number on the
--     request instead), and booking_requests_channel_shape now lets a Meta
--     request carry no thread, both columns at once. The kept draft, whose
--     thread is its key, and the thread's own row are deleted by the
--     application (lib/patient-rights/erasure.ts).
--   * A call with no caller ID kept its conversation. Its raw payload,
--     which named the person, was deleted, but the conversation, with
--     treatment_interest, transcript_uri and external_call_id, stayed until
--     the record clock took it. app_erase_unmatched_calls() deletes the
--     conversations those payloads were (external_call_id = the payload's
--     delivery id), with their amendments, when no contact is on them and
--     nothing else refers to them.
--   * The purge kept rows up to a day past their period. Its cutoffs were
--     exactly now less the period, and it runs at 03 and 09 UTC, so a row
--     lived up to the period and eighteen hours, or a day more when a tick
--     was missed, against clause 4's "no longer than the periods this
--     agreement states". Every cutoff the purge takes by a stated period is
--     now a day early (lib/retention/purge.ts), and app_record_cutoff(), the
--     latest cutoff the database accepts, takes the same day.
--   * Deposits had no retention clock, only destruction.
--     app_purge_deposit_payments() deletes a deposit with its appointment,
--     under the record clock, and one whose appointment is already gone once
--     it is older than the clock.
--
-- Safe to apply in place: one constraint widened, two functions redefined on
-- their latest bodies (app_erase_contacts, 0064; app_record_cutoff, 0058),
-- four new ones. apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The record a deletion's later steps run under
-- -----------------------------------------------------------------------------
-- The check app_erase_contact_evidence() (0063) makes, as a function the new
-- definers share: the named deletion request was written in this transaction,
-- or still holds its restore references (the reapply path after a restore).
-- Returns its erased_at, the bound on what the step may take. Against the
-- runtime role this is advisory (it can write such a record itself; 0063's
-- comment says how); the audit rows the steps write are the bound.
CREATE OR REPLACE FUNCTION app_erasure_record_bound(erasure uuid)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  recorded_before timestamptz;
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_erasure_record_bound: no tenant; an erasure runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;
  SELECT er.erased_at
    INTO recorded_before
    FROM erasure_requests er
   WHERE er.clinic_id = tenant
     AND er.id = erasure
     AND (er.erased_at >= now() OR cardinality(er.restore_refs) > 0);
  IF recorded_before IS NULL THEN
    RAISE EXCEPTION 'no deletion request % written in this transaction, or holding its restore references, at clinic %', erasure, tenant
      USING ERRCODE = '42501',
            HINT = 'erasePerson records the request before it deletes; reapplyErasures uses a record whose references have not expired.';
  END IF;
  RETURN recorded_before;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_erasure_record_bound(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_erasure_record_bound(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Erasure: the people's deposits go with them
-- -----------------------------------------------------------------------------
-- 0064's definition, the last before this one, with the deposits of the
-- people's appointments deleted before the appointments, and the Connect
-- events that last touched those deposits before them. Every guarantee it
-- gave it still gives: only the people's own requests, the amendments of what
-- it deletes first, and all of it or none of it.
DROP FUNCTION app_erase_contacts(uuid[]);--> statement-breakpoint
CREATE FUNCTION app_erase_contacts(
  target_contacts uuid[],
  OUT requests_deleted integer,
  OUT appointments_deleted integer,
  OUT conversations_deleted integer,
  OUT contacts_deleted integer,
  OUT amendments_deleted integer,
  OUT deposits_deleted integer,
  OUT connect_events_deleted integer
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

  -- Their deposits, while the appointments still lead to them (the foreign
  -- key sets appointment_id to NULL when an appointment goes), and first the
  -- Connect events that last touched them: the ledger's only link to a
  -- deposit is last_event_id. One resolved to another clinic is never taken.
  DELETE FROM stripe_connect_events e
   WHERE e.stripe_event_id IN (SELECT dp.last_event_id
                                 FROM deposit_payments dp
                                WHERE dp.clinic_id = tenant
                                  AND dp.appointment_id = ANY (bookings)
                                  AND dp.last_event_id IS NOT NULL)
     AND (e.resolved_clinic_id IS NULL OR e.resolved_clinic_id = tenant);
  GET DIAGNOSTICS connect_events_deleted = ROW_COUNT;

  DELETE FROM deposit_payments dp
   WHERE dp.clinic_id = tenant
     AND dp.appointment_id = ANY (bookings);
  GET DIAGNOSTICS deposits_deleted = ROW_COUNT;

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
-- A household thread: the kept requests lose the person's identifier
-- -----------------------------------------------------------------------------
-- A Meta request may now carry no thread, but only both columns together.
-- Only app_unthread_requests() writes that shape: the runtime role has no
-- UPDATE on either column, and every request it inserts has its thread.
ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_channel_shape;--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_channel_shape CHECK (
    (channel = 'meta' AND platform IS NOT NULL
      AND ((external_id IS NOT NULL AND sender_id IS NOT NULL)
           OR (external_id IS NULL AND sender_id IS NULL)))
    OR (channel = 'voice' AND platform IS NULL)
  );--> statement-breakpoint

-- Takes the thread off the tenant's Meta requests sent from the given
-- threads ("platform:sender id"), recorded no later than the deletion
-- request's erased_at: sender_id and external_id to NULL, nothing else
-- changed. For a thread whose identifier is the erased person's own (a
-- WhatsApp sender id is their number), whose requests for other people are
-- kept as those people's records. Writes an audit row when it changes any.
CREATE OR REPLACE FUNCTION app_unthread_requests(erasure uuid, threads text[])
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  recorded_before timestamptz := app_erasure_record_bound(erasure);
  changed integer;
BEGIN
  UPDATE booking_requests r
     SET sender_id = NULL,
         external_id = NULL
   WHERE r.clinic_id = tenant
     AND r.channel = 'meta'
     AND r.sender_id IS NOT NULL
     AND (r.platform || ':' || r.sender_id) = ANY (coalesce(threads, '{}'))
     AND r.created_at <= recorded_before;
  GET DIAGNOSTICS changed = ROW_COUNT;

  IF changed > 0 THEN
    INSERT INTO audit_log (clinic_id, actor_type, actor_label, action, resource_type, resource_id, result_count, metadata)
    VALUES (tenant, 'system', 'app_unthread_requests', 'update', 'booking_request_unthreaded', erasure::text,
            changed, jsonb_build_object('erasureId', erasure, 'requests', changed));
  END IF;
  RETURN changed;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_unthread_requests(uuid, text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_unthread_requests(uuid, text[]) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- A call with no caller ID: its conversation goes with its payload
-- -----------------------------------------------------------------------------
-- The conversations of the given calls (external_call_id, the voice
-- payload's delivery id), started no later than the deletion request's
-- erased_at, that no contact is on and nothing else refers to: no
-- appointment and no booking request. A call on someone's contact, or one
-- that produced someone else's booking, is that person's record and stays.
-- Their amendments go first, in the same call, as everywhere else.
CREATE OR REPLACE FUNCTION app_erase_unmatched_calls(
  erasure uuid,
  target_calls text[],
  OUT conversations_deleted integer,
  OUT amendments_deleted integer
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  recorded_before timestamptz := app_erasure_record_bound(erasure);
  doomed uuid[];
BEGIN
  SELECT coalesce(array_agg(v.id), '{}')
    INTO doomed
    FROM conversations v
   WHERE v.clinic_id = tenant
     AND v.external_call_id = ANY (coalesce(target_calls, '{}'))
     AND v.contact_id IS NULL
     AND v.started_at <= recorded_before
     AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.clinic_id = tenant AND a.conversation_id = v.id)
     AND NOT EXISTS (SELECT 1 FROM booking_requests r WHERE r.clinic_id = tenant AND r.conversation_id = v.id);

  DELETE FROM record_amendments ra
   WHERE ra.clinic_id = tenant
     AND ra.conversation_id = ANY (doomed);
  GET DIAGNOSTICS amendments_deleted = ROW_COUNT;

  DELETE FROM conversations v
   WHERE v.clinic_id = tenant
     AND v.id = ANY (doomed);
  GET DIAGNOSTICS conversations_deleted = ROW_COUNT;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_erase_unmatched_calls(uuid, text[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_erase_unmatched_calls(uuid, text[]) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The record clock, a day early
-- -----------------------------------------------------------------------------
-- 0058's definition, with the cutoff a day before the clock in force: the
-- purge runs at 03 and 09 UTC, so a cutoff of exactly the period kept a row
-- up to eighteen hours past it, and a day more after a missed tick. A day
-- early, every row is gone before its period ends, whichever run takes it.
-- The latest cutoff app_purge_booking_requests, app_purge_amended_appointments,
-- app_purge_amended_conversations and app_purge_deposit_payments accept. A
-- one-day clock (the least clinics.retention_record_days allows) cuts at now.
CREATE OR REPLACE FUNCTION app_record_cutoff()
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
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
  RETURN now() - make_interval(days => greatest(in_force - 1, 0));
END
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Deposits on the record clock
-- -----------------------------------------------------------------------------
-- A deposit goes the night its appointment does: the appointment is past the
-- cutoff and no booking request holds it (the same predicate purgeClinic and
-- app_purge_amended_appointments use), so it is deleted while the
-- appointment still leads to it. A deposit whose appointment is already gone
-- (its link set to NULL) goes once it is older than the cutoff. With each,
-- the Connect event that last touched it. The runtime role has no DELETE on
-- deposit_payments (0043), so this does it, no later than app_record_cutoff().
CREATE OR REPLACE FUNCTION app_purge_deposit_payments(
  record_before timestamptz,
  OUT deposits_deleted integer,
  OUT connect_events_deleted integer
)
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
BEGIN
  IF tenant IS NULL THEN
    RAISE EXCEPTION 'app_purge_deposit_payments: no tenant; a purge runs inside the clinic''s own transaction'
      USING ERRCODE = '42501';
  END IF;

  allowed := app_record_cutoff();
  IF record_before IS NULL OR record_before > allowed THEN
    RAISE EXCEPTION 'app_purge_deposit_payments: % is later than clinic %''s record clock allows (%); refusing.',
      record_before, tenant, allowed
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT coalesce(array_agg(dp.id), '{}')
    INTO doomed
    FROM deposit_payments dp
   WHERE dp.clinic_id = tenant
     AND ((dp.appointment_id IS NULL AND dp.created_at < record_before)
          OR EXISTS (SELECT 1
                       FROM appointments a
                      WHERE a.id = dp.appointment_id
                        AND a.clinic_id = tenant
                        AND a.scheduled_for < record_before
                        AND NOT EXISTS (SELECT 1 FROM booking_requests r
                                         WHERE r.clinic_id = tenant AND r.appointment_id = a.id)));

  DELETE FROM stripe_connect_events e
   WHERE e.stripe_event_id IN (SELECT dp.last_event_id
                                 FROM deposit_payments dp
                                WHERE dp.clinic_id = tenant
                                  AND dp.id = ANY (doomed)
                                  AND dp.last_event_id IS NOT NULL)
     AND (e.resolved_clinic_id IS NULL OR e.resolved_clinic_id = tenant);
  GET DIAGNOSTICS connect_events_deleted = ROW_COUNT;

  DELETE FROM deposit_payments dp
   WHERE dp.clinic_id = tenant
     AND dp.id = ANY (doomed);
  GET DIAGNOSTICS deposits_deleted = ROW_COUNT;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_purge_deposit_payments(timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_purge_deposit_payments(timestamptz) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON FUNCTION app_erasure_record_bound(uuid) IS
  'The erased_at of the named deletion request, which must have been written in this transaction or still hold its restore references; refuses otherwise. The bound the erasure steps of 0067 run under. Advisory against the runtime role, which can write such a record; their audit rows are the bound.';--> statement-breakpoint
COMMENT ON FUNCTION app_erase_contacts(uuid[]) IS
  'Deletes the tenant''s given contacts with their own booking requests, their appointments, the deposits of those appointments and the Connect events that last touched them, their conversations and the ones that produced their appointments, and the amendments of all of these. All or nothing: anything else that still refers to them fails the call. For eraseContact in lib/retention/purge.ts; the runtime role has no DELETE on booking requests or deposits.';--> statement-breakpoint
COMMENT ON FUNCTION app_unthread_requests(uuid, text[]) IS
  'Sets sender_id and external_id to NULL on the tenant''s Meta requests sent from the given threads, recorded no later than the named deletion request (app_erasure_record_bound). For a household thread whose identifier is the erased person''s own: the requests it sent for others stay, without it. Writes an audit row (booking_request_unthreaded) when it changes any.';--> statement-breakpoint
COMMENT ON FUNCTION app_erase_unmatched_calls(uuid, text[]) IS
  'Deletes the tenant''s conversations of the given calls that no contact is on, no appointment or booking request refers to, and that started no later than the named deletion request, with their amendments: a call with no caller ID whose raw payload named the person.';--> statement-breakpoint
COMMENT ON FUNCTION app_record_cutoff() IS
  'now() less the tenant''s record clock in force (app_record_days_in_force), a day early (0067): the latest cutoff the purge''s definers accept, so a row is gone before its period ends whichever run takes it. Refuses without a tenant.';--> statement-breakpoint
COMMENT ON FUNCTION app_purge_deposit_payments(timestamptz) IS
  'Deletes the tenant''s deposits whose appointment is past the cutoff and held by no booking request, and those whose appointment is gone and that are older than it, with the Connect events that last touched them. Refuses a cutoff later than app_record_cutoff(). Returns the two counts.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  offending text;
BEGIN
  IF has_function_privilege('public', 'app_erase_contacts(uuid[])', 'EXECUTE')
     OR has_function_privilege('public', 'app_unthread_requests(uuid, text[])', 'EXECUTE')
     OR has_function_privilege('public', 'app_erase_unmatched_calls(uuid, text[])', 'EXECUTE')
     OR has_function_privilege('public', 'app_purge_deposit_payments(timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'A SECURITY DEFINER function of this migration is executable by PUBLIC.';
  END IF;

  IF has_column_privilege('healdesk_app', 'booking_requests', 'sender_id', 'UPDATE')
     OR has_column_privilege('healdesk_app', 'booking_requests', 'external_id', 'UPDATE')
     OR has_table_privilege('healdesk_app', 'deposit_payments', 'DELETE')
     OR has_table_privilege('healdesk_app', 'stripe_connect_events', 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can rewrite a request''s thread, or delete deposits or Connect events, directly; only the definers may.';
  END IF;

  SELECT string_agg(p.proname, ', ') INTO offending
    FROM pg_proc p
   WHERE p.oid IN ('app_erasure_record_bound(uuid)'::regprocedure,
                   'app_erase_contacts(uuid[])'::regprocedure,
                   'app_unthread_requests(uuid, text[])'::regprocedure,
                   'app_erase_unmatched_calls(uuid, text[])'::regprocedure,
                   'app_record_cutoff()'::regprocedure,
                   'app_purge_deposit_payments(timestamptz)'::regprocedure)
     AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c WHERE c LIKE 'search_path=%');
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Function(s) without a pinned search_path: %', offending;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO offending
    FROM pg_proc p
   WHERE p.oid IN ('app_record_cutoff()'::regprocedure,
                   'app_purge_deposit_payments(timestamptz)'::regprocedure)
     AND NOT ('TimeZone=UTC' = ANY (coalesce(p.proconfig, ARRAY[]::text[])));
  IF offending IS NOT NULL THEN
    RAISE EXCEPTION 'Function(s) that lost or lack the UTC pin (drizzle/0058): %', offending;
  END IF;
END;
$$;
