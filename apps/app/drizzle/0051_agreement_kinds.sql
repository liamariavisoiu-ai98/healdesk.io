ALTER TABLE "baa_acceptances" ADD COLUMN "agreement_kind" text GENERATED ALWAYS AS (case when document_version like 'dpa/%' then 'dpa' else 'baa' end) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "regulatory_regime" text;--> statement-breakpoint
ALTER TABLE "clinics" ADD COLUMN "agreement_kind" text;--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD CONSTRAINT "baa_acceptances_agreement_kind_check" CHECK ("baa_acceptances"."agreement_kind" in ('baa', 'dpa'));--> statement-breakpoint
ALTER TABLE "baa_acceptances" ADD CONSTRAINT "baa_acceptances_version_namespace" CHECK ("baa_acceptances"."document_version" not like '%/%' or "baa_acceptances"."document_version" like 'dpa/%');--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_regulatory_regime_check" CHECK ("clinics"."regulatory_regime" is null or "clinics"."regulatory_regime" in ('hipaa', 'hipaa-if-covered', 'non-hipaa'));--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_agreement_kind_check" CHECK ("clinics"."agreement_kind" is null or "clinics"."agreement_kind" in ('baa', 'dpa'));--> statement-breakpoint
ALTER TABLE "clinics" ADD CONSTRAINT "clinics_dpa_never_hipaa" CHECK ("clinics"."agreement_kind" is distinct from 'dpa' or "clinics"."regulatory_regime" is distinct from 'hipaa');--> statement-breakpoint

-- =============================================================================
-- Agreement kinds: the Data Protection Agreement beside the BAA (plan Part L,
-- 6 October 2026). Everything above this line was generated from schema.ts;
-- everything below is the part drizzle cannot express: the backfill, the
-- grants, two new functions, the PHI gate's new condition, the comments and
-- the audit at the end.
--
-- What this migration adds, in one paragraph. A practice HIPAA does not cover
-- (a veterinary practice, or a practice HIPAA reaches only if covered that
-- answered "No") signs the healdesk Data Protection Agreement instead of the
-- BAA, under a namespaced version ("dpa/1.0.0", packages/catalog/src/dpa.ts).
-- baa_acceptances keeps both kinds and says which a row is in a generated
-- column. clinics records the regime of its specialty and the kind of
-- agreement it is under, in two gate columns the runtime role cannot update.
-- app_agreement_kind_sufficient() says whether that agreement covers the
-- clinic's data, and the PHI gate now asks it. app_supersede_agreement() is
-- the one way a clinic's agreement is replaced: a DPA by a BAA, or a BAA by a
-- later BAA, and never a BAA by a DPA.
--
-- Safe to run: the new acceptance column is generated, every stored version
-- is un-namespaced so its CHECK holds, and the two clinic columns are
-- nullable and backfilled below from facts already stored. No clinic has
-- handled real patient data (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Backfill. clinics is ENABLEd but not FORCEd (0002), so these statements, run
-- as the owner, see every clinic. baa_acceptances is FORCEd, and with no tenant
-- set its policy (0031) lets the owner read every row.
-- -----------------------------------------------------------------------------

-- The regime of each specialty as packages/catalog/src/specialties.ts gives it
-- when this runs. 'dermatology' was folded into 'med-spa' and shares its
-- regime. Any other value stays NULL, which app_agreement_kind_sufficient()
-- reads as covered by nothing.
UPDATE clinics
   SET regulatory_regime = CASE specialty
         WHEN 'plastic-surgery' THEN 'hipaa'
         WHEN 'fertility' THEN 'hipaa'
         WHEN 'dental' THEN 'hipaa'
         WHEN 'glp1' THEN 'hipaa'
         WHEN 'med-spa' THEN 'hipaa-if-covered'
         WHEN 'dermatology' THEN 'hipaa-if-covered'
         WHEN 'hair-restoration' THEN 'hipaa-if-covered'
         WHEN 'massage-chiro' THEN 'hipaa-if-covered'
         WHEN 'veterinary' THEN 'non-hipaa'
       END
 WHERE regulatory_regime IS NULL;--> statement-breakpoint

-- The kind of the agreement in force: the newest bound acceptance of the
-- clinic's organisation that has not been terminated, the row
-- app_mark_clinic_production() copies its date from. An organisation that
-- holds none leaves the kind NULL.
UPDATE clinics c
   SET agreement_kind = (
         SELECT b.agreement_kind
           FROM baa_acceptances b
          WHERE b.organization_id = c.organization_id
            AND b.terminated_at IS NULL
          ORDER BY b.accepted_at DESC
          LIMIT 1)
 WHERE c.agreement_kind IS NULL;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The two clinic columns are gate columns. Column-level grants (0031) do not
-- reach a column added later, so healdesk_app already holds no UPDATE on
-- either; the REVOKE says so in executable form, and the audit at the foot of
-- this file fails any later migration that widens it. Provisioning writes both
-- on INSERT, which healdesk_app holds on clinics (0003), and afterwards only
-- the SECURITY DEFINER app_supersede_agreement() moves the kind.
-- clinics.is_covered_entity stays writable: a practice's notice that it is now
-- a covered entity is recorded there, and that write is what closes the gate
-- on a DPA clinic.
-- -----------------------------------------------------------------------------
REVOKE UPDATE (regulatory_regime, agreement_kind) ON clinics FROM healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Whether the agreement a clinic is under covers its data. The rule follows
-- agreementKindFor (packages/catalog/src/agreement-kind.ts):
--
--   a BAA covers a practice HIPAA can reach ('hipaa', 'hipaa-if-covered'),
--     whatever it answered: until the DPA is released a "No" signs the BAA,
--     and a BAA is a data-protection agreement on the same terms for a
--     practice that is not covered (its clause 2);
--   a DPA covers a veterinary practice ('non-hipaa'), and a 'hipaa-if-covered'
--     practice only while is_covered_entity is false;
--   nothing else covers anything: a BAA at a veterinary practice (the wrong
--     paper: its terms are written for PHI the practice does not hold), a DPA
--     once the practice is covered or not sure, any other kind or regime, and
--     NULL anywhere.
--
-- Total and never NULL. IMMUTABLE and reading no table, so the gate can ask it
-- per row. apps/app/src/lib/agreements/kind.ts is the TypeScript mirror, and
-- tests/agreement-kinds.test.ts runs every combination through both.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_agreement_kind_sufficient(regime text, kind text, covered boolean)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT (CASE
            WHEN kind = 'baa' THEN regime IN ('hipaa', 'hipaa-if-covered')
            WHEN kind = 'dpa' THEN regime = 'non-hipaa'
                                OR (regime = 'hipaa-if-covered' AND covered IS FALSE)
            ELSE false
          END) IS TRUE
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_agreement_kind_sufficient(text, text, boolean) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_agreement_kind_sufficient(text, text, boolean) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The PHI gate asks the new question (plan Part L: "a DPA clinic whose covered
-- status flips refuses PHI writes"). 0001's definition with one condition
-- added for a production clinic: where its agreement kind is recorded, that
-- agreement must cover it. A DPA practice that tells healdesk it now bills
-- insurance electronically has is_covered_entity set true, and from that
-- write the database refuses its client data until app_supersede_agreement()
-- puts it under a BAA.
--
-- An unrecorded kind keeps 0001's rule, so nothing that passed the gate before
-- this migration fails it now. After the backfill the kind is NULL only where
-- the clinic's organisation holds no agreement in force, which
-- app_mark_clinic_production() refuses to take to production; every clinic
-- provisioned from here on records it. Synthetic clinics are untouched.
-- SECURITY DEFINER and the pinned search_path are 0001's, restated because
-- CREATE OR REPLACE replaces them; the grants survive it.
-- -----------------------------------------------------------------------------
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
        )
      )
  )
