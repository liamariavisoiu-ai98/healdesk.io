-- =============================================================================
-- The destruction clock follows the clinic's own agreement (7 October 2026).
-- This migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- The failure, in one paragraph. Until now every clinic ran on one clock:
-- destroy_after thirty days after offboarding started, and the daily job
-- (dueForDestruction) destroying once it had passed if the export had been
-- delivered, and otherwise only once ninety days had. That is the rule DPA
-- 1.0.0 states and BAA 1.3.0 will state. It is not what BAA 1.2.1 says, the
-- version every practice signs today, as 1.2.0 and 1.1.0-draft do: "Within
-- thirty days of termination healdesk will return or destroy all PHI it holds
-- for Practice and retain no copies" (1.0.0 and 0.1.0-draft say "On
-- termination"). A 1.2.1 practice whose export had not been delivered had
-- its patients held for up to sixty days longer than its signed agreement
-- allows. And the thirty days ran from when we processed the end
-- rather than from the end itself, so a deletion Stripe retried for hours, or
-- one a person replayed days later, started them late by as much, and a daily
-- job reached a clinic due at day 30 up to a day after it.
--
-- What changes:
--
--   * The rule comes from the agreement the clinic was bound to when its
--     service ended, terminated since or not (app_agreement_at_end). The
--     agreement in effect (app_agreement_in_effect, 0048) skips a terminated
--     acceptance, and an operator records a termination whenever they get to
--     it (markAgreementTerminated), so at destruction time it may read none.
--   * app_destruction_rule() is the version-to-rule map in SQL: an allow-list
--     of the versions that state the DPA's rule. Every other version, one no
--     one has mapped, and no agreement at all get the thirty days, the
--     strictest rule. DESTRUCTION_RULES in lib/offboarding/offboarding.ts is
--     the map; tests/destruction-clock.test.ts holds the two together and
--     fails when a template in the catalog has no entry.
--   * app_destruction_due() is the floor under both delete functions and the
--     destroyed stamp, and the same rule dueForDestruction applies:
--       thirty days (BAA 1.2.1 and earlier, none, unknown): from day 29, so
--         that the job, which now runs every hour, has the data gone before
--         the thirty days are up whatever hour the clinic left;
--       the DPA's rule (BAA 1.3.0, DPA 1.0.0): from day 30 once the export
--         has been delivered, and from day 90 whether or not it has.
--   * app_start_offboarding() takes the moment the service ended (Stripe's
--     own end of the subscription) and stamps it, clamped to no earlier than
--     a week before the call and no later than the call.
--   * export_delivered_at is the database's stamp too, written once by
--     app_mark_export_delivered() at the moment a delivery is recorded,
--     because the floor now reads it.
--   * Suppressions, consent records and contact attempts are destroyed with
--     the rest (BAA 1.3.0 release gate 7). v1 places no outbound contact, so
--     the TCPA evidence they were kept as has nothing to evidence, and every
--     agreement's return-or-destroy clause reaches them. The runtime role has
--     no DELETE on them (0010), so app_destroy_contact_evidence() deletes
--     the tenant's, on the same floor, and app_mark_clinic_destroyed()
--     refuses while any is left.
--   * app_clinics_overview() carries the version the rule was read from.
--   * The offboarding-destroy job runs every hour (lib/scheduler/tick.ts).
--
-- What a compromised runtime role can still do, said plainly. It holds INSERT
-- on baa_acceptances, which signing needs, and a column-level REVOKE cannot
-- narrow a table-level grant (0054 explains why the grant cannot become a
-- column list), so it can write an acceptance of any version, bound to any
-- organisation and accepted at any time, and so put any clinic on the thirty
-- days. With the start backdated by the week the clamp allows, the earliest
-- it can make anything due is day 29 counted from a week before its call:
-- twenty-two days after it starts, and the clinic it starts on has its
-- service ended in plain sight. That bound is the floor's; the rule beyond it
-- is the agreement's.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and no clinic has offboarded
-- outside a test.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The rule, from the agreement the service ended under
-- -----------------------------------------------------------------------------
-- The versions whose Term clause states the DPA's rule. A version is the
-- stored document_version, namespace included: the DPA's are "dpa/1.0.0"
-- (0051), so the DPA's 1.0.0 and the BAA's 1.0.0 are different strings with
-- different rules. Total and never NULL; NULL (no agreement) and any version
-- not listed read as the thirty days. An allow-list rather than a deny-list,
-- so a version released without a migration fails strict, never lenient.
CREATE OR REPLACE FUNCTION app_destruction_rule(version text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN version = ANY (ARRAY['1.3.0', 'dpa/1.0.0']) THEN 'export_or_ninety'
           ELSE 'thirty_days'
         END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destruction_rule(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destruction_rule(text) TO healdesk_app;--> statement-breakpoint

-- The agreement a clinic was bound to when its service ended: the newest
-- acceptance bound to its organisation that was accepted, and bound, no later
-- than offboarding_started_at, whether or not it has been terminated since.
-- No row while the clinic is not offboarding, or when its organisation held
-- no agreement then. Not SECURITY DEFINER, like app_agreement_in_effect: the
-- callers that need every clinic are definers already, and in a tenant
-- session FORCE ROW LEVEL SECURITY shows only that tenant's organisation,
-- which is the only one it asks about.
CREATE OR REPLACE FUNCTION app_agreement_at_end(target_clinic uuid)
RETURNS TABLE (agreement_id uuid, document_version text, accepted_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT b.id, b.document_version, b.accepted_at
    FROM clinics c
    JOIN baa_acceptances b ON b.organization_id = c.organization_id
   WHERE c.id = target_clinic
     AND c.offboarding_started_at IS NOT NULL
     AND b.accepted_at <= c.offboarding_started_at
     AND (b.bound_at IS NULL OR b.bound_at <= c.offboarding_started_at)
   ORDER BY b.accepted_at DESC, b.id DESC
   LIMIT 1
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_agreement_at_end(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_agreement_at_end(uuid) TO healdesk_app;--> statement-breakpoint

-- Whether the clinic's data may be destroyed now, by the database's clock and
-- the rule of the agreement its service ended under. The floor under
-- dueForDestruction (lib/offboarding/offboarding.ts), which decides when the
-- job asks: the thirty days' clinic from day 29, the DPA rule's from day 30
-- with the export delivered and from day 90 without. now(), the start of the
-- destroying transaction, is earlier than the moment of any statement in it,
-- so a transaction left open cannot spend its own wait; the dates it reads
-- are written by app_start_offboarding() and app_mark_export_delivered()
-- alone. Not SECURITY DEFINER: only the three definers below call it.
CREATE OR REPLACE FUNCTION app_destruction_due(target_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((
    SELECT CASE app_destruction_rule((SELECT e.document_version FROM app_agreement_at_end(c.id) e))
             WHEN 'export_or_ninety' THEN
                   c.offboarding_started_at <= now() - interval '30 days'
               AND c.destroy_after <= now()
               AND (c.export_delivered_at IS NOT NULL
                    OR c.offboarding_started_at <= now() - interval '90 days')
             ELSE c.offboarding_started_at <= now() - interval '29 days'
           END
      FROM clinics c
     WHERE c.id = target_clinic
       AND c.offboarding_started_at IS NOT NULL
       AND c.destroy_after IS NOT NULL), false)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destruction_due(uuid) FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The clock starts when the service ended
-- -----------------------------------------------------------------------------
-- 0054's definition, with the end passed in. startOffboarding passes the
-- subscription's own end from Stripe's signed customer.subscription.deleted
-- (its ended_at, else the event's created); the operator path and our own
-- setup closure pass nothing, and get the moment of the call. The stamp is
-- that end, clamped to no earlier than a week before the call and no later
-- than the call, both by the database's clock at the call (clock_timestamp(),
-- for 0054's reason: a transaction opened long ago and left idle must not
-- stamp an end already old). So a deletion processed late, by Stripe's retries
-- or a replay of a dead letter, starts the clock when the practice left, as
-- the agreements count it, and a runtime role that passes any other moment
-- moves the clock a week at most. Once stamped, nothing moves either date.
--
-- Returns the stamps, whether this call made them, and the end it was asked
-- for, so the caller can tell ops when the week's clamp cost the practice
-- days (lib/offboarding, offboarding_started_late).
DROP FUNCTION IF EXISTS app_start_offboarding(uuid);--> statement-breakpoint
CREATE FUNCTION app_start_offboarding(
  target_clinic uuid,
  ended timestamptz DEFAULT NULL,
  OUT started_at timestamptz,
  OUT due_at timestamptz,
  OUT first_start boolean,
  OUT asked_for timestamptz
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  clock timestamptz := clock_timestamp();
  stamp timestamptz;
  prior timestamptz;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_start_offboarding: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  asked_for := coalesce(ended, clock);
  stamp := greatest(least(asked_for, clock), clock - interval '7 days');

  SELECT c.offboarding_started_at INTO prior
    FROM clinics c
   WHERE c.id = target_clinic
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE clinics c
     SET offboarding_started_at = coalesce(c.offboarding_started_at, stamp),
         destroy_after = coalesce(c.destroy_after, stamp + interval '30 days'),
         updated_at = now()
   WHERE c.id = target_clinic
  RETURNING c.offboarding_started_at, c.destroy_after INTO started_at, due_at;
  first_start := prior IS NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_start_offboarding(uuid, timestamptz) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_start_offboarding(uuid, timestamptz) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The export's delivery, stamped by the database
-- -----------------------------------------------------------------------------
-- The floor reads export_delivered_at now, so the runtime role loses UPDATE on
-- it, as 0054 took the offboarding dates out of its reach, and only this
-- function writes it: the tenant's own clinic, once offboarding has started
-- and before its data is destroyed, at the moment of the call, once. It is
-- called when the export reaches the practice, never when it is produced
-- (markExportDelivered in lib/offboarding: the operator's record of the
-- handover). A second call keeps the first stamp.
REVOKE UPDATE (export_delivered_at) ON clinics FROM healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_mark_export_delivered(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  tenant uuid := app_current_clinic_id();
  started timestamptz;
  done timestamptz;
  delivered timestamptz;
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_mark_export_delivered: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  SELECT c.offboarding_started_at, c.destroyed_at INTO started, done
    FROM clinics c
   WHERE c.id = target_clinic
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;
  IF started IS NULL THEN
    RAISE EXCEPTION 'Clinic % is not offboarding; the export is delivered on the way out.', target_clinic
      USING ERRCODE = 'check_violation';
  END IF;
  IF done IS NOT NULL THEN
    RAISE EXCEPTION 'Clinic %''s data was destroyed on %; there is no export left to deliver.', target_clinic, done
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE clinics c
     SET export_delivered_at = coalesce(c.export_delivered_at, clock_timestamp()),
         updated_at = now()
   WHERE c.id = target_clinic
  RETURNING c.export_delivered_at INTO delivered;
  RETURN delivered;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_mark_export_delivered(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_mark_export_delivered(uuid) TO healdesk_app;--> statement-breakpoint

-- 0054's insert guard with export_delivered_at added: a clinic born with an
-- export already delivered would meet the DPA rule's day 30 without one.
CREATE OR REPLACE FUNCTION app_clinic_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.offboarding_started_at IS NOT NULL
     OR NEW.destroy_after IS NOT NULL
     OR NEW.destroyed_at IS NOT NULL
     OR NEW.export_delivered_at IS NOT NULL
     OR NEW.retention_record_days_previous IS NOT NULL
     OR NEW.retention_record_days_shortened_at IS NOT NULL THEN
    RAISE EXCEPTION 'clinics: a new clinic carries no offboarding date, no export delivery and no record-clock history; app_start_offboarding, app_mark_export_delivered, app_mark_clinic_destroyed and the clinics_record_clock trigger write them'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Destruction, on the floor above
-- -----------------------------------------------------------------------------
-- 0054's definition with the floor replaced: app_destruction_due() instead of
-- thirty days for every clinic. The message is unchanged.
CREATE OR REPLACE FUNCTION app_destroy_booking_requests(target_clinic uuid)
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
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_destroy_booking_requests: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to delete its booking requests.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction is due by the rule of the agreement the service ended under (app_destruction_due), by the database''s clock.';
  END IF;

  DELETE FROM booking_requests r WHERE r.clinic_id = target_clinic;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint

-- Suppressions, consent records and contact attempts: every one of the
-- tenant's own, once it is due. The runtime role has no DELETE on any of the
-- three (0010: append-only by grant, as TCPA evidence) and is given none,
-- because an inbound-only product still writes suppressions (an erasure, a
-- "stop"), and one the runtime role could delete at will would be a "stop"
-- it could quietly undo. FORCE ROW LEVEL SECURITY binds the definer to the
-- tenant as it binds everyone.
CREATE OR REPLACE FUNCTION app_destroy_contact_evidence(
  target_clinic uuid,
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
BEGIN
  IF tenant IS NULL OR target_clinic IS DISTINCT FROM tenant THEN
    RAISE EXCEPTION 'app_destroy_contact_evidence: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;

  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to delete its suppressions, consent records and contact attempts.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction is due by the rule of the agreement the service ended under (app_destruction_due), by the database''s clock.';
  END IF;

  DELETE FROM suppressions s WHERE s.clinic_id = target_clinic;
  GET DIAGNOSTICS suppressions_deleted = ROW_COUNT;
  DELETE FROM consent_records r WHERE r.clinic_id = target_clinic;
  GET DIAGNOSTICS consent_records_deleted = ROW_COUNT;
  DELETE FROM contact_attempts a WHERE a.clinic_id = target_clinic;
  GET DIAGNOSTICS contact_attempts_deleted = ROW_COUNT;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destroy_contact_evidence(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destroy_contact_evidence(uuid) TO healdesk_app;--> statement-breakpoint

-- 0054's definition with the floor replaced and the three tables above added
-- to the list it requires empty. Every table it checked before, it still
-- checks; tests/booking-request-destruction.test.ts reads the list from this
-- source and pins destroyClinicData's deletes to it.
CREATE OR REPLACE FUNCTION app_mark_clinic_destroyed(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
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
     OR EXISTS (SELECT 1 FROM suppressions s WHERE s.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM consent_records g WHERE g.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM contact_attempts n WHERE n.clinic_id = target_clinic) THEN
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
-- The console projection, with the version the rule is read from
-- -----------------------------------------------------------------------------
-- 0048's definition plus destruction_agreement_version
-- (app_agreement_at_end), so the daily job and the console read the rule from
-- the same row. Contract metadata, not patient data. A return type cannot
-- change under CREATE OR REPLACE, so drop and recreate, as 0048 did.
DROP FUNCTION IF EXISTS app_clinics_overview();--> statement-breakpoint
CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid, slug text, name text, timezone text, specialty text, plan text,
  attribution_mode attribution_mode, data_classification data_classification,
  is_covered_entity boolean, baa_signed_at timestamptz, created_at timestamptz,
  phone_system_type phone_system_type, call_routing call_routing, call_routing_confirmed_at timestamptz,
  carrier text, synthflow_number_e164 text, opening_hours_present boolean,
  onboarding jsonb, agent_approved_at timestamptz, went_live_at timestamptz,
  offboarding_started_at timestamptz, export_delivered_at timestamptz, destroy_after timestamptz, destroyed_at timestamptz,
  published_phone_e164 text, forwarding_test_until timestamptz, forwarding_test_observed jsonb,
  stripe_connect_account_id text, stripe_connect_connected_at timestamptz,
  meta_front_door_enabled boolean,
  booking_mode text, direct_booking_elected_at timestamptz, direct_booking_withdrawn_at timestamptz,
  timezone_confirmed_at timestamptz,
  booking_requirements jsonb, booking_requirements_confirmed_at timestamptz, booking_requirements_source text,
  billing_clinic_id uuid, stripe_connect_disconnected_at timestamptz,
  baa_version text,
  destruction_agreement_version text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.slug, c.name, c.timezone, c.specialty, c.plan,
         c.attribution_mode, c.data_classification,
         c.is_covered_entity, c.baa_signed_at, c.created_at,
         c.phone_system_type, c.call_routing, c.call_routing_confirmed_at,
         c.carrier, c.synthflow_number_e164,
         (c.opening_hours IS NOT NULL) AS opening_hours_present,
         c.onboarding, c.agent_approved_at, c.went_live_at,
         c.offboarding_started_at, c.export_delivered_at, c.destroy_after, c.destroyed_at,
         c.published_phone_e164, c.forwarding_test_until, c.forwarding_test_observed,
         c.stripe_connect_account_id, c.stripe_connect_connected_at,
         c.meta_front_door_enabled,
         c.booking_mode, c.direct_booking_elected_at, c.direct_booking_withdrawn_at,
         c.timezone_confirmed_at,
         c.booking_requirements, c.booking_requirements_confirmed_at, c.booking_requirements_source,
         c.billing_clinic_id, c.stripe_connect_disconnected_at,
         (SELECT e.document_version FROM app_agreement_in_effect(c.organization_id) e) AS baa_version,
         (SELECT e.document_version FROM app_agreement_at_end(c.id) e) AS destruction_agreement_version
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding, offboarding, booking-mode and billing-location state, the version of the agreement in effect, and the version of the agreement the service ended under (the destruction rule''s) — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The job's cadence, as the console shows it
-- -----------------------------------------------------------------------------
UPDATE scheduled_jobs
   SET cadence = 'Hourly; destroys each offboarded clinic''s patient data when the agreement its service ended under says: from day 29 under BAA 1.2.1 and earlier, and at the 04 UTC run from day 30 (export delivered) or day 90 under BAA 1.3.0 and the DPA'
 WHERE name = 'offboarding-destroy';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON FUNCTION app_destruction_rule(text) IS
  'The destruction rule a stored agreement version states: export_or_ninety for BAA 1.3.0 and DPA 1.0.0 (dpa/1.0.0), thirty_days for every other version, an unknown one and NULL. The SQL mirror of DESTRUCTION_RULES in lib/offboarding/offboarding.ts (parity test in tests/destruction-clock.test.ts).';--> statement-breakpoint
COMMENT ON FUNCTION app_agreement_at_end(uuid) IS
  'The agreement a clinic was bound to when its service ended: the newest acceptance bound to its organisation that was accepted and bound no later than offboarding_started_at, terminated since or not. No row while the clinic is not offboarding or held none then. The destruction rule is read from it.';--> statement-breakpoint
COMMENT ON FUNCTION app_destruction_due(uuid) IS
  'Whether a clinic''s data may be destroyed now, by the database''s clock: under the thirty days (BAA 1.2.1 and earlier, none, unknown) from day 29 after offboarding_started_at; under the DPA''s rule (BAA 1.3.0, DPA 1.0.0) from day 30 once export_delivered_at is set, and from day 90 regardless. The floor under app_destroy_booking_requests, app_destroy_contact_evidence and app_mark_clinic_destroyed.';--> statement-breakpoint
COMMENT ON FUNCTION app_start_offboarding(uuid, timestamptz) IS
  'Stamps clinics.offboarding_started_at at the end of the service (ended, or the call when NULL), clamped to no earlier than seven days before the call and no later than the call, both by clock_timestamp(); destroy_after thirty days later; once, so starting again moves neither. The tenant''s own clinic only. Returns the stamps, whether this call made them, and the end asked for.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_export_delivered(uuid) IS
  'Stamps clinics.export_delivered_at from clock_timestamp(), once, when the export reaches the practice (the operator''s record of the handover). The tenant''s own clinic, offboarding and not yet destroyed. The only writer of the column: app_destruction_due reads it.';--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_contact_evidence(uuid) IS
  'Deletes every suppression, consent record and contact attempt of the tenant''s own clinic, for destroyClinicData. Refuses unless the clinic passed is app.clinic_id and app_destruction_due() says it is due. Returns the three counts.';--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_booking_requests(uuid) IS
  'Deletes every booking request of the tenant''s own clinic, for destroyClinicData, before its appointments go. Refuses unless the clinic passed is app.clinic_id and app_destruction_due() says it is due, by the database''s clock, on dates only app_start_offboarding and app_mark_export_delivered write. Returns the count.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes, suppressions, consent records and contact attempts included. Returns destroyed_at.';--> statement-breakpoint
COMMENT ON COLUMN clinics.offboarding_started_at IS
  'When the clinic''s service ended: Stripe''s end of the subscription, or the moment an operator or our own setup closure ended it. Written only by app_start_offboarding(), clamped to the week before the call; a new clinic cannot carry it (clinics_insert_guard).';--> statement-breakpoint
COMMENT ON COLUMN clinics.destroy_after IS
  'Thirty days after offboarding_started_at, the thirty days every agreement counts. Under the DPA''s rule (BAA 1.3.0, DPA 1.0.0) destruction is due from it once the export is delivered, and ninety days after the start regardless; under the thirty days (BAA 1.2.1 and earlier) it is due a day before it, whatever the export. app_destruction_due() and lib/offboarding say which. Written only by app_start_offboarding(); a new clinic cannot carry it.';--> statement-breakpoint
COMMENT ON COLUMN clinics.export_delivered_at IS
  'When the offboarding export reached the practice: the operator''s record of the handover, never the moment it was produced. Written only by app_mark_export_delivered(), from the database''s clock, once; a new clinic cannot carry it.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'export_delivered_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE clinics.export_delivered_at; app_destruction_due reads it as its floor, so only app_mark_export_delivered may write it.';
  END IF;
  IF has_table_privilege('healdesk_app'::name, 'suppressions'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'consent_records'::regclass, 'DELETE')
     OR has_table_privilege('healdesk_app'::name, 'contact_attempts'::regclass, 'DELETE') THEN
    RAISE EXCEPTION 'healdesk_app can DELETE suppressions, consent records or contact attempts; only app_destroy_contact_evidence may, at destruction.';
  END IF;
  IF app_destruction_rule(NULL) <> 'thirty_days'
     OR app_destruction_rule('1.2.1') <> 'thirty_days'
     OR app_destruction_rule('1.0.0') <> 'thirty_days'
     OR app_destruction_rule('9.9.9') <> 'thirty_days'
     OR app_destruction_rule('1.3.0') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.0.0') <> 'export_or_ninety' THEN
    RAISE EXCEPTION 'app_destruction_rule does not give the thirty days to 1.2.1, 1.0.0, an unknown version and none, and the DPA''s rule to 1.3.0 and dpa/1.0.0.';
  END IF;
  IF to_regprocedure('app_start_offboarding(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'app_start_offboarding(uuid) still exists beside app_start_offboarding(uuid, timestamptz).';
  END IF;
  IF has_function_privilege('public', 'app_start_offboarding(uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('public', 'app_mark_export_delivered(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_destroy_contact_evidence(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_destruction_due(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_agreement_at_end(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_destruction_rule(text)', 'EXECUTE')
     OR has_function_privilege('public', 'app_clinics_overview()', 'EXECUTE') THEN
    RAISE EXCEPTION 'A function of this migration is executable by PUBLIC.';
  END IF;
  IF NOT EXISTS (SELECT 1
                   FROM pg_trigger t
                  WHERE NOT t.tgisinternal
                    AND t.tgenabled = 'O'
                    AND t.tgrelid = 'clinics'::regclass
                    AND t.tgname = 'clinics_insert_guard') THEN
    RAISE EXCEPTION 'clinics_insert_guard is missing or not enabled.';
  END IF;
END;
$$;
