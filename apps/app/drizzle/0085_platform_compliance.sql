CREATE TABLE "platform_compliance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"action" text NOT NULL,
	"document_ref" text NOT NULL,
	"effective_on" date NOT NULL,
	"expires_on" date,
	"actor_label" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "platform_compliance_subject_check" CHECK ("platform_compliance"."subject" in ('anthropic', 'database_host', 'aws', 'retell', 'launch_promises', 'runtime_web', 'runtime_meta', 'runtime_voice', 'voice_pass_through')),
	CONSTRAINT "platform_compliance_action_check" CHECK ("platform_compliance"."action" in ('attested', 'withdrawn')),
	CONSTRAINT "platform_compliance_document_ref_check" CHECK (char_length("platform_compliance"."document_ref") between 1 and 300 and "platform_compliance"."document_ref" !~ '[[:cntrl:]]'),
	CONSTRAINT "platform_compliance_expires_check" CHECK ("platform_compliance"."expires_on" is null or ("platform_compliance"."action" = 'attested' and "platform_compliance"."expires_on" >= "platform_compliance"."effective_on")),
	CONSTRAINT "platform_compliance_actor_check" CHECK (char_length("platform_compliance"."actor_label") between 1 and 200)
);
--> statement-breakpoint
CREATE INDEX "platform_compliance_subject_idx" ON "platform_compliance" USING btree ("subject","recorded_at");
-- =============================================================================
-- Automatic go-live (WP2, 19 October 2026; plan Part G "Automatic go-live",
-- Part J "Go-live", Part K, the Gates table). The two statements above were
-- generated from schema.ts; everything below is the part drizzle cannot
-- express.
--
-- What this migration does, in one paragraph. A clinic goes from synthetic to
-- production with no operator step: when its practice questions pass, or any
-- other input of a channel arrives (lib/channels/events.ts), and every
-- precondition below holds, app_mark_clinic_production() flips it, and the
-- channel goes live in the same transaction. The function and
-- goLivePreconditions (lib/onboarding/go-live.ts) are rewritten together:
-- the voice-era operator stamps (opening hours, call routing confirmed, the
-- agent approved by hand, the eight onboarding steps) are gone, and go-live
-- asks instead
--
--   * that the clinic has not left and is not a demo clinic;
--   * that its covered status is determined, where its regime asks it;
--   * that its agreement in effect is acceptable for its kind, DPA-aware
--     (app_agreement_version_acceptable: a BAA through
--     app_baa_version_acceptable, which each release keeps current, a DPA
--     through app_dpa_version_released), is the kind the clinic records, and
--     covers the practice (app_agreement_kind_sufficient, 0051);
--   * that the platform is attested (platform_compliance, below): the model
--     provider, the database host and AWS, and the owner's launch promises;
--   * and Gate B for at least one channel: its runtime (ours and the
--     clinic's step), its practice questions passed (app_channel_audit_ok,
--     the SQL of lib/channels/audit-seam.ts and practiceQuestionsGate),
--     setup as its skip lines promise, and its own attestations (Retell,
--     phone's runtime and pass-through test; website chat's and the Meta
--     channel's runtimes).
--
-- A channel's `live` (app_channel_live_ok, 0079) now also asks the practice
-- questions' gate and the channel's attestations, so a channel bought after
-- go-live meets Gate B too; it never takes a live channel offline, because a
-- live channel is never asked again (0079's app_channel_mark_live sets
-- live_at once).
--
-- The purge needs nothing here: it already follows the agreement in effect
-- (lib/scheduler/retention-purge.ts, purgeIsPromised), and every version
-- go-live accepts states it, so a production clinic is purged nightly.
--
-- ## platform_compliance and row-level security
--
-- RLS in this database is tenant isolation keyed on clinic_id
-- (tests/rls-drift.test.ts asks it of every table that has one). This table
-- has no clinic_id because it is not any tenant's: one row per attestation or
-- withdrawal about the platform, read by every clinic's go-live alike. A
-- tenant policy would isolate nothing, and a policy that let every tenant
-- read every row would be RLS in name only, so it has none, as ops_alerts,
-- email_daily_quota and scheduled_jobs have none (0046, 0007). What protects
-- it instead:
--
--   * the grant: the runtime role SELECTs and INSERTs and nothing else, so an
--     attestation, once recorded, is never rewritten or erased; a withdrawal
--     is a row of its own;
--   * a trigger refusing an INSERT made inside a tenant transaction. Every
--     path that answers a patient runs inside one (lib/tenant.ts); the ops
--     envelope, the one writer, runs outside, after apps/web has checked the
--     operator's session and a fresh authenticator code;
--   * the CHECKs: a closed list of subjects, a short reference to a document
--     rather than its text, an expiry only on an attestation.
--
-- No patient data, so no BAA gate, and no clinic_id, so it is in neither
-- destruction's lists nor the purge: offboarding a clinic leaves the
-- platform's record of its vendors alone, as it leaves ops_alerts.
--
-- Safe to apply in place: one new table and its trigger, functions replaced
-- and added, the overview recreated with two more columns. apps/app has only
-- ever held synthetic and seed data (CLAUDE.md), and no clinic is production
-- on the host: a synthetic clinic that was ready under the voice-era
-- checklist now waits for the attestations below.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- platform_compliance: grants, and no write from inside a tenant
-- -----------------------------------------------------------------------------
-- 0003's default privileges have given healdesk_app all four verbs on the new
-- table, so the REVOKE is required, and the GRANT restates the intended set.
REVOKE ALL ON platform_compliance FROM healdesk_app;--> statement-breakpoint
GRANT SELECT, INSERT ON platform_compliance TO healdesk_app;--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_platform_compliance_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_current_clinic_id() IS NOT NULL THEN
    RAISE EXCEPTION 'platform_compliance is written from the ops envelope, outside any tenant'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER platform_compliance_insert_guard
  BEFORE INSERT ON platform_compliance
  FOR EACH ROW EXECUTE FUNCTION app_platform_compliance_insert_guard();--> statement-breakpoint
REVOKE ALL ON FUNCTION app_platform_compliance_insert_guard() FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The agreement's version, by its kind
-- -----------------------------------------------------------------------------
-- The released DPA versions: agreementTemplateReleased()'s DPA half in
-- @healdesk/catalog (getDpaTemplate(version).approvedByCounsel), written out
-- as app_baa_version_acceptable writes out the BAA's floor. None today: the
-- DPA is drafted and the owner releases it at launch (packages/catalog/src/
-- dpa.ts). Its release needs a migration adding its version here, in the
-- commit that flips approvedByCounsel; until it lands go-live refuses a DPA
-- clinic, the safe way round, and tests/go-live.test.ts fails on the
-- disagreement.
CREATE OR REPLACE FUNCTION app_dpa_version_released(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY[]::text[]), false)
$$;--> statement-breakpoint

