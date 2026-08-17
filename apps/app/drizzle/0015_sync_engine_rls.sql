-- =============================================================================
-- RLS for the sync tables.
--
-- All three carry a clinic_id, so tests/rls-drift.test.ts would fail without
-- this — it asks the catalog which tables have one and demands each be enabled
-- AND forced. That test is the reason this migration exists rather than being
-- forgotten until a sync leaked across tenants.
--
-- webhook_events deserves a note: rawPayload holds whatever the platform sent,
-- which will contain PHI. It is stored before it is understood — that is the
-- point of store-then-process — so it must be protected from the moment it
-- lands, not once we have parsed it.
-- =============================================================================

ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE sync_runs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY sync_runs_tenant_isolation ON sync_runs
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY webhook_events_tenant_isolation ON webhook_events
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

ALTER TABLE reconciliation_exceptions ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE reconciliation_exceptions FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY reconciliation_exceptions_tenant_isolation ON reconciliation_exceptions
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());
--> statement-breakpoint

-- sync_runs is a record of what happened, so the application may create and
-- finish a run but never erase one. A sync history with gaps cannot answer
-- "why is last month's number different now".
REVOKE DELETE ON sync_runs FROM healdesk_app;
--> statement-breakpoint

COMMENT ON TABLE webhook_events IS
  'Raw inbound webhooks, stored before processing. rawPayload may contain PHI and is subject to the retention sweep.';
--> statement-breakpoint

COMMENT ON TABLE reconciliation_exceptions IS
  'Money and visits the matcher could not place. Surfaced rather than excluded from totals — a report that quietly under-counts is the failure this product exists to replace.';
