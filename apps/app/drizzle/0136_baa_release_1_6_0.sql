-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- BAA 1.6.0 is released (owner, 2026-10-29), and the go-live floor moves to it.
-- This migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- Prepared in docs/design/launch-readiness-2026-10-27/baa-release-1-6-0.sql
-- and added here in the commit that sets BAA_1_6_0_RELEASED to true in
-- packages/catalog/src/baa.ts, through
-- `npx drizzle-kit generate --custom --name baa_release_1_6_0` run in apps/app
-- and that text pasted over the empty file it created, on the owner's word
-- "Release." of 29 October 2026, given without external counsel
-- (baa-1-6-0-owner-checklist.md, section 4).
-- apps/app/tests/baa-release-1-6-0.test.ts holds this allow-list to
-- baaVersionAcceptableWhen(true, ...) before the release, and the parity test
-- in tests/database-audit.test.ts to isBaaVersionAcceptable() after it.
--
-- BAA 1.5.1's Subcontractors clause (clause 13, 1.3.0's object) says
-- Anthropic keeps conversation content "for 30 days, for abuse detection and
-- security", that content the law requires it to keep may be kept "for up to
-- two years", and that its service "cannot run with shorter retention".
-- Anthropic's documentation says none of that of the models the product
-- calls (docs/counsel/agreement-changes.md §17.1 and §17.2). 1.6.0 is 1.5.1
-- with that paragraph said as Anthropic documents it (MODEL_RETENTION_AGREEMENT
-- in packages/catalog/src/model-retention.ts), and the state-law and Term
-- clauses' cross-references to it said as it now reads (§17.3); and, since
-- 29 October 2026, the Safeguards clause (clause 10) saying the assistant is
-- engineered and designed to offer a caller one text with fixed wording and
-- Practice's own payment link, where Practice has chosen that option, where
-- 1.5.1 says healdesk "sends no SMS" (§20). Terms § 1
-- lets the agreement win over terms § 9 on anything about patient
-- information, so while clinics sign 1.5.1 the corrected § 9 is overridden;
-- the launch tracker's baa-1-6-0-retention therefore says no clinic goes live
-- under 1.5.1's retention clause.
--
-- The floor: MIN_ACCEPTABLE_BAA_VERSION is 1.6.0 and BAA_RELEASE_OVERLAP is
-- empty, the treatment 0081 gave 1.5.0, on the owner's reading of the
-- marketing Sheet that no real buyer holds a 1.5.1 signature waiting to be
-- provisioned. isBaaVersionAcceptable() in @healdesk/catalog therefore
-- accepts 1.6.0 and nothing else, and app_baa_version_acceptable(), its SQL
-- mirror, must say the same: without this migration go-live
-- (app_mark_clinic_production) and a supersede (app_supersede_agreement)
-- would refuse every 1.6.0 signer and keep accepting 1.5.1.
-- app_agreement_version_acceptable() (0090) reads this function for a BAA,
-- so it moves with it, and still accepts the released DPA through
-- app_dpa_version_released() (0104).
--
-- Unchanged, and asserted below:
--   * app_destruction_rule() has given 1.6.0 the export rule its Term clause
--     states since 0091 (baa_draft_1_6_0), and 1.5.1 keeps it: a synthetic
--     clinic bound to 1.5.1 still offboards by what it signed.
--   * app_calendar_election_released() (0104) lists calendar-election/1.0.0
--     and calendar-election-dpa/1.0.0: 1.6.0 carries 1.3.0's calendar
--     clauses as the same objects, so the BAA's election form amends it as
--     it amends 1.5.1.
--   * The incident clocks (lib/incidents/reporting-rules.ts) and the purge
--     already read 1.6.0 as 1.5.1, whose Reporting, notice and Minimum
--     necessary clauses it carries as the same objects; neither is SQL.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and no real account is bound
-- to any agreement. A synthetic account bound to 1.5.1 can no longer go live;
-- it re-signs 1.6.0 first (lib/agreements/resign.ts opens the re-sign once the
-- floor has passed its version), as a superseded signer would.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The acceptable versions: isBaaVersionAcceptable(), written out
-- -----------------------------------------------------------------------------
-- 0081's definition, with 1.6.0 in place of 1.5.1. An allow-list, so a draft,
-- an unknown string or NULL is refused, and so is every version below the
-- floor. CREATE OR REPLACE keeps the function's owner, grants and every
-- caller.
CREATE OR REPLACE FUNCTION app_baa_version_acceptable(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['1.6.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_baa_version_acceptable(text) IS
  'True for the BAA versions a clinic may go live under: registered, approved for release, and no older than MIN_ACCEPTABLE_BAA_VERSION in @healdesk/catalog, which is 1.6.0 since its release (baa_release_1_6_0). Must equal isBaaVersionAcceptable() there (parity test in tests/database-audit.test.ts).';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_baa_version_acceptable('1.6.0')
     OR app_baa_version_acceptable('1.5.1')
     OR app_baa_version_acceptable('1.5.0')
     OR app_baa_version_acceptable('1.4.0')
     OR app_baa_version_acceptable('1.3.0')
     OR app_baa_version_acceptable('1.2.2')
     OR app_baa_version_acceptable('1.2.1')
     OR app_baa_version_acceptable('1.2.0')
     OR app_baa_version_acceptable('1.0.0')
     OR app_baa_version_acceptable('1.1.0-draft')
     OR app_baa_version_acceptable('0.1.0-draft')
     OR app_baa_version_acceptable('dpa/1.0.0')
     OR app_baa_version_acceptable('9.9.9')
     OR app_baa_version_acceptable('')
     OR app_baa_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_baa_version_acceptable must accept 1.6.0 and nothing else: not 1.5.1, 1.5.0, 1.4.0, 1.3.0, 1.2.2, 1.2.1, 1.2.0, 1.0.0, a draft, the DPA, an unknown version, the empty string or NULL.';
  END IF;
  IF NOT app_agreement_version_acceptable('1.6.0')
     OR NOT app_agreement_version_acceptable('dpa/1.0.0')
     OR app_agreement_version_acceptable('1.5.1')
     OR app_agreement_version_acceptable('dpa/9.9.9')
     OR app_agreement_version_acceptable('')
     OR app_agreement_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_agreement_version_acceptable must accept the BAA floor (1.6.0) and the released DPA (dpa/1.0.0), and nothing else: not 1.5.1, an unknown DPA version, the empty string or NULL.';
  END IF;
  IF NOT app_calendar_election_released('calendar-election/1.0.0')
     OR NOT app_calendar_election_released('calendar-election-dpa/1.0.0')
     OR app_calendar_election_released('calendar-election/9.9.9')
     OR app_calendar_election_released('')
     OR app_calendar_election_released(NULL) THEN
    RAISE EXCEPTION 'app_calendar_election_released must list calendar-election/1.0.0 and calendar-election-dpa/1.0.0 and nothing else.';
  END IF;
  IF app_destruction_rule('1.6.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.5.1') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.0.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.2.2') <> 'thirty_days'
     OR app_destruction_rule('9.9.9') <> 'thirty_days'
     OR app_destruction_rule(NULL) <> 'thirty_days' THEN
    RAISE EXCEPTION 'app_destruction_rule must keep giving 1.6.0, 1.5.1 and dpa/1.0.0 the export rule their Term clauses state, and the thirty days to 1.2.2, an unknown version and none.';
  END IF;
END;
$$;
