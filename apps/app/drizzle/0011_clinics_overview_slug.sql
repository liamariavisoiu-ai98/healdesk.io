-- =============================================================================
-- Add `slug` to the ops clinic listing.
--
-- The console needs it to link into each clinic. It cannot get it by joining
-- back to `clinics` — the function bypasses RLS, but a join alongside it does
-- not, so with no tenant set the join returns nothing and the list silently
-- comes back empty.
--
-- That failure mode is worth naming, because it is the shape of every mistake
-- around a SECURITY DEFINER function: the privileged read works, the ordinary
-- read next to it quietly does not, and the result looks like "no data" rather
-- than "no permission".
--
-- The projection stays minimal. A slug is a routing identifier, not patient
-- data, and anything beyond it must go through withTenant() and be audited.
-- =============================================================================

DROP FUNCTION IF EXISTS app_clinics_overview();
--> statement-breakpoint

CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (id uuid, slug text, name text, timezone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.slug, c.name, c.timezone
  FROM clinics c
  ORDER BY c.created_at
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app_clinics_overview() IS
  'Minimal tenant listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Returns non-PHI columns only; callers must still use withTenant() to read anything.';
--> statement-breakpoint

REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;
