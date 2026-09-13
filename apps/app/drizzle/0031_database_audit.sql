-- =============================================================================
-- The September database audit, closed.
--
-- docs/state-of-play.md "Database-layer findings" listed five defects in the
-- tenant-isolation model. This migration fixes the four that are fixable and
-- records the verdict on the fifth.
--
-- ## 1. Migration 0019's backfill under FORCE RLS (verdict: no data was lost)
--
-- 0019 ran `UPDATE conversations SET recovery_reason = ... WHERE
-- is_recovered_missed_call = true` as the migrator with no tenant set. The
-- migrator is NOBYPASSRLS and conversations is FORCEd, so that statement
-- matched zero rows, and the source column was then dropped. That is a real
-- defect in the migration. It did not lose data: at the time 0019 ran no
-- clinic had ever left `synthetic` classification (provisioning pins every
-- clinic there and nothing could flip it — see §3), so every row it could
-- have touched was seed data. There is nothing to restore, and the column is
-- gone, so nothing is restored here. The rule that prevents a repeat is in
-- docs/handover.md: a migration that writes to a FORCEd table must either
-- set app.clinic_id per clinic or go through a SECURITY DEFINER function.
--
-- ## 2. The gate function had no pinned search_path, and skipped four tables
--
-- app_enforce_baa_gate() (0004) is the only SECURITY-relevant function that
-- inherited its caller's search_path. Pinned here, and asserted for every
-- SECURITY DEFINER function by tests/database-audit.test.ts. The trigger is
-- also extended to webhook_events (whose raw_payload 0014's own comment calls
-- PHI), consent_records, contact_attempts and suppressions (a phone number
-- plus a clinic is an identifier plus a health context).
--
-- ## 3. The BAA gate sat on state the gated role could write
--
-- healdesk_app held table-level UPDATE on clinics, so the application — or
-- anyone holding its connection string — could set data_classification =
-- 'production' and baa_signed_at = now() and switch the gate off for itself.
-- Now: UPDATE is column-scoped to everything EXCEPT those two, and the only
-- way to flip a clinic to production is app_mark_clinic_production(), a
-- SECURITY DEFINER function that refuses unless the clinic's organisation
-- holds a bound, in-effect agreement, and copies THAT row's accepted_at into
-- baa_signed_at rather than trusting a date the caller supplies.
--
-- ⚠️ Column-level grants do not extend to columns added later. A future
-- `ALTER TABLE clinics ADD COLUMN` must be followed by
-- `GRANT UPDATE (new_column) ON clinics TO healdesk_app`, or the application
-- gets 42501 on the first write. tests/database-audit.test.ts asserts that
-- every column but the two gate columns is updatable, so forgetting fails CI.
--
-- ## 4. baa_acceptances had no RLS, and the binding grant was a rebinding grant
--
-- 0016 granted UPDATE (organization_id, bound_at) so provisioning could attach
-- a signed agreement to the organisation it paid for. The WHERE that made it
-- bind-once lived in application code; the grant itself let any session
-- rewrite organization_id on any row, including a bound one. Now: the grant
-- is revoked and binding is app_bind_agreement(), which binds only a row
-- whose organization_id is still NULL, only to an organisation that exists
-- and holds no bound agreement yet, and returns the signed variables or NULL.
--
-- The table also gets RLS, ENABLEd and FORCEd. The policy is honest about
-- the two contexts that read it:
--
--   * service context (no tenant set): signing at checkout, provisioning,
--     the signed-copy PDF route, and the operator console — all of which run
--     on unsafeDb with no app.clinic_id, and all of which need every row.
--     The guarantees in that context come from grants (append-only, column
--     scoped) and from the two functions above, not from the policy.
--   * tenant context (app.clinic_id set): a clinic's own console session,
--     which now sees only its own organisation's agreement instead of every
--     signatory name, email and IP address in the table.
--
-- The rls-drift test's rule that every policy reads the tenant through
-- app_current_clinic_id() applies here too, which is why the service-context
-- branch is written as `app_current_clinic_id() IS NULL`.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- §2 — the gate function and its coverage
-- ---------------------------------------------------------------------------
ALTER FUNCTION app_enforce_baa_gate() SET search_path = public, pg_temp;--> statement-breakpoint

DROP TRIGGER IF EXISTS webhook_events_baa_gate ON webhook_events;--> statement-breakpoint
CREATE TRIGGER webhook_events_baa_gate
  BEFORE INSERT OR UPDATE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

DROP TRIGGER IF EXISTS consent_records_baa_gate ON consent_records;--> statement-breakpoint
CREATE TRIGGER consent_records_baa_gate
  BEFORE INSERT OR UPDATE ON consent_records
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

DROP TRIGGER IF EXISTS contact_attempts_baa_gate ON contact_attempts;--> statement-breakpoint
CREATE TRIGGER contact_attempts_baa_gate
  BEFORE INSERT OR UPDATE ON contact_attempts
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

DROP TRIGGER IF EXISTS suppressions_baa_gate ON suppressions;--> statement-breakpoint
CREATE TRIGGER suppressions_baa_gate
  BEFORE INSERT OR UPDATE ON suppressions
  FOR EACH ROW EXECUTE FUNCTION app_enforce_baa_gate();--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §3 — the gate columns leave the runtime role's reach
