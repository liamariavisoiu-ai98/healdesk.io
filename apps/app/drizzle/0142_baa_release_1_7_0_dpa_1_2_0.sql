-- Custom SQL migration file, put your code below! --

-- =============================================================================
-- BAA 1.7.0 and DPA 1.2.0 are released (owner, 30 October 2026; landed on
-- 1 November 2026), and the BAA's go-live floor moves to 1.7.0. This
-- migration changes no table, so drizzle generated it empty (--custom);
-- everything below is the part drizzle cannot express.
--
-- Added in the commit that sets BAA_1_7_0_RELEASED (packages/catalog
-- src/baa.ts) and DPA_1_2_0_RELEASED (src/dpa.ts) to true, through
-- `npx drizzle-kit generate --custom --name baa_release_1_7_0_dpa_1_2_0` run
-- in apps/app and this text pasted over the empty file it created, on the
-- owner's words "release BAA 1.7.0 and DPA 1.1.0" of 30 October 2026, given
-- without external counsel, and his "Go C13" of 1 November 2026 to land it
-- before launch (docs/counsel/agreement-changes.md §22).
-- apps/app/tests/baa-release-1-7-0.test.ts holds these lists to the catalog.
--
-- Why it is 0142 and the DPA is 1.2.0: this release was built on a branch
-- (LEGAL-4) as migration 0140_baa_release_1_7_0 and a "dpa/1.1.0" carrying
-- three changes. Main released and deployed its own dpa/1.1.0 the same day,
-- the payment-link text in the same words, with its own migration 0140
-- (dpa_release_1_1_0), which production has run. A released version is never
-- edited, so the branch's two other changes are dpa/1.2.0, on top of it, and
-- this migration follows 0141.
--
-- What changed, at the owner's instruction of 30 October ("adjust whatever's
-- needed"): both documents report a breach, a security incident or an
-- improper use or disclosure "without unreasonable delay and in no case later
-- than 10 calendar days after discovery", where BAA 1.6.0 and dpa/1.1.0 say
-- 60, and give "at least 15 days' notice by email" before a new
-- subcontractor, where they give 24 hours. Every other clause is the earlier
-- version's own object.
--
-- The BAA floor: MIN_ACCEPTABLE_BAA_VERSION is 1.7.0 and BAA_RELEASE_OVERLAP
-- is empty, as at 1.6.0's release, on the owner's word that there are no
-- clients yet (synthetic data only). app_baa_version_acceptable() therefore
-- accepts 1.7.0 and nothing else. app_agreement_version_acceptable() (0090)
-- reads it for a BAA and app_dpa_version_released() for a DPA, so it moves
-- with both.
--
-- The DPA: app_dpa_version_released() must equal getDpaTemplate(v)
-- .approvedByCounsel in @healdesk/catalog (parity test in tests/go-live.test.ts).
-- dpa/1.0.0 and dpa/1.1.0 stay released, as every released version stays
-- registered and frozen; the DPA has no go-live floor, so a practice bound to
-- either still goes live under it. New practices are offered dpa/1.2.0, which
-- is DPA_TEMPLATES[0]. The calendar election form is unchanged.
--
-- The destruction rule: 1.7.0's and dpa/1.2.0's Term clauses are 1.6.0's and
-- dpa/1.0.0's own objects, so both state the export-or-ninety rule.
-- The incident clocks (lib/incidents/reporting-rules.ts) are not SQL.
--
-- Safe to apply in place: apps/app has only ever held synthetic and seed data
-- (CLAUDE.md, "Until BAA coverage is in place"), and no real account is bound
-- to any agreement. A synthetic account bound to 1.6.0 can no longer go live;
-- it re-signs 1.7.0 first, as a superseded signer would.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_baa_version_acceptable(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['1.7.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_baa_version_acceptable(text) IS
  'True for the BAA versions a clinic may go live under: registered, approved for release, and no older than MIN_ACCEPTABLE_BAA_VERSION in @healdesk/catalog, which is 1.7.0 since its release (baa_release_1_7_0_dpa_1_2_0). Must equal isBaaVersionAcceptable() there (parity test in tests/database-audit.test.ts).';--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_dpa_version_released(version text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT coalesce(version = ANY (ARRAY['dpa/1.2.0', 'dpa/1.1.0', 'dpa/1.0.0']), false)
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_dpa_version_released(text) IS
  'The released DPA versions, written out: dpa/1.0.0, released by the owner on 20 October 2026 (dpa_release_1_0_0); dpa/1.1.0, released on 30 October 2026 (dpa_release_1_1_0); and dpa/1.2.0, released on 30 October 2026 and reconciled on 1 November 2026 (baa_release_1_7_0_dpa_1_2_0). Must equal getDpaTemplate(v).approvedByCounsel in @healdesk/catalog (parity test in tests/go-live.test.ts); a release needs a migration redefining it.';--> statement-breakpoint

CREATE OR REPLACE FUNCTION app_destruction_rule(version text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN version = ANY (ARRAY['1.7.0', '1.6.0', '1.5.1', '1.5.0', '1.4.0', '1.3.0', 'dpa/1.2.0', 'dpa/1.1.0', 'dpa/1.0.0']) THEN 'export_or_ninety'
           ELSE 'thirty_days'
         END
$$;--> statement-breakpoint

COMMENT ON FUNCTION app_destruction_rule(text) IS
  'The destruction rule a stored agreement version states: export_or_ninety for BAA 1.7.0, 1.6.0, 1.5.1, 1.5.0, 1.4.0 and 1.3.0, whose Term clauses state the same export-or-ninety rule, and DPA 1.2.0, 1.1.0 and 1.0.0, whose Term clause is the same; thirty_days for every other version, an unknown one and NULL. The SQL mirror of DESTRUCTION_RULES in lib/offboarding/offboarding.ts (parity test in tests/destruction-clock.test.ts); 1.5.1 added by baa_release_1_5_1, 1.6.0 by baa_draft_1_6_0, dpa/1.1.0 by dpa_release_1_1_0, 1.7.0 and dpa/1.2.0 by baa_release_1_7_0_dpa_1_2_0.';--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- The posture, re-asserted: a later widening fails here, not in production.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT app_baa_version_acceptable('1.7.0')
     OR app_baa_version_acceptable('1.6.0')
     OR app_baa_version_acceptable('1.5.1')
     OR app_baa_version_acceptable('1.2.2')
     OR app_baa_version_acceptable('1.0.0')
     OR app_baa_version_acceptable('1.1.0-draft')
     OR app_baa_version_acceptable('0.1.0-draft')
     OR app_baa_version_acceptable('dpa/1.2.0')
     OR app_baa_version_acceptable('dpa/1.1.0')
     OR app_baa_version_acceptable('9.9.9')
     OR app_baa_version_acceptable('')
     OR app_baa_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_baa_version_acceptable must accept 1.7.0 and nothing else: not 1.6.0, 1.5.1, an older version, a draft, a DPA, an unknown version, the empty string or NULL.';
  END IF;
  IF NOT app_dpa_version_released('dpa/1.2.0')
     OR NOT app_dpa_version_released('dpa/1.1.0')
     OR NOT app_dpa_version_released('dpa/1.0.0')
     OR app_dpa_version_released('dpa/1.3.0')
     OR app_dpa_version_released('dpa/9.9.9')
     OR app_dpa_version_released('1.7.0')
     OR app_dpa_version_released('')
     OR app_dpa_version_released(NULL) THEN
    RAISE EXCEPTION 'app_dpa_version_released must list dpa/1.2.0, dpa/1.1.0 and dpa/1.0.0 and nothing else: not an unknown DPA version, a BAA, the empty string or NULL.';
  END IF;
  IF NOT app_agreement_version_acceptable('1.7.0')
     OR NOT app_agreement_version_acceptable('dpa/1.2.0')
     OR NOT app_agreement_version_acceptable('dpa/1.1.0')
     OR NOT app_agreement_version_acceptable('dpa/1.0.0')
     OR app_agreement_version_acceptable('1.6.0')
     OR app_agreement_version_acceptable('dpa/9.9.9')
     OR app_agreement_version_acceptable('')
     OR app_agreement_version_acceptable(NULL) THEN
    RAISE EXCEPTION 'app_agreement_version_acceptable must accept the BAA floor (1.7.0) and the released DPAs (dpa/1.2.0, dpa/1.1.0, dpa/1.0.0), and nothing else: not 1.6.0, an unknown DPA version, the empty string or NULL.';
  END IF;
  IF NOT app_calendar_election_released('calendar-election/1.0.0')
     OR NOT app_calendar_election_released('calendar-election-dpa/1.0.0')
     OR app_calendar_election_released('calendar-election-dpa/1.1.0') THEN
    RAISE EXCEPTION 'app_calendar_election_released must still list calendar-election/1.0.0 and calendar-election-dpa/1.0.0 and nothing else.';
  END IF;
  IF app_destruction_rule('1.7.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.6.0') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.2.0') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.1.0') <> 'export_or_ninety'
     OR app_destruction_rule('dpa/1.0.0') <> 'export_or_ninety'
     OR app_destruction_rule('1.2.2') <> 'thirty_days'
     OR app_destruction_rule('dpa/1.3.0') <> 'thirty_days'
     OR app_destruction_rule('9.9.9') <> 'thirty_days'
     OR app_destruction_rule(NULL) <> 'thirty_days' THEN
    RAISE EXCEPTION 'app_destruction_rule must give 1.7.0, 1.6.0 and the three DPAs the export rule their Term clauses state, and the thirty days to 1.2.2, an unknown version and none.';
  END IF;
END;
$$;
