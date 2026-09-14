CREATE TYPE "public"."incident_class" AS ENUM('security_incident', 'improper_use_or_disclosure', 'breach', 'service_complaint');--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"class" "incident_class" NOT NULL,
	"summary" text NOT NULL,
	"conversation_id" uuid,
	"discovered_at" timestamp with time zone NOT NULL,
	"notify_by" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone,
	"notified_how" text,
	"ftc_notify_by" timestamp with time zone,
	"opened_by" text NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_key" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"message_id" text,
	"reason" text,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "report_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"email" text NOT NULL,
	"label" text,
	"added_by" text NOT NULL,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "offboarding_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "export_delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "destroy_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "destroyed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "timezone" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_deliveries" ADD CONSTRAINT "report_deliveries_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_recipients" ADD CONSTRAINT "report_recipients_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incidents_clinic_idx" ON "incidents" USING btree ("clinic_id","discovered_at");--> statement-breakpoint
CREATE INDEX "incidents_open_idx" ON "incidents" USING btree ("notify_by") WHERE "incidents"."resolved_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "report_deliveries_once_idx" ON "report_deliveries" USING btree ("clinic_id","kind","period_key","recipient");--> statement-breakpoint
CREATE UNIQUE INDEX "report_recipients_clinic_email_idx" ON "report_recipients" USING btree ("clinic_id","email");--> statement-breakpoint

-- =============================================================================
-- Delivery, incidents, offboarding, and the scheduler's enumeration helpers.
-- =============================================================================

-- Tenant isolation for the three new clinic-scoped tables (rls-drift demands it).
ALTER TABLE report_recipients ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE report_recipients FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY report_recipients_tenant_isolation ON report_recipients
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE report_deliveries ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE report_deliveries FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY report_deliveries_tenant_isolation ON report_deliveries
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY incidents_tenant_isolation ON incidents
  FOR ALL USING (clinic_id = app_current_clinic_id()) WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
-- An incident is evidence with a legal clock on it. Resolved, never deleted.
REVOKE DELETE ON incidents FROM healdesk_app;--> statement-breakpoint

-- The runtime role's UPDATE on clinics is a column list (0031); the new columns need theirs.
GRANT UPDATE (offboarding_started_at, export_delivered_at, destroy_after, destroyed_at)
  ON clinics TO healdesk_app;--> statement-breakpoint

-- The jobs, seeded OFF like every other (0008, 0030, 0032). `heartbeat` is
-- not a job the console switches on; the worker writes its last_run_at on
-- every tick so a dead worker shows as a stale timestamp.
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('heartbeat', 'Every worker tick; last_run_at is the liveness signal', true),
  ('connection-health', 'Hourly; flags revoked connections, stale syncs and stuck webhooks, emails ops one digest', false),
  ('annual-renewal-reminder', 'Daily; emails the billing contact 30 days before an annual renewal, once per period', false),
  ('weekly-recap', 'Hourly check; sends each live clinic a 7-day recap on its own Monday morning, and a first one on day 7', false),
  ('nightly-sync', 'Daily at 02:00 UTC; enqueues a sync per active connection, staggered; reconcile on the 1st', false),
  ('offboarding-destroy', 'Daily; destroys the patient data of clinics whose destroy_after has passed and whose export was delivered', false)
ON CONFLICT (name) DO NOTHING;--> statement-breakpoint

-- Both walk the tenants one at a time. provider_connections, sync_runs and
-- webhook_events FORCE row-level security, which binds the function's owner
-- too, so a plain cross-tenant SELECT from a SECURITY DEFINER function returns
-- nothing at all. Setting the tenant GUC per clinic inside the function is the
-- same mechanism withTenant() uses; it is transaction-local and restored
-- before the function returns. The projection is still the whole surface:
-- ids, a provider name, a status and three counts — no credential, no error
-- text, nothing patient-adjacent.
CREATE OR REPLACE FUNCTION app_active_connections()
RETURNS TABLE (clinic_id uuid, connection_id uuid, provider text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT id FROM clinics ORDER BY created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT p.clinic_id, p.id, p.provider
        FROM provider_connections p
       WHERE p.status IN ('active', 'degraded')
       ORDER BY p.id;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_active_connections() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_active_connections() TO healdesk_app;--> statement-breakpoint

-- Connection health, across tenants, for the watchdog: status and the last
-- successful sync per connection, plus the two webhook counts. Same walk.
CREATE OR REPLACE FUNCTION app_connection_health()
RETURNS TABLE (clinic_id uuid, connection_id uuid, provider text, status connection_status, last_ok_sync_at timestamptz, unprocessed_webhooks bigint, invalid_signatures_24h bigint)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT id FROM clinics ORDER BY created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT p.clinic_id, p.id, p.provider, p.status,
             (SELECT max(s.started_at) FROM sync_runs s
               WHERE s.connection_id = p.id AND s.status IN ('ok', 'partial')) AS last_ok_sync_at,
             (SELECT count(*) FROM webhook_events w
               WHERE w.clinic_id = p.clinic_id AND w.processed_at IS NULL
                 AND w.received_at < now() - interval '1 hour') AS unprocessed_webhooks,
             (SELECT count(*) FROM webhook_events w
               WHERE w.clinic_id = p.clinic_id AND w.signature_valid = false
                 AND w.received_at > now() - interval '1 day') AS invalid_signatures_24h
        FROM provider_connections p
       ORDER BY p.id;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_connection_health() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_connection_health() TO healdesk_app;--> statement-breakpoint

-- Clinics whose subscription ended and whose data may be destroyed. The
-- offboarding columns are on clinics, so the overview function serves them;
-- nothing extra is needed here beyond the grant above.
COMMENT ON COLUMN clinics.destroy_after IS
  'Hard-delete of patient data is permitted from this instant, and only if export_delivered_at is set or 90 days have passed since offboarding_started_at. See lib/offboarding.';
--> statement-breakpoint

-- The overview grows the offboarding dates (configuration, not patient data).
DROP FUNCTION IF EXISTS app_clinics_overview();--> statement-breakpoint
CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid, slug text, name text, timezone text, specialty text, plan text,
  attribution_mode attribution_mode, data_classification data_classification,
  is_covered_entity boolean, baa_signed_at timestamptz, created_at timestamptz,
  phone_system_type phone_system_type, call_routing call_routing, call_routing_confirmed_at timestamptz,
  carrier text, synthflow_number_e164 text, opening_hours_present boolean,
  onboarding jsonb, agent_approved_at timestamptz, went_live_at timestamptz,
  offboarding_started_at timestamptz, export_delivered_at timestamptz, destroy_after timestamptz, destroyed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, c.slug, c.name, c.timezone, c.specialty, c.plan,
         c.attribution_mode, c.data_classification,
         c.is_covered_entity, c.baa_signed_at, c.created_at,
         c.phone_system_type, c.call_routing, c.call_routing_confirmed_at,
         c.carrier, c.synthflow_number_e164,
         (c.opening_hours IS NOT NULL) AS opening_hours_present,
         c.onboarding, c.agent_approved_at, c.went_live_at,
         c.offboarding_started_at, c.export_delivered_at, c.destroy_after, c.destroyed_at
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding and offboarding state only — no patient data.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;
