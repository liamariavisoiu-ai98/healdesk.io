-- =============================================================================
-- The BAA gate.
--
-- docs/hipaa-compliance.md says: "Do not let real PHI touch apps/app until
-- coverage is in place. Synthetic and seed data only."
--
-- This turns that sentence into a database constraint. A clinic starts as
-- 'synthetic'. Marking it 'production' without a signed BAA makes every write
-- to a PHI table fail — loudly, at the point of the write, naming the reason.
--
-- Why a trigger rather than a CHECK constraint: the condition lives on the
-- clinics row, not on the row being written, so it needs a lookup. And why
-- enforce it in the database at all rather than in application code: because
-- the seed script, a migration, a background job and a future service all write
-- through different paths, and only the database sees every one of them.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_enforce_baa_gate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app_clinic_accepts_phi(NEW.clinic_id) THEN
    RAISE EXCEPTION
      'Clinic % is marked production but has no signed BAA; refusing to write PHI to %.',
      NEW.clinic_id, TG_TABLE_NAME
      USING
        ERRCODE = 'check_violation',
        HINT = 'Set clinics.baa_signed_at, or keep data_classification = ''synthetic'' while testing. See docs/hipaa-compliance.md.';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app_enforce_baa_gate() IS
  'Blocks PHI writes to clinics marked production without a signed BAA.';
--> statement-breakpoint

-- Applied only to the tables that actually carry patient data.
--
-- Deliberately NOT on audit_log: if a write is refused we still want the
-- attempt recorded, and an audit row describing a blocked access contains no
-- PHI itself. Also not on ad_interactions (ad-platform data, no patient) or
-- provider_connections (clinic credentials, not patient data).
CREATE TRIGGER contacts_baa_gate
  BEFORE INSERT OR UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();
--> statement-breakpoint

CREATE TRIGGER conversations_baa_gate
  BEFORE INSERT OR UPDATE ON conversations
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();
--> statement-breakpoint

CREATE TRIGGER appointments_baa_gate
  BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();
--> statement-breakpoint

CREATE TRIGGER transactions_baa_gate
  BEFORE INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();
