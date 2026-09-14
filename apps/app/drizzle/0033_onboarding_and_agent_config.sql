CREATE TABLE "agent_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clinic_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"greeting" text NOT NULL,
	"services" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"escalation_phone" text,
	"escalation_hours" text,
	"notes" text,
	"approved_at" timestamp with time zone,
	"approved_by_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "onboarding" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "carrier" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "synthflow_number_e164" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "call_routing_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "agent_approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "went_live_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_configs" ADD CONSTRAINT "agent_configs_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_configs_clinic_idx" ON "agent_configs" USING btree ("clinic_id");--> statement-breakpoint

-- =============================================================================
-- Onboarding and the agent's words.
--
-- agent_configs carries what the agent SAYS for one clinic. Not PHI, but it is
-- spoken on recorded calls and approved by the clinic, so it is tenant-scoped
-- like everything with a clinic_id (rls-drift.test.ts demands it) and every
-- edit is audited by the code that writes it.
--
-- The new clinics columns need their own UPDATE grant (0031 scoped the
-- runtime role's UPDATE to a column list). The overview function grows the
-- columns the ops console needs to show onboarding state — configuration
-- only, still no patient data.
-- =============================================================================

ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE agent_configs FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_configs_tenant_isolation ON agent_configs
  FOR ALL
  USING (clinic_id = app_current_clinic_id())
  WITH CHECK (clinic_id = app_current_clinic_id());--> statement-breakpoint

GRANT UPDATE (onboarding, carrier, synthflow_number_e164, call_routing_confirmed_at, agent_approved_at, went_live_at)
  ON clinics TO healdesk_app;--> statement-breakpoint

DROP FUNCTION IF EXISTS app_clinics_overview();--> statement-breakpoint

CREATE FUNCTION app_clinics_overview()
RETURNS TABLE (
  id uuid,
  slug text,
  name text,
  timezone text,
  specialty text,
  plan text,
  attribution_mode attribution_mode,
  data_classification data_classification,
  is_covered_entity boolean,
  baa_signed_at timestamptz,
  created_at timestamptz,
  phone_system_type phone_system_type,
  call_routing call_routing,
  call_routing_confirmed_at timestamptz,
  carrier text,
  synthflow_number_e164 text,
  opening_hours_present boolean,
  onboarding jsonb,
  agent_approved_at timestamptz,
  went_live_at timestamptz
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
         c.onboarding, c.agent_approved_at, c.went_live_at
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration and onboarding state only — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint

REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint

-- Go-live also requires the onboarding checklist, enforced in the database so
-- no caller can route around it: every required step stamped, hours present,
-- routing confirmed, agent approved.
CREATE OR REPLACE FUNCTION app_mark_clinic_production(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  covered boolean;
  signed timestamptz;
  steps jsonb;
  missing text;
  hours_present boolean;
  routing_confirmed timestamptz;
  agent_approved timestamptz;
BEGIN
  SELECT c.organization_id, c.is_covered_entity, c.onboarding,
         (c.opening_hours IS NOT NULL), c.call_routing_confirmed_at, c.agent_approved_at
    INTO org, covered, steps, hours_present, routing_confirmed, agent_approved
    FROM clinics c WHERE c.id = target_clinic;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;

  IF covered IS NULL THEN
    RAISE EXCEPTION
      'Clinic % has not had its covered-entity status determined; refusing to mark it production.',
      target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Confirm with the clinic whether it sends any health information electronically to a payer, record the answer on clinics.is_covered_entity, then retry.';
  END IF;

  IF NOT hours_present THEN
    RAISE EXCEPTION 'Clinic % has no opening hours on file; refusing to mark it production.', target_clinic
      USING ERRCODE = 'check_violation';
  END IF;
  IF routing_confirmed IS NULL THEN
    RAISE EXCEPTION 'Clinic % has not confirmed its call routing; refusing to mark it production.', target_clinic
      USING ERRCODE = 'check_violation';
  END IF;
  IF agent_approved IS NULL THEN
    RAISE EXCEPTION 'Clinic % has not approved its agent script; refusing to mark it production.', target_clinic
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT string_agg(k, ', ' ORDER BY k) INTO missing
    FROM unnest(ARRAY['hours_confirmed','phone_type_confirmed','call_routing_chosen',
                      'covered_entity_confirmed','agent_script_approved',
                      'forwarding_configured','test_call_passed']) AS k
   WHERE coalesce(steps, '{}'::jsonb) -> k IS NULL
      OR jsonb_typeof(coalesce(steps, '{}'::jsonb) -> k) = 'null';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Clinic % has open onboarding steps: %; refusing to mark it production.', target_clinic, missing
      USING ERRCODE = 'check_violation';
  END IF;

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
         went_live_at = now(),
         updated_at = now()
   WHERE id = target_clinic;

  RETURN signed;
END;
$$;
