-- =============================================================================
-- Row-level security.
--
-- The second of two locks. The application already filters by clinic_id; this
-- makes the database refuse to hand over another clinic's rows even if that
-- filter is forgotten. For patient data, one lock is not enough — a missed
-- WHERE in a hotfix is a reportable breach.
--
-- Two things that make RLS silently useless, both handled here:
--
--   ENABLE alone is not sufficient. A table's OWNER bypasses its own policies.
--   Migrations run as healdesk_migrator, which owns these tables, so every
--   table also gets FORCE ROW LEVEL SECURITY.
--
--   The policy predicate is written as a bare function call to a STABLE
--   function, which the planner hoists to an InitPlan — evaluated once per
--   query, not once per row.
--
-- USING governs what a query can SEE. WITH CHECK governs what it can WRITE.
-- Both are needed: without WITH CHECK, a tenant could INSERT rows belonging to
-- another clinic even though it could never read them back.
-- =============================================================================

-- clinics itself: within a tenant session you see exactly one row, your own.
--
-- ENABLED but deliberately NOT FORCED, unlike every table below. FORCE applies
-- policies to the table's owner too, and the owner is the only role that can
-- provision a clinic in the first place — a FORCEd policy of
-- `id = app_current_clinic_id()` makes clinic creation impossible, because the
-- tenant cannot be set to a row that does not exist yet.
--
-- So provisioning (the purchase flow, the admin console) runs as the migrator
-- role, which bypasses this policy; request handling runs as healdesk_app,
-- which does not. The exposure is bounded: `clinics` holds configuration, not
-- PHI. Every table that does hold PHI is FORCEd below.
--
-- Note this table has an `id`, not a `clinic_id`, so tests/rls-drift.test.ts
-- correctly does not demand FORCE here.
ALTER TABLE clinics ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinics_tenant_isolation ON clinics
  FOR ALL
  USING (id = app_current_clinic_id())
  WITH CHECK (id = app_current_clinic_id());
--> statement-breakpoint

-- Everything below is FORCEd, so provisioning must work *within* a tenant.
-- The sequence is:
--
--   1. insert the clinic          (as migrator; clinics is not FORCEd)
--   2. set_config('app.clinic_id', <new id>, true)
--   3. insert the first membership, connections, etc.
--
-- Step 2 is what makes step 3 legal, and it means even provisioning code is
-- writing inside a declared tenant rather than around the policy.
ALTER TABLE clinic_memberships ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_memberships FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_memberships_tenant_isolation ON clinic_memberships
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE provider_connections ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE provider_connections FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY provider_connections_tenant_isolation ON provider_connections
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE ad_interactions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE ad_interactions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY ad_interactions_tenant_isolation ON ad_interactions
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY contacts_tenant_isolation ON contacts
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY conversations_tenant_isolation ON conversations
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY appointments_tenant_isolation ON appointments
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY transactions_tenant_isolation ON transactions
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

-- audit_log is append-only for the runtime role (see 0003), so it needs SELECT
-- and INSERT policies but never UPDATE or DELETE.
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY audit_log_tenant_read ON audit_log
  FOR SELECT
  USING (clinic_id = app_current_clinic_id());
--> statement-breakpoint
CREATE POLICY audit_log_tenant_append ON audit_log
  FOR INSERT
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

COMMENT ON POLICY clinics_tenant_isolation ON clinics IS
  'Tenant isolation. Every table with a clinic_id must have an equivalent policy, both ENABLEd and FORCEd — asserted by tests/rls-drift.test.ts, which fails the day someone adds a table and forgets.';