$$;--> statement-breakpoint

-- The refusal names both reasons now that there are two. Otherwise 0004's
-- trigger function, with 0031's pinned search_path restated.
CREATE OR REPLACE FUNCTION app_enforce_baa_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app_clinic_accepts_phi(NEW.clinic_id) THEN
    RAISE EXCEPTION
      'Clinic % is marked production without an agreement that covers its data; refusing to write PHI to %.',
      NEW.clinic_id, TG_TABLE_NAME
      USING
        ERRCODE = 'check_violation',
        HINT = 'A production clinic needs clinics.baa_signed_at and, where clinics.agreement_kind is recorded, an agreement app_agreement_kind_sufficient() accepts for its regime and covered-entity status. A DPA practice that is now a covered entity signs the BAA, which app_supersede_agreement() puts in force. See docs/hipaa-compliance.md.';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Replacing the agreement a clinic is under (plan Part L): a DPA by a BAA,
-- when a practice that signed the DPA becomes a covered entity; or a BAA by a
-- later BAA re-acceptance, when the practice signs a newer version. Never a
-- BAA by a DPA, and never a DPA by a DPA: a newer DPA is a later decision, and
-- refusing it until then fails closed.
--
-- One agreement covers every location of an organisation, so the kind moves on
-- every clinic of it together, and the new agreement must cover each of them.
-- The agreement replaced is the organisation's newest bound one still in
-- effect; it is terminated at the end of today in UTC, the instant
-- markAgreementTerminated (lib/ops/api.ts) records for a date, because it was
-- in effect for the whole of the day it was replaced, and its six-year
-- retention floor (0025) runs from then. The new one is bound here rather than
-- through app_bind_agreement(), which binds only the first agreement an
-- organisation holds. A production clinic's baa_signed_at becomes the new
-- agreement's acceptance, the date app_mark_clinic_production() would copy.
--
-- What the signing path checks first, and this function cannot: that the new
-- agreement's template is released (the TypeScript wrapper,
-- apps/app/src/lib/agreements/kind.ts, refuses an unreleased one). It writes
-- its own security event, in the same transaction as the change, so a
-- supersede without a record cannot happen.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_supersede_agreement(target_clinic uuid, superseding uuid, actor text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  old_id uuid;
  old_kind text;
  old_version text;
  old_accepted timestamptz;
  new_org text;
  new_kind text;
  new_version text;
  new_accepted timestamptz;
  new_terminated timestamptz;
  ended timestamptz;
  uncovered text;
BEGIN
  IF actor IS NULL OR btrim(actor) = '' THEN
    RAISE EXCEPTION 'A supersede names who made it.'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT c.organization_id INTO org FROM clinics c WHERE c.id = target_clinic;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Every location of the organisation moves together.
  PERFORM 1 FROM clinics c WHERE c.organization_id = org FOR UPDATE;

  -- The policy's switch (0031), on for the reads and writes below and off
  -- again; is_local, so a refusal anywhere reverts it with the transaction.
  PERFORM set_config('app.agreement_bind', 'on', true);

  SELECT b.id, b.agreement_kind, b.document_version, b.accepted_at
    INTO old_id, old_kind, old_version, old_accepted
    FROM baa_acceptances b
   WHERE b.organization_id = org
     AND b.terminated_at IS NULL
   ORDER BY b.accepted_at DESC
   LIMIT 1
   FOR UPDATE;
  IF old_id IS NULL THEN
    RAISE EXCEPTION 'Clinic % has no agreement in effect to supersede.', target_clinic
      USING ERRCODE = 'check_violation',
            HINT = 'A first agreement is bound by provisioning (app_bind_agreement), not superseded.';
  END IF;

  SELECT b.organization_id, b.agreement_kind, b.document_version, b.accepted_at, b.terminated_at
    INTO new_org, new_kind, new_version, new_accepted, new_terminated
    FROM baa_acceptances b
   WHERE b.id = superseding
   FOR UPDATE;
  IF new_kind IS NULL THEN
    RAISE EXCEPTION 'Agreement % does not exist.', superseding
      USING ERRCODE = 'no_data_found';
  END IF;
  IF new_org IS NOT NULL OR new_terminated IS NOT NULL THEN
    RAISE EXCEPTION 'Agreement % is already bound or terminated; a supersede needs a fresh signature.', superseding
      USING ERRCODE = 'check_violation';
  END IF;
  IF new_accepted <= old_accepted THEN
    RAISE EXCEPTION 'Agreement % was signed before the agreement it would replace.', superseding
      USING ERRCODE = 'check_violation';
  END IF;
  IF new_kind <> 'baa' THEN
    RAISE EXCEPTION 'A % agreement is never replaced by a data protection agreement.', old_kind
      USING ERRCODE = 'check_violation',
            HINT = 'Only a business associate agreement supersedes: a DPA by a BAA, or a BAA by a later BAA.';
  END IF;

  SELECT string_agg(c.slug, ', ' ORDER BY c.slug) INTO uncovered
    FROM clinics c
   WHERE c.organization_id = org
     AND NOT app_agreement_kind_sufficient(c.regulatory_regime, new_kind, c.is_covered_entity);
  IF uncovered IS NOT NULL THEN
    RAISE EXCEPTION 'A % agreement would not cover %; refusing to supersede.', new_kind, uncovered
      USING ERRCODE = 'check_violation';
  END IF;

  ended := (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '23:59:59.999') AT TIME ZONE 'UTC';

  UPDATE baa_acceptances
     SET terminated_at = ended
   WHERE id = old_id
     AND terminated_at IS NULL;

  UPDATE baa_acceptances
     SET organization_id = org,
         bound_at = now()
   WHERE id = superseding
     AND organization_id IS NULL;

  PERFORM set_config('app.agreement_bind', 'off', true);

  UPDATE clinics
     SET agreement_kind = new_kind,
         baa_signed_at = CASE WHEN baa_signed_at IS NULL THEN NULL ELSE new_accepted END,
         updated_at = now()
   WHERE organization_id = org;

  INSERT INTO security_events (actor_label, event, organization_id, metadata)
  VALUES (
    actor,
    'agreement_superseded',
    org,
    jsonb_build_object(
      'clinicId', target_clinic,
      'supersededAgreementId', old_id,
      'supersededKind', old_kind,
      'supersededVersion', old_version,
      'supersedingAgreementId', superseding,
      'supersedingKind', new_kind,
      'supersedingVersion', new_version
    )
  );

  RETURN jsonb_build_object(
    'supersededAgreementId', old_id,
    'supersededKind', old_kind,
    'supersedingAgreementId', superseding,
    'supersedingKind', new_kind,
    'terminatedAt', ended
  );
END;
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION app_supersede_agreement(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_supersede_agreement(uuid, uuid, text) TO healdesk_app;--> statement-breakpoint

-- TODO(go-live, plan Part J "Go-live"): app_mark_clinic_production() and
-- goLivePreconditions() do not ask app_agreement_kind_sufficient() yet. Wiring
-- it in means restating 0040's whole function and recreating
-- app_clinics_overview() for the two new columns, which the plan does when it
-- rewrites both together (M6). Until then a DPA clinic whose covered status
-- has flipped can still be marked production, and the PHI gate above refuses
-- its data from the first write.

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON COLUMN baa_acceptances.agreement_kind IS
  'Generated from document_version: ''dpa'' for the DPA''s namespace (dpa/1.0.0), ''baa'' otherwise. No writer can set it. agreementKindOfVersion in @healdesk/catalog is its mirror.';--> statement-breakpoint
COMMENT ON CONSTRAINT baa_acceptances_version_namespace ON baa_acceptances IS
  'A namespaced version must be a DPA''s, so the generated kind never calls an unknown document a BAA.';--> statement-breakpoint
COMMENT ON COLUMN clinics.regulatory_regime IS
  'The regime of the clinic''s specialty at provisioning: hipaa, hipaa-if-covered or non-hipaa. A gate column: written on insert, never updated by healdesk_app.';--> statement-breakpoint
COMMENT ON COLUMN clinics.agreement_kind IS
  'The kind of agreement the clinic is under, baa or dpa: from the bound acceptance at provisioning, moved only by app_supersede_agreement(). A gate column. NULL only before 0051 where no agreement was bound.';--> statement-breakpoint
COMMENT ON FUNCTION app_agreement_kind_sufficient(text, text, boolean) IS
  'Whether an agreement of this kind covers a clinic of this regime and covered-entity status. A BAA covers hipaa and hipaa-if-covered; a DPA covers non-hipaa, and hipaa-if-covered only while not covered. Total; never NULL.';--> statement-breakpoint
COMMENT ON FUNCTION app_clinic_accepts_phi(uuid) IS
  'True for a synthetic clinic, or a production clinic with baa_signed_at whose recorded agreement kind (if any) app_agreement_kind_sufficient() accepts. Enforced by the trigger in 0004_baa_gate.sql.';--> statement-breakpoint
COMMENT ON FUNCTION app_supersede_agreement(uuid, uuid, text) IS
  'Replaces the agreement in force for a clinic''s organisation with a later, unbound BAA acceptance: a DPA by a BAA, or a BAA by a later BAA, never by a DPA. Terminates the old at the end of the UTC day, binds the new, moves every location''s agreement_kind and writes an agreement_superseded security event.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  unpinned text;
BEGIN
  IF has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'regulatory_regime', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'agreement_kind', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'data_classification', 'UPDATE')
     OR has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'baa_signed_at', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app can UPDATE a gate column on clinics; the agreement gate would be theatre.';
  END IF;
  IF NOT has_column_privilege('healdesk_app'::name, 'clinics'::regclass, 'is_covered_entity', 'UPDATE') THEN
    RAISE EXCEPTION 'healdesk_app cannot record a practice''s covered-entity notice on clinics.is_covered_entity.';
  END IF;
  IF (SELECT a.attgenerated FROM pg_attribute a
       WHERE a.attrelid = 'baa_acceptances'::regclass AND a.attname = 'agreement_kind') IS DISTINCT FROM 's' THEN
    RAISE EXCEPTION 'baa_acceptances.agreement_kind must be a stored generated column.';
  END IF;
  IF NOT has_function_privilege('healdesk_app'::name, 'app_supersede_agreement(uuid, uuid, text)', 'EXECUTE')
     OR NOT has_function_privilege('healdesk_app'::name, 'app_agreement_kind_sufficient(text, text, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'healdesk_app cannot execute the agreement-kind functions 0051 added.';
  END IF;

  SELECT string_agg(p.proname, ', ')
    INTO unpinned
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.prosecdef
     AND NOT EXISTS (
       SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) cfg WHERE cfg LIKE 'search_path=%'
     );
  IF unpinned IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER function(s) without a pinned search_path: %', unpinned;
  END IF;
END;
$$;
