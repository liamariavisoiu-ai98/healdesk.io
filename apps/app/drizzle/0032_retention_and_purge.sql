ALTER TABLE "clinics" ADD COLUMN "retention_media_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "retention_record_days" integer DEFAULT 730 NOT NULL;--> statement-breakpoint

-- =============================================================================
-- Retention and purge.
--
-- Two clocks per clinic (the columns above), one job that runs them, and one
-- rule about what is NOT on a clock. See lib/retention/purge.ts.
--
-- 0031 scoped the runtime role's UPDATE on clinics to a column list, so the
-- two new columns need their own grant or the console cannot change a
-- clinic's window. tests/database-audit.test.ts fails without this.
-- =============================================================================
GRANT UPDATE (retention_media_days, retention_record_days) ON clinics TO healdesk_app;--> statement-breakpoint

COMMENT ON COLUMN clinics.retention_media_days IS
  'Days after a conversation starts before its transcript and recording references are removed. Vendor-side audio retention is a separate setting in the vendor console and must be at most this.';--> statement-breakpoint
COMMENT ON COLUMN clinics.retention_record_days IS
  'Days after which conversation, appointment and transaction rows are deleted. Consent records, suppressions and contact attempts are never on this clock: they are evidence.';--> statement-breakpoint

-- Seeded OFF, like every job (0008, 0030). Turned on from the ops console
-- once a clinic is in production and its window has been confirmed with it.
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('retention-purge', 'Nightly; removes media references and rows past each clinic''s retention window, and processed webhook payloads older than 30 days', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- =============================================================================
-- Go-live refuses while covered-entity status is undetermined.
--
-- The answer decides which privacy regime applies (HIPAA, or the FTC Health
-- Breach Notification Rule and state consumer-health-data laws), which breach
-- clock runs, and which consent standard the outbound rules apply. A clinic
-- that answered "I'm not sure" at checkout is confirmed during onboarding;
-- until the column is non-null, the only path to production says no.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_mark_clinic_production(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  covered boolean;
  signed timestamptz;
BEGIN
  SELECT c.organization_id, c.is_covered_entity INTO org, covered
    FROM clinics c WHERE c.id = target_clinic;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;

  IF covered IS NULL THEN
    RAISE EXCEPTION
      'Clinic % has not had its covered-entity status determined; refusing to mark it production.',
      target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Confirm with the clinic whether it sends any health information electronically to a payer, record the answer on clinics.is_covered_entity, then retry.';
  END IF;

  SELECT b.accepted_at INTO signed
    FROM baa_acceptances b
   WHERE b.organization_id = org
     AND b.terminated_at IS NULL
   ORDER BY b.accepted_at DESC
   LIMIT 1;

  IF signed IS NULL THEN
    RAISE EXCEPTION
      'Clinic % has no bound, in-effect business associate agreement; refusing to mark it production.',
      target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Bind the signed agreement to this clinic''s organisation first (provisioning does this on purchase).';
  END IF;

  UPDATE clinics
     SET data_classification = 'production',
         baa_signed_at = signed,
         updated_at = now()
   WHERE id = target_clinic;

  RETURN signed;
END;
$$;
