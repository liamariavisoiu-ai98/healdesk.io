ALTER TABLE "baa_acceptances" ADD COLUMN "termination_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_connections_meta_asset_live_idx" ON "provider_connections" USING btree ("provider",("metadata" ->> 'externalId')) WHERE "provider_connections"."provider" like 'meta-%' and "provider_connections"."status" <> 'revoked';--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD CONSTRAINT "baa_acceptances_termination_reason_check" CHECK ("baa_acceptances"."termination_reason" is null or ("baa_acceptances"."terminated_at" is not null and "baa_acceptances"."termination_reason" in ('practice_healdesk_breach', 'practice_subcontractor_objection', 'healdesk_practice_breach', 'change_in_law', 'services_ended')));--> statement-breakpoint

-- =============================================================================
-- Ending the agreement ends the Services (BAA 1.3.0 clause 1, clause 17 ¶3,
-- clause 20; the C19 audit's blocker 1). Everything above this line was
-- generated from schema.ts; everything below is written by hand.
--
-- The failure. markAgreementTerminated (lib/ops/api.ts) recorded
-- terminated_at and swept the calendars, and nothing else read it: the
-- database's patient-data gate asked only whether the clinic had ever been
-- taken live under an agreement (baa_signed_at, which a termination does not
-- clear), so after a termination every PHI table still took new rows, with no
-- agreement in effect to cover them.
--
-- What changes:
--
--   * baa_acceptances.termination_reason (above) records who ended the
--     agreement and why, from the closed set in @healdesk/catalog
--     (AGREEMENT_TERMINATION_REASONS), because clause 17 ¶3 refunds only two
--     of them. The runtime role may write it, column-scoped like
--     terminated_at (0025), and the transition guard makes it write-once and
--     writable only in the update that records the termination itself, so a
--     reason cannot be added to, or changed on, an ending already recorded:
--     that would turn a no-refund ending into a refunded one after the fact.
--   * app_clinic_accepts_phi() asks, for a production clinic, that its
--     organisation have an agreement in effect (app_agreement_in_effect,
--     0048), on top of 0051's conditions. A terminated agreement is in effect
--     for nobody, so every location of a practice whose only agreement was
--     terminated refuses new patient rows from that statement on. A practice
--     with another agreement still in effect (a supersede's successor) keeps
--     passing. Synthetic clinics are untouched: they hold no patient data.
--   * app_enforce_baa_gate() refuses an INSERT on that rule, and an UPDATE on
--     app_clinic_phi_update_permitted(): the same rule, or, once the clinic's
--     offboarding has started, 0051's rule without the agreement. A
--     terminated practice is always offboarding (the termination starts it),
--     and its rows must still be changed on the way out: destruction deletes
--     appointments and requests whose children point back at them ON DELETE
--     SET NULL (deposit_payments, slot_holds), which Postgres carries out as
--     an UPDATE of the child that fires this trigger, and the retention purge
--     clears and detaches rows the same way. A refused UPDATE there would
--     hold a practice's patients past the date its agreement says they go.
--     Nothing new is inserted after the end, which is what "refuse new PHI"
--     means here; DELETE never fires the gate, and the export only reads.
--   * app_organization_clinics() lists the ids of an organisation's
--     locations for the termination: which clinics to offboard and which
--     billing clinics to cancel. clinics is tenant-isolated, so a service
--     context cannot list them itself. Ids and dates only.
--
-- Two more of the release's blockers ride in this migration:
--
--   * provider_connections_meta_asset_live_idx (generated above) keeps one
--     Meta Page, Instagram account or WhatsApp number on one clinic while its
--     connection is not revoked. With two, app_meta_channel (0036, 0061)
--     routed every message to the older clinic: another practice's patients
--     in its records. apps/app has held no real patient data, so no
--     duplicate can stand in the way of the index; attachMetaChannel turns
--     the refusal into words for the person connecting.
--   * the incident-deadlines job's row, seeded on (at the foot).
--
-- SECURITY DEFINER and the pinned search_path are restated on every
-- CREATE OR REPLACE, which replaces them; the grants survive it. None of
-- these functions counts days, so none needs the UTC pin.
-- =============================================================================

GRANT UPDATE (termination_reason) ON baa_acceptances TO healdesk_app;--> statement-breakpoint

-- 0025's guard with one clause added for termination_reason. Every other
-- clause is unchanged.
CREATE OR REPLACE FUNCTION app_baa_acceptance_transition_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
     AND OLD.organization_id IS NOT NULL THEN
    RAISE EXCEPTION
      'baa_acceptance %: already bound to organization %; refusing to move it to %.',
      OLD.id, OLD.organization_id, NEW.organization_id
      USING
        ERRCODE = 'check_violation',
        HINT = 'An agreement belongs to the practice it names. Have that practice sign its own.';
  END IF;

  IF OLD.bound_at IS NOT NULL AND NEW.bound_at IS DISTINCT FROM OLD.bound_at THEN
    RAISE EXCEPTION
      'baa_acceptance %: bound_at is already recorded as %; refusing to change it.',
      OLD.id, OLD.bound_at
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.terminated_at IS NOT NULL
     AND NEW.terminated_at IS DISTINCT FROM OLD.terminated_at THEN
    RAISE EXCEPTION
      'baa_acceptance %: terminated_at is already recorded as %; refusing to change it to %.',
      OLD.id, OLD.terminated_at, NEW.terminated_at
      USING
        ERRCODE = 'check_violation',
        HINT = 'This date is the retention clock (45 CFR 164.530(j)(2)). Correcting it is a deliberate act: ALTER TABLE baa_acceptances DISABLE TRIGGER baa_acceptances_transition_guard, as the owner, with a reason.';
  END IF;

  -- Who ended it and why is recorded with the ending, once: never added to
  -- an ending already on record, never changed, never cleared.
  IF NEW.termination_reason IS DISTINCT FROM OLD.termination_reason
     AND (OLD.termination_reason IS NOT NULL OR OLD.terminated_at IS NOT NULL) THEN
    RAISE EXCEPTION
      'baa_acceptance %: the termination is already recorded; refusing to change who ended it or why.',
      OLD.id
      USING
        ERRCODE = 'check_violation',
        HINT = 'The reason decides whether clause 17 refunds the practice. Correcting it is a deliberate act, as the owner, as for terminated_at.';
  END IF;

  IF OLD.copy_sent_at IS NOT NULL
     AND NEW.copy_sent_at IS DISTINCT FROM OLD.copy_sent_at THEN
    RAISE EXCEPTION
      'baa_acceptance %: a copy was already recorded as sent at %; refusing to overwrite that.',
      OLD.id, OLD.copy_sent_at
      USING
        ERRCODE = 'check_violation',
        HINT = 'The first delivery is the fact that matters. A later, different document is a separate event and does not belong in this row.';
  END IF;

  IF OLD.copy_document_sha256 IS NOT NULL
     AND NEW.copy_document_sha256 IS DISTINCT FROM OLD.copy_document_sha256 THEN
    RAISE EXCEPTION
      'baa_acceptance %: the delivered document hash is already recorded; refusing to overwrite it.',
      OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_baa_acceptance_transition_guard() IS
  'Binding is one-way; terminated_at, copy_sent_at and copy_document_sha256 are write-once, and termination_reason is written only with terminated_at, once (0063). Enforced for every role including the owner, because these are the transitions that move a retention clock, decide a refund, or move a contract between practices.';--> statement-breakpoint
COMMENT ON COLUMN baa_acceptances.termination_reason IS
  'Who ended the agreement and why: AGREEMENT_TERMINATION_REASONS in @healdesk/catalog. Recorded with terminated_at by the console, once; clause 17 of BAA 1.3.0 refunds only practice_healdesk_breach and practice_subcontractor_objection. Null while in effect, and on endings recorded before 0063 or by app_supersede_agreement().';--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_clinic_accepts_phi(target_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM clinics c
    WHERE c.id = target_clinic
      AND (
        c.data_classification = 'synthetic'
        OR (
          c.data_classification = 'production'
          AND c.baa_signed_at IS NOT NULL
          AND (
            c.agreement_kind IS NULL
            OR app_agreement_kind_sufficient(c.regulatory_regime, c.agreement_kind, c.is_covered_entity)
          )
          AND EXISTS (SELECT 1 FROM app_agreement_in_effect(c.organization_id))
        )
      )
  )
$$;--> statement-breakpoint

-- The rule for changing a row that is already there: everything a new row
-- needs, or, once offboarding has started, everything but the agreement in
-- effect (see the header).
CREATE OR REPLACE FUNCTION app_clinic_phi_update_permitted(target_clinic uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app_clinic_accepts_phi(target_clinic)
      OR EXISTS (
           SELECT 1
             FROM clinics c
            WHERE c.id = target_clinic
              AND c.data_classification = 'production'
              AND c.baa_signed_at IS NOT NULL
              AND (
                c.agreement_kind IS NULL
                OR app_agreement_kind_sufficient(c.regulatory_regime, c.agreement_kind, c.is_covered_entity)
              )
              AND c.offboarding_started_at IS NOT NULL
         )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinic_phi_update_permitted(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinic_phi_update_permitted(uuid) TO healdesk_app;--> statement-breakpoint

-- 0051's trigger function, asking the INSERT and the UPDATE their own
-- question. The message keeps "refusing to write PHI to <table>", which the
-- tests and the runbooks match.
CREATE OR REPLACE FUNCTION app_enforce_baa_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF (TG_OP = 'UPDATE' AND NOT app_clinic_phi_update_permitted(NEW.clinic_id))
     OR (TG_OP <> 'UPDATE' AND NOT app_clinic_accepts_phi(NEW.clinic_id)) THEN
    RAISE EXCEPTION
      'Clinic % is marked production without an agreement in effect that covers its data; refusing to write PHI to %.',
      NEW.clinic_id, TG_TABLE_NAME
      USING
        ERRCODE = 'check_violation',
        HINT = 'A production clinic needs clinics.baa_signed_at, an agreement in effect for its organisation (app_agreement_in_effect), and, where clinics.agreement_kind is recorded, an agreement app_agreement_kind_sufficient() accepts. A terminated agreement is in effect for nobody: its practice is offboarding, and only changes to rows already held are let through. See docs/hipaa-compliance.md.';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- The locations of one organisation, for the termination's offboarding and
-- cancellation (lib/agreements/termination.ts). Read across tenants by
-- design, as app_clinics_overview() is: ids, the billing clinic and the
-- offboarding dates, no patient data.
CREATE OR REPLACE FUNCTION app_organization_clinics(target_org text)
RETURNS TABLE (
  clinic_id uuid,
  billing_clinic_id uuid,
  data_classification data_classification,
  offboarding_started_at timestamptz,
  destroyed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.id, coalesce(c.billing_clinic_id, c.id), c.data_classification,
         c.offboarding_started_at, c.destroyed_at
    FROM clinics c
   WHERE c.organization_id = target_org
   ORDER BY c.created_at, c.id
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_organization_clinics(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_organization_clinics(text) TO healdesk_app;--> statement-breakpoint

COMMENT ON FUNCTION app_clinic_accepts_phi(uuid) IS
  'May a new patient row be written for this clinic: a synthetic clinic, or a production clinic with baa_signed_at, an agreement in effect for its organisation (app_agreement_in_effect) and, where its kind is recorded, one app_agreement_kind_sufficient() accepts. Enforced on INSERT by the trigger app_enforce_baa_gate (0004, 0063).';--> statement-breakpoint
COMMENT ON FUNCTION app_clinic_phi_update_permitted(uuid) IS
  'May a patient row already held be changed: app_clinic_accepts_phi(), or, once the clinic is offboarding, the same rule without the agreement in effect, so destruction''s cascades and the purge still run after a termination. Enforced on UPDATE by app_enforce_baa_gate (0063).';--> statement-breakpoint
COMMENT ON FUNCTION app_organization_clinics(text) IS
  'The locations of one organisation, with their billing clinic and offboarding dates: what a recorded termination offboards and cancels (0063). Ids and dates only.';
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- A missed incident notice target raises an alert (BAA 1.3.0 release gate 5)
-- -----------------------------------------------------------------------------
-- overdueIncidents (lib/incidents/incidents.ts) had no caller, so an incident
-- past healdesk's internal 24-hour notice target sat in the console
-- unremarked. The agreements promise 60 calendar days (the owner, 12 October
-- 2026); the target is ours, and stricter. The hourly incident-deadlines job
-- raises one ops alert, ever, per such incident, with ids only. Seeded ON,
-- unlike every other job: it only alerts, it sends nothing to a clinic, and a
-- target nobody is told about is the failure it exists to prevent.
INSERT INTO scheduled_jobs (name, cadence, enabled) VALUES
  ('incident-deadlines', 'Hourly; raises one ops alert, ever, for each open incident past the internal 24-hour notice target with no notice recorded', true)
ON CONFLICT (name) DO NOTHING;
