CREATE TABLE "clinic_touches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"touched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"by_label" text NOT NULL,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_configs" ADD COLUMN "deposit_policy" jsonb;--> statement-breakpoint
ALTER TABLE "appointments" ADD COLUMN "deposit_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "published_phone_e164" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "forwarding_test_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "forwarding_test_observed" jsonb;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "stripe_connect_account_id" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "stripe_connect_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinic_touches" ADD CONSTRAINT "clinic_touches_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_touches_clinic_idx" ON "clinic_touches" USING btree ("clinic_id","touched_at");
-- Tenant isolation for the touches table: same policy form as every other
-- tenant-scoped table (0010). Forced, so the owner role is bound too.
ALTER TABLE clinic_touches ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE clinic_touches FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY clinic_touches_tenant_isolation ON clinic_touches
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint
GRANT SELECT, INSERT ON clinic_touches TO healdesk_app;--> statement-breakpoint
-- A touch is a record of a conversation that happened; it is not edited after.
REVOKE UPDATE, DELETE ON clinic_touches FROM healdesk_app;--> statement-breakpoint

-- clinics carries column-level UPDATE grants (0031): every new column that the
-- runtime writes needs its own.
GRANT UPDATE (published_phone_e164, forwarding_test_until, forwarding_test_observed,
              stripe_connect_account_id, stripe_connect_connected_at)
  ON clinics TO healdesk_app;--> statement-breakpoint

-- The overview grows the forwarding-test and Connect state (configuration; the
-- observation holds a conversation id and booleans, never a caller).
DROP FUNCTION IF EXISTS app_clinics_overview();--> statement-breakpoint
CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid, slug text, name text, timezone text, specialty text, plan text,
  attribution_mode attribution_mode, data_classification data_classification,
  is_covered_entity boolean, baa_signed_at timestamptz, created_at timestamptz,
  phone_system_type phone_system_type, call_routing call_routing, call_routing_confirmed_at timestamptz,
  carrier text, synthflow_number_e164 text, opening_hours_present boolean,
  onboarding jsonb, agent_approved_at timestamptz, went_live_at timestamptz,
  offboarding_started_at timestamptz, export_delivered_at timestamptz, destroy_after timestamptz, destroyed_at timestamptz,
  published_phone_e164 text, forwarding_test_until timestamptz, forwarding_test_observed jsonb,
  stripe_connect_account_id text, stripe_connect_connected_at timestamptz
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
         c.offboarding_started_at, c.export_delivered_at, c.destroy_after, c.destroyed_at,
         c.published_phone_e164, c.forwarding_test_until, c.forwarding_test_observed,
         c.stripe_connect_account_id, c.stripe_connect_connected_at
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint
