-- =============================================================================
-- Helper functions used by the row-level security policies in 0002.
--
-- Kept in their own migration because policies reference them: functions must
-- exist first, and splitting the files makes that ordering explicit rather than
-- implicit in statement order.
-- =============================================================================

-- Current tenant, read from the transaction-local setting that withTenant()
-- establishes (src/lib/tenant.ts).
--
-- Three details matter here:
--
--   1. `true` as the second argument to current_setting() means "return NULL if
--      unset" instead of raising. An unset tenant must produce zero rows, not
--      an error — a policy that errors is a policy people work around.
--
--   2. STABLE, not VOLATILE. It lets the planner evaluate this once per query
--      as an InitPlan rather than once per row. On a large contacts table that
--      is the difference between an index scan and a sequential one.
--
--   3. It returns uuid, so a malformed setting fails loudly at cast time
--      rather than silently matching nothing.
CREATE OR REPLACE FUNCTION app_current_clinic_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.clinic_id', true), '')::uuid
$$;
--> statement-breakpoint

COMMENT ON FUNCTION app_current_clinic_id() IS
  'Tenant for the current transaction. Set by withTenant() via set_config(..., is_local => true). NULL outside a tenant transaction, which every RLS policy treats as "no rows".';
--> statement-breakpoint

-- Whether a PHI write is currently permitted for a clinic.
--
-- Encodes the rule from docs/hipaa-compliance.md: synthetic and seed data only
-- until a BAA is signed. Used by the trigger in 0004.
--
-- SECURITY DEFINER is load-bearing, and the reason is subtle. `clinics` is
-- itself under RLS, so an INVOKER-rights function would only see the clinic
-- matching the *current* tenant. A write aimed at another clinic would then
-- find no row, return false, and fail as a BAA violation — the right outcome
-- reached by the wrong mechanism, reported with a misleading error, and
-- shadowing the RLS check that should have caught it.
--
-- Running as the owner makes the gate answer the question it was asked: what is
-- THIS clinic's BAA state, regardless of who is asking. Cross-tenant writes are
-- then rejected by RLS with 42501, as they should be.
--
-- search_path is pinned because SECURITY DEFINER functions inherit the caller's
-- path otherwise, which is the classic privilege-escalation route.
CREATE OR REPLACE FUNCTION app_clinic_accepts_phi(target_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM clinics c
    WHERE c.id = target_clinic
      AND (
        c.data_classification = 'synthetic'
        OR (c.data_classification = 'production' AND c.baa_signed_at IS NOT NULL)
      )
  )
$$;
--> statement-breakpoint

-- Only the owner may execute it; it reads across tenants by design.
REVOKE ALL ON FUNCTION app_clinic_accepts_phi(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinic_accepts_phi(uuid) TO healdesk_app;
--> statement-breakpoint

COMMENT ON FUNCTION app_clinic_accepts_phi(uuid) IS
  'False when a clinic is marked production but has no signed BAA. Enforced by the trigger in 0004_baa_gate.sql.';