-- Whether a clinic may go live under this version, by the agreement's kind
-- (the namespace rule of baa_acceptances.agreement_kind, 0051): a DPA's
-- release, or a BAA's current floor, read from app_baa_version_acceptable so
-- that each BAA release, which redefines that one function, keeps go-live
-- current without touching this one.
CREATE OR REPLACE FUNCTION app_agreement_version_acceptable(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN version IS NULL THEN false
           WHEN version LIKE 'dpa/%' THEN app_dpa_version_released(version)
           ELSE app_baa_version_acceptable(version)
         END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_dpa_version_released(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_agreement_version_acceptable(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_dpa_version_released(text) TO healdesk_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_agreement_version_acceptable(text) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The platform's attestations
-- -----------------------------------------------------------------------------
-- What each channel needs attested: CLINIC_WIDE_SUBJECTS for a NULL channel,
-- CHANNEL_SUBJECTS for one (lib/compliance/subjects.ts). An unknown channel
-- needs a subject no row can attest, so it fails closed.
CREATE OR REPLACE FUNCTION app_platform_subjects_for(p_channel text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN p_channel IS NULL THEN ARRAY['anthropic', 'database_host', 'aws', 'launch_promises']
           WHEN p_channel = 'web' THEN ARRAY['runtime_web']
           WHEN p_channel = 'meta' THEN ARRAY['runtime_meta']
           WHEN p_channel = 'voice' THEN ARRAY['retell', 'runtime_voice', 'voice_pass_through']
           ELSE ARRAY['unknown_channel']
         END
$$;--> statement-breakpoint

-- A subject counts while its latest row attests it and has not lapsed. The
-- day is UTC's, whatever the session's time zone (expires_on is a UTC date).
CREATE OR REPLACE FUNCTION app_platform_attested(p_subject text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce((
           SELECT p.action = 'attested'
                  AND (p.expires_on IS NULL OR p.expires_on >= (now() AT TIME ZONE 'UTC')::date)
             FROM platform_compliance p
            WHERE p.subject = p_subject
            ORDER BY p.recorded_at DESC, p.id DESC
            LIMIT 1), false)
$$;--> statement-breakpoint

-- The subjects a channel (or, for NULL, every channel) still waits on.
CREATE OR REPLACE FUNCTION app_platform_missing(p_channel text)
RETURNS text[]
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(s ORDER BY o), ARRAY[]::text[])
    FROM unnest(app_platform_subjects_for(p_channel)) WITH ORDINALITY AS u(s, o)
   WHERE NOT app_platform_attested(s)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_platform_subjects_for(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_platform_attested(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_platform_missing(text) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_platform_subjects_for(text) TO healdesk_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_platform_attested(text) TO healdesk_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_platform_missing(text) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- A channel's audit, as `live` reads it
-- -----------------------------------------------------------------------------
-- practiceQuestionsGate (lib/engine/practice/store.ts) in SQL: a channel
-- already live is never held back; one that is not needs no run queued or
-- running, and the latest run whose outcome stands passed, with the
-- channel's own result passed or an operator's override.
CREATE OR REPLACE FUNCTION app_practice_gate_open(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN EXISTS (SELECT 1 FROM clinic_channels cc
                         WHERE cc.clinic_id = p_clinic AND cc.channel = p_channel AND cc.live_at IS NOT NULL)
             THEN true
           WHEN EXISTS (SELECT 1 FROM practice_question_runs r
                         WHERE r.clinic_id = p_clinic AND r.status IN ('queued', 'running'))
             THEN false
           ELSE coalesce((
             SELECT r.status = 'passed'
                    AND (r.override_label IS NOT NULL
                         OR EXISTS (SELECT 1 FROM practice_question_results x
                                     WHERE x.run_id = r.id AND x.clinic_id = p_clinic
                                       AND x.channel = p_channel AND x.status = 'passed'))
               FROM practice_question_runs r
              WHERE r.clinic_id = p_clinic
                AND r.status IN ('passed', 'failed', 'in_review', 'error')
                AND r.finished_at IS NOT NULL
              ORDER BY r.finished_at DESC
              LIMIT 1), false)
         END
$$;--> statement-breakpoint

-- channelsWithAuditPassed (lib/channels/audit-seam.ts) in SQL: an operator's
-- attestation counts for good; the practice questions' record counts only
-- while their gate holds open for the channel.
CREATE OR REPLACE FUNCTION app_channel_audit_ok(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM channel_events e
                  WHERE e.clinic_id = p_clinic AND e.channel = p_channel AND e.kind = 'audit_passed'
                    AND (e.detail ->> 'via') IS DISTINCT FROM 'practice_questions')
      OR (EXISTS (SELECT 1 FROM channel_events e
                   WHERE e.clinic_id = p_clinic AND e.channel = p_channel AND e.kind = 'audit_passed'
                     AND e.detail ->> 'via' = 'practice_questions')
          AND app_practice_gate_open(p_clinic, p_channel))
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Gate B, and `live`
-- -----------------------------------------------------------------------------
-- Everything 0079's app_channel_live_ok asked, but the clinic being in
-- production: ready on our side, the clinic's own step evidenced, and setup
-- done as its skip lines promise. The body is 0079's, one line removed.
CREATE OR REPLACE FUNCTION app_channel_inputs_ok(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT app_channel_ours_ok(p_clinic, p_channel)
     AND EXISTS (
       SELECT 1
         FROM clinics k
         LEFT JOIN clinic_settings s ON s.clinic_id = k.id
         LEFT JOIN agent_configs a ON a.clinic_id = k.id
        WHERE k.id = p_clinic
          AND CASE p_channel
                WHEN 'voice' THEN coalesce((k.forwarding_test_observed ->> 'callerIdPreserved')::boolean, false)
                WHEN 'web' THEN EXISTS (SELECT 1 FROM channel_events e
                                         WHERE e.clinic_id = p_clinic AND e.channel = 'web' AND e.kind = 'runtime_seen')
                WHEN 'meta' THEN EXISTS (SELECT 1 FROM provider_connections p
                                          WHERE p.clinic_id = p_clinic
                                            AND p.provider IN ('meta-messenger', 'meta-instagram', 'meta-whatsapp')
                                            AND p.status IN ('active', 'pending'))
                ELSE false
              END
          AND NOT EXISTS (
                SELECT 1
                  FROM (VALUES ('basics'), ('hours'), ('services'), ('question'), ('insurance'),
                               ('tone'), ('coverage'), ('direct_line'), ('deposits'), ('urgent'),
                               ('calendar'), ('providers'), ('channels')) AS wizard(screen)
                 WHERE (wizard.screen NOT IN ('insurance', 'coverage', 'direct_line')
                        OR (wizard.screen = 'insurance'
                            AND k.regulatory_regime IS NOT DISTINCT FROM 'hipaa-if-covered'
                            AND k.agreement_kind IS NOT DISTINCT FROM 'baa'
                            AND k.is_covered_entity IS NULL)
                        OR (wizard.screen IN ('coverage', 'direct_line')
                            AND EXISTS (SELECT 1 FROM clinic_channels v
                                         WHERE v.clinic_id = p_clinic AND v.channel = 'voice')))
                   AND NOT EXISTS (SELECT 1 FROM clinic_setup_screens ss
                                    WHERE ss.clinic_id = p_clinic AND ss.screen = wizard.screen))
          AND (p_channel <> 'voice'
               OR (k.opening_hours IS NOT NULL
                   AND k.onboarding ->> 'hours_confirmed' IS NOT NULL
                   AND s.direct_line_e164 IS NOT NULL))
          AND (k.regulatory_regime IS DISTINCT FROM 'non-hipaa' OR s.vet_referral_e164 IS NOT NULL)
          AND NOT (EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(a.services, '[]'::jsonb)) sv
                            WHERE sv ->> 'priceFromUsd' IS NOT NULL)
                   AND NOT EXISTS (SELECT 1 FROM clinic_setup_screens ss
                                    WHERE ss.clinic_id = p_clinic AND ss.screen = 'services' AND ss.outcome = 'done'))
          AND NOT (k.regulatory_regime IS NOT DISTINCT FROM 'hipaa-if-covered' AND k.is_covered_entity IS NULL))
$$;--> statement-breakpoint

-- Gate B for one channel, as the clinic's go-live asks it: the channel's
-- inputs, its practice questions passed, and its own attestations. The
-- attestations every channel shares are go-live's `platform`, asked once.
CREATE OR REPLACE FUNCTION app_channel_gate_b_ok(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT app_channel_inputs_ok(p_clinic, p_channel)
     AND app_channel_audit_ok(p_clinic, p_channel)
     AND cardinality(app_platform_missing(p_channel)) = 0
$$;--> statement-breakpoint

-- Live: Gate B for the channel, every channel's attestations, and the clinic
-- in production. decideChannel (lib/channels/events.ts) is its mirror; the
-- definers that call it (0079) keep their bodies, owners and grants.
CREATE OR REPLACE FUNCTION app_channel_live_ok(p_clinic uuid, p_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  SELECT app_channel_gate_b_ok(p_clinic, p_channel)
     AND cardinality(app_platform_missing(NULL)) = 0
     AND EXISTS (SELECT 1 FROM clinics k WHERE k.id = p_clinic AND k.data_classification = 'production')
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_practice_gate_open(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_audit_ok(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_inputs_ok(uuid, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_channel_gate_b_ok(uuid, text) FROM PUBLIC;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- What go-live still waits on
-- -----------------------------------------------------------------------------
-- The codes of goLivePreconditions (lib/onboarding/go-live.ts), in its order:
-- leaving, demo, covered_status, no_agreement, agreement_version,
-- agreement_kind_mismatch, agreement_insufficient, platform, gate_b. Empty
-- when the clinic may go live. tests/go-live.test.ts runs fixtures through
-- both and fails when they disagree.
--
-- SECURITY DEFINER so it reads as the functions it calls are written to,
-- and only in the clinic's own tenant, which it refuses to run without: the
-- channel tables FORCE row-level security, so from anywhere else it would
-- see none of the clinic's channels and say Gate B is not met, a wrong answer
-- for the right reason.
CREATE OR REPLACE FUNCTION app_go_live_missing(target_clinic uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  leaving boolean;
  regime text;
  clinic_kind text;
  covered boolean;
  agreement uuid;
  agreement_version text;
  agreement_kind text;
  codes text[] := ARRAY[]::text[];
BEGIN
  IF app_current_clinic_id() IS DISTINCT FROM target_clinic THEN
    RAISE EXCEPTION 'app_go_live_missing runs inside the clinic''s own tenant' USING ERRCODE = '42501';
  END IF;
  SELECT c.organization_id, (c.offboarding_started_at IS NOT NULL OR c.destroyed_at IS NOT NULL),
         c.regulatory_regime, c.agreement_kind, c.is_covered_entity
    INTO org, leaving, regime, clinic_kind, covered
    FROM clinics c WHERE c.id = target_clinic;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic USING ERRCODE = 'no_data_found';
  END IF;

  IF leaving THEN codes := codes || 'leaving'::text; END IF;
  IF app_clinic_is_demo(target_clinic) THEN codes := codes || 'demo'::text; END IF;
  IF regime IS NOT DISTINCT FROM 'hipaa-if-covered' AND covered IS NULL THEN
    codes := codes || 'covered_status'::text;
  END IF;

  SELECT e.agreement_id, e.document_version, b.agreement_kind
    INTO agreement, agreement_version, agreement_kind
    FROM app_agreement_in_effect(org) e
    JOIN baa_acceptances b ON b.id = e.agreement_id;
  IF agreement IS NULL THEN
    codes := codes || 'no_agreement'::text;
  ELSE
    IF NOT app_agreement_version_acceptable(agreement_version) THEN
      codes := codes || 'agreement_version'::text;
    END IF;
    IF clinic_kind IS DISTINCT FROM agreement_kind THEN
      codes := codes || 'agreement_kind_mismatch'::text;
    END IF;
    IF NOT app_agreement_kind_sufficient(regime, agreement_kind, covered) THEN
      codes := codes || 'agreement_insufficient'::text;
    END IF;
  END IF;

  IF cardinality(app_platform_missing(NULL)) > 0 THEN codes := codes || 'platform'::text; END IF;
  IF NOT EXISTS (SELECT 1 FROM clinic_channels cc
                  WHERE cc.clinic_id = target_clinic
                    AND app_channel_gate_b_ok(target_clinic, cc.channel)) THEN
    codes := codes || 'gate_b'::text;
  END IF;
  RETURN codes;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_go_live_missing(uuid) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_go_live_missing(uuid) TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Go-live
-- -----------------------------------------------------------------------------
-- The only path from synthetic to production, rewritten with
-- goLivePreconditions. It runs in the clinic's own tenant (the channel
-- events' writer calls it, lib/channels/events.ts, and so does the
-- operator's "Check go-live now"), locks the clinic's row so two callers flip
-- it once, and returns the agreement's acceptance date, which it copies into
-- baa_signed_at, as before. A clinic already in production is left as it is
-- and its date returned: go-live happens once. A refusal names what is
-- missing first, in the order of app_go_live_missing, with the rest in its
-- HINT, and writes nothing.
CREATE OR REPLACE FUNCTION app_mark_clinic_production(target_clinic uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  org text;
  classification data_classification;
  signed_before timestamptz;
  regime text;
  clinic_kind text;
  covered boolean;
  signed timestamptz;
  signed_version text;
  signed_kind text;
  missing text[];
  rest text;
BEGIN
  IF app_current_clinic_id() IS DISTINCT FROM target_clinic THEN
    RAISE EXCEPTION 'app_mark_clinic_production runs inside the clinic''s own tenant' USING ERRCODE = '42501';
  END IF;
  SELECT c.organization_id, c.data_classification, c.baa_signed_at,
         c.regulatory_regime, c.agreement_kind, c.is_covered_entity
    INTO org, classification, signed_before, regime, clinic_kind, covered
    FROM clinics c WHERE c.id = target_clinic
    FOR UPDATE;
  IF org IS NULL THEN
    RAISE EXCEPTION 'Clinic % does not exist.', target_clinic USING ERRCODE = 'no_data_found';
  END IF;
  IF classification = 'production' THEN
    RETURN signed_before;
  END IF;

  missing := app_go_live_missing(target_clinic);
  IF cardinality(missing) > 0 THEN
    rest := 'Everything go-live waits on: ' || array_to_string(missing, ', ') || '.';
    SELECT e.accepted_at, e.document_version, b.agreement_kind
      INTO signed, signed_version, signed_kind
      FROM app_agreement_in_effect(org) e JOIN baa_acceptances b ON b.id = e.agreement_id;
    IF 'leaving' = ANY (missing) THEN
      RAISE EXCEPTION 'Clinic % has left; refusing to mark it production.', target_clinic
        USING ERRCODE = 'check_violation', HINT = rest;
    ELSIF 'demo' = ANY (missing) THEN
      RAISE EXCEPTION 'Clinic % is a demo clinic, which never goes live; refusing to mark it production.', target_clinic
        USING ERRCODE = 'check_violation', HINT = rest;
    ELSIF 'no_agreement' = ANY (missing) THEN
      RAISE EXCEPTION 'Clinic % has no bound, in-effect agreement; refusing to mark it production.', target_clinic
        USING ERRCODE = 'check_violation',
              HINT = 'Bind the signed agreement to this clinic''s organisation first (provisioning does this on purchase). ' || rest;
    ELSIF 'agreement_version' = ANY (missing) AND signed_kind = 'dpa' THEN
      RAISE EXCEPTION 'Clinic % is bound to data protection agreement version %, which is not released; refusing to mark it production.',
        target_clinic, signed_version
        USING ERRCODE = 'check_violation', HINT = 'The DPA''s release adds its version to app_dpa_version_released. ' || rest;
    ELSIF 'agreement_version' = ANY (missing) THEN
      RAISE EXCEPTION 'Clinic % is bound to business associate agreement version %, which has been superseded; refusing to mark it production.',
        target_clinic, signed_version
        USING ERRCODE = 'check_violation',
              HINT = 'The practice accepts the current agreement first; once bound it becomes the agreement in effect and go-live can be retried. ' || rest;
    ELSIF 'agreement_kind_mismatch' = ANY (missing) THEN
      RAISE EXCEPTION 'Clinic % records agreement kind %, and the agreement in effect is a %; refusing to mark it production.',
        target_clinic, coalesce(clinic_kind, 'none'), signed_kind
        USING ERRCODE = 'check_violation', HINT = rest;
    ELSIF 'agreement_insufficient' = ANY (missing) THEN
      RAISE EXCEPTION 'The % in effect does not cover clinic % (regime %, covered %); refusing to mark it production.',
        signed_kind, target_clinic, coalesce(regime, 'none'), coalesce(covered::text, 'undetermined')
        USING ERRCODE = 'check_violation',
              HINT = 'A practice HIPAA reaches signs a business associate agreement first (app_supersede_agreement). ' || rest;
    ELSIF 'covered_status' = ANY (missing) THEN
      RAISE EXCEPTION 'Clinic % has not had its covered-entity status determined; refusing to mark it production.', target_clinic
        USING ERRCODE = 'check_violation',
              HINT = 'The practice says in setup whether it sends any health information electronically to a payer. ' || rest;
    ELSIF 'platform' = ANY (missing) THEN
      RAISE EXCEPTION 'The platform is not attested for go-live (%); refusing to mark clinic % production.',
        array_to_string(app_platform_missing(NULL), ', '), target_clinic
        USING ERRCODE = 'check_violation', HINT = 'An operator attests each on /admin/compliance. ' || rest;
    ELSE
      RAISE EXCEPTION 'No channel of clinic % meets Gate B; refusing to mark it production.', target_clinic
        USING ERRCODE = 'check_violation',
              HINT = 'A channel needs its runtime, its practice questions passed, its own step, setup done and its attestations. ' || rest;
    END IF;
  END IF;

  SELECT e.accepted_at INTO signed FROM app_agreement_in_effect(org) e;
  UPDATE clinics
     SET data_classification = 'production',
         baa_signed_at = signed,
         went_live_at = now(),
         updated_at = now()
   WHERE id = target_clinic;
  RETURN signed;
END;
$$;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The console projection, with the agreement gate's two columns
-- -----------------------------------------------------------------------------
-- 0075's definition plus regulatory_regime and agreement_kind (0051), so the
-- console can say a clinic's agreement does not cover it before go-live
-- refuses it (blockersFor, lib/ops/clinics.ts). Configuration and contract
-- metadata, not patient data. A return type cannot change under CREATE OR
-- REPLACE, so drop and recreate, with 0075's comment, REVOKE and GRANT.
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
  destruction_agreement_version text,
  regulatory_regime text,
  agreement_kind text
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
         (SELECT e.document_version FROM app_agreement_at_end(c.id) e) AS destruction_agreement_version,
         c.regulatory_regime,
         c.agreement_kind
  FROM clinics c
  ORDER BY c.created_at DESC
$$;--> statement-breakpoint
COMMENT ON FUNCTION app_clinics_overview() IS
  'Clinic listing for background jobs and the ops console. SECURITY DEFINER because a scheduler must enumerate clinics before choosing one, which the runtime role cannot do. Configuration, onboarding, offboarding, booking-mode and billing-location state, the version of the agreement in effect, the version of the agreement the service ended under (the destruction rule''s), and the agreement gate''s regime and kind (0085) — no patient data. Callers must still use withTenant() to read anything else.';--> statement-breakpoint
REVOKE ALL ON FUNCTION app_clinics_overview() FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_clinics_overview() TO healdesk_app;--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Comments
-- -----------------------------------------------------------------------------
COMMENT ON TABLE platform_compliance IS
  'Ops-only, platform-wide: each operator attestation (or its withdrawal) of a vendor''s business associate agreement in the chain (anthropic, database_host, aws; retell for phone) or a Gate B readiness flag, with the operator, the dates and a reference to the document. Go-live and each channel''s live read the latest row per subject (app_platform_attested). Append-only; written outside any tenant, from the ops envelope. No clinic_id and no patient data, so no RLS (0085 says why) and no place in destruction or the purge.';--> statement-breakpoint
COMMENT ON FUNCTION app_mark_clinic_production(uuid) IS
  'The only path from synthetic to production, automatic since 0085: in the clinic''s own tenant, once app_go_live_missing() is empty (not leaving, not a demo, covered status determined, an acceptable agreement of the clinic''s kind that covers it, the platform attested, and Gate B for a channel). Copies the agreement''s accepted_at into baa_signed_at; a clinic already in production is left as it is.';--> statement-breakpoint
COMMENT ON FUNCTION app_go_live_missing(uuid) IS
  'What go-live still waits on, as goLivePreconditions'' codes in its order; empty when the clinic may go live. In the clinic''s own tenant only. No patient data.';--> statement-breakpoint
COMMENT ON FUNCTION app_agreement_version_acceptable(text) IS
  'Whether a clinic may go live under an agreement version, by its kind: a DPA through app_dpa_version_released, a BAA through app_baa_version_acceptable. The SQL of agreementTemplateReleased() (parity test in tests/go-live.test.ts).';--> statement-breakpoint
COMMENT ON FUNCTION app_dpa_version_released(text) IS
  'The released DPA versions, written out: none until the owner releases the DPA (packages/catalog/src/dpa.ts). Must equal getDpaTemplate(v).approvedByCounsel (parity test in tests/go-live.test.ts).';--> statement-breakpoint
COMMENT ON FUNCTION app_channel_live_ok(uuid, text) IS
  'Whether a channel may go live: Gate B for it (app_channel_gate_b_ok: its inputs, its practice questions passed, its attestations), every channel''s attestations, and the clinic in production. decideChannel in lib/channels/events.ts is its mirror.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF has_table_privilege('healdesk_app'::name, 'platform_compliance'::regclass, 'DELETE')
     OR has_any_column_privilege('healdesk_app'::name, 'platform_compliance'::regclass, 'UPDATE')
     OR NOT has_table_privilege('healdesk_app'::name, 'platform_compliance'::regclass, 'INSERT')
     OR NOT has_table_privilege('healdesk_app'::name, 'platform_compliance'::regclass, 'SELECT') THEN
    RAISE EXCEPTION 'healdesk_app must read and append platform_compliance, and never rewrite or erase it.';
  END IF;
  IF app_dpa_version_released('dpa/1.0.0')
     OR app_agreement_version_acceptable('dpa/1.0.0')
     OR NOT app_agreement_version_acceptable('1.5.1')
     OR app_agreement_version_acceptable('1.5.0')
     OR app_agreement_version_acceptable('')
     OR app_agreement_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_agreement_version_acceptable must accept the BAA floor (1.5.1) and nothing else while the DPA is unreleased.';
  END IF;
  IF app_platform_subjects_for(NULL) <> ARRAY['anthropic', 'database_host', 'aws', 'launch_promises']
     OR app_platform_subjects_for('voice') <> ARRAY['retell', 'runtime_voice', 'voice_pass_through']
     OR app_platform_subjects_for('nonsense') <> ARRAY['unknown_channel'] THEN
    RAISE EXCEPTION 'app_platform_subjects_for does not name what lib/compliance/subjects.ts names.';
  END IF;
  IF has_function_privilege('public', 'app_go_live_missing(uuid)', 'EXECUTE')
     OR has_function_privilege('public', 'app_mark_clinic_production(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('healdesk_app', 'app_mark_clinic_production(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'go-live''s definers must be executable by healdesk_app and not by PUBLIC.';
  END IF;
END
$$;
