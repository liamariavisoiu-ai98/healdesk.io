-- =============================================================================
-- Letting a background job enumerate tenants, without handing it the keys.
--
-- The problem, left open deliberately in Phase 6: a scheduler has to list every
-- clinic BEFORE it has chosen one, and the runtime role cannot — with no tenant
-- set, `clinics` returns nothing. That is the isolation working.
--
-- The two obvious answers are both bad:
--
--   * Run the scheduler as the migrator. That hands a long-lived process
--     owner-level credentials to solve a read-only listing problem, and one
--     compromise then reaches every table.
--   * Loosen the clinics policy so the runtime role can read all rows without a
--     tenant. That silently widens every other query in the application too.
--
-- So instead: one SECURITY DEFINER function with a fixed, minimal projection.
-- It bypasses RLS because it runs as the owner, but it is the ENTIRE surface —
-- it returns three non-PHI columns, takes no filters that could be widened, and
-- can be found by grepping for its name. A reviewer can audit it in ten seconds,
-- which is not true of a credential.
--
-- Note what it does NOT return: no contact details, no counts, nothing patient-
-- adjacent. The scheduler gets a list of ids and must then go through
-- withTenant() like everything else to read anything real.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_clinics_overview()
RETURNS TABLE (id uuid, name text, timezone text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.name, c.timezone
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
--> statement-breakpoint

-- scheduled_jobs is platform configuration, not tenant data, so it carries no
-- RLS. The runtime role needs to read it (to decide whether to run) and update
-- it (to record the outcome), but must never create or drop jobs — the set of
-- jobs is defined by migrations, not at runtime.
REVOKE INSERT, DELETE ON scheduled_jobs FROM healdesk_app;
--> statement-breakpoint

-- Seed the jobs we know about, all switched OFF.
--
-- ON CONFLICT DO NOTHING so re-running never silently re-enables something ops
-- has deliberately turned off.
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('monthly-report', 'Monthly, on the 1st, per clinic timezone', false)
ON CONFLICT (name) DO NOTHING;
