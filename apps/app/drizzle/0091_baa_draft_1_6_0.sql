-- =============================================================================
-- BAA 1.6.0 is drafted (19 October 2026), NOT released: it gets the
-- destruction rule its Term clause states, and nothing else changes. This
-- migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- 1.6.0 is 1.5.1 with three clauses changed so Anthropic's retention is said
-- as Anthropic's own documentation says it for the models the product calls:
-- the Subcontractors clause (conversation content kept no more than the 30
-- days of its standard retention, two years for flagged content alone,
-- law-required content for as long as the law requires, no training without
-- healdesk's permission), the state-law clause's exception to deletion, and
-- the Term clause, which keeps Anthropic's copies "only for the periods" the
-- Subcontractors clause states rather than "the purposes and periods"
-- (packages/catalog/src/baa.ts, SUBCONTRACTORS_1_6, stateLawClauseBody160
-- and TERM_1_6; model-retention.ts; docs/counsel/agreement-changes.md §17).
-- It is registered in BAA_TEMPLATES after 1.5.1 with approvedByCounsel
-- false, so checkout does not offer it and signing, provisioning and go-live
-- all refuse it.
--
-- This is not a release. app_baa_version_acceptable() is left exactly as
-- 0081 (baa_release_1_5_1) made it: 1.5.1 and nothing else, so go-live still
-- refuses 1.6.0, as isBaaVersionAcceptable() does while the draft is
-- unreleased. Releasing 1.6.0 is the owner's decision, and its own migration
-- moves that list and the floor, as 0081 did for 1.5.1.
--
-- The destruction rule is different: it is an allow-list read by version, so
-- a version left off it reads as the thirty days, which 1.6.0's Term clause
-- (1.3.0's, changed only in that one phrase about Anthropic) does not state.
-- DESTRUCTION_RULES in lib/offboarding/offboarding.ts gives every registered
-- version its rule, drafts included, and the parity test in
-- tests/destruction-clock.test.ts holds this function to that map version for
-- version. 0058 did the same for 1.3.0 while it was still a draft. No clinic
-- can be bound to 1.6.0 before it is released, so the entry changes nothing
-- for any clinic until then. 1.5.1, 1.5.0, 1.4.0, 1.3.0 and dpa/1.0.0 keep
-- the export rule 0081 left them.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place").
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The destruction rule: DESTRUCTION_RULES, written out
-- -----------------------------------------------------------------------------
-- 0081's definition, with 1.6.0 beside 1.5.1, 1.5.0, 1.4.0, 1.3.0 and
-- dpa/1.0.0. Total and never NULL; NULL (no agreement) and any version not
-- listed read as the thirty days. CREATE OR REPLACE keeps 0058's REVOKE from
-- PUBLIC and its grant to healdesk_app, and every caller (app_destruction_due
-- among them).
CREATE OR REPLACE FUNCTION app_destruction_rule(version text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN version = ANY (ARRAY['1.6.0', '1.5.1', '1.5.0', '1.4.0', '1.3.0', 'dpa/1.0.0']) THEN 'export_or_ninety'
           ELSE 'thirty_days'
         END
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_destruction_rule(text) IS
  'The destruction rule a stored agreement version states: export_or_ninety for BAA 1.6.0 (a draft until the owner releases it), 1.5.1, 1.5.0, 1.4.0 and 1.3.0, whose Term clauses state the same export-or-ninety rule, and DPA 1.0.0 (dpa/1.0.0), thirty_days for every other version, an unknown one and NULL. The SQL mirror of DESTRUCTION_RULES in lib/offboarding/offboarding.ts (parity test in tests/destruction-clock.test.ts); 1.5.1 added by baa_release_1_5_1, 1.6.0 by baa_draft_1_6_0.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_baa_version_acceptable('1.5.1')
     OR app_baa_version_acceptable('1.6.0')
     OR app_baa_version_acceptable('1.5.0')
     OR app_baa_version_acceptable('1.4.0')
     OR app_baa_version_acceptable('9.9.9')
     OR app_baa_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_baa_version_acceptable must still accept 1.5.1 and nothing else: not the unreleased 1.6.0 draft, 1.5.0, 1.4.0, an unknown version or NULL.';
  END IF;
  IF app_destruction_rule('1.6.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.5.1') <> 'export_or_ninety'
     OR app_destruction_rule('1.5.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.4.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.3.0') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.0.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.2.2') <> 'thirty_days'
     OR app_destruction_rule('1.0.0') <> 'thirty_days'
     OR app_destruction_rule('1.5.2') <> 'thirty_days'
     OR app_destruction_rule('1.6.1') <> 'thirty_days'
     OR app_destruction_rule('9.9.9') <> 'thirty_days'
     OR app_destruction_rule(NULL) <> 'thirty_days' THEN
    RAISE EXCEPTION 'app_destruction_rule does not give 1.6.0, 1.5.1, 1.5.0, 1.4.0, 1.3.0 and dpa/1.0.0 the export rule their Term clauses state, and the thirty days to 1.2.2, 1.0.0, an unknown version and none.';
  END IF;
END;
$$;
