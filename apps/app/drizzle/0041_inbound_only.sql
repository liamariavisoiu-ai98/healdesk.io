DROP TABLE "outbound_calls" CASCADE;--> statement-breakpoint
ALTER TABLE "consent_records" DROP CONSTRAINT "consent_records_booking_request_id_booking_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "booking_requests" DROP COLUMN "whatsapp_optin_at";--> statement-breakpoint
ALTER TABLE "booking_requests" DROP COLUMN "whatsapp_optin_quote";--> statement-breakpoint
ALTER TABLE "clinics" DROP COLUMN "outbound_callbacks_enabled";--> statement-breakpoint
ALTER TABLE "clinics" DROP COLUMN "synthflow_callback_agent_id";--> statement-breakpoint
ALTER TABLE "consent_records" DROP COLUMN "wording_version";--> statement-breakpoint
ALTER TABLE "consent_records" DROP COLUMN "booking_request_id";--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" DROP COLUMN "consent_asked_at";--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" DROP COLUMN "callback_consent";--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" DROP COLUMN "callback_consent_quote";--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" DROP COLUMN "whatsapp_asked_at";--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" DROP COLUMN "whatsapp_optin";--> statement-breakpoint
ALTER TABLE "meta_booking_drafts" DROP COLUMN "whatsapp_optin_quote";--> statement-breakpoint

