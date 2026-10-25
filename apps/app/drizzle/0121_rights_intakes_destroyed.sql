-- =============================================================================
-- A clinic's patient-rights intakes go with its data (owner, 25 October 2026;
-- ops automation lane P6e). A custom migration: nothing in schema.ts changes.
--
-- 0120 kept rights_intakes for good when an account closed, beside the
-- incidents, as the record that the agreement's clocks were kept. The owner
-- decided instead that an intake is one of the clinic's patient-rights
-- records, like the deletion requests (erasure_requests, 0063), the
-- amendments Practice directed (record_amendments, 0064) and the patients'
-- requests passed to it (patient_requests, 0094), and goes with them: each
-- says that a patient of the clinic exercised a right, and when, and the
-- agreement's return-or-destroy clause reaches it. Kept for good, it was the
-- one record of the clinic's patients left behind a destruction record that
-- says none remain.
--
-- So, as the neighbours are:
--
--   * app_destroy_rights_intakes(clinic) deletes every one of the tenant's
--     intakes, open or closed, as app_destroy_erasure_requests() deletes the
--     deletion records: the runtime role has no DELETE on the table (0120),
--     and the definer refuses unless the clinic is this transaction's tenant
--     and app_destruction_due() says it is due by the rule of the agreement
--     the service ended under, on the database's clock. destroyClinicData
--     calls it beside the other patient-rights deletes. An open intake goes
--     too, as an open patient request, an erasure whose Retell step is
--     outstanding, and an amendment do: by then the clinic's patient data is
--     going under the agreement, the return bundle has been offered, and the
--     floor is the same one.
--   * app_mark_clinic_destroyed() is 0108's definition with rights_intakes
--     added, so the destruction is never recorded while an intake is left;
--     every table 0108 named is named here, so this redefinition drops none.
--   * rights_intakes_guard() refuses a new intake for a destroyed clinic, as
--     erasure_requests_guard does for a deletion record (0063): destruction
--     runs once, so an intake written after it would be kept for good. It
--     reads the clinic's row FOR SHARE, and app_mark_clinic_destroyed()
--     locks it FOR UPDATE before it checks the tables empty, so an intake
--     racing the destruction either lands before the check, which refuses,
--     or sees the stamp.
--   * rights_intakes_closed_account: a closed account takes no new or
--     changed intake (app_refuse_after_account_closure, 0096), as every
--     table destruction empties.
--
-- The clinics row is never deleted (the runtime role has no DELETE on it,
-- 0066; destruction stamps it), so the foreign key's ON DELETE CASCADE from
-- clinics never runs in this path: the intakes go only by the delete here.
--
-- Safe to apply in place: functions and one trigger; no row changes.
-- =============================================================================

CREATE OR REPLACE FUNCTION rights_intakes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  destroyed timestamptz;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- A destroyed clinic's intakes went with its data; one written after
    -- would outlive the destruction (0121, header).
    SELECT c.destroyed_at INTO destroyed FROM clinics c WHERE c.id = NEW.clinic_id FOR SHARE;
    IF destroyed IS NOT NULL THEN
      RAISE EXCEPTION 'rights_intakes: clinic % was destroyed on %; its patient-rights records went with its data', NEW.clinic_id, destroyed
        USING ERRCODE = '42501';
    END IF;
    -- The database's clock, and every intake born open.
    NEW.recorded_at := clock_timestamp();
    NEW.status := 'open';
    NEW.closed_at := NULL;
    IF NEW.received_on > (clock_timestamp() AT TIME ZONE 'UTC')::date + 1 THEN
      RAISE EXCEPTION 'rights_intakes: a request cannot be received after today';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'rights_intakes: intake % is already closed', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.request_key IS DISTINCT FROM OLD.request_key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.asked_for IS DISTINCT FROM OLD.asked_for
     OR NEW.received_on IS DISTINCT FROM OLD.received_on
     OR NEW.verified_via IS DISTINCT FROM OLD.verified_via
     OR NEW.due_on IS DISTINCT FROM OLD.due_on
     OR NEW.linked_record_id IS DISTINCT FROM OLD.linked_record_id
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'rights_intakes: only the status of an intake changes';
  END IF;
  IF NEW.status = 'open' THEN
    NEW.closed_at := NULL;
  ELSE
    NEW.closed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_destroy_rights_intakes(target_clinic uuid)
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
    RAISE EXCEPTION 'app_destroy_rights_intakes: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;
  IF NOT app_destruction_due(target_clinic) THEN
    RAISE EXCEPTION 'Clinic % is not due for destruction; refusing to delete its patient-rights intakes.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Destruction is due by the rule of the agreement the service ended under (app_destruction_due), by the database''s clock.';
  END IF;

  DELETE FROM rights_intakes ri WHERE ri.clinic_id = target_clinic;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_destroy_rights_intakes(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_destroy_rights_intakes(uuid) TO healdesk_app;--> statement-breakpoint
COMMENT ON FUNCTION app_destroy_rights_intakes(uuid) IS
  'Deletes every patient-rights intake (rights_intakes, 0120), open or closed, of the clinic passed, for destroyClinicData. Refuses unless that clinic is app.clinic_id and app_destruction_due() says it is due. Returns the count.';--> statement-breakpoint

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

  -- The clinic's row first, FOR UPDATE, so a deletion request or a
  -- patient-rights intake recorded concurrently (erasure_requests_guard and
  -- rights_intakes_guard read the row FOR SHARE) either commits before the
  -- checks below, which then see it and refuse, or waits for the stamp and
  -- is refused itself. Review of 12 October 2026.
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
     OR EXISTS (SELECT 1 FROM incident_affected_contacts ia WHERE ia.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM retell_recording_alerts rr WHERE rr.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM voice_redial_contexts vr WHERE vr.clinic_id = target_clinic)
     OR EXISTS (SELECT 1 FROM rights_intakes ri WHERE ri.clinic_id = target_clinic) THEN
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
COMMENT ON FUNCTION app_mark_clinic_destroyed(uuid) IS
  'Stamps clinics.destroyed_at from the database''s clock, once, for destroyClinicData. Locks the clinic row, then refuses unless the clinic passed is app.clinic_id, app_destruction_due() says it is due, and it holds none of the rows destroyClinicData deletes: deposits included (0065), the transcript outbox (0069), handovers (0092), the flags on conversations (0093), the patient requests passed to it (0094), the list of who an incident affected (0098), the Retell call alerts (0106), the redial records of calls that ended early (0108) and the patient-rights intakes (0121), with suppressions, consent records, contact attempts, erasure requests, record amendments, the setup screens, slot holds, providers and provider services. Returns destroyed_at.';--> statement-breakpoint

CREATE TRIGGER rights_intakes_closed_account
  BEFORE INSERT OR UPDATE ON rights_intakes
  FOR EACH ROW EXECUTE FUNCTION app_refuse_after_account_closure();--> statement-breakpoint

COMMENT ON TABLE rights_intakes IS
  'One row per patient-rights request as it reached healdesk (0120): ids, closed words and dates, no person. Deleted with the clinic''s other patient-rights records at its destruction, open or closed (app_destroy_rights_intakes, 0121); never kept past it.';