-- ---------------------------------------------------------------------------
REVOKE UPDATE ON clinics FROM healdesk_app;--> statement-breakpoint

DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
    INTO cols
    FROM pg_attribute a
   WHERE a.attrelid = 'clinics'::regclass
     AND a.attnum > 0
     AND NOT a.attisdropped
     AND a.attname NOT IN ('data_classification', 'baa_signed_at');
  EXECUTE format('GRANT UPDATE (%s) ON clinics TO healdesk_app', cols);
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_mark_clinic_production(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  signed timestamptz;
BEGIN
  SELECT c.organization_id INTO org FROM clinics c WHERE c.id = target_clinic;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The newest bound, in-effect agreement for this organisation. Its
  -- accepted_at is the only date baa_signed_at may ever hold: the caller
  -- does not get to supply one.
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
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_mark_clinic_production(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_mark_clinic_production(uuid) TO healdesk_app;--> statement-breakpoint

COMMENT ON FUNCTION app_mark_clinic_production(uuid) IS
  'The only path from synthetic to production. Requires a bound, in-effect BAA for the clinic''s organisation and copies its accepted_at into baa_signed_at; the runtime role cannot UPDATE either column directly (0031).';--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- §4 — baa_acceptances: bind once, through a function, behind RLS
-- ---------------------------------------------------------------------------
REVOKE UPDATE (organization_id, bound_at) ON baa_acceptances FROM healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_agreement_bind_active()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT current_setting('app.agreement_bind', true) = 'on'
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_agreement_bind_active() IS
  'True only while app_bind_agreement() has app.agreement_bind switched on around its write. Read by the baa_acceptances_scope policy.';--> statement-breakpoint

-- The organisation of the current tenant, or NULL outside a tenant. clinics is
-- ENABLEd but not FORCEd (0002), and the clinics policy lets a tenant read its
-- own row, so no SECURITY DEFINER is needed here.
CREATE OR REPLACE FUNCTION app_current_organization_id()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT c.organization_id FROM clinics c WHERE c.id = app_current_clinic_id()
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_bind_agreement(agreement uuid, target_org text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  vars jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM organization o WHERE o.id = target_org) THEN
    RAISE EXCEPTION 'Organization % does not exist; nothing to bind to.', target_org
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- Switched on for the duration of the two statements below and off again.
  -- is_local, so a failure anywhere in between reverts it with the transaction.
  PERFORM set_config('app.agreement_bind', 'on', true);

  IF EXISTS (SELECT 1 FROM baa_acceptances b WHERE b.organization_id = target_org) THEN
    PERFORM set_config('app.agreement_bind', 'off', true);
    RAISE EXCEPTION 'Organization % already holds a bound agreement.', target_org
      USING ERRCODE = 'unique_violation';
  END IF;

  UPDATE baa_acceptances
     SET organization_id = target_org,
         bound_at = now()
   WHERE id = agreement
     AND organization_id IS NULL
  RETURNING variables INTO vars;

  PERFORM set_config('app.agreement_bind', 'off', true);

  -- NULL when the row does not exist or is already bound: the caller decides
  -- what that means (provisioning refuses to create the account).
  RETURN vars;
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_bind_agreement(uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_bind_agreement(uuid, text) TO healdesk_app;--> statement-breakpoint

COMMENT ON FUNCTION app_bind_agreement(uuid, text) IS
  'Binds an UNBOUND signed agreement to an organisation that exists and holds none yet; returns the signed variables, or NULL if the row is missing or already bound. The only write path to organization_id/bound_at (0031).';--> statement-breakpoint

ALTER TABLE baa_acceptances ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE baa_acceptances FORCE ROW LEVEL SECURITY;--> statement-breakpoint

DROP POLICY IF EXISTS baa_acceptances_scope ON baa_acceptances;--> statement-breakpoint
CREATE POLICY baa_acceptances_scope ON baa_acceptances
  FOR ALL
  USING (
    app_current_clinic_id() IS NULL
    OR app_agreement_bind_active()
    OR organization_id = app_current_organization_id()
  )
  WITH CHECK (
    app_current_clinic_id() IS NULL
    OR app_agreement_bind_active()
    OR organization_id = app_current_organization_id()
  );--> statement-breakpoint

COMMENT ON POLICY baa_acceptances_scope ON baa_acceptances IS
  'Service context (no tenant) sees every row — signing, provisioning, the PDF route and the operator console all run there and are protected by grants, not by this policy. A tenant session sees only its own organisation''s agreement.';--> statement-breakpoint

-- The posture, re-asserted the way 0025 asserted it: the migration that
-- follows a widening fails here.
DO $$
DECLARE
  writable text;
BEGIN
  IF has_column_privilege('healdesk_app'::name, 'baa_acceptances'::regclass, 'organization_id', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'baa_acceptances'::regclass, 'bound_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can still UPDATE the binding columns on baa_acceptances; binding must go through app_bind_agreement().';
  END IF;

  IF has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'data_classification', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'baa_signed_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can still UPDATE the BAA gate columns on clinics; the gate would be theatre.';
  END IF;

  SELECT string_agg(p.proname, ', ')
    INTO writable
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND NOT EXISTS (
       SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%'
     );
  IF writable IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER function(s) without a pinned search_path: %', writable;
  END IF;
END;
$$;