-- =============================================================================
-- Inbound only (the v1 product spec, docs/v1-product-spec.md, "Scope and
-- locked decisions": no outbound on any product). Everything above this line
-- was generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- What goes, in one paragraph. 0040 added a consented call-back: a placed-call
-- ledger (outbound_calls) with a consent-match trigger, a per-clinic switch, a
-- per-clinic Synthflow callback agent, a versioned consent row tied to a
-- booking request, the two fixed consent questions on the Meta draft, and a
-- WhatsApp opt-in for one approved template outside the 24-hour window. v1
-- contacts no patient first and sends nothing after a conversation ends, so
-- every one of those is removed rather than left switched off. No migration
-- before this one is edited; 0040 stays as history.
--
-- What stays from 0040, because v1 still uses it: booking modes and the
-- direct-booking columns (see lib/booking/mode.ts for what the gate still
-- requires), the requirement set and its setup link, the calendar-write
-- columns on appointments, provider_connections.phi_basis, the desk's
-- "propose other times" decision, and timezone_confirmed_at.
--
-- Safe to drop: apps/app has only ever held synthetic and seed data (CLAUDE.md,
-- "Until BAA coverage is in place"), every call-back switch was seeded OFF,
-- and nothing outside 0040 references the dropped objects. Two functions did
-- reference dropped columns from inside their bodies, which Postgres does not
-- track as a dependency; both are redefined below in this same transaction.
-- =============================================================================

-- The consent-match trigger went with the table (CASCADE); its function did not.
DROP FUNCTION IF EXISTS app_outbound_call_requires_matching_consent();--> statement-breakpoint

-- The dialer's job row. Its pg-boss queue and cron schedule (`callback-dialer`)
-- live in the pgboss schema and are not touched here; the worker no longer
-- registers or works them.
DELETE FROM scheduled_jobs WHERE name = 'callback-dialer';--> statement-breakpoint

-- booked_via loses 'callback'. No row ever carried it: 0040's trigger froze the
-- column at insert, so a slot chosen on a call-back was recorded as 'desk'.
ALTER TABLE booking_requests DROP CONSTRAINT booking_requests_booked_via_known;--> statement-breakpoint
ALTER TABLE booking_requests
  ADD CONSTRAINT booking_requests_booked_via_known CHECK (booked_via IN ('desk', 'agent_direct'));--> statement-breakpoint

COMMENT ON COLUMN clinics.timezone_confirmed_at IS
  'Stamped by the ops op setClinicTimezone. NULL means clinics.timezone is still the provisioning default: a guess, not an answer the clinic gave.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The transition trigger, without the WhatsApp opt-in columns
-- -----------------------------------------------------------------------------
-- 0040's function, minus whatsapp_optin_at and whatsapp_optin_quote in the
-- decision-side freeze. The permitted transitions are unchanged:
--
--   requested    → accepted, rescheduling, confirmed, declined, expired
--   accepted     → rescheduling, confirmed, expired
--   rescheduling → confirmed, declined, expired
--   confirmed, declined, expired → nothing
CREATE OR REPLACE FUNCTION app_booking_request_no_rewrite()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT (
         (OLD.status = 'requested'    AND NEW.status IN ('accepted', 'rescheduling', 'confirmed', 'declined', 'expired'))
      OR (OLD.status = 'accepted'     AND NEW.status IN ('rescheduling', 'confirmed', 'expired'))
      OR (OLD.status = 'rescheduling' AND NEW.status IN ('confirmed', 'declined', 'expired'))
    ) THEN
      RAISE EXCEPTION 'booking_requests: % -> % is not a permitted transition; a decided request is already decided', OLD.status, NEW.status
        USING ERRCODE = '42501';
    END IF;
  ELSIF OLD.status IN ('confirmed', 'declined', 'expired')
        AND (NEW.decided_at IS DISTINCT FROM OLD.decided_at
             OR NEW.decided_by_label IS DISTINCT FROM OLD.decided_by_label
             OR NEW.desk_note IS DISTINCT FROM OLD.desk_note
             OR NEW.confirmed_for IS DISTINCT FROM OLD.confirmed_for
             OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id) THEN
    RAISE EXCEPTION 'booking_requests row is already decided and cannot be re-decided'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.status IN ('confirmed', 'declined', 'expired')
     AND (NEW.proposed_slots IS DISTINCT FROM OLD.proposed_slots
          OR NEW.reschedule_expires_at IS DISTINCT FROM OLD.reschedule_expires_at
          OR NEW.collected_fields IS DISTINCT FROM OLD.collected_fields
          OR NEW.last_inbound_at IS DISTINCT FROM OLD.last_inbound_at) THEN
    RAISE EXCEPTION 'booking_requests: the request is % and its slots, fields and thread state are frozen', NEW.status
      USING ERRCODE = '42501';
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.clinic_id IS DISTINCT FROM OLD.clinic_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.channel IS DISTINCT FROM OLD.channel
     OR (OLD.conversation_id IS NOT NULL
         AND NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
         AND NEW.conversation_id IS NOT NULL)
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.preferred_window IS DISTINCT FROM OLD.preferred_window
     OR NEW.alternative_windows IS DISTINCT FROM OLD.alternative_windows
     OR NEW.treatment IS DISTINCT FROM OLD.treatment
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.booked_via IS DISTINCT FROM OLD.booked_via
     OR NEW.vendor_call_id IS DISTINCT FROM OLD.vendor_call_id
  THEN
    RAISE EXCEPTION 'booking_requests: only the decision columns may change'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- The grant follows the function, as in 0040: the two dropped columns took
-- their column grants with them, and re-stating the list keeps the grant and
-- the function readable side by side.
REVOKE UPDATE ON booking_requests FROM healdesk_app;--> statement-breakpoint
GRANT UPDATE ("status", "desk_notified_at", "decided_at", "decided_by_label", "desk_note", "confirmed_for", "appointment_id",
              "conversation_id", "proposed_slots", "reschedule_expires_at", "collected_fields", "last_inbound_at")
  ON booking_requests TO healdesk_app;--> statement-breakpoint

COMMENT ON TABLE booking_requests IS
  'A booking request taken by the phone agent or the Meta front door and handed to the practice through a single-use link: confirm a slot, accept, propose other times (rescheduling) or decline. The manual booking path: the clinic runs manual booking mode, or the assistant could not book directly. Where the clinic''s booking mode lets the assistant book on a call, its booking is INSERTed already confirmed with the vendor call id. healdesk contacts no one about a request; the desk does, from its own phone. Stores SHA-256(token), never the token.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The console projection, without the two dropped clinic columns
-- -----------------------------------------------------------------------------
-- A return type cannot change under CREATE OR REPLACE, so drop and recreate,
-- exactly as 0040 did.
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
  booking_requirements jsonb, booking_requirements_confirmed_at timestamptz, booking_requirements_source text
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
         c.booking_requirements, c.booking_requirements_confirmed_at, c.booking_requirements_source
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding, offboarding and booking-mode state only — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint

-- The posture, re-asserted the way 0040 asserts it: the migration that follows
-- a widening fails here, not in production.
DO $$
BEGIN
  IF to_regclass('public.outbound_calls') IS NOT NULL THEN
    RAISE EXCEPTION 'outbound_calls still exists; v1 places no calls.';
  END IF;
  IF has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'preferred_window', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'token_hash', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'expires_at', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'booked_via', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'booking_requests'::regclass, 'vendor_call_id', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a frozen booking_requests column; the request would no longer be evidence of what the practice was told.';
  END IF;
END;
$$;
