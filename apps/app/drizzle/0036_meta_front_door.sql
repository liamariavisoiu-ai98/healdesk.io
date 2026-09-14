ALTER TABLE "clinics" ADD COLUMN "meta_front_door_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
GRANT UPDATE (meta_front_door_enabled) ON clinics TO healdesk_app;--> statement-breakpoint

-- Which clinic owns a Meta page, Instagram account or WhatsApp number. The
-- webhook arrives with the platform's id and no tenant, so this walks the
-- tenants (provider_connections FORCEs RLS; see 0034 for the pattern) and
-- returns ids only. The access token stays sealed in the row and is opened,
-- audited, inside the tenant transaction that sends the reply.
CREATE OR REPLACE FUNCTION app_meta_channel(external_id text)
RETURNS TABLE (clinic_id uuid, connection_id uuid, provider text, enabled boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  previous text := current_setting('app.clinic_id', true);
  c record;
BEGIN
  FOR c IN SELECT id, meta_front_door_enabled FROM clinics ORDER BY created_at LOOP
    PERFORM set_config('app.clinic_id', c.id::text, true);
    RETURN QUERY
      SELECT p.clinic_id, p.id, p.provider, c.meta_front_door_enabled
        FROM provider_connections p
       WHERE p.provider LIKE 'meta-%'
         AND p.status IN ('active', 'pending')
         AND p.metadata ->> 'externalId' = external_id
       ORDER BY p.id;
  END LOOP;
  PERFORM set_config('app.clinic_id', coalesce(previous, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_meta_channel(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_meta_channel(text) TO healdesk_app;--> statement-breakpoint

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
  stripe_connect_account_id text, stripe_connect_connected_at timestamptz,
  meta_front_door_enabled boolean
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
         c.stripe_connect_account_id, c.stripe_connect_connected_at,
         c.meta_front_door_enabled
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint
