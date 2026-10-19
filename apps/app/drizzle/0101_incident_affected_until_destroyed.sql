-- =============================================================================
-- Who an incident affected, recorded until the clinic is destroyed (wave 2,
-- R11's check, 19 October 2026). A custom migration: nothing in schema.ts
-- changes.
--
-- 0098 put incident_affected_contacts behind the BAA gate like every table
-- that holds PHI, and for an INSERT the gate asks app_clinic_accepts_phi(),
-- which refuses a clinic once its offboarding has started, after its
-- agreement has ended, and while a DPA practice's covered answer leaves its
-- agreement short. So the operator could take a person off an incident's
-- list in those windows but could not add one, and the L29 report's list
-- behind step-up could not exist for a breach found during offboarding.
--
-- Those windows are exactly when it is needed. The agreements' breach duties
-- outlive termination (BAA clause 17: "After termination healdesk uses and
-- discloses PHI only as this clause provides and to meet its duties under
-- this agreement and the law"), and 0096's closure waits for open incidents,
-- so a breach found during the pass-through or the destruction window is
-- reported, with the list, before the account closes. And the rows bring no patient data in: each names a
-- contact the clinic already holds (composite foreign keys to contacts and
-- incidents, 0098), which is the gate's concern.
--
-- So the table asks its own question, as record_amendments does: not
-- "does this clinic accept new PHI" but "is it destroyed". After destruction
-- there is no one left to name; 0096's closed-account trigger refuses it
-- after closure too. The message keeps "refusing to write PHI to <table>",
-- which the tests and the runbooks match.
--
-- Safe to apply in place: one function redefined. apps/app has only ever held
-- synthetic and seed data (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- 0066's definition, with incident_affected_contacts' branch added.
CREATE OR REPLACE FUNCTION app_enforce_baa_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- An amendment is Practice's direction about a record already held: its
  -- own rule, offboarding included (app_clinic_amendment_permitted).
  IF TG_TABLE_NAME = 'record_amendments' THEN
    IF NOT app_clinic_amendment_permitted(NEW.clinic_id) THEN
      RAISE EXCEPTION
        'Clinic % may not take an amendment: it is destroyed, or production without an agreement that covers its data; refusing to write PHI to %.',
        NEW.clinic_id, TG_TABLE_NAME
        USING
          ERRCODE = 'check_violation',
          HINT = 'An amendment is taken while the clinic holds the record it amends, through offboarding, and never after destruction. See docs/hipaa-compliance.md.';
    END IF;
    RETURN NEW;
  END IF;
  -- Who an incident affected names contacts already held and brings nothing
  -- new in, and the breach duties outlive the agreement (BAA clause 17): it
  -- is recorded until the clinic's data is destroyed, through offboarding,
  -- termination and a covered answer the agreement does not meet (0101).
  IF TG_TABLE_NAME = 'incident_affected_contacts' THEN
    IF EXISTS (SELECT 1 FROM clinics c WHERE c.id = NEW.clinic_id AND c.destroyed_at IS NOT NULL) THEN
      RAISE EXCEPTION
        'Clinic % is destroyed: it holds no one to name; refusing to write PHI to %.',
        NEW.clinic_id, TG_TABLE_NAME
        USING
          ERRCODE = 'check_violation',
          HINT = 'Who an incident affected is recorded while the clinic holds the contacts it names, through offboarding and after its agreement ends, and never after destruction (drizzle/0101).';
    END IF;
    RETURN NEW;
  END IF;
  IF (TG_OP = 'UPDATE' AND NOT app_clinic_phi_update_permitted(NEW.clinic_id))
     OR (TG_OP <> 'UPDATE' AND NOT app_clinic_accepts_phi(NEW.clinic_id)) THEN
    RAISE EXCEPTION
      'Clinic % is marked production without an agreement in effect that covers its data; refusing to write PHI to %.',
      NEW.clinic_id, TG_TABLE_NAME
      USING
        ERRCODE = 'check_violation',
        HINT = 'A production clinic needs clinics.baa_signed_at, an agreement in effect for its organisation (app_agreement_in_effect), and, where clinics.agreement_kind is recorded, an agreement app_agreement_kind_sufficient() accepts; and it takes no new row once its offboarding has started. A terminated agreement is in effect for nobody: its practice is offboarding, and only changes to rows already held are let through. See docs/hipaa-compliance.md.';
  END IF;
  RETURN NEW;
END;
$$;
