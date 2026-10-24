-- =============================================================================
-- Let the change file's role pass the BAA gate's question (ops automation,
-- wave 2, lane G; owner approved 23 October 2026). A custom migration:
-- nothing in schema.ts changes.
--
-- healdesk_writer, the db-apply role, may INSERT and UPDATE clinic_closures,
-- clinic_providers and clinic_provider_services (owner decision D8,
-- docs/design/db-access-2026-10-22.md). It could write only the first. The
-- other two carry the BAA gate (0057), and app_enforce_baa_gate() runs with
-- the caller's rights; it asks app_clinic_accepts_phi() on an INSERT and
-- app_clinic_phi_update_permitted() on an UPDATE, which were granted to
-- healdesk_app alone, so every change file on the roster failed with
-- "permission denied for function app_clinic_phi_update_permitted".
--
-- Both functions are SECURITY DEFINER, STABLE, take one clinic id and return
-- a boolean: whether that clinic may take a new patient row, or a change to
-- one it already holds. What they read (clinics, and through
-- app_agreement_in_effect() and app_agreement_kind_sufficient() its
-- agreements) they read as their owner, so the writer gains no table right,
-- only that yes or no. The owner is still bound by baa_acceptances' FORCEd
-- row-level security, so inside a tenant session the agreement lookup sees
-- only that tenant's organisation: a row for another clinic is refused by
-- the gate's BAA message, before row-level security's own check. The gate
-- still refuses the writer exactly where it refuses the app:
-- tests/writer-baa-gate.test.ts.
--
-- PUBLIC stays revoked (0001, 0066) and the runtime role keeps its grant.
-- Conditional on the role, as the provisioning scripts create it (with
-- writer_password), not the migrations. 0114 already grants it
-- app_clinics_changed_in_transaction() unconditionally, so any database this
-- runs on has the role; the check keeps the migration safe to run anyway.
-- =============================================================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'healdesk_writer') THEN
    GRANT EXECUTE ON FUNCTION app_clinic_accepts_phi(uuid) TO healdesk_writer;
    GRANT EXECUTE ON FUNCTION app_clinic_phi_update_permitted(uuid) TO healdesk_writer;
  ELSE
    RAISE NOTICE '0116: healdesk_writer does not exist; the BAA gate grants were not made';
  END IF;
END
$$;
