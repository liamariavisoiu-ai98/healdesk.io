ALTER TABLE "clinics" ALTER COLUMN "retention_record_days" SET DEFAULT 90;--> statement-breakpoint

-- =============================================================================
-- Two decisions of 3 October 2026, made with BAA 1.3.0. The line above was
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
--   1. The record clock says what the agreement says: 90 days, not 730.
--   2. Go-live refuses an account whose agreement in effect has been
--      superseded (docs/counsel/agreement-changes.md §10).
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and has never been deployed,
-- so no real account is bound to any agreement.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Records are kept for the 90 days the agreement states
-- -----------------------------------------------------------------------------
-- BAA 1.2.1 and 1.3.0 both say "healdesk keeps transcripts and conversation
-- records for 90 days, which Practice may shorten in its portal". The purge
-- (lib/retention/purge.ts) deletes conversation, appointment and transaction
-- rows only at clinics.retention_record_days, which 0032 defaulted to 730 for
-- a year-over-year revenue report, a phase-two feature. A clinic left at the
-- default kept its records eight times as long as its agreement says.
--
-- A row still at 730 never chose it, so it moves to 90. A window set to
-- anything else was set on purpose and is left alone.
UPDATE clinics SET retention_record_days = 90 WHERE retention_record_days = 730;--> statement-breakpoint

COMMENT ON COLUMN clinics.retention_record_days IS
  'Days after which conversation, appointment and transaction rows are deleted. 90 by default, the period the BAA states (TRANSCRIPT_RETENTION_DAYS in @healdesk/catalog). Consent records, suppressions and contact attempts are never on this clock: they are evidence.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Go-live refuses a superseded agreement
-- -----------------------------------------------------------------------------
-- Until now nothing compared the bound agreement's version with anything.
-- Provisioning binds whichever acceptance the purchase names, and
-- app_mark_clinic_production took the newest bound, unterminated row with no
-- predicate on its version, so an account bound to 1.0.0, or to an
-- unapproved draft, could be flipped to production. 1.3.0 is the first
-- version with the Payments clause and the clause for a practice that is not
-- a covered entity; an account on anything older has neither.
--
-- "Acceptable" is the catalog's isBaaVersionAcceptable(): a registered
-- template, approved for release, no older than MIN_ACCEPTABLE_BAA_VERSION.
-- SQL cannot read the catalog, so the list below is that set written out, and
-- tests/database-audit.test.ts fails when the two disagree. An allow-list
-- rather than a comparison, so a draft, an unknown string or NULL is refused.
-- Every release that stays acceptable needs a migration redefining this one
-- function; until it lands, go-live refuses the new version, which is the
-- safe way round.
CREATE OR REPLACE FUNCTION app_baa_version_acceptable(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['1.3.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_baa_version_acceptable(text) IS
  'True for the BAA versions a clinic may go live under: registered, approved for release, and no older than MIN_ACCEPTABLE_BAA_VERSION in @healdesk/catalog. Must equal isBaaVersionAcceptable() there (parity test in tests/database-audit.test.ts).';--> statement-breakpoint

-- The one definition of "the agreement in effect": the newest bound,
-- unterminated acceptance by accepted_at, which is the rule go-live has used
-- since 0031. Go-live and the console projection both read it here, so they
-- cannot disagree about which agreement a clinic is on.
--
-- Not SECURITY DEFINER. The runtime role can already read baa_acceptances
-- under its scope policy, and both callers below are definer functions
-- themselves, so the privilege would add one more function to audit and buy
-- nothing. FORCE ROW LEVEL SECURITY applies inside it either way: in a tenant
-- session it sees only that tenant's organisation.
CREATE OR REPLACE FUNCTION app_agreement_in_effect(target_org text)
RETURNS TABLE (agreement_id uuid, document_version text, accepted_at timestamptz)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT b.id, b.document_version, b.accepted_at
    FROM baa_acceptances b
   WHERE b.organization_id = target_org
     AND b.terminated_at IS NULL
   ORDER BY b.accepted_at DESC
   LIMIT 1
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_agreement_in_effect(text) IS
  'The agreement an organisation is on: its newest bound, unterminated BAA acceptance by accepted_at, or no row. Read by app_mark_clinic_production and app_clinics_overview (0042).';--> statement-breakpoint

-- Go-live: 0040's definition with one check added after the agreement lookup,
-- which now reads app_agreement_in_effect() (the same query 0040 wrote
-- inline). Every other refusal is unchanged. A refused clinic stays
-- synthetic and its baa_signed_at stays NULL: the check raises before the
-- UPDATE runs.
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
  signed_version text;
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
                      'forwarding_configured','test_call_passed',
                      'booking_requirements_confirmed']) AS k
   WHERE coalesce(steps, '{}'::jsonb) -> k IS NULL
      OR jsonb_typeof(coalesce(steps, '{}'::jsonb) -> k) = 'null';
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Clinic % has open onboarding steps: %; refusing to mark it production.', target_clinic, missing
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT e.accepted_at, e.document_version INTO signed, signed_version
    FROM app_agreement_in_effect(org) e;

  IF signed IS NULL THEN
    RAISE EXCEPTION
      'Clinic % has no bound, in-effect business associate agreement; refusing to mark it production.',
      target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'Bind the signed agreement to this clinic''s organisation first (provisioning does this on purchase).';
  END IF;

  IF NOT app_baa_version_acceptable(signed_version) THEN
    RAISE EXCEPTION
      'Clinic % is bound to business associate agreement version %, which has been superseded; refusing to mark it production.',
      target_clinic, signed_version
      USING ERRCODE = 'check_violation',
            HINT = 'The practice accepts the current agreement first; once bound it becomes the agreement in effect and go-live can be retried.';
  END IF;

  UPDATE clinics
     SET data_classification = 'production',
         baa_signed_at = signed,
         went_live_at = now(),
         updated_at = now()
   WHERE id = target_clinic;

  RETURN signed;
END;
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_mark_clinic_production(uuid) IS
  'The only path from synthetic to production. Requires a bound, in-effect BAA of an acceptable version (app_baa_version_acceptable, 0042) for the clinic''s organisation and copies its accepted_at into baa_signed_at; the runtime role cannot UPDATE either column directly (0031).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The console projection, with the version of the agreement in effect
-- -----------------------------------------------------------------------------
-- 0041's definition plus baa_version, so the clinic card can say a clinic is
-- on a superseded agreement before anyone presses go-live. Contract metadata,
-- not patient data. A return type cannot change under CREATE OR REPLACE, so
-- drop and recreate, exactly as 0040 and 0041 did.
--
-- Every caller of listClinics() reads this outside a tenant. Inside one,
-- FORCE ROW LEVEL SECURITY on baa_acceptances hides every other
-- organisation's agreement, and baa_version reads NULL for those clinics.
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
  meta_front_door_enabled boolean,
  booking_mode text, direct_booking_elected_at timestamptz, direct_booking_withdrawn_at timestamptz,
  timezone_confirmed_at timestamptz,
  booking_requirements jsonb, booking_requirements_confirmed_at timestamptz, booking_requirements_source text,
  baa_version text
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
         c.meta_front_door_enabled,
         c.booking_mode, c.direct_booking_elected_at, c.direct_booking_withdrawn_at,
         c.timezone_confirmed_at,
         c.booking_requirements, c.booking_requirements_confirmed_at, c.booking_requirements_source,
         (SELECT e.document_version FROM app_agreement_in_effect(c.organization_id) e) AS baa_version
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding, offboarding and booking-mode state, and the version of the agreement in effect — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;
