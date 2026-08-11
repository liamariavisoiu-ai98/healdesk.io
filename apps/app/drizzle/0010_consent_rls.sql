-- =============================================================================
-- RLS for the consent tables.
--
-- These carry phone numbers tied to a medical clinic, which is PHI, so they get
-- the same treatment as every other tenant table: enabled AND forced, because
-- the owner otherwise bypasses its own policies.
--
-- tests/rls-drift.test.ts would fail without this — it asks the catalog which
-- tables have a clinic_id and demands each one be protected, which is exactly
-- the case this migration exists to satisfy.
-- =============================================================================

ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY consent_records_tenant_isolation ON consent_records
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE suppressions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE suppressions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY suppressions_tenant_isolation ON suppressions
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE contact_attempts ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE contact_attempts FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY contact_attempts_tenant_isolation ON contact_attempts
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

-- Consent and suppression records are evidence. The application may add to them
-- and revoke consent, but must never rewrite history:
--
--   * consent_records keeps UPDATE, because revocation sets revoked_at. DELETE
--     is withheld — a revoked consent still has to be producible.
--   * suppressions is append-only outright. There is no legitimate reason for
--     the application to un-suppress a number; re-consent is a NEW consent
--     record, not the erasure of someone having asked us to stop.
--   * contact_attempts is append-only, since it is what proves the frequency
--     caps were respected.
REVOKE DELETE ON consent_records FROM healdesk_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON suppressions FROM healdesk_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON contact_attempts FROM healdesk_app;
--> statement-breakpoint

COMMENT ON TABLE suppressions IS
  'Append-only do-not-contact list. A NULL channel means every channel. Outranks any consent record.';
