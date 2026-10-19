-- =============================================================================
-- A re-sign is the organisation's, so it is walked while the organisation is
-- in service (wave 2, R11's check, 19 October 2026). A custom migration:
-- nothing in schema.ts changes.
--
-- Since 0098 a location can hold its organisation's DPA→BAA re-sign (it
-- recorded the answer), and the re-sign pauses every clinic of the
-- organisation. Two walks still asked about the clinic holding the row:
--
--   - app_open_agreement_resigns (0088), the hourly job's and the digest's,
--     walked only clinics not offboarding. Once the location holding the
--     row started offboarding, L22's reminders and the 7-day ops alert
--     stopped, while its siblings stayed paused with no one chasing the
--     signature.
--   - app_organisation_open_resigns (0098), the header's and the billing
--     page's, walked app_organisation_clinics, which leaves out a destroyed
--     clinic, as pausing must. Once that location was destroyed the row
--     vanished from it: a sibling's header could switch AYA back on under an
--     agreement that does not cover it, and a second re-sign could open.
--
-- Now the hourly walk takes every clinic of an organisation that still has a
-- clinic in service (not offboarding, not destroyed), whatever the state of
-- the clinic holding the row, and stops once the whole organisation is
-- leaving; the organisation's walk takes every clinic of it, a destroyed one
-- included. Pausing still goes through app_organisation_clinics, which a
-- destroyed clinic stays out of. Ids and contract metadata only, as before.
--
-- Safe to apply in place: two functions redefined with their signatures and
-- grants unchanged. apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- 0088's definition, walking by organisation.
CREATE OR REPLACE FUNCTION app_open_agreement_resigns()
RETURNS TABLE (clinic_id uuid, id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN
    SELECT cl.id
      FROM clinics cl
     WHERE EXISTS (SELECT 1
                     FROM clinics s
                    WHERE s.organization_id = cl.organization_id
                      AND s.offboarding_started_at IS NULL
                      AND s.destroyed_at IS NULL)
     ORDER BY cl.created_at
  LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT r.clinic_id, r.id
        FROM agreement_resigns r
       WHERE r.clinic_id = c.id
         AND r.status = 'open';
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint

-- 0098's definition, walking every clinic of the organisation rather than
-- app_organisation_clinics.
CREATE OR REPLACE FUNCTION app_organisation_open_resigns(target_clinic uuid)
RETURNS TABLE (
  resign_id uuid,
  clinic_id uuid,
  reason text,
  paused_at timestamptz,
  started_at timestamptz,
  from_version text,
  from_version_acceptable boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  IF app_current_clinic_id() IS DISTINCT FROM target_clinic THEN
    RAISE EXCEPTION 'app_organisation_open_resigns: clinic % is not the tenant of this transaction', target_clinic
      USING ERRCODE = '42501';
  END IF;
  FOR c IN
    SELECT o.id
      FROM clinics o
      JOIN clinics t ON t.id = target_clinic AND t.organization_id = o.organization_id
     ORDER BY (o.id = target_clinic) DESC, o.created_at, o.id
  LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT r.id, r.clinic_id, r.reason, r.paused_at, r.started_at, b.document_version,
             coalesce(app_baa_version_acceptable(b.document_version), false)
        FROM agreement_resigns r
        LEFT JOIN baa_acceptances b ON b.id = r.from_agreement_id
       WHERE r.clinic_id = c.id
         AND r.status = 'open';
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;
