-- =============================================================================
-- Add compliance status to the ops clinic listing.
--
-- The console needs to show, at a glance, which clinics are in a state that
-- blocks patient data: marked production with no signed BAA, or with covered-
-- entity status never determined. Both are conditions someone has to act on,
-- and both are currently invisible until a write fails.
--
-- Everything added here is clinic CONFIGURATION, not patient data: whether they
-- bill insurance electronically, whether a contract is signed, which plan they
-- are on. The projection stays free of anything patient-adjacent, and anything
-- that isn't must still go through withTenant() and be audited.
--
-- Third revision of this function. That is the cost of the SECURITY DEFINER
-- approach — every new column is a migration — and it is the right cost: the
-- alternative is a role that can read everything, where nobody ever notices
-- what it started reading.
-- =============================================================================

DROP FUNCTION IF EXISTS app_clinics_overview();
--> statement-breakpoint

CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  timezone text,
  specialty text,
  plan text,
  attribution_mode attribution_mode,
  data_classification data_classification,
  is_covered_entity boolean,
  baa_signed_at timestamptz,
  created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.slug, c.name, c.timezone, c.specialty, c.plan,
         c.attribution_mode, c.data_classification,
         c.is_covered_entity, c.baa_signed_at, c.created_at
  FROM clinics c
  ORDER BY c.created_at DESC
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration columns only — no patient data. Callers must still use withTenant() to read anything else.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;
