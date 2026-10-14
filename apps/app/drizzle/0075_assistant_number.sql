ALTER TABLE "clinics" RENAME COLUMN "synthflow_number_e164" TO "assistant_number_e164";--> statement-breakpoint

-- =============================================================================
-- The assistant's number, by what it is (14 October 2026). The statement above
-- was generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- clinics.synthflow_number_e164 held the number a clinic forwards its calls
-- to. Synthflow was replaced by Retell on 5 October 2026 and its webhook was
-- removed on 14 October; the number is the assistant's whatever the vendor, so
-- the column is named for that.
--
-- A rename keeps the column's grants (0033's UPDATE to healdesk_app), but
-- app_clinics_overview() is LANGUAGE sql with its body stored as text, so its
-- body still names the old column, and the column is one of its OUT columns.
-- A return type cannot change under CREATE OR REPLACE, so drop and recreate,
-- with the same comment, REVOKE and GRANT as 0058, which this copies with the
-- one column renamed.
--
-- Safe to apply in place: one rename and one function. apps/app has only ever
-- held synthetic and seed data (CLAUDE.md).
-- =============================================================================

DROP FUNCTION IF EXISTS app_clinics_overview();--> statement-breakpoint
CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid, slug text, name text, timezone text, specialty text, plan text,
  attribution_mode attribution_mode, data_classification data_classification,
  is_covered_entity boolean, baa_signed_at timestamptz, created_at timestamptz,
  phone_system_type phone_system_type, call_routing call_routing, call_routing_confirmed_at timestamptz,
  carrier text, assistant_number_e164 text, opening_hours_present boolean,
  onboarding jsonb, agent_approved_at timestamptz, went_live_at timestamptz,
  offboarding_started_at timestamptz, export_delivered_at timestamptz, destroy_after timestamptz, destroyed_at timestamptz,
  published_phone_e164 text, forwarding_test_until timestamptz, forwarding_test_observed jsonb,
  stripe_connect_account_id text, stripe_connect_connected_at timestamptz,
  meta_front_door_enabled boolean,
  booking_mode text, direct_booking_elected_at timestamptz, direct_booking_withdrawn_at timestamptz,
  timezone_confirmed_at timestamptz,
  booking_requirements jsonb, booking_requirements_confirmed_at timestamptz, booking_requirements_source text,
  billing_clinic_id uuid, stripe_connect_disconnected_at timestamptz,
  baa_version text,
  destruction_agreement_version text
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
         c.carrier, c.assistant_number_e164,
         (c.opening_hours IS NOT NULL) AS opening_hours_present,
         c.onboarding, c.agent_approved_at, c.went_live_at,
         c.offboarding_started_at, c.export_delivered_at, c.destroy_after, c.destroyed_at,
         c.published_phone_e164, c.forwarding_test_until, c.forwarding_test_observed,
         c.stripe_connect_account_id, c.stripe_connect_connected_at,
         c.meta_front_door_enabled,
         c.booking_mode, c.direct_booking_elected_at, c.direct_booking_withdrawn_at,
         c.timezone_confirmed_at,
         c.booking_requirements, c.booking_requirements_confirmed_at, c.booking_requirements_source,
         c.billing_clinic_id, c.stripe_connect_disconnected_at,
         (SELECT e.document_version FROM app_agreement_in_effect(c.organization_id) e) AS baa_version,
         (SELECT e.document_version FROM app_agreement_at_end(c.id) e) AS destruction_agreement_version
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding, offboarding, booking-mode and billing-location state, the version of the agreement in effect, and the version of the agreement the service ended under (the destruction rule''s) — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: the rename kept the grant, and the function is the
-- runtime role's alone.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'assistant_number_e164', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app lost UPDATE on clinics.assistant_number_e164 in the rename; the ops console''s phone settings write it.';
  END IF;
  IF has_function_privilege('public', 'app_clinics_overview()', 'EXECUTE')
     OR NOT has_function_privilege('healdesk_app', 'app_clinics_overview()', 'EXECUTE') THEN
    RAISE EXCEPTION 'app_clinics_overview() must be executable by healdesk_app and not by PUBLIC.';
  END IF;
END;
$$;
